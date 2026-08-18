"""Dependency-free runtime validation for Agent Feed protocol 0.1.

The nine JSON schemas under ``packages/schema/contracts`` are the source of
truth.  This compact installed-SDK validator mirrors their closed-object,
type, enum, format, length, and uniqueness rules without requiring a runtime
JSON Schema dependency.  It never accepts camelCase wire fields.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import datetime
import math
import re
from typing import Any, Callable
from urllib.parse import urlparse

from .errors import ValidationError

PROTOCOL_VERSION = "0.1"
_PRODUCER_TYPES = {"chatgpt", "claude", "codex", "custom_agent", "human", "automation"}
_TERMINAL = {"completed", "partial", "failed", "cancelled"}
_RUN_STATUSES = {"running", *_TERMINAL}
_EVIDENCE_KINDS = {"web", "document", "email", "api", "social_post", "database", "human_observation", "file", "other"}
_EVENT_TYPES = {"run.started", "finding.submitted", "run.completed", "run.partial", "run.failed"}
_LIVENESS = {"healthy", "due", "overdue", "degraded", "disabled", "never_seen"}
_NOVELTY = {"new", "known", "uncertain"}
_COMPLETENESS = {"complete", "partial", "lead_only"}
_AUTHORITY = {"primary", "official_secondary", "third_party", "unknown"}
_STREAM = re.compile(r"^[a-z0-9][a-z0-9._-]+$")
_FINDING_TYPE = re.compile(r"^[a-z0-9][a-z0-9._-]+$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")


def _fail(path: str, message: str, keyword: str | None = None) -> None:
    issue: dict[str, Any] = {"path": path, "message": message}
    if keyword is not None:
        issue["keyword"] = keyword
    raise ValidationError(f"{path} {message}", path=path, issues=(issue,))


def _obj(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        _fail(path, "must be an object", "type")
    result = dict(value)
    if any(not isinstance(key, str) for key in result):
        _fail(path, "object keys must be strings", "propertyNames")
    return result


def _closed(value: Any, path: str, keys: Sequence[str]) -> dict[str, Any]:
    result = _obj(value, path)
    expected = set(keys)
    for key in keys:
        if key not in result:
            _fail(f"{path}.{key}", "is required", "required")
    for key in result:
        if key not in expected:
            _fail(f"{path}.{key}", "is not allowed", "additionalProperties")
    return result


def _str(value: Any, path: str, *, minimum: int | None = None, maximum: int | None = None, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str):
        _fail(path, "must be a string", "type")
    if minimum is not None and len(value) < minimum:
        _fail(path, f"must contain at least {minimum} characters", "minLength")
    if maximum is not None and len(value) > maximum:
        _fail(path, f"must contain at most {maximum} characters", "maxLength")
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail(path, "has an invalid format", "pattern")
    return value


def _nullable_str(value: Any, path: str, *, minimum: int | None = None) -> str | None:
    return None if value is None else _str(value, path, minimum=minimum)


def _bool(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        _fail(path, "must be a boolean", "type")
    return value


def _int(value: Any, path: str, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(path, "must be an integer", "type")
    if minimum is not None and value < minimum:
        _fail(path, f"must be greater than or equal to {minimum}", "minimum")
    return value


def _num(value: Any, path: str, minimum: float | None = None, maximum: float | None = None) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(path, "must be a number", "type")
    if minimum is not None and value < minimum:
        _fail(path, f"must be greater than or equal to {minimum}", "minimum")
    if maximum is not None and value > maximum:
        _fail(path, f"must be less than or equal to {maximum}", "maximum")
    return value


def _array(value: Any, path: str, minimum: int | None = None, maximum: int | None = None) -> list[Any]:
    if not isinstance(value, list):
        _fail(path, "must be an array", "type")
    if minimum is not None and len(value) < minimum:
        _fail(path, f"must contain at least {minimum} items", "minItems")
    if maximum is not None and len(value) > maximum:
        _fail(path, f"must contain at most {maximum} items", "maxItems")
    return value


def _unique(values: Sequence[Any], path: str) -> None:
    try:
        duplicate = len(set(values)) != len(values)
    except TypeError:
        duplicate = len({repr(item) for item in values}) != len(values)
    if duplicate:
        _fail(path, "must not contain duplicates", "uniqueItems")


def _strings(value: Any, path: str, unique: bool = False) -> list[str]:
    values = _array(value, path)
    result = [_str(item, f"{path}[{index}]") for index, item in enumerate(values)]
    if unique:
        _unique(result, path)
    return result


def _json(value: Any, path: str = "$") -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return deepcopy(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail(path, "must be a finite JSON number", "type")
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, child in value.items():
            if not isinstance(key, str):
                _fail(path, "object keys must be strings", "propertyNames")
            result[key] = _json(child, f"{path}.{key}")
        return result
    if isinstance(value, list):
        return [_json(child, f"{path}[{index}]") for index, child in enumerate(value)]
    _fail(path, "must be JSON serializable", "type")
    raise AssertionError("unreachable")


def _metadata(value: Any, path: str) -> dict[str, Any]:
    _obj(value, path)
    return _json(value, path)


def _datetime(value: Any, path: str) -> str:
    text = _str(value, path)
    if _RFC3339.fullmatch(text) is None:
        _fail(path, "must be an RFC 3339 date-time", "format")
    candidate = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except (TypeError, ValueError):
        _fail(path, "must be an ISO date-time", "format")
    if parsed.tzinfo is None:
        _fail(path, "must include a timezone", "format")
    return text


def _uri(value: Any, path: str) -> str | None:
    text = _nullable_str(value, path)
    if text is None:
        return None
    parsed = urlparse(text)
    if not parsed.scheme or (parsed.scheme.lower() in {"http", "https"} and not parsed.netloc):
        _fail(path, "must be an absolute URI or null", "format")
    return text


def _scope(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("source_ids", "subjects", "queries", "metadata"))
    queries = _array(result["queries"], f"{path}.queries")
    return {
        "source_ids": _strings(result["source_ids"], f"{path}.source_ids", True),
        "subjects": _strings(result["subjects"], f"{path}.subjects", True),
        "queries": [_str(item, f"{path}.queries[{index}]") for index, item in enumerate(queries)],
        "metadata": _metadata(result["metadata"], f"{path}.metadata"),
    }


def _producer(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("producer_id", "type", "name", "version"))
    producer_type = _str(result["type"], f"{path}.type")
    if producer_type not in _PRODUCER_TYPES:
        _fail(f"{path}.type", "is not supported", "enum")
    return {
        "producer_id": _str(result["producer_id"], f"{path}.producer_id", minimum=1),
        "type": producer_type,
        "name": _str(result["name"], f"{path}.name", minimum=1),
        "version": _nullable_str(result["version"], f"{path}.version"),
    }


def _task(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("task_type", "definition_id", "definition_version"))
    return {
        "task_type": _str(result["task_type"], f"{path}.task_type", minimum=1),
        "definition_id": _nullable_str(result["definition_id"], f"{path}.definition_id"),
        "definition_version": _nullable_str(result["definition_version"], f"{path}.definition_version"),
    }


def _subject(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("type", "id", "name"))
    return {
        "type": _str(result["type"], f"{path}.type", minimum=1),
        "id": _nullable_str(result["id"], f"{path}.id"),
        "name": _nullable_str(result["name"], f"{path}.name"),
    }


def _effective(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("occurred_at", "effective_from", "effective_to"))
    return {key: None if result[key] is None else _datetime(result[key], f"{path}.{key}") for key in ("occurred_at", "effective_from", "effective_to")}


def _assessment(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("novelty", "source_authority_claim", "evidence_completeness", "agent_confidence"))
    novelty = _str(result["novelty"], f"{path}.novelty")
    authority = _str(result["source_authority_claim"], f"{path}.source_authority_claim")
    completeness = _str(result["evidence_completeness"], f"{path}.evidence_completeness")
    if novelty not in _NOVELTY:
        _fail(f"{path}.novelty", "is not supported", "enum")
    if authority not in _AUTHORITY:
        _fail(f"{path}.source_authority_claim", "is not supported", "enum")
    if completeness not in _COMPLETENESS:
        _fail(f"{path}.evidence_completeness", "is not supported", "enum")
    confidence = result["agent_confidence"]
    if confidence is not None:
        confidence = _num(confidence, f"{path}.agent_confidence", 0, 1)
    return {"novelty": novelty, "evidence_completeness": completeness, "agent_confidence": confidence, "source_authority_claim": authority}


def _finding(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("finding_id", "finding_type", "title", "summary", "subjects", "effective_time", "assessment", "evidence_refs", "producer_dedupe_key", "routing_tags", "attributes", "security_flags"))
    subjects = _array(result["subjects"], f"{path}.subjects", minimum=1)
    return {
        "finding_id": _str(result["finding_id"], f"{path}.finding_id", minimum=3),
        "finding_type": _str(result["finding_type"], f"{path}.finding_type", pattern=_FINDING_TYPE),
        "title": _str(result["title"], f"{path}.title", minimum=3, maximum=300),
        "summary": _str(result["summary"], f"{path}.summary", minimum=3, maximum=5000),
        "subjects": [_subject(item, f"{path}.subjects[{index}]") for index, item in enumerate(subjects)],
        "effective_time": _effective(result["effective_time"], f"{path}.effective_time"),
        "assessment": _assessment(result["assessment"], f"{path}.assessment"),
        "evidence_refs": _strings(result["evidence_refs"], f"{path}.evidence_refs", True),
        "producer_dedupe_key": _nullable_str(result["producer_dedupe_key"], f"{path}.producer_dedupe_key"),
        "routing_tags": _strings(result["routing_tags"], f"{path}.routing_tags", True),
        "attributes": _metadata(result["attributes"], f"{path}.attributes"),
        "security_flags": _strings(result["security_flags"], f"{path}.security_flags", True),
    }


def _source(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("uri", "title", "publisher", "source_id"))
    return {"uri": _uri(result["uri"], f"{path}.uri"), "title": _nullable_str(result["title"], f"{path}.title"), "publisher": _nullable_str(result["publisher"], f"{path}.publisher"), "source_id": _nullable_str(result["source_id"], f"{path}.source_id")}


def _locator(value: Any, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    result = _closed(value, path, ("type", "value", "page"))
    return {"type": _str(result["type"], f"{path}.type"), "value": _str(result["value"], f"{path}.value"), "page": None if result["page"] is None else _int(result["page"], f"{path}.page", 1)}


def _artifact(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("uri", "media_type", "size_bytes"))
    return {"uri": _uri(result["uri"], f"{path}.uri"), "media_type": _nullable_str(result["media_type"], f"{path}.media_type"), "size_bytes": None if result["size_bytes"] is None else _int(result["size_bytes"], f"{path}.size_bytes", 0)}


def _handling(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("contains_personal_data", "contains_secrets", "redistribution_restricted"))
    return {key: _bool(result[key], f"{path}.{key}") for key in ("contains_personal_data", "contains_secrets", "redistribution_restricted")}


def _evidence(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("evidence_id", "kind", "source", "captured_at", "published_at", "locator", "excerpt", "content_hash", "artifact", "handling", "metadata"))
    kind = _str(result["kind"], f"{path}.kind")
    if kind not in _EVIDENCE_KINDS:
        _fail(f"{path}.kind", "is not supported", "enum")
    excerpt = _nullable_str(result["excerpt"], f"{path}.excerpt")
    if excerpt is not None and len(excerpt) > 5000:
        _fail(f"{path}.excerpt", "is too long", "maxLength")
    content_hash = _nullable_str(result["content_hash"], f"{path}.content_hash")
    if content_hash is not None and _SHA256.fullmatch(content_hash) is None:
        _fail(f"{path}.content_hash", "must be a sha256 digest", "pattern")
    return {
        "evidence_id": _str(result["evidence_id"], f"{path}.evidence_id", minimum=3),
        "kind": kind,
        "source": _source(result["source"], f"{path}.source"),
        "captured_at": _datetime(result["captured_at"], f"{path}.captured_at"),
        "published_at": None if result["published_at"] is None else _datetime(result["published_at"], f"{path}.published_at"),
        "locator": _locator(result["locator"], f"{path}.locator"),
        "excerpt": excerpt,
        "content_hash": content_hash,
        "artifact": _artifact(result["artifact"], f"{path}.artifact"),
        "handling": _handling(result["handling"], f"{path}.handling"),
        "metadata": _metadata(result["metadata"], f"{path}.metadata"),
    }


def _stats(value: Any, path: str) -> dict[str, int]:
    result = _closed(value, path, ("sources_attempted", "sources_succeeded", "findings_submitted", "evidence_submitted", "batches_submitted"))
    return {key: _int(result[key], f"{path}.{key}", 0) for key in ("sources_attempted", "sources_succeeded", "findings_submitted", "evidence_submitted", "batches_submitted")}


def _error(value: Any, path: str) -> dict[str, Any]:
    result = _closed(value, path, ("code", "message", "source_id", "retryable"))
    return {"code": _str(result["code"], f"{path}.code"), "message": _str(result["message"], f"{path}.message"), "source_id": _nullable_str(result["source_id"], f"{path}.source_id"), "retryable": _bool(result["retryable"], f"{path}.retryable")}


def validate_begin(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "idempotency_key", "stream_id", "producer", "task", "expected_scope", "started_at", "parent_run_id", "metadata"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    return {"protocol_version": PROTOCOL_VERSION, "idempotency_key": _str(result["idempotency_key"], "$.idempotency_key", minimum=8), "stream_id": _str(result["stream_id"], "$.stream_id", pattern=_STREAM), "producer": _producer(result["producer"], "$.producer"), "task": _task(result["task"], "$.task"), "expected_scope": _scope(result["expected_scope"], "$.expected_scope"), "started_at": _datetime(result["started_at"], "$.started_at"), "parent_run_id": _nullable_str(result["parent_run_id"], "$.parent_run_id"), "metadata": _metadata(result["metadata"], "$.metadata")}


def validate_complete(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "run_id", "idempotency_key", "status", "completed_at", "actual_scope", "stats", "errors", "metadata"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    status = _str(result["status"], "$.status")
    if status not in _TERMINAL:
        _fail("$.status", "must be terminal", "enum")
    errors = _array(result["errors"], "$.errors")
    return {"protocol_version": PROTOCOL_VERSION, "run_id": _str(result["run_id"], "$.run_id", minimum=8), "idempotency_key": _str(result["idempotency_key"], "$.idempotency_key", minimum=8), "status": status, "completed_at": _datetime(result["completed_at"], "$.completed_at"), "actual_scope": _scope(result["actual_scope"], "$.actual_scope"), "stats": _stats(result["stats"], "$.stats"), "errors": [_error(item, f"$.errors[{index}]") for index, item in enumerate(errors)], "metadata": _metadata(result["metadata"], "$.metadata")}


def validate_delivery_event(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "event_id", "event_type", "stream_id", "run_id", "finding_id", "occurred_at", "attempt", "payload"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    event_type = _str(result["event_type"], "$.event_type")
    if event_type not in _EVENT_TYPES:
        _fail("$.event_type", "is not supported", "enum")
    return {"protocol_version": PROTOCOL_VERSION, "event_id": _str(result["event_id"], "$.event_id", minimum=8), "event_type": event_type, "stream_id": _str(result["stream_id"], "$.stream_id"), "run_id": _str(result["run_id"], "$.run_id"), "finding_id": _nullable_str(result["finding_id"], "$.finding_id"), "occurred_at": _datetime(result["occurred_at"], "$.occurred_at"), "attempt": _int(result["attempt"], "$.attempt", 1), "payload": _metadata(result["payload"], "$.payload")}


def validate_evidence(value: Any) -> dict[str, Any]:
    return _evidence(value, "$")


def validate_finding(value: Any) -> dict[str, Any]:
    return _finding(value, "$")


def validate_submit(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "run_id", "batch_id", "idempotency_key", "sequence_number", "submitted_at", "findings", "evidence", "metadata"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    findings = _array(result["findings"], "$.findings", maximum=100)
    evidence = _array(result["evidence"], "$.evidence", maximum=500)
    if not findings and not evidence:
        _fail("$", "findings or evidence is required", "anyOf")
    return {"protocol_version": PROTOCOL_VERSION, "run_id": _str(result["run_id"], "$.run_id", minimum=8), "batch_id": _str(result["batch_id"], "$.batch_id", minimum=3), "idempotency_key": _str(result["idempotency_key"], "$.idempotency_key", minimum=8), "sequence_number": _int(result["sequence_number"], "$.sequence_number", 1), "submitted_at": _datetime(result["submitted_at"], "$.submitted_at"), "findings": [_finding(item, f"$.findings[{index}]") for index, item in enumerate(findings)], "evidence": [_evidence(item, f"$.evidence[{index}]") for index, item in enumerate(evidence)], "metadata": _metadata(result["metadata"], "$.metadata")}


def validate_run_bundle(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "run_id", "begin", "batches", "complete"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    batches = _array(result["batches"], "$.batches")
    return {"protocol_version": PROTOCOL_VERSION, "run_id": _str(result["run_id"], "$.run_id", minimum=8), "begin": validate_begin(result["begin"]), "batches": [validate_submit(item) for item in batches], "complete": validate_complete(result["complete"])}


def validate_run_envelope(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("protocol_version", "run_id", "stream_id", "producer", "task", "started_at", "completed_at", "status", "expected_scope", "actual_scope", "stats", "parent_run_id", "error_summary", "metadata"))
    if result["protocol_version"] != PROTOCOL_VERSION:
        _fail("$.protocol_version", "must equal 0.1", "const")
    status = _str(result["status"], "$.status")
    if status not in _RUN_STATUSES:
        _fail("$.status", "is not supported", "enum")
    return {"protocol_version": PROTOCOL_VERSION, "run_id": _str(result["run_id"], "$.run_id", minimum=8), "stream_id": _str(result["stream_id"], "$.stream_id", pattern=_STREAM), "producer": _producer(result["producer"], "$.producer"), "task": _task(result["task"], "$.task"), "started_at": _datetime(result["started_at"], "$.started_at"), "completed_at": None if result["completed_at"] is None else _datetime(result["completed_at"], "$.completed_at"), "status": status, "expected_scope": _scope(result["expected_scope"], "$.expected_scope"), "actual_scope": None if result["actual_scope"] is None else _scope(result["actual_scope"], "$.actual_scope"), "stats": _stats(result["stats"], "$.stats"), "parent_run_id": _nullable_str(result["parent_run_id"], "$.parent_run_id"), "error_summary": _nullable_str(result["error_summary"], "$.error_summary"), "metadata": _metadata(result["metadata"], "$.metadata")}


def validate_stream_expectation(value: Any) -> dict[str, Any]:
    result = _closed(value, "$", ("stream_id", "expected_cadence_seconds", "grace_seconds", "enabled", "expected_scope", "last_terminal_run_at", "next_due_at", "evaluated_at", "liveness_status", "owner", "notes"))
    status = _str(result["liveness_status"], "$.liveness_status")
    if status not in _LIVENESS:
        _fail("$.liveness_status", "is not supported", "enum")
    scope = _closed(result["expected_scope"], "$.expected_scope", ("source_ids", "subjects"))
    return {"stream_id": _str(result["stream_id"], "$.stream_id", pattern=_STREAM), "expected_cadence_seconds": _int(result["expected_cadence_seconds"], "$.expected_cadence_seconds", 3600), "grace_seconds": _int(result["grace_seconds"], "$.grace_seconds", 0), "enabled": _bool(result["enabled"], "$.enabled"), "expected_scope": {"source_ids": _strings(scope["source_ids"], "$.expected_scope.source_ids", True), "subjects": _strings(scope["subjects"], "$.expected_scope.subjects", True)}, "last_terminal_run_at": None if result["last_terminal_run_at"] is None else _datetime(result["last_terminal_run_at"], "$.last_terminal_run_at"), "next_due_at": None if result["next_due_at"] is None else _datetime(result["next_due_at"], "$.next_due_at"), "evaluated_at": _datetime(result["evaluated_at"], "$.evaluated_at"), "liveness_status": status, "owner": _str(result["owner"], "$.owner", minimum=1), "notes": _str(result["notes"], "$.notes")}


_VALIDATORS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "begin": validate_begin, "begin_run": validate_begin, "begin-run": validate_begin,
    "complete": validate_complete, "complete_run": validate_complete, "complete-run": validate_complete,
    "delivery_event": validate_delivery_event, "delivery-event": validate_delivery_event,
    "evidence": validate_evidence, "finding": validate_finding,
    "run_bundle": validate_run_bundle, "run-bundle": validate_run_bundle,
    "run_envelope": validate_run_envelope, "run-envelope": validate_run_envelope,
    "stream_expectation": validate_stream_expectation, "stream-expectation": validate_stream_expectation,
    "submit": validate_submit, "submit_batch": validate_submit, "submit-batch": validate_submit,
}

# Descriptive aliases for callers that prefer schema-root terminology.
validate_begin_run = validate_begin
validate_complete_run = validate_complete
validate_submit_batch = validate_submit


def validate(value: Any, schema: str) -> dict[str, Any]:
    """Validate a protocol value by root name and return a detached copy."""
    try:
        validator = _VALIDATORS[schema]
    except KeyError as exc:
        raise ValueError(f"unknown protocol schema: {schema}") from exc
    return deepcopy(validator(value))


__all__ = ["PROTOCOL_VERSION", "validate", "validate_begin", "validate_begin_run", "validate_complete", "validate_complete_run", "validate_delivery_event", "validate_evidence", "validate_finding", "validate_run_bundle", "validate_run_envelope", "validate_stream_expectation", "validate_submit", "validate_submit_batch"]
