from __future__ import annotations

import unittest

from agent_feed import (
    BeginRunRequest,
    ConflictError,
    ConsumerClient,
    ProducerClient,
    RetryExhaustedError,
    RetryPolicy,
    ProtocolError,
    ServerError,
    TransportResponse,
    ValidationError,
)
from agent_feed import validate_run_bundle


BEGIN = {
    "protocol_version": "0.1",
    "idempotency_key": "begin-key-1",
    "stream_id": "monitor.stream",
    "producer": {"producer_id": "producer-1", "type": "automation", "name": "test", "version": "1"},
    "task": {"task_type": "monitor", "definition_id": None, "definition_version": None},
    "expected_scope": {"source_ids": ["source-1"], "subjects": ["subject-1"], "queries": [], "metadata": {}},
    "started_at": "2026-08-18T00:00:00Z",
    "parent_run_id": None,
    "metadata": {},
}

BATCH = {
    "protocol_version": "0.1",
    "run_id": "run_12345678",
    "batch_id": "batch-001",
    "idempotency_key": "batch-key-1",
    "sequence_number": 1,
    "submitted_at": "2026-08-18T00:00:00Z",
    "findings": [],
    "evidence": [{
        "evidence_id": "evidence-001",
        "kind": "web",
        "source": {"uri": "https://example.com", "title": "Example", "publisher": None, "source_id": None},
        "captured_at": "2026-08-18T00:00:00Z",
        "published_at": None,
        "locator": None,
        "excerpt": None,
        "content_hash": None,
        "artifact": {"uri": None, "media_type": None, "size_bytes": None},
        "handling": {"contains_personal_data": False, "contains_secrets": False, "redistribution_restricted": False},
        "metadata": {},
    }],
    "metadata": {},
}

COMPLETE = {
    "protocol_version": "0.1",
    "run_id": "run_12345678",
    "idempotency_key": "complete-key-1",
    "status": "completed",
    "completed_at": "2026-08-18T01:00:00Z",
    "actual_scope": {"source_ids": [], "subjects": [], "queries": [], "metadata": {}},
    "stats": {"sources_attempted": 0, "sources_succeeded": 0, "findings_submitted": 0, "evidence_submitted": 1, "batches_submitted": 1},
    "errors": [],
    "metadata": {},
}


class FakeTransport:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, str, dict[str, str], object, float]] = []

    def request(self, method: str, path: str, *, headers: dict[str, str], body: object, timeout: float) -> TransportResponse:
        self.calls.append((method, path, headers, body, timeout))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response  # type: ignore[return-value]


class SdkTests(unittest.TestCase):
    def test_models_are_strict_and_mapping_compatible(self) -> None:
        model = BeginRunRequest.from_dict(BEGIN)
        self.assertEqual(model["stream_id"], "monitor.stream")
        self.assertEqual(model.to_dict(), BEGIN)
        with self.assertRaises(KeyError):
            _ = model["unknown"]
        with self.assertRaises(ValidationError):
            BeginRunRequest.from_dict({**BEGIN, "streamId": "wrong"})
        with self.assertRaises(ValidationError):
            BeginRunRequest.from_dict({**BEGIN, "started_at": "2026-08-18 00:00:00Z"})

    def test_idempotent_producer_retry_is_bounded(self) -> None:
        transport = FakeTransport([
            TransportResponse(503, {}, {"error": "unavailable"}),
            TransportResponse(503, {}, {"error": "unavailable"}),
            TransportResponse(201, {}, {"run_id": "run_12345678"}),
        ])
        client = ProducerClient("https://feed.invalid", token="secret-token", transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))
        result = client.begin_run(BEGIN)
        self.assertEqual(result["run_id"], "run_12345678")
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(transport.calls[0][0:2], ("POST", "https://feed.invalid/v1/runs:begin"))
        self.assertEqual(transport.calls[0][2]["Idempotency-Key"], "begin-key-1")

    def test_producer_run_records_only_successful_batches_and_exports_recovery(self) -> None:
        transport = FakeTransport([
            TransportResponse(201, {}, {"run_id": "run_12345678"}),
            TransportResponse(503, {}, {"error": "temporary_failure"}),
            TransportResponse(202, {}, {"run_id": "run_12345678"}),
        ])
        client = ProducerClient("https://feed.invalid", transport=transport, retry=RetryPolicy(max_attempts=1))
        run = client.run(BEGIN)
        with self.assertRaises(ServerError):
            run.submit_batch(BATCH)
        self.assertEqual(run.batches, [])

        run.submit_batch(BATCH)
        self.assertEqual(len(run.batches), 1)
        self.assertEqual(run.batches[0]["run_id"], "run_12345678")
        with self.assertRaises(ProtocolError):
            run.bundle()
        with self.assertRaises(TypeError):
            run.recovery_bundle(idempotency_key="recovery-key-1")  # type: ignore[call-arg]

        recovery = run.recovery_bundle(idempotency_key="recovery-key-1", completed_at="2026-08-18T01:00:00Z")
        self.assertEqual(validate_run_bundle(recovery)["complete"]["status"], "partial")
        self.assertEqual(recovery["complete"]["stats"]["batches_submitted"], 1)
        self.assertEqual(recovery["complete"]["stats"]["evidence_submitted"], 1)

    def test_producer_run_does_not_record_failed_completion_and_recovery_is_explicit(self) -> None:
        transport = FakeTransport([
            TransportResponse(201, {}, {"run_id": "run_12345678"}),
            TransportResponse(202, {}, {"run_id": "run_12345678"}),
            TransportResponse(503, {}, {"error": "temporary_failure"}),
        ])
        client = ProducerClient("https://feed.invalid", transport=transport, retry=RetryPolicy(max_attempts=1))
        run = client.run(BEGIN)
        run.submit_batch(BATCH)
        with self.assertRaises(ServerError):
            run.complete(COMPLETE)
        self.assertIsNone(run.complete_request)
        recovery = run.partial_bundle(idempotency_key="recovery-key-2", completed_at="2026-08-18T01:00:00Z")
        self.assertEqual(recovery["complete"]["status"], "partial")

    def test_retry_exhaustion_does_not_retry_create_subscription(self) -> None:
        transport = FakeTransport([TransportResponse(503, {}, {"error": "unavailable"})])
        client = ConsumerClient("https://feed.invalid", consumer_id="consumer/a", transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))
        with self.assertRaises(Exception) as raised:
            client.create_subscription({"name": "feed", "selectors": {"streamIds": ["monitor.stream"]}, "delivery": {"mode": "pull"}})
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIsInstance(raised.exception, RetryExhaustedError)

    def test_transport_timeout_is_typed_and_does_not_retain_raw_secret(self) -> None:
        class TimeoutTransport:
            def request(self, method: str, path: str, *, headers: dict[str, str], body: object, timeout: float) -> TransportResponse:
                raise TimeoutError("Authorization Bearer private-secret")

        from agent_feed import TimeoutError as SdkTimeoutError
        client = ProducerClient("https://feed.invalid", transport=TimeoutTransport(), retry=RetryPolicy(max_attempts=1))
        with self.assertRaises(SdkTimeoutError) as raised:
            client.get_run("run_12345678")
        self.assertNotIn("private-secret", str(raised.exception))
        self.assertIsNone(raised.exception.cause)

    def test_keyword_only_transport_is_supported(self) -> None:
        calls: list[tuple[str, str]] = []

        def request(*, method: str, url: str, headers: object, body: object, timeout: float) -> TransportResponse:
            del headers, body, timeout
            calls.append((method, url))
            return TransportResponse(200, {}, {"run_id": "run_12345678"})

        client = ProducerClient("https://feed.invalid", transport=request)
        self.assertEqual(client.get_run("run_12345678")["run_id"], "run_12345678")
        self.assertEqual(calls, [("GET", "https://feed.invalid/v1/runs/run_12345678")])

    def test_acknowledgement_retries_and_maps_conflict(self) -> None:
        transport = FakeTransport([
            TransportResponse(503, {}, None),
            TransportResponse(200, {}, {"acknowledgementId": "ack-1", "acknowledgedDeliveryIds": ["delivery-1"], "ackCursor": None}),
        ])
        client = ConsumerClient("https://feed.invalid", consumer_id="consumer/a", transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))
        result = client.acknowledge({"subscriptionId": "subscription-1", "deliveryIds": ["delivery-1"], "idempotencyKey": "ack-key-1"})
        self.assertEqual(result["acknowledgementId"], "ack-1")
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(transport.calls[0][2]["Idempotency-Key"], "ack-key-1")

        conflict_transport = FakeTransport([TransportResponse(409, {}, {"error": "idempotency_payload_conflict", "token": "secret-token", "excerpt": "private evidence excerpt"})])
        conflict_client = ConsumerClient("https://feed.invalid", transport=conflict_transport)
        with self.assertRaises(ConflictError) as conflict:
            conflict_client.acknowledge({"subscriptionId": "subscription-1", "deliveryIds": ["delivery-1"], "idempotencyKey": "ack-key-1"})
        self.assertNotIn("secret-token", str(conflict.exception))
        self.assertNotIn("secret-token", repr(conflict.exception.details))
        self.assertNotIn("private evidence excerpt", repr(conflict.exception.details))

    def test_consumer_surface_matches_existing_camel_case_api(self) -> None:
        transport = FakeTransport([
            TransportResponse(200, {}, {"items": [], "nextCursor": "cursor-1", "ackCursor": None, "hasMore": False}),
            TransportResponse(200, {}, []),
            TransportResponse(200, {}, {"replayId": "replay-1", "delivery": {"deliveryId": "delivery-1"}}),
        ])
        client = ConsumerClient("https://feed.invalid", consumer_id="consumer/a", transport=transport, retry=RetryPolicy(sleep=lambda _delay: None))
        page = client.pullPage({"subscriptionId": "subscription-1", "limit": 10})
        self.assertFalse(page["hasMore"])
        client.listDeadLetters({"subscriptionId": "subscription-1", "limit": 5})
        client.replayDeadLetter({"subscriptionId": "subscription-1", "deliveryId": "delivery-1", "idempotencyKey": "replay-key-1"})
        self.assertIn("/v1/consumers/consumer%2Fa/events?subscription_id=subscription-1&limit=10", transport.calls[0][1])
        self.assertIn("/v1/consumers/consumer%2Fa/dead-letters?subscription_id=subscription-1&limit=5", transport.calls[1][1])
        self.assertIn("/v1/consumers/consumer%2Fa/dead-letters/delivery-1:replay?subscription_id=subscription-1", transport.calls[2][1])


if __name__ == "__main__":
    unittest.main()
