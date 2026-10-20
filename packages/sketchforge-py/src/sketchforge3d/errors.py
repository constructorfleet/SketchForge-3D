"""Errors the API answers with, kept distinguishable so a macro can react to them."""

from __future__ import annotations

from typing import Any, Optional, Tuple

#: The server's machine-readable reason, which a status code is too coarse to
#: carry: ``404`` is a missing project, a missing shape or an API that is
#: switched off, and ``409`` is both a busy project worth retrying and a locked
#: shape that never will be.
API_ERROR_CODES: Tuple[str, ...] = (
    "api_disabled",
    "unauthorized",
    "storage_unconfigured",
    "invalid_project_id",
    "invalid_shape_id",
    "invalid_body",
    "invalid_request",
    "project_not_found",
    "project_exists",
    "project_busy",
    "shape_not_found",
    "shape_locked",
    "unsupported_kind",
    "unapplicable_fields",
    "too_many_shapes",
    "geometry_failed",
    "cad_failed",
)


class SketchForgeError(Exception):
    """Anything this library raises on its own behalf."""


class MissingConfigurationError(SketchForgeError):
    """The environment does not say how to reach the server."""


class SketchForgeApiError(SketchForgeError):
    """The server answered, and refused."""

    def __init__(
        self,
        method: str,
        url: str,
        status: int,
        detail: Optional[str] = None,
        body: Any = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(f"{method} {url} failed with {status}: {detail or 'no detail'}")
        self.method = method
        self.url = url
        self.status = status
        self.detail = detail
        self.code = code
        self.body = body

    def _is(self, code: str, status: int, prose: str) -> bool:
        """
        Whether the server gave this reason.

        The prose match is the fallback for a server from before codes existed,
        and is deliberately kept: a client reading only ``code`` would treat
        every error from such a server as unrecognised.
        """
        if self.code:
            return self.code == code
        return self.status == status and prose in (self.detail or "").lower()

    @property
    def looks_disabled(self) -> bool:
        """The API answers 404 on every route when the server has no token set."""
        return self._is("api_disabled", 404, "disabled")

    @property
    def needs_storage(self) -> bool:
        """The server has a token but no project directory, so it can store nothing."""
        return self.status == 503

    @property
    def is_project_busy(self) -> bool:
        """Another write holds the project's lock; retrying is the right response."""
        return self._is("project_busy", 409, "being changed")

    @property
    def is_shape_locked(self) -> bool:
        """That shape is locked; retrying will not help, unlocking it will."""
        return self._is("shape_locked", 409, "locked")

    @property
    def is_project_missing(self) -> bool:
        return self._is("project_not_found", 404, "project is not on the server")

    @property
    def is_shape_missing(self) -> bool:
        return self._is("shape_not_found", 404, "not in the project")

    @property
    def has_unapplicable_fields(self) -> bool:
        """The change named fields the shape's kind has no use for."""
        return self._is("unapplicable_fields", 422, "cannot take")

    @property
    def unapplicable_fields(self) -> list:
        """Which fields those were, which is why this is an error and not a no-op."""
        fields = self.body.get("fields") if isinstance(self.body, dict) else None
        return [field for field in fields if isinstance(field, str)] if isinstance(fields, list) else []


class SketchForgeTransportError(SketchForgeError):
    """The request never reached the server, or never came back."""

    def __init__(self, method: str, url: str, cause: BaseException) -> None:
        super().__init__(f"{method} {url} could not be completed: {cause}")
        self.method = method
        self.url = url
        self.cause = cause
