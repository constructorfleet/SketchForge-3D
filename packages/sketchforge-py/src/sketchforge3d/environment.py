"""
Connecting from the environment, which is how a macro is meant to be run.

The token is a password for every project on the server, so it belongs in the
environment rather than in a macro's source or on a command line where it lands
in shell history and in ``ps``.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional

from .client import SketchForgeClient
from .errors import MissingConfigurationError

BASE_URL_ENV = "SKETCHFORGE_URL"
TOKEN_ENV = "SKETCHFORGE_API_TOKEN"
PROJECT_ENV = "SKETCHFORGE_PROJECT_ID"

DEFAULT_BASE_URL = "http://127.0.0.1:3000"


def client_from_environment(
    environment: Optional[Mapping[str, str]] = None,
    **overrides: Any,
) -> SketchForgeClient:
    source = environment if environment is not None else os.environ
    token = overrides.pop("token", None) or source.get(TOKEN_ENV)
    if not token:
        raise MissingConfigurationError(
            f"{TOKEN_ENV} is not set. It is the same token the server was started with; "
            "without it every route answers 404."
        )
    base_url = overrides.pop("base_url", None) or source.get(BASE_URL_ENV) or DEFAULT_BASE_URL
    return SketchForgeClient(base_url=base_url, token=token, **overrides)


def target_project_from_environment(
    environment: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    """The project an operator named for a ``target`` macro, if any."""
    source = environment if environment is not None else os.environ
    return source.get(PROJECT_ENV) or None
