"""
A client for the SketchForge REST API, and a runner for macros written against it.

    from sketchforge3d import client_from_environment

    client = client_from_environment()
    project = client.project(client.projects.create("Bracket").id)
    project.add({"kind": "box", "width": 60, "depth": 40, "height": 8})

Installed as ``sketchforge3d``; imported the same way.
"""

from __future__ import annotations

from . import layout
from .client import Edges, ProjectHandle, Projects, Shapes, SketchForgeClient, Treatments, chunk
from .environment import (
    BASE_URL_ENV,
    DEFAULT_BASE_URL,
    PROJECT_ENV,
    TOKEN_ENV,
    client_from_environment,
    target_project_from_environment,
)
from .errors import (
    API_ERROR_CODES,
    MissingConfigurationError,
    SketchForgeApiError,
    SketchForgeError,
    SketchForgeTransportError,
)
from .layout import Point2, angle_of, centered_offsets, grid, mm, ring, row
from ._macro import (
    PROJECT_MODES,
    Macro,
    MacroContext,
    MacroRunReport,
    define_macro,
    load_macro_file,
    resolve_macro_params,
    resolve_macro_project,
    run_macro,
    run_stamp,
)
from .types import (
    MAX_SHAPES_PER_REQUEST,
    PARAMETRIC_SHAPE_KINDS,
    SHAPE_DESCRIPTION_FIELDS,
    SHAPE_KINDS,
    SHAPE_PARAMETER_NAMES,
    THREAD_DESIGNATIONS,
    EdgeSummary,
    ProjectDetail,
    ProjectSummary,
    ShapeSummary,
    ShapeWriteResult,
    TreatmentResult,
)

__version__ = "0.1.0"

__all__ = [
    "API_ERROR_CODES",
    "BASE_URL_ENV",
    "DEFAULT_BASE_URL",
    "Edges",
    "EdgeSummary",
    "MAX_SHAPES_PER_REQUEST",
    "Macro",
    "MacroContext",
    "MacroRunReport",
    "MissingConfigurationError",
    "PARAMETRIC_SHAPE_KINDS",
    "PROJECT_ENV",
    "PROJECT_MODES",
    "Point2",
    "ProjectDetail",
    "ProjectHandle",
    "ProjectSummary",
    "Projects",
    "SHAPE_DESCRIPTION_FIELDS",
    "SHAPE_KINDS",
    "SHAPE_PARAMETER_NAMES",
    "Shapes",
    "ShapeSummary",
    "ShapeWriteResult",
    "SketchForgeApiError",
    "SketchForgeClient",
    "SketchForgeError",
    "SketchForgeTransportError",
    "THREAD_DESIGNATIONS",
    "TOKEN_ENV",
    "TreatmentResult",
    "Treatments",
    "angle_of",
    "centered_offsets",
    "chunk",
    "client_from_environment",
    "define_macro",
    "grid",
    "layout",
    "load_macro_file",
    "mm",
    "resolve_macro_params",
    "resolve_macro_project",
    "ring",
    "row",
    "run_macro",
    "run_stamp",
    "target_project_from_environment",
]
