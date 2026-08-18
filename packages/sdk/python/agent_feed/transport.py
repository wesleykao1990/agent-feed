"""Injectable transport seam and the stdlib HTTP(S) implementation."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
import builtins
import json
import socket
import ssl
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import TimeoutError as SdkTimeoutError
from .errors import TransportError


@dataclass(frozen=True)
class TransportResponse:
    status_code: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: Any = None

    @property
    def status(self) -> int:
        return self.status_code


class Transport(Protocol):
    def request(self, method: str, path: str, *, headers: Mapping[str, str], body: Any, timeout: float) -> TransportResponse: ...


class UrllibTransport:
    """Dependency-free HTTP(S) transport with platform TLS verification."""

    def __init__(self, *, ssl_context: ssl.SSLContext | None = None) -> None:
        self.ssl_context = ssl_context

    def request(self, method: str, path: str, *, headers: Mapping[str, str], body: Any, timeout: float) -> TransportResponse:
        request_headers = {str(key): str(value) for key, value in headers.items()}
        encoded: bytes | None = None
        if body is not None:
            try:
                encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError) as exc:
                raise TransportError("request body is not JSON serializable", cause=exc) from None
            request_headers.setdefault("Content-Type", "application/json")
        request = Request(path, data=encoded, headers=request_headers, method=method.upper())
        try:
            kwargs: dict[str, Any] = {"timeout": timeout}
            if self.ssl_context is not None:
                kwargs["context"] = self.ssl_context
            with urlopen(request, **kwargs) as response:  # noqa: S310 - explicit caller endpoint
                raw = response.read()
                return TransportResponse(int(response.status), {str(k).lower(): str(v) for k, v in response.headers.items()}, _decode(raw, response.headers.get("Content-Type")))
        except HTTPError as exc:
            try:
                raw = exc.read()
            except OSError:
                raw = b""
            headers_out = {str(k).lower(): str(v) for k, v in exc.headers.items()} if exc.headers else {}
            return TransportResponse(int(exc.code), headers_out, _decode(raw, exc.headers.get("Content-Type") if exc.headers else None))
        except (socket.timeout, builtins.TimeoutError, SdkTimeoutError) as exc:
            raise SdkTimeoutError(cause=exc) from None
        except URLError as exc:
            reason = exc.reason
            if isinstance(reason, (socket.timeout, builtins.TimeoutError, SdkTimeoutError)):
                raise SdkTimeoutError(cause=reason) from None
            raise TransportError(cause=exc) from None
        except (OSError, ssl.SSLError) as exc:
            raise TransportError(cause=exc) from None


def _decode(raw: bytes, content_type: str | None) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if "json" in media or text.lstrip().startswith(("{", "[")):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


__all__ = ["Transport", "TransportResponse", "UrllibTransport"]
