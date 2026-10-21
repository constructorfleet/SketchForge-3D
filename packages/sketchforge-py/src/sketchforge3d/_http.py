"""
The one place that talks HTTP, over ``urllib`` so the package has no dependencies.

Ids travel in the query string rather than the path, which is a constraint of
the server's static-export build rather than a style choice, so every call goes
through ``query`` and no resource builds a path by hand.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional

from .errors import SketchForgeApiError, SketchForgeTransportError

DEFAULT_TIMEOUT_SECONDS = 60.0
DEFAULT_RETRY_ON_BUSY = 4
_BUSY_RETRY_BASE_SECONDS = 0.06


def normalize_base_url(base_url: str) -> str:
    """``http://host:3000``, with or without a trailing slash or the API prefix."""
    trimmed = base_url.strip().rstrip("/")
    if not trimmed:
        raise ValueError("A base_url is required, for example http://localhost:3000.")
    return trimmed if trimmed.endswith("/api/v1") else trimmed + "/api/v1"


def build_url(root: str, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
    pairs = [(key, str(value)) for key, value in (query or {}).items() if value is not None]
    suffix = "?" + urllib.parse.urlencode(pairs) if pairs else ""
    return root + path + suffix


class Transport:
    """Sends one request and parses one answer, retrying only a lost project lock."""

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retry_on_busy: int = DEFAULT_RETRY_ON_BUSY,
        headers: Optional[Mapping[str, str]] = None,
        opener: Optional[Any] = None,
    ) -> None:
        self.api_root = normalize_base_url(base_url)
        self._token = token
        self._timeout = timeout
        self._retry_on_busy = retry_on_busy
        self._headers = dict(headers or {})
        #: Injectable so tests need no socket; anything with ``open(request, timeout=)``.
        self._opener = opener or urllib.request.build_opener()

    def send(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
        retryable: bool = False,
    ) -> Any:
        url = build_url(self.api_root, path, query)
        attempts = self._retry_on_busy + 1 if retryable else 1

        for attempt in range(1, attempts + 1):
            try:
                return self._send_once(method, url, body)
            except SketchForgeApiError as error:
                # A locked *shape* also answers 409 and must not be retried,
                # which is why the message rather than the status decides.
                if not error.is_project_busy or attempt == attempts:
                    raise
                time.sleep(_BUSY_RETRY_BASE_SECONDS * attempt)
        raise AssertionError("unreachable")

    def _send_once(self, method: str, url: str, body: Optional[Any]) -> Any:
        headers: Dict[str, str] = dict(self._headers)
        headers["Authorization"] = "Bearer " + self._token
        headers["Accept"] = "application/json"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return _decode(response.read())
        except urllib.error.HTTPError as error:
            _raise_http_error(method, url, error)
        except urllib.error.URLError as error:
            raise SketchForgeTransportError(method, url, error) from None
        except OSError as error:
            raise SketchForgeTransportError(method, url, error) from None

    def send_multipart(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]],
        fields: Mapping[str, str],
        file_name: str,
        file_data: bytes,
        media_type: Optional[str] = None,
        retryable: bool = False,
    ) -> Any:
        """Send a buffered multipart request without base64 or JSON expansion."""
        import uuid

        boundary = "sketchforge-" + uuid.uuid4().hex
        chunks = []
        for name, value in fields.items():
            chunks.extend((
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n".encode(),
                value.encode("utf-8"), b"\r\n",
            ))
        safe_name = file_name.replace("\\", "_").replace('"', "_").replace("\r", "_").replace("\n", "_")
        content_type = media_type or "application/octet-stream"
        chunks.extend((
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\nContent-Type: {content_type}\r\n\r\n".encode(),
            file_data, b"\r\n", f"--{boundary}--\r\n".encode(),
        ))
        url = build_url(self.api_root, path, query)
        headers = dict(self._headers)
        headers["Authorization"] = "Bearer " + self._token
        headers["Accept"] = "application/json"
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        request = urllib.request.Request(url, data=b"".join(chunks), headers=headers, method=method)
        attempts = self._retry_on_busy + 1 if retryable else 1
        for attempt in range(1, attempts + 1):
            try:
                with self._opener.open(request, timeout=self._timeout) as response:
                    return _decode(response.read())
            except urllib.error.HTTPError as error:
                try:
                    _raise_http_error(method, url, error)
                except SketchForgeApiError as api_error:
                    if not api_error.is_project_busy or attempt == attempts:
                        raise
                    time.sleep(_BUSY_RETRY_BASE_SECONDS * attempt)
            except urllib.error.URLError as error:
                raise SketchForgeTransportError(method, url, error) from None
            except OSError as error:
                raise SketchForgeTransportError(method, url, error) from None
        raise AssertionError("unreachable")

    def download_to_file(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]],
        body: Optional[Any],
        destination: str,
    ) -> Mapping[str, str]:
        """Stream a response to a temporary sibling, replacing destination on success."""
        url = build_url(self.api_root, path, query)
        headers: Dict[str, str] = dict(self._headers)
        headers["Authorization"] = "Bearer " + self._token
        headers["Accept"] = "application/octet-stream, application/json"
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        destination = os.fspath(destination)
        directory = os.path.dirname(os.path.abspath(destination))
        fd, temporary = tempfile.mkstemp(prefix=".sketchforge-", dir=directory)
        try:
            try:
                with self._opener.open(request, timeout=self._timeout) as response, os.fdopen(fd, "wb") as output:
                    while True:
                        block = response.read(64 * 1024)
                        if not block:
                            break
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                    response_headers = {key.lower(): value for key, value in response.headers.items()}
            except urllib.error.HTTPError as error:
                os.close(fd)
                _raise_http_error(method, url, error)
            os.replace(temporary, destination)
            return response_headers
        except (urllib.error.URLError, OSError) as error:
            try:
                os.close(fd)
            except OSError:
                # The file descriptor may already have been closed by fdopen.
                pass
            if isinstance(error, urllib.error.URLError):
                raise SketchForgeTransportError(method, url, error) from None
            raise
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def _decode(raw: bytes) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _raise_http_error(method: str, url: str, error: urllib.error.HTTPError) -> None:
    try:
        parsed = _decode(error.read())
    finally:
        error.close()
    detail = parsed.get("error") if isinstance(parsed, dict) else None
    code = parsed.get("code") if isinstance(parsed, dict) else None
    raise SketchForgeApiError(
        method,
        url,
        error.code,
        detail if isinstance(detail, str) else None,
        parsed,
        code if isinstance(code, str) else None,
    ) from None
