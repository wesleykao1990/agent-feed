"""Transport-injected producer and delivery-consumer clients."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import inspect
import math
import random
import re
import time
import builtins
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlparse

from .errors import (
    AgentFeedError, AuthenticationError, AuthorizationError, ConflictError,
    HttpError, NotFoundError, ProtocolError, RateLimitError, RetryExhaustedError,
    ServerError, TimeoutError, TransportError,
)
from .models import ProtocolModel
from .transport import Transport, TransportResponse, UrllibTransport
from .validation import validate, validate_begin, validate_complete, validate_run_bundle, validate_submit


@dataclass(frozen=True)
class RetryPolicy:
    """Small bounded retry policy for safe/idempotent operations only."""

    max_attempts: int = 3
    initial_delay: float = 0.25
    max_delay: float = 2.0
    jitter: float = 0.0
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        if not isinstance(self.max_attempts, int) or isinstance(self.max_attempts, bool) or not 1 <= self.max_attempts <= 8:
            raise ValueError("max_attempts must be between 1 and 8")
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in (self.initial_delay, self.max_delay, self.jitter)):
            raise ValueError("retry delays and jitter must be finite numbers")
        if self.initial_delay < 0 or self.max_delay < 0 or self.initial_delay > self.max_delay:
            raise ValueError("retry delays must be non-negative and ordered")
        if self.jitter < 0 or self.jitter > 1:
            raise ValueError("jitter must be between 0 and 1")
        if not callable(self.sleep):
            raise ValueError("sleep must be callable")

    def delay(self, attempt: int, retry_after: float | None = None) -> float:
        if retry_after is not None:
            value = min(self.max_delay, max(0.0, retry_after))
        else:
            value = min(self.max_delay, self.initial_delay * (2 ** max(0, attempt - 1)))
        if self.jitter:
            value = min(self.max_delay, value * (1 + random.uniform(0, self.jitter)))
        return value


_RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


class BaseClient:
    """Shared request, timeout, retry, and error handling."""

    def __init__(self, base_url: str, *, token: str | None = None, transport: Transport | Callable[..., Any] | None = None, timeout: float = 30.0, retry: RetryPolicy | None = None, headers: Mapping[str, str] | None = None) -> None:
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("base_url must be non-empty")
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an http(s) URL")
        if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            raise ValueError("base_url credentials, query, and fragment are not allowed")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive")
        if token is not None and (not isinstance(token, str) or not token.strip() or "\r" in token or "\n" in token):
            raise ValueError("token must be non-empty when supplied")
        self.base_url = base_url.rstrip("/") + "/"
        self.token = token
        self.transport = transport or UrllibTransport()
        self.timeout = float(timeout)
        self.retry = retry or RetryPolicy()
        self.headers = {str(key): str(value) for key, value in (headers or {}).items() if str(key).lower() != "authorization"}

    def _url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            raise ValueError("request path must be relative to base_url")
        return urljoin(self.base_url, path.lstrip("/"))

    def _request(self, method: str, path: str, *, body: Any = None, safe_to_retry: bool = False, idempotency_key: str | None = None, expected_status: set[int] | None = None) -> Any:
        url = self._url(path)
        headers = {"Accept": "application/json", **self.headers}
        if body is not None:
            headers.setdefault("Content-Type", "application/json")
        if self.token is not None:
            headers["Authorization"] = f"Bearer {self.token}"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key

        last_error: BaseException | None = None
        attempts = self.retry.max_attempts if safe_to_retry else 1
        for attempt in range(1, attempts + 1):
            try:
                response = _invoke_transport(self.transport, method.upper(), url, headers=headers, body=body, timeout=self.timeout)
            except AgentFeedError as exc:
                last_error = exc
                retryable = isinstance(exc, (TransportError, TimeoutError))
                if not retryable or attempt >= attempts:
                    if safe_to_retry and retryable and attempts > 1 and attempt >= attempts:
                        raise RetryExhaustedError(attempts=attempt, last_error=exc) from None
                    raise
                self._sleep_retry(self.retry.delay(attempt))
                continue
            except (builtins.TimeoutError, TimeoutError) as exc:
                wrapped = TimeoutError(cause=exc)
                last_error = wrapped
                if not safe_to_retry or attempt >= attempts:
                    if safe_to_retry and attempts > 1 and attempt >= attempts:
                        raise RetryExhaustedError(attempts=attempt, last_error=wrapped) from None
                    raise wrapped from None
                self._sleep_retry(self.retry.delay(attempt))
                continue
            except Exception as exc:
                wrapped = TransportError(cause=exc)
                last_error = wrapped
                if not safe_to_retry or attempt >= attempts:
                    if safe_to_retry and attempts > 1 and attempt >= attempts:
                        raise RetryExhaustedError(attempts=attempt, last_error=wrapped) from None
                    raise wrapped from None
                self._sleep_retry(self.retry.delay(attempt))
                continue

            if isinstance(response.status_code, bool) or not isinstance(response.status_code, int):
                raise ProtocolError("transport returned an invalid status")
            if 200 <= response.status_code < 300:
                if expected_status is not None and response.status_code not in expected_status:
                    raise ProtocolError("unexpected successful response status", details={"status_code": response.status_code})
                return _response_body(response.body)
            error = _http_error(response)
            last_error = error
            if response.status_code in _RETRYABLE_STATUSES and safe_to_retry and attempt < attempts:
                self._sleep_retry(self.retry.delay(attempt, _retry_after(response.headers)))
                continue
            if response.status_code in _RETRYABLE_STATUSES and safe_to_retry and attempts > 1 and attempt >= attempts:
                raise RetryExhaustedError(attempts=attempt, last_error=error) from None
            raise error
        raise RetryExhaustedError(attempts=attempts, last_error=last_error)

    def _sleep_retry(self, delay: float) -> None:
        try:
            self.retry.sleep(delay)
        except AgentFeedError:
            raise
        except builtins.TimeoutError as exc:
            raise TimeoutError(cause=exc) from None
        except Exception as exc:
            raise TransportError(cause=exc) from None


class ProducerClient(BaseClient):
    """Protocol 0.1 begin/submit/complete producer client."""

    def begin_run(self, request: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> Any:
        payload = _payload(request)
        if idempotency_key is not None:
            if "idempotency_key" in payload and payload["idempotency_key"] != idempotency_key:
                raise ValueError("idempotency_key does not match payload")
            payload["idempotency_key"] = idempotency_key
        validated = validate_begin(payload)
        return _require_run_response(self._request("POST", "/v1/runs:begin", body=validated, safe_to_retry=True, idempotency_key=validated["idempotency_key"], expected_status={201}), "producer.begin_run")

    def submit_batch(self, run_id: str, request: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> Any:
        _required_id(run_id, "run_id")
        payload = _payload(request)
        if payload.get("run_id") not in (None, run_id):
            raise ValueError("path run_id and body run_id must match")
        payload["run_id"] = run_id
        if idempotency_key is not None:
            if "idempotency_key" in payload and payload["idempotency_key"] != idempotency_key:
                raise ValueError("idempotency_key does not match payload")
            payload["idempotency_key"] = idempotency_key
        validated = validate_submit(payload)
        return _require_run_response(self._request("POST", f"/v1/runs/{quote(run_id, safe='')}/batches", body=validated, safe_to_retry=True, idempotency_key=validated["idempotency_key"], expected_status={202}), "producer.submit_batch")

    def complete_run(self, run_id: str, request: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> Any:
        _required_id(run_id, "run_id")
        payload = _payload(request)
        if payload.get("run_id") not in (None, run_id):
            raise ValueError("path run_id and body run_id must match")
        payload["run_id"] = run_id
        if idempotency_key is not None:
            if "idempotency_key" in payload and payload["idempotency_key"] != idempotency_key:
                raise ValueError("idempotency_key does not match payload")
            payload["idempotency_key"] = idempotency_key
        validated = validate_complete(payload)
        return _require_run_response(self._request("POST", f"/v1/runs/{quote(run_id, safe='')}:complete", body=validated, safe_to_retry=True, idempotency_key=validated["idempotency_key"], expected_status={200}), "producer.complete_run")

    def get_run(self, run_id: str) -> Any:
        _required_id(run_id, "run_id")
        return _require_run_response(self._request("GET", f"/v1/runs/{quote(run_id, safe='')}", safe_to_retry=True, expected_status={200}), "producer.get_run")

    def get_findings(self, run_id: str) -> Any:
        _required_id(run_id, "run_id")
        return _require_findings_response(self._request("GET", f"/v1/runs/{quote(run_id, safe='')}/findings", safe_to_retry=True, expected_status={200}), "producer.get_findings")

    @staticmethod
    def build_run_bundle(first: str | Mapping[str, Any] | ProtocolModel, *args: Any, run_id: str | None = None) -> dict[str, Any]:
        # TypeScript parity accepts (run_id, begin, batches, complete); the
        # Python-friendly form accepts (begin, batches, complete, run_id=...).
        if isinstance(first, str):
            if len(args) != 3:
                raise TypeError("build_run_bundle(run_id, begin, batches, complete) requires four arguments")
            selected_run_id = first
            begin, batches, complete = args
        else:
            if len(args) != 2:
                raise TypeError("build_run_bundle(begin, batches, complete) requires three arguments")
            begin = first
            batches, complete = args
            selected_run_id = run_id
        begin_payload = validate_begin(_payload(begin))
        if not isinstance(batches, (list, tuple)):
            raise TypeError("batches must be a sequence")
        batch_payloads = [validate_submit(_payload(item)) for item in batches]
        complete_payload = validate_complete(_payload(complete))
        selected_run_id = selected_run_id or complete_payload["run_id"]
        _required_id(selected_run_id, "run_id")
        bundle = {"protocol_version": "0.1", "run_id": selected_run_id, "begin": begin_payload, "batches": batch_payloads, "complete": complete_payload}
        if complete_payload["run_id"] != selected_run_id:
            raise ValueError("complete_run_id_mismatch")
        if any(batch["run_id"] != selected_run_id for batch in batch_payloads):
            raise ValueError("batch_run_id_mismatch")
        return validate_run_bundle(bundle)

    @staticmethod
    def build_recovery_bundle(
        run_id: str,
        begin: Mapping[str, Any] | ProtocolModel,
        batches: list[Mapping[str, Any] | ProtocolModel] | tuple[Mapping[str, Any] | ProtocolModel, ...],
        *,
        idempotency_key: str,
        completed_at: str,
        actual_scope: Mapping[str, Any] | None = None,
        stats: Mapping[str, Any] | None = None,
        errors: list[Mapping[str, Any]] | tuple[Mapping[str, Any], ...] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build an explicit protocol-valid partial recovery bundle.

        A recovery export is a local partial closure artifact. It never calls
        ``complete_run`` and fixes the terminal status to ``partial`` so a
        caller cannot accidentally represent an unfinished run as completed.
        Unknown scope/source counts default conservatively; callers can supply
        observed values when they have them.
        """
        _required_id(run_id, "run_id")
        begin_payload = validate_begin(_payload(begin))
        if not isinstance(batches, (list, tuple)):
            raise TypeError("batches must be a sequence")
        batch_payloads = [validate_submit(_payload(item)) for item in batches]
        if any(batch["run_id"] != run_id for batch in batch_payloads):
            raise ValueError("batch_run_id_mismatch")
        _required_id(idempotency_key, "idempotency_key")
        scope_payload = dict(actual_scope) if actual_scope is not None else _empty_scope()
        stats_payload = dict(stats) if stats is not None else {
            "sources_attempted": 0,
            "sources_succeeded": 0,
            "findings_submitted": sum(len(batch["findings"]) for batch in batch_payloads),
            "evidence_submitted": sum(len(batch["evidence"]) for batch in batch_payloads),
            "batches_submitted": len(batch_payloads),
        }
        errors_payload = list(errors) if errors is not None else [{
            "code": "producer_run_recovered_partial",
            "message": "run exported before terminal completion",
            "source_id": None,
            "retryable": True,
        }]
        complete_payload = validate_complete({
            "protocol_version": "0.1",
            "run_id": run_id,
            "idempotency_key": idempotency_key,
            "status": "partial",
            "completed_at": completed_at,
            "actual_scope": scope_payload,
            "stats": stats_payload,
            "errors": errors_payload,
            "metadata": dict(metadata) if metadata is not None else {},
        })
        return ProducerClient.build_run_bundle(run_id, begin_payload, batch_payloads, complete_payload)

    def run(self, begin: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> "ProducerRun":
        return ProducerRun(self, _payload(begin), idempotency_key=idempotency_key)

    beginRun = begin_run
    submitBatch = submit_batch
    completeRun = complete_run
    getRun = get_run
    getFindings = get_findings
    getRunFindings = get_findings
    buildRunBundle = build_run_bundle
    buildRecoveryBundle = build_recovery_bundle


class ProducerRun:
    """Convenience lifecycle object; no implicit completion is performed."""

    def __init__(self, client: ProducerClient, begin: Mapping[str, Any], *, idempotency_key: str | None = None) -> None:
        self.client = client
        self.begin_request = dict(begin)
        self.idempotency_key = idempotency_key
        self.begin_response: Any = None
        self.run_id: str | None = None
        self.batches: list[Mapping[str, Any]] = []
        self.complete_request: Mapping[str, Any] | None = None
        self.complete_response: Any = None

    def start(self) -> Any:
        if self.begin_response is None:
            begin_payload = _payload(self.begin_request)
            if self.idempotency_key is not None:
                if begin_payload.get("idempotency_key") not in (None, self.idempotency_key):
                    raise ValueError("idempotency_key does not match payload")
                begin_payload["idempotency_key"] = self.idempotency_key
            self.begin_request = validate_begin(begin_payload)
            self.begin_response = self.client.begin_run(self.begin_request)
            self.run_id = _find_run_id(self.begin_response)
        if self.run_id is None:
            raise ProtocolError("begin response did not contain run_id")
        return self.begin_response

    def submit_batch(self, request: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> Any:
        if self.run_id is None:
            self.start()
        if self.run_id is None:
            raise ProtocolError("begin response did not contain run_id")
        payload = _payload(request)
        if payload.get("run_id") not in (None, self.run_id):
            raise ValueError("path run_id and body run_id must match")
        payload["run_id"] = self.run_id
        if idempotency_key is not None:
            if payload.get("idempotency_key") not in (None, idempotency_key):
                raise ValueError("idempotency_key does not match payload")
            payload["idempotency_key"] = idempotency_key
        validated = validate_submit(payload)
        response = self.client.submit_batch(self.run_id, validated)
        # Keep only durably accepted, protocol-normalized batches. A failed
        # submission remains caller-owned recovery material and is not claimed
        # by this run object.
        self.batches.append(validated)
        return response

    def complete(self, request: Mapping[str, Any] | ProtocolModel, *, idempotency_key: str | None = None) -> Any:
        if self.run_id is None:
            self.start()
        if self.run_id is None:
            raise ProtocolError("begin response did not contain run_id")
        payload = _payload(request)
        if payload.get("run_id") not in (None, self.run_id):
            raise ValueError("path run_id and body run_id must match")
        payload["run_id"] = self.run_id
        if idempotency_key is not None:
            if payload.get("idempotency_key") not in (None, idempotency_key):
                raise ValueError("idempotency_key does not match payload")
            payload["idempotency_key"] = idempotency_key
        validated = validate_complete(payload)
        self.complete_response = self.client.complete_run(self.run_id, validated)
        self.complete_request = validated
        return self.complete_response

    def bundle(self) -> dict[str, Any]:
        if self.complete_request is None:
            raise ProtocolError("run is not complete; call recovery_bundle for an explicit partial export")
        if self.run_id is None:
            raise ProtocolError("run has no run_id")
        return self.client.build_run_bundle(self.begin_request, self.batches, self.complete_request, run_id=self.run_id)

    def recovery_bundle(
        self,
        *,
        idempotency_key: str,
        completed_at: str,
        actual_scope: Mapping[str, Any] | None = None,
        stats: Mapping[str, Any] | None = None,
        errors: list[Mapping[str, Any]] | tuple[Mapping[str, Any], ...] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Export begun progress as an explicit protocol ``partial`` bundle.

        This is local recovery material, not an implicit completion call. A
        run must have a durable ``run_id`` and must not already have a terminal
        completion; successful batches are included, while a failed in-flight
        batch is intentionally omitted.
        """
        if self.run_id is None:
            raise ProtocolError("run has not started; no recovery identity exists")
        if self.complete_request is not None:
            raise ProtocolError("run already has a terminal completion")
        return self.client.build_recovery_bundle(
            self.run_id,
            self.begin_request,
            self.batches,
            idempotency_key=idempotency_key,
            completed_at=completed_at,
            actual_scope=actual_scope,
            stats=stats,
            errors=errors,
            metadata=metadata,
        )

    partial_bundle = recovery_bundle

    def __enter__(self) -> "ProducerRun":
        self.start()
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        return None


@dataclass(frozen=True)
class ConsumerPaths:
    """Overrideable paths matching the documented delivery-api routes."""

    subscriptions: str = "/v1/consumers/subscriptions"
    subscription: str = "/v1/consumers/subscriptions/{subscription_id}"
    pull: str = "/v1/consumers/events"
    acknowledge: str = "/v1/consumers/events/{delivery_id}:ack"
    dead_letters: str = "/v1/consumers/dead-letters"
    replay: str = "/v1/consumers/dead-letters/{delivery_id}:replay"


class ConsumerClient(BaseClient):
    """Client matching the transport-neutral delivery-consumer API."""

    def __init__(self, base_url: str, *, token: str | None = None, credential: str | None = None, consumer_id: str | None = None, consumer_prefix: str | None = None, transport: Transport | Callable[..., Any] | None = None, timeout: float = 30.0, retry: RetryPolicy | None = None, headers: Mapping[str, str] | None = None, paths: ConsumerPaths | None = None) -> None:
        super().__init__(base_url, token=token if token is not None else credential, transport=transport, timeout=timeout, retry=retry, headers=headers)
        if consumer_prefix is not None:
            if not consumer_prefix or any(char in consumer_prefix for char in "?#") or re.match(r"^[a-z][a-z\d+.-]*:", consumer_prefix, re.I):
                raise ValueError("consumer_prefix is invalid")
            prefix = consumer_prefix.rstrip("/")
        else:
            prefix = "/v1/consumers"
            if consumer_id is not None:
                prefix += "/" + quote(_required_id(consumer_id, "consumer_id"), safe="")
        self.paths = paths or ConsumerPaths(
            subscriptions=f"{prefix}/subscriptions",
            subscription=f"{prefix}/subscriptions/{{subscription_id}}",
            pull=f"{prefix}/events",
            acknowledge=f"{prefix}/events/{{delivery_id}}:ack",
            dead_letters=f"{prefix}/dead-letters",
            replay=f"{prefix}/dead-letters/{{delivery_id}}:replay",
        )

    def create_subscription(self, request: Mapping[str, Any] | None = None, _options: Mapping[str, Any] | None = None, *, name: str | None = None, selectors: Mapping[str, Any] | None = None, delivery: Mapping[str, Any] | None = None) -> Any:
        body = _consumer_input(request, {"name": name, "selectors": selectors, "delivery": delivery})
        _validate_create_subscription(body)
        return _require_mapping_response(self._request("POST", self.paths.subscriptions, body=body, safe_to_retry=False, expected_status={201}), "consumer.create_subscription")

    def update_subscription(self, subscription_id: str | Mapping[str, Any], request: Mapping[str, Any] | None = None, *, expected_selector_version: int | None = None, name: str | None = None, selectors: Mapping[str, Any] | None = None, delivery: Mapping[str, Any] | None = None, status: str | None = None) -> Any:
        if isinstance(subscription_id, Mapping):
            if request is not None:
                raise ValueError("request cannot be supplied twice")
            request = dict(subscription_id)
            subscription_id = request.pop("subscriptionId", request.pop("subscription_id", None))
        if not isinstance(subscription_id, str):
            raise ValueError("subscription_id is required")
        _required_id(subscription_id, "subscription_id")
        body = _consumer_input(request, {"expectedSelectorVersion": expected_selector_version, "name": name, "selectors": selectors, "delivery": delivery, "status": status})
        _validate_update_subscription(body)
        return _require_mapping_response(self._request("PATCH", self.paths.subscription.format(subscription_id=quote(subscription_id, safe="")), body=body, safe_to_retry=False, expected_status={200}), "consumer.update_subscription")

    def list_subscriptions(self) -> Any:
        return _require_list_response(self._request("GET", self.paths.subscriptions, safe_to_retry=True, expected_status={200}), "consumer.list_subscriptions")

    def pull_page(self, subscription_id: str | Mapping[str, Any], options: Mapping[str, Any] | None = None, *, cursor: str | None = None, limit: int | None = None) -> Any:
        if options is not None:
            if not isinstance(options, Mapping):
                raise ValueError("pull options must be an object")
            if cursor is None:
                cursor = options.get("cursor")
            if limit is None:
                limit = options.get("limit")
        if isinstance(subscription_id, Mapping):
            value = dict(subscription_id)
            subscription_id = value.pop("subscriptionId", value.pop("subscription_id", None))
            if cursor is None:
                cursor = value.pop("cursor", None)
            if limit is None:
                limit = value.pop("limit", None)
            if value:
                raise ValueError(f"unknown pull fields: {sorted(value)}")
        if not isinstance(subscription_id, str):
            raise ValueError("subscription_id is required")
        _required_id(subscription_id, "subscription_id")
        query: dict[str, Any] = {"subscription_id": subscription_id}
        if cursor is not None:
            _required_id(cursor, "cursor")
            query["cursor"] = cursor
        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
                raise ValueError("limit must be a positive integer")
            query["limit"] = str(limit)
        path = self.paths.pull.format(subscription_id=quote(subscription_id, safe=""))
        return _require_pull_response(self._request("GET", _with_query(path, query), safe_to_retry=True, expected_status={200}), "consumer.pull_page")

    def acknowledge(self, subscription_id: str | Mapping[str, Any], request: Mapping[str, Any] | list[str] | None = None, options: Mapping[str, Any] | None = None, *, delivery_ids: list[str] | None = None, ack_through_cursor: str | None = None, idempotency_key: str | None = None) -> Any:
        if isinstance(request, list):
            delivery_ids = request
            request = options if options is not None else None
            options = None
        if options is not None:
            if not isinstance(options, Mapping):
                raise ValueError("acknowledge options must be an object")
            request = _consumer_input(request, options)
        if isinstance(subscription_id, Mapping):
            if request is not None:
                raise ValueError("request cannot be supplied twice")
            request = dict(subscription_id)
            subscription_id = request.pop("subscriptionId", request.pop("subscription_id", None))
        if not isinstance(subscription_id, str):
            raise ValueError("subscription_id is required")
        _required_id(subscription_id, "subscription_id")
        body = _consumer_input(request, {"deliveryIds": delivery_ids, "ackThroughCursor": ack_through_cursor, "idempotencyKey": idempotency_key})
        _validate_ack(body)
        first_delivery_id = body["deliveryIds"][0]
        path = self.paths.acknowledge.format(subscription_id=quote(subscription_id, safe=""), delivery_id=quote(first_delivery_id, safe=""))
        return _require_ack_response(self._request("POST", _with_query(path, {"subscription_id": subscription_id}), body=body, safe_to_retry=True, idempotency_key=body["idempotencyKey"], expected_status={200}), "consumer.acknowledge")

    def list_dead_letters(self, subscription_id: str | Mapping[str, Any], options: Mapping[str, Any] | None = None, *, limit: int | None = None) -> Any:
        if options is not None:
            if not isinstance(options, Mapping):
                raise ValueError("dead-letter options must be an object")
            if limit is None:
                limit = options.get("limit")
        if isinstance(subscription_id, Mapping):
            value = dict(subscription_id)
            subscription_id = value.pop("subscriptionId", value.pop("subscription_id", None))
            if limit is None:
                limit = value.pop("limit", None)
            if value:
                raise ValueError(f"unknown dead-letter fields: {sorted(value)}")
        if not isinstance(subscription_id, str):
            raise ValueError("subscription_id is required")
        _required_id(subscription_id, "subscription_id")
        query = {"subscription_id": subscription_id}
        if limit is not None:
            query["limit"] = _positive_query_limit(limit)
        path = self.paths.dead_letters.format(subscription_id=quote(subscription_id, safe=""))
        return _require_list_response(self._request("GET", _with_query(path, query), safe_to_retry=True, expected_status={200}), "consumer.list_dead_letters")

    def replay_dead_letter(self, subscription_id: str | Mapping[str, Any], delivery_id: str | None = None, request: Mapping[str, Any] | None = None, *, idempotency_key: str | None = None) -> Any:
        if isinstance(subscription_id, Mapping):
            if request is not None:
                raise ValueError("request cannot be supplied twice")
            request = dict(subscription_id)
            subscription_id = request.pop("subscriptionId", request.pop("subscription_id", None))
            delivery_id = request.pop("deliveryId", request.pop("delivery_id", delivery_id))
        if not isinstance(subscription_id, str):
            raise ValueError("subscription_id is required")
        _required_id(subscription_id, "subscription_id")
        _required_id(delivery_id, "delivery_id")
        body = _consumer_input(request, {"idempotencyKey": idempotency_key})
        if "idempotencyKey" not in body and "idempotency_key" in body:
            body["idempotencyKey"] = body.pop("idempotency_key")
        _validate_replay(body)
        path = self.paths.replay.format(subscription_id=quote(subscription_id, safe=""), delivery_id=quote(delivery_id, safe=""))
        return _require_replay_response(self._request("POST", _with_query(path, {"subscription_id": subscription_id}), body=body, safe_to_retry=True, idempotency_key=body["idempotencyKey"], expected_status={200}), "consumer.replay_dead_letter")

    createSubscription = create_subscription
    updateSubscription = update_subscription
    listSubscriptions = list_subscriptions
    pullPage = pull_page
    pull = pull_page
    acknowledgeDelivery = acknowledge
    acknowledge = acknowledge
    ack = acknowledge
    listDeadLetters = list_dead_letters
    replayDeadLetter = replay_dead_letter
    replay = replay_dead_letter


def _payload(value: Mapping[str, Any] | ProtocolModel) -> dict[str, Any]:
    if isinstance(value, ProtocolModel):
        return value.to_dict()
    if not isinstance(value, Mapping):
        raise TypeError("request must be a mapping or protocol model")
    return dict(value)


def _empty_scope() -> dict[str, Any]:
    return {"source_ids": [], "subjects": [], "queries": [], "metadata": {}}


def _required_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _find_run_id(value: Any) -> str | None:
    if isinstance(value, Mapping) and isinstance(value.get("run_id"), str):
        return value["run_id"]
    if isinstance(value, Mapping):
        for key in ("run", "result", "data"):
            nested = value.get(key)
            found = _find_run_id(nested)
            if found is not None:
                return found
    return None


def _require_run_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not isinstance(value.get("run_id"), str) or not value["run_id"]:
        raise ProtocolError(f"{operation} returned an invalid run response")
    return value


def _require_findings_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not isinstance(value.get("run_id"), str) or not isinstance(value.get("findings"), list):
        raise ProtocolError(f"{operation} returned an invalid findings response")
    return value


def _require_mapping_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{operation} returned an invalid object response")
    return value


def _require_list_response(value: Any, operation: str) -> list[Any]:
    if not isinstance(value, list):
        raise ProtocolError(f"{operation} returned an invalid array response")
    return value


def _require_pull_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not isinstance(value.get("items"), list) or not isinstance(value.get("nextCursor"), str) or not isinstance(value.get("hasMore"), bool) or (value.get("ackCursor") is not None and not isinstance(value.get("ackCursor"), str)):
        raise ProtocolError(f"{operation} returned an invalid pull response")
    return value


def _require_ack_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not isinstance(value.get("acknowledgementId"), str) or not isinstance(value.get("acknowledgedDeliveryIds"), list) or (value.get("ackCursor") is not None and not isinstance(value.get("ackCursor"), str)):
        raise ProtocolError(f"{operation} returned an invalid acknowledgement response")
    return value


def _require_replay_response(value: Any, operation: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not isinstance(value.get("replayId"), str) or not isinstance(value.get("delivery"), Mapping):
        raise ProtocolError(f"{operation} returned an invalid replay response")
    return value


def _response_body(value: Any) -> Any:
    if value is None or isinstance(value, (Mapping, list, int, float, bool)):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        import json
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _invoke_transport(transport: Any, method: str, url: str, *, headers: Mapping[str, str], body: Any, timeout: float) -> TransportResponse:
    function = transport.request if hasattr(transport, "request") else transport
    if not callable(function):
        raise TransportError("transport is not callable")
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        signature = None
    if signature is not None:
        parameter_names = set(signature.parameters)
        positional = [parameter for parameter in signature.parameters.values() if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}]
        has_varargs = any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in signature.parameters.values())
        keyword_url = "url" if "url" in parameter_names else "path" if "path" in parameter_names else None
        if "method" in parameter_names and keyword_url is not None and not positional:
            kwargs: dict[str, Any] = {"method": method, keyword_url: url, "headers": headers, "timeout": timeout}
            if "body" in signature.parameters or any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
                kwargs["body"] = body
            elif "json" in signature.parameters:
                kwargs["json"] = body
            elif "payload" in signature.parameters:
                kwargs["payload"] = body
            result = function(**kwargs)
            if inspect.isawaitable(result):
                raise TransportError("async transport requires a synchronous adapter")
            if isinstance(result, TransportResponse):
                return result
            if isinstance(result, tuple) and len(result) == 3:
                return TransportResponse(int(result[0]), result[1] or {}, result[2])
            if isinstance(result, Mapping) and ("status_code" in result or "status" in result):
                return TransportResponse(int(result.get("status_code", result.get("status"))), result.get("headers", {}), result.get("body"))
            return TransportResponse(200, {}, result)
        if len(positional) <= 1 and not has_varargs:
            result = function({"method": method, "url": url, "headers": headers, "body": body, "timeout": timeout})
            if inspect.isawaitable(result):
                raise TransportError("async transport requires a synchronous adapter")
            if isinstance(result, TransportResponse):
                return result
            if isinstance(result, tuple) and len(result) == 3:
                return TransportResponse(int(result[0]), result[1] or {}, result[2])
            if isinstance(result, Mapping) and ("status_code" in result or "status" in result):
                return TransportResponse(int(result.get("status_code", result.get("status"))), result.get("headers", {}), result.get("body"))
            return TransportResponse(200, {}, result)
    kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout}
    if signature is None or "body" in signature.parameters or any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        kwargs["body"] = body
    elif "json" in signature.parameters:
        kwargs["json"] = body
    elif "payload" in signature.parameters:
        kwargs["payload"] = body
    else:
        kwargs["body"] = body
    try:
        result = function(method, url, **kwargs)
    except TypeError:
        # Accommodate tiny positional fakes without broadening the public seam.
        result = function(method, url, headers, body, timeout)
    if inspect.isawaitable(result):
        raise TransportError("async transport requires a synchronous adapter")
    if isinstance(result, TransportResponse):
        return result
    if isinstance(result, tuple) and len(result) == 3:
        return TransportResponse(int(result[0]), result[1] or {}, result[2])
    if isinstance(result, Mapping) and ("status_code" in result or "status" in result):
        return TransportResponse(int(result.get("status_code", result.get("status"))), result.get("headers", {}), result.get("body"))
    return TransportResponse(200, {}, result)


def _retry_after(headers: Mapping[str, str]) -> float | None:
    value = next((str(v) for key, v in headers.items() if str(key).lower() == "retry-after"), None)
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _http_error(response: TransportResponse) -> HttpError:
    status = response.status_code
    headers = response.headers
    request_id = next((str(value) for key, value in headers.items() if str(key).lower() in {"x-request-id", "x-correlation-id"} and re.fullmatch(r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})", str(value), re.I)), None)
    body = _response_body(response.body)
    if status == 401:
        return AuthenticationError(status, "authentication failed", headers=headers, body=body, request_id=request_id)
    if status == 403:
        return AuthorizationError(status, "authorization failed", headers=headers, body=body, request_id=request_id)
    if status == 404:
        return NotFoundError(status, "resource not found", headers=headers, body=body, request_id=request_id)
    if status == 409:
        return ConflictError(status, "request conflicts with existing state", headers=headers, body=body, request_id=request_id)
    if status == 429:
        return RateLimitError(status, retry_after=_retry_after(headers), headers=headers, body=body, request_id=request_id)
    if status >= 500:
        return ServerError(status, "Agent Feed service unavailable", headers=headers, body=body, request_id=request_id)
    return HttpError(status, "Agent Feed request rejected", headers=headers, body=body, request_id=request_id)


def _with_query(path: str, query: Mapping[str, Any]) -> str:
    return path if not query else f"{path}?{urlencode(query)}"


def _consumer_input(request: Mapping[str, Any] | None, kwargs: Mapping[str, Any]) -> dict[str, Any]:
    aliases = {
        "expected_selector_version": "expectedSelectorVersion",
        "ack_through_cursor": "ackThroughCursor",
        "idempotency_key": "idempotencyKey",
        "delivery_ids": "deliveryIds",
        "finding_types": "findingTypes",
        "routing_tags": "routingTags",
        "event_types": "eventTypes",
        "stream_ids": "streamIds",
        "endpoint_ref": "endpointRef",
        "signing_key_id": "signingKeyId",
    }
    body: dict[str, Any] = {}
    for key, value in dict(request or {}).items():
        wire_key = aliases.get(key, key)
        if wire_key in body and body[wire_key] != value:
            raise ValueError(f"{wire_key} does not match request")
        body[wire_key] = value
    for key, value in kwargs.items():
        if value is not None:
            if key in body and body[key] != value:
                raise ValueError(f"{key} does not match request")
            body[key] = value
    return body


def _validate_create_subscription(body: Mapping[str, Any]) -> None:
    required = {"name", "selectors", "delivery"}
    if set(body) != required:
        raise ValueError("create subscription requires name, selectors, and delivery")
    _required_id(body["name"], "name")
    _validate_selectors(body["selectors"])
    _validate_delivery(body["delivery"])


def _validate_update_subscription(body: Mapping[str, Any]) -> None:
    if not body:
        raise ValueError("update subscription body must not be empty")
    if "expectedSelectorVersion" in body and (isinstance(body["expectedSelectorVersion"], bool) or not isinstance(body["expectedSelectorVersion"], int) or body["expectedSelectorVersion"] < 1):
        raise ValueError("expectedSelectorVersion must be a positive integer")
    if "name" in body:
        _required_id(body["name"], "name")
    if "selectors" in body:
        _validate_selectors(body["selectors"])
    if "delivery" in body:
        _validate_delivery(body["delivery"])
    if "status" in body and body["status"] not in {"active", "paused", "revoked"}:
        raise ValueError("status is invalid")


def _validate_selectors(value: Any) -> None:
    if not isinstance(value, Mapping) or not isinstance(value.get("streamIds"), list) or not value["streamIds"] or not all(isinstance(item, str) and item for item in value["streamIds"]):
        raise ValueError("selectors.streamIds must be a non-empty string array")
    for key in ("findingTypes", "eventTypes"):
        if key in value and (not isinstance(value[key], list) or not all(isinstance(item, str) and item for item in value[key])):
            raise ValueError(f"selectors.{key} must be a string array")
    tags = value.get("routingTags")
    if tags is not None and (not isinstance(tags, Mapping) or tags.get("mode") not in {"any", "all"} or not isinstance(tags.get("values"), list) or not tags["values"] or not all(isinstance(item, str) and item for item in tags["values"])):
        raise ValueError("selectors.routingTags is invalid")


def _validate_delivery(value: Any) -> None:
    if not isinstance(value, Mapping) or value.get("mode") not in {"pull", "webhook"}:
        raise ValueError("delivery.mode is invalid")
    if value["mode"] == "pull" and ("endpointRef" in value or "signingKeyId" in value):
        raise ValueError("pull delivery cannot have webhook configuration")
    if value["mode"] == "webhook" and (not isinstance(value.get("endpointRef"), str) or not value["endpointRef"] or not isinstance(value.get("signingKeyId"), str) or not value["signingKeyId"]):
        raise ValueError("webhook delivery requires endpointRef and signingKeyId")


def _validate_ack(body: Mapping[str, Any]) -> None:
    if set(body) - {"deliveryIds", "ackThroughCursor", "idempotencyKey"} or not isinstance(body.get("deliveryIds"), list) or not body["deliveryIds"] or not all(isinstance(item, str) and item for item in body["deliveryIds"]):
        raise ValueError("acknowledge requires non-empty deliveryIds")
    _required_id(body.get("idempotencyKey"), "idempotencyKey")
    if body.get("ackThroughCursor") is not None:
        _required_id(body["ackThroughCursor"], "ackThroughCursor")


def _validate_replay(body: Mapping[str, Any]) -> None:
    if set(body) != {"idempotencyKey"}:
        raise ValueError("replay requires idempotencyKey")
    _required_id(body.get("idempotencyKey"), "idempotencyKey")


def _positive_query_limit(limit: int) -> str:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("limit must be a positive integer")
    return str(limit)


AgentFeedProducerClient = ProducerClient
AgentFeedConsumerClient = ConsumerClient
AgentFeedClient = BaseClient


def create_run_bundle(run_id: str, begin: Mapping[str, Any] | ProtocolModel, batches: list[Mapping[str, Any] | ProtocolModel], complete: Mapping[str, Any] | ProtocolModel) -> dict[str, Any]:
    return ProducerClient.build_run_bundle(run_id, begin, batches, complete)


def create_recovery_bundle(
    run_id: str,
    begin: Mapping[str, Any] | ProtocolModel,
    batches: list[Mapping[str, Any] | ProtocolModel] | tuple[Mapping[str, Any] | ProtocolModel, ...],
    *,
    idempotency_key: str,
    completed_at: str,
    actual_scope: Mapping[str, Any] | None = None,
    stats: Mapping[str, Any] | None = None,
    errors: list[Mapping[str, Any]] | tuple[Mapping[str, Any], ...] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return ProducerClient.build_recovery_bundle(
        run_id,
        begin,
        batches,
        idempotency_key=idempotency_key,
        completed_at=completed_at,
        actual_scope=actual_scope,
        stats=stats,
        errors=errors,
        metadata=metadata,
    )


__all__ = ["AgentFeedClient", "AgentFeedConsumerClient", "AgentFeedProducerClient", "BaseClient", "ConsumerClient", "ConsumerPaths", "ProducerClient", "ProducerRun", "RetryPolicy", "create_recovery_bundle", "create_run_bundle"]
