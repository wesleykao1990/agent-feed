"""Typed, redacted exceptions raised by the Agent Feed Python SDK."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from typing import Any

_SENSITIVE_KEY_PARTS = (
    "authorization", "api_key", "apikey", "credential", "cookie", "password",
    "passwd", "private_key", "privatekey", "secret", "token",
)
_MAX_STRING = 256
_MAX_ITEMS = 32
_SECRET_TEXT = re.compile(r"(?i)(?:bearer|password|passwd|secret|token|api[ _-]?key|authorization)\s*[:=]?\s*[^\s,;]+")
_SAFE_API_CODE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,99}$")


def _sensitive_key(key: object) -> bool:
    lowered = str(key).lower().replace("-", "_")
    return any(part in lowered for part in _SENSITIVE_KEY_PARTS)


def redact(value: Any, *, _depth: int = 0) -> Any:
    """Return a bounded diagnostic-safe copy of an arbitrary JSON-ish value."""
    if _depth > 6:
        return "<redacted-depth>"
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for index, (key, child) in enumerate(value.items()):
            if index >= _MAX_ITEMS:
                result["<redacted-more>"] = f"{len(value) - _MAX_ITEMS} additional fields"
                break
            key_text = str(key)
            result[key_text] = "<redacted>" if _sensitive_key(key_text) else redact(child, _depth=_depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        items = [redact(item, _depth=_depth + 1) for item in value[:_MAX_ITEMS]]
        if len(value) > _MAX_ITEMS:
            items.append(f"<redacted {len(value) - _MAX_ITEMS} additional items>")
        return items
    if isinstance(value, bytes):
        return f"<binary {len(value)} bytes>"
    if isinstance(value, str):
        if _SECRET_TEXT.search(value):
            return "<redacted>"
        return value if len(value) <= _MAX_STRING else value[:_MAX_STRING] + "…"
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return f"<{type(value).__name__}>"


class AgentFeedError(Exception):
    code = "agent_feed_error"

    def __init__(self, message: str | None = None, *, details: Any = None) -> None:
        self.details = redact(details if details is not None else {})
        super().__init__(message or self.code)


class ValidationError(AgentFeedError):
    code = "schema_validation_failed"

    def __init__(self, message: str = "payload does not match protocol 0.1", *, path: str = "$", issues: Sequence[Any] = ()) -> None:
        self.path = path
        self.issues = tuple(redact(issue) for issue in issues)
        super().__init__(message, details={"path": path, "issues": self.issues})


# Explicit aliases make integration code readable without creating a second
# exception hierarchy.
ProtocolValidationError = ValidationError
SchemaValidationError = ValidationError


class ProtocolError(AgentFeedError):
    code = "protocol_error"


class TransportError(AgentFeedError):
    code = "transport_error"

    def __init__(self, message: str = "transport request failed", *, details: Any = None, cause: BaseException | None = None) -> None:
        self.cause_type = type(cause).__name__ if cause is not None else None
        # Do not retain the raw exception: it may contain a URL, credential,
        # evidence excerpt, or server response body.
        self.cause = None
        super().__init__(message, details=details)


class TimeoutError(TransportError):
    code = "timeout"


class RetryExhaustedError(TransportError):
    code = "retry_exhausted"

    def __init__(self, *, attempts: int, last_error: BaseException | None = None) -> None:
        self.attempts = attempts
        self.last_error_code = getattr(last_error, "code", None)
        super().__init__("request retries exhausted", details={"attempts": attempts, "last_error_code": self.last_error_code}, cause=last_error)


class HttpError(AgentFeedError):
    code = "http_error"

    def __init__(self, status_code: int, message: str = "Agent Feed request failed", *, headers: Mapping[str, str] | None = None, body: Any = None, request_id: str | None = None) -> None:
        self.status_code = status_code
        safe_headers = {"retry-after", "content-type"}
        self.headers = {str(key).lower(): str(value) for key, value in (headers or {}).items() if str(key).lower() in safe_headers}
        self.request_id = request_id
        # Keep only a stable server error code. Complete response bodies may
        # contain evidence excerpts, cursors, credentials, or arbitrary agent
        # content and are never a diagnostic surface.
        candidate = body.get("error") if isinstance(body, Mapping) else None
        self.api_code = str(candidate) if isinstance(candidate, str) and _SAFE_API_CODE.fullmatch(candidate) else None
        self.body = {"error": self.api_code} if self.api_code is not None else None
        super().__init__(message, details={"status_code": status_code, "request_id": request_id, "api_code": self.api_code})


class AuthenticationError(HttpError):
    code = "unauthorized"


class AuthorizationError(HttpError):
    code = "forbidden"


class NotFoundError(HttpError):
    code = "not_found"


class ConflictError(HttpError):
    code = "conflict"


class RateLimitError(HttpError):
    code = "rate_limited"

    def __init__(self, status_code: int, message: str = "request rate limited", *, retry_after: float | None = None, **kwargs: Any) -> None:
        self.retry_after = retry_after
        super().__init__(status_code, message, **kwargs)


class ServerError(HttpError):
    code = "server_error"


__all__ = [
    "AgentFeedError", "AuthenticationError", "AuthorizationError", "ConflictError", "HttpError",
    "NotFoundError", "ProtocolError", "RateLimitError", "RetryExhaustedError", "ServerError",
    "ProtocolValidationError", "SchemaValidationError", "TimeoutError", "TransportError", "ValidationError", "redact",
]
