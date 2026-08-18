"""Optional immutable, mapping-compatible protocol 0.1 models."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass, fields
from typing import Any, ClassVar, TypeVar

from .validation import (
    validate_begin, validate_complete, validate_delivery_event, validate_evidence,
    validate_finding, validate_run_bundle, validate_run_envelope,
    validate_stream_expectation, validate_submit,
)

_T = TypeVar("_T", bound="ProtocolModel")


class ProtocolModel(Mapping[str, Any]):
    """Validated dataclass that can be sent as either a model or mapping."""

    _validator: ClassVar[Any]

    def _raw_dict(self) -> dict[str, Any]:
        return {item.name: getattr(self, item.name) for item in fields(self)}

    def to_dict(self) -> dict[str, Any]:
        return deepcopy(self._raw_dict())

    model_dump = to_dict
    dict = to_dict

    def __getitem__(self, key: str) -> Any:
        if not isinstance(key, str) or key not in {item.name for item in fields(self)}:
            raise KeyError(key)
        return getattr(self, key)

    def __iter__(self) -> Iterator[str]:
        return (item.name for item in fields(self))

    def __len__(self) -> int:
        return len(fields(self))

    @classmethod
    def from_dict(cls: type[_T], value: Mapping[str, Any] | _T) -> _T:
        if isinstance(value, cls):
            return value
        return cls(**cls._validator(value))


@dataclass(frozen=True)
class BeginRunRequest(ProtocolModel):
    protocol_version: str
    idempotency_key: str
    stream_id: str
    producer: Mapping[str, Any]
    task: Mapping[str, Any]
    expected_scope: Mapping[str, Any]
    started_at: str
    parent_run_id: str | None
    metadata: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_begin)

    def __post_init__(self) -> None:
        for key, value in validate_begin(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class CompleteRunRequest(ProtocolModel):
    protocol_version: str
    run_id: str
    idempotency_key: str
    status: str
    completed_at: str
    actual_scope: Mapping[str, Any]
    stats: Mapping[str, Any]
    errors: list[Mapping[str, Any]]
    metadata: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_complete)

    def __post_init__(self) -> None:
        for key, value in validate_complete(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class DeliveryEvent(ProtocolModel):
    protocol_version: str
    event_id: str
    event_type: str
    stream_id: str
    run_id: str
    finding_id: str | None
    occurred_at: str
    attempt: int
    payload: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_delivery_event)

    def __post_init__(self) -> None:
        for key, value in validate_delivery_event(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class SubmittedEvidence(ProtocolModel):
    evidence_id: str
    kind: str
    source: Mapping[str, Any]
    captured_at: str
    published_at: str | None
    locator: Mapping[str, Any] | None
    excerpt: str | None
    content_hash: str | None
    artifact: Mapping[str, Any]
    handling: Mapping[str, Any]
    metadata: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_evidence)

    def __post_init__(self) -> None:
        for key, value in validate_evidence(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class Finding(ProtocolModel):
    finding_id: str
    finding_type: str
    title: str
    summary: str
    subjects: list[Mapping[str, Any]]
    effective_time: Mapping[str, Any]
    assessment: Mapping[str, Any]
    evidence_refs: list[str]
    producer_dedupe_key: str | None
    routing_tags: list[str]
    attributes: Mapping[str, Any]
    security_flags: list[str]
    _validator: ClassVar[Any] = staticmethod(validate_finding)

    def __post_init__(self) -> None:
        for key, value in validate_finding(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class RunBundle(ProtocolModel):
    protocol_version: str
    run_id: str
    begin: Mapping[str, Any]
    batches: list[Mapping[str, Any]]
    complete: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_run_bundle)

    def __post_init__(self) -> None:
        for key, value in validate_run_bundle(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class RunEnvelope(ProtocolModel):
    protocol_version: str
    run_id: str
    stream_id: str
    producer: Mapping[str, Any]
    task: Mapping[str, Any]
    started_at: str
    completed_at: str | None
    status: str
    expected_scope: Mapping[str, Any]
    actual_scope: Mapping[str, Any] | None
    stats: Mapping[str, Any]
    parent_run_id: str | None
    error_summary: str | None
    metadata: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_run_envelope)

    def __post_init__(self) -> None:
        for key, value in validate_run_envelope(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class StreamExpectation(ProtocolModel):
    stream_id: str
    expected_cadence_seconds: int
    grace_seconds: int
    enabled: bool
    expected_scope: Mapping[str, Any]
    last_terminal_run_at: str | None
    next_due_at: str | None
    evaluated_at: str
    liveness_status: str
    owner: str
    notes: str
    _validator: ClassVar[Any] = staticmethod(validate_stream_expectation)

    def __post_init__(self) -> None:
        for key, value in validate_stream_expectation(self._raw_dict()).items():
            object.__setattr__(self, key, value)


@dataclass(frozen=True)
class SubmitBatchRequest(ProtocolModel):
    protocol_version: str
    run_id: str
    batch_id: str
    idempotency_key: str
    sequence_number: int
    submitted_at: str
    findings: list[Mapping[str, Any]]
    evidence: list[Mapping[str, Any]]
    metadata: Mapping[str, Any]
    _validator: ClassVar[Any] = staticmethod(validate_submit)

    def __post_init__(self) -> None:
        for key, value in validate_submit(self._raw_dict()).items():
            object.__setattr__(self, key, value)


BeginRun = BeginRunRequest
CompleteRun = CompleteRunRequest
AgentFeedDeliveryEvent = DeliveryEvent
Evidence = SubmittedEvidence
SubmitBatch = SubmitBatchRequest

__all__ = [
    "AgentFeedDeliveryEvent", "BeginRun", "BeginRunRequest", "CompleteRun", "CompleteRunRequest",
    "DeliveryEvent", "Evidence", "Finding", "ProtocolModel", "RunBundle", "RunEnvelope",
    "StreamExpectation", "SubmitBatch", "SubmitBatchRequest", "SubmittedEvidence",
]
