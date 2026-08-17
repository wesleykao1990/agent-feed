"""Generated Agent Feed protocol types; do not edit."""

# Source of truth: packages/schema/contracts/*.schema.json
# Generator: scripts/generate_protocol_types.py
# Wire property names are intentionally preserved as snake_case.

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

PROTOCOL_VERSION = "0.1"
ProtocolVersion = Literal["0.1"]

class BeginRunRequest(TypedDict):
    protocol_version: Literal["0.1"]
    idempotency_key: str
    stream_id: str
    producer: BeginRunRequestProducer
    task: BeginRunRequestTask
    expected_scope: BeginRunRequestExpectedScope
    started_at: str
    parent_run_id: str | None
    metadata: dict[str, Any]

class CompleteRunRequest(TypedDict):
    protocol_version: Literal["0.1"]
    run_id: str
    idempotency_key: str
    status: Literal["completed"] | Literal["partial"] | Literal["failed"] | Literal["cancelled"]
    completed_at: str
    actual_scope: CompleteRunRequestActualScope
    stats: CompleteRunRequestStats
    errors: list[CompleteRunRequestErrorsItem]
    metadata: dict[str, Any]

class DeliveryEvent(TypedDict):
    protocol_version: Literal["0.1"]
    event_id: str
    event_type: Literal["run.started"] | Literal["finding.submitted"] | Literal["run.completed"] | Literal["run.partial"] | Literal["run.failed"]
    stream_id: str
    run_id: str
    finding_id: str | None
    occurred_at: str
    attempt: int
    payload: dict[str, Any]

class SubmittedEvidence(TypedDict):
    evidence_id: str
    kind: Literal["web"] | Literal["document"] | Literal["email"] | Literal["api"] | Literal["social_post"] | Literal["database"] | Literal["human_observation"] | Literal["file"] | Literal["other"]
    source: SubmittedEvidenceSource
    captured_at: str
    published_at: str | None
    locator: SubmittedEvidenceLocator | None
    excerpt: str | None
    content_hash: str | None
    artifact: SubmittedEvidenceArtifact
    handling: SubmittedEvidenceHandling
    metadata: dict[str, Any]

class Finding(TypedDict):
    finding_id: str
    finding_type: str
    title: str
    summary: str
    subjects: list[FindingSubjectsItem]
    effective_time: FindingEffectiveTime
    assessment: FindingAssessment
    evidence_refs: list[str]
    producer_dedupe_key: str | None
    routing_tags: list[str]
    attributes: dict[str, Any]
    security_flags: list[str]

class RunBundle(TypedDict):
    protocol_version: Literal["0.1"]
    begin: BeginRunRequest
    batches: list[SubmitBatchRequest]
    complete: CompleteRunRequest
    run_id: str

class RunEnvelope(TypedDict):
    protocol_version: Literal["0.1"]
    run_id: str
    stream_id: str
    producer: RunEnvelopeProducer
    task: RunEnvelopeTask
    started_at: str
    completed_at: str | None
    status: Literal["running"] | Literal["completed"] | Literal["partial"] | Literal["failed"] | Literal["cancelled"]
    expected_scope: RunEnvelopeScope
    actual_scope: RunEnvelopeScope | None
    stats: RunEnvelopeStats
    parent_run_id: str | None
    error_summary: str | None
    metadata: dict[str, Any]

class StreamExpectation(TypedDict):
    stream_id: str
    expected_cadence_seconds: int
    grace_seconds: int
    enabled: bool
    expected_scope: StreamExpectationExpectedScope
    last_terminal_run_at: str | None
    next_due_at: str | None
    evaluated_at: str
    liveness_status: Literal["healthy"] | Literal["due"] | Literal["overdue"] | Literal["degraded"] | Literal["disabled"] | Literal["never_seen"]
    owner: str
    notes: str

class SubmitBatchRequest(TypedDict):
    protocol_version: Literal["0.1"]
    run_id: str
    batch_id: str
    idempotency_key: str
    sequence_number: int
    submitted_at: str
    findings: list[Finding]
    evidence: list[SubmittedEvidence]
    metadata: dict[str, Any]

class BeginRunRequestProducer(TypedDict):
    producer_id: str
    type: Literal["chatgpt"] | Literal["claude"] | Literal["codex"] | Literal["custom_agent"] | Literal["human"] | Literal["automation"]
    name: str
    version: str | None

class BeginRunRequestTask(TypedDict):
    task_type: str
    definition_id: str | None
    definition_version: str | None

class BeginRunRequestExpectedScope(TypedDict):
    source_ids: list[str]
    subjects: list[str]
    queries: list[str]
    metadata: dict[str, Any]

class CompleteRunRequestActualScope(TypedDict):
    source_ids: list[str]
    subjects: list[str]
    queries: list[str]
    metadata: dict[str, Any]

class CompleteRunRequestStats(TypedDict):
    sources_attempted: int
    sources_succeeded: int
    findings_submitted: int
    evidence_submitted: int
    batches_submitted: int

class CompleteRunRequestErrorsItem(TypedDict):
    code: str
    message: str
    source_id: str | None
    retryable: bool

class SubmittedEvidenceSource(TypedDict):
    uri: str | None
    title: str | None
    publisher: str | None
    source_id: str | None

class SubmittedEvidenceLocator(TypedDict):
    type: str
    value: str
    page: int | None

class SubmittedEvidenceArtifact(TypedDict):
    uri: str | None
    media_type: str | None
    size_bytes: int | None

class SubmittedEvidenceHandling(TypedDict):
    contains_personal_data: bool
    contains_secrets: bool
    redistribution_restricted: bool

class FindingSubjectsItem(TypedDict):
    type: str
    id: str | None
    name: str | None

class FindingEffectiveTime(TypedDict):
    occurred_at: str | None
    effective_from: str | None
    effective_to: str | None

class FindingAssessment(TypedDict):
    novelty: Literal["new"] | Literal["known"] | Literal["uncertain"]
    evidence_completeness: Literal["complete"] | Literal["partial"] | Literal["lead_only"]
    agent_confidence: float | None
    source_authority_claim: Literal["primary"] | Literal["official_secondary"] | Literal["third_party"] | Literal["unknown"]

class RunEnvelopeScope(TypedDict):
    source_ids: list[str]
    subjects: list[str]
    queries: list[str]
    metadata: dict[str, Any]

class RunEnvelopeProducer(TypedDict):
    producer_id: str
    type: Literal["chatgpt"] | Literal["claude"] | Literal["codex"] | Literal["custom_agent"] | Literal["human"] | Literal["automation"]
    name: str
    version: str | None

class RunEnvelopeTask(TypedDict):
    task_type: str
    definition_id: str | None
    definition_version: str | None

class RunEnvelopeStats(TypedDict):
    sources_attempted: int
    sources_succeeded: int
    findings_submitted: int
    evidence_submitted: int
    batches_submitted: int

class StreamExpectationExpectedScope(TypedDict):
    source_ids: list[str]
    subjects: list[str]

BeginRun = BeginRunRequest
CompleteRun = CompleteRunRequest
AgentFeedDeliveryEvent = DeliveryEvent
Evidence = SubmittedEvidence
SubmitBatch = SubmitBatchRequest

__all__ = [
    "PROTOCOL_VERSION",
    "ProtocolVersion",
    "BeginRunRequest",
    "CompleteRunRequest",
    "DeliveryEvent",
    "SubmittedEvidence",
    "Finding",
    "RunBundle",
    "RunEnvelope",
    "StreamExpectation",
    "SubmitBatchRequest",
    "BeginRunRequestProducer",
    "BeginRunRequestTask",
    "BeginRunRequestExpectedScope",
    "CompleteRunRequestActualScope",
    "CompleteRunRequestStats",
    "CompleteRunRequestErrorsItem",
    "SubmittedEvidenceSource",
    "SubmittedEvidenceLocator",
    "SubmittedEvidenceArtifact",
    "SubmittedEvidenceHandling",
    "FindingSubjectsItem",
    "FindingEffectiveTime",
    "FindingAssessment",
    "RunEnvelopeScope",
    "RunEnvelopeProducer",
    "RunEnvelopeTask",
    "RunEnvelopeStats",
    "StreamExpectationExpectedScope",
    "BeginRun",
    "CompleteRun",
    "AgentFeedDeliveryEvent",
    "Evidence",
    "SubmitBatch",
]
