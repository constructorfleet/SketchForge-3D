"""Errors the API answers with, kept distinguishable so a macro can react to them."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .types import ExpressionError, ShapeDependent

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
    "revision_mismatch",
    "shape_not_found",
    "shape_locked",
    "parameter_not_found",
    "parameter_exists",
    "parameter_in_use",
    "invalid_expression",
    "unsupported_kind",
    "unsupported_format",
    "unapplicable_fields",
    "too_many_shapes",
    "limit_exceeded",
    "geometry_failed",
    "cad_failed",
    "internal_error",
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
    def is_limit_exceeded(self) -> bool:
        """A size or count cap was reached; accepts the legacy shape-count code."""
        return self.code in ("limit_exceeded", "too_many_shapes") if self.code else self.status == 413

    @property
    def is_project_busy(self) -> bool:
        """Another write holds the project's lock; retrying is the right response."""
        return self._is("project_busy", 409, "being changed")

    @property
    def is_revision_mismatch(self) -> bool:
        """The project changed since the supplied If-Match revision."""
        return self._is("revision_mismatch", 409, "changed since")

    @property
    def current_revision(self) -> Optional[int]:
        """The current project revision returned with a 409 mismatch."""
        revision = self.body.get("revision") if isinstance(self.body, dict) else None
        return revision if isinstance(revision, int) and not isinstance(revision, bool) else None

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
    def unapplicable_fields(self) -> List[str]:
        """Which fields those were, which is why this is an error and not a no-op."""
        return self.fields

    @property
    def is_invalid_expression(self) -> bool:
        """A parameter or bound field does not evaluate; ``expression_error`` says where."""
        return self.code == "invalid_expression"

    @property
    def is_parameter_missing(self) -> bool:
        return self.code == "parameter_not_found"

    @property
    def is_parameter_duplicate(self) -> bool:
        """The table already has a parameter with that name."""
        return self.code == "parameter_exists"

    @property
    def is_parameter_in_use(self) -> bool:
        """A delete was refused; ``dependents`` and ``shape_dependents`` name what still uses it."""
        return self.code == "parameter_in_use"

    @property
    def _detail(self) -> Dict[str, Any]:
        return self.body if isinstance(self.body, dict) else {}

    def _text(self, key: str) -> Optional[str]:
        value = self._detail.get(key)
        return value if isinstance(value, str) else None

    @property
    def parameter(self) -> Optional[str]:
        """The parameter that failed, which can be a dependent of the one changed."""
        return self._text("parameter")

    @property
    def reason(self) -> Optional[str]:
        """The engine's finer code, such as ``outOfRange`` or ``duplicateName``."""
        return self._text("reason")

    @property
    def expression_error(self) -> Optional[ExpressionError]:
        detail = self._detail.get("expressionError")
        return ExpressionError.from_payload(detail) if isinstance(detail, dict) else None

    @property
    def dependents(self) -> List[str]:
        """Parameters whose expressions use the one a delete was refused for."""
        return _strings(self._detail.get("dependents"))

    @property
    def shape_dependents(self) -> List[ShapeDependent]:
        entries = self._detail.get("shapeDependents")
        if not isinstance(entries, list):
            return []
        return [
            ShapeDependent(shape_id=entry["shapeId"], fields=_strings(entry.get("fields")))
            for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("shapeId"), str)
        ]

    @property
    def shape_id(self) -> Optional[str]:
        """The shape a binding refusal is about. A batch create names its ``index`` instead."""
        return self._text("shapeId")

    @property
    def field(self) -> Optional[str]:
        return self._text("field")

    @property
    def fields(self) -> List[str]:
        """Fields named by ``unapplicable_fields``, or the bound fields of a refused rebuild."""
        return _strings(self._detail.get("fields"))

    @property
    def index(self) -> Optional[int]:
        """Position in a batch ``POST /shapes``, whose new shape has no id yet."""
        index = self._detail.get("index")
        return index if isinstance(index, int) and not isinstance(index, bool) else None


def _strings(value: Any) -> List[str]:
    return [entry for entry in value if isinstance(entry, str)] if isinstance(value, list) else []


class SketchForgeTransportError(SketchForgeError):
    """The request never reached the server, or never came back."""

    def __init__(self, method: str, url: str, cause: BaseException) -> None:
        super().__init__(f"{method} {url} could not be completed: {cause}")
        self.method = method
        self.url = url
        self.cause = cause
