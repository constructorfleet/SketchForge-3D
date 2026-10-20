"""Errors the API answers with, kept distinguishable so a macro can react to them."""

from __future__ import annotations

from typing import Any, Optional


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
    ) -> None:
        super().__init__(f"{method} {url} failed with {status}: {detail or 'no detail'}")
        self.method = method
        self.url = url
        self.status = status
        self.detail = detail
        self.body = body

    @property
    def looks_disabled(self) -> bool:
        """
        The API answers 404 on every route when the server has no token set,
        which no status code distinguishes from a missing project -- only the
        message does.
        """
        return self.status == 404 and "disabled" in (self.detail or "").lower()

    @property
    def needs_storage(self) -> bool:
        """The server has a token but no project directory, so it can store nothing."""
        return self.status == 503

    @property
    def is_project_busy(self) -> bool:
        """Another write holds the project's lock; retrying is the right response."""
        return self.status == 409 and "being changed" in (self.detail or "").lower()


class SketchForgeTransportError(SketchForgeError):
    """The request never reached the server, or never came back."""

    def __init__(self, method: str, url: str, cause: BaseException) -> None:
        super().__init__(f"{method} {url} could not be completed: {cause}")
        self.method = method
        self.url = url
        self.cause = cause
