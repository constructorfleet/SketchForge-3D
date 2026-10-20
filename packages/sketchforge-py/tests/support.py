"""A recording opener, so the unit tests need no socket."""

from __future__ import annotations

import io
import json
import urllib.error
from typing import Any, Dict, List, Optional, Sequence


class RecordedCall:
    def __init__(self, method: str, url: str, body: Any, headers: Dict[str, str]) -> None:
        self.method = method
        self.url = url
        self.body = body
        self.headers = headers


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class FakeOpener:
    """Answers in order; the last answer repeats once the queue runs dry."""

    def __init__(self, *responses: Sequence[Any]) -> None:
        self.responses: List[Any] = [
            response if isinstance(response, tuple) else (200, response) for response in responses
        ] or [(200, {})]
        self.calls: List[RecordedCall] = []

    def open(self, request: Any, timeout: Optional[float] = None) -> Any:
        payload = json.loads(request.data.decode()) if request.data else None
        self.calls.append(
            RecordedCall(
                method=request.get_method(),
                url=request.full_url,
                body=payload,
                headers={key.lower(): value for key, value in request.headers.items()},
            )
        )
        status, body = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        encoded = json.dumps(body).encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(encoded))
        return _Response(encoded)


def shape_payload(shape_id: str = "s1", **overrides: Any) -> Dict[str, Any]:
    payload = {
        "id": shape_id,
        "name": shape_id,
        "kind": "box",
        "color": "#fff",
        "hole": False,
        "locked": False,
        "hidden": False,
        "x": 0,
        "z": 0,
        "elevation": 0,
        "width": 1,
        "depth": 1,
        "height": 1,
        "rotation": 0,
        "rotationX": 0,
        "rotationZ": 0,
    }
    payload.update(overrides)
    return payload


def project_payload(project_id: str, name: str) -> Dict[str, Any]:
    return {
        "id": project_id,
        "name": name,
        "shapes": 0,
        "revision": 1,
        "updatedAt": 0,
        "packageBytes": 0,
    }
