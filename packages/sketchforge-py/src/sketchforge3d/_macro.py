"""
Macros: a script that is handed a connected project and builds something in it.

The hard part of a macro is not the geometry, it is what happens the second time
it runs. A script that appends shapes to a project it found is a script that
doubles the part on every run, and the mistake is invisible until someone opens
the project. So a macro cannot choose a project implicitly: it declares a
project mode, and the runner -- not the macro body -- does what that mode says
before the macro sees anything.

    fresh     a new project every run, named uniquely. Nothing is ever reused,
              so a run can never corrupt an earlier one.
    replace   one project of that name, emptied first. Re-running gives the same
              result, which is what "idempotent" means for a build script.
    reuse     one project of that name, left as it is. For a macro that adds a
              feature to whatever is already there; it is the caller's problem
              if that runs twice.
    target    the project id the operator names, never created and never
              cleared. Refuses to run without one.

Run one with ``python -m sketchforge3d.macro <file> [--name=value ...]``. The
file is imported from a path the person running the command typed; nothing here
accepts code over a socket.
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import importlib.util
import json
import os
import sys
import time
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Union

from . import layout as layout_module
from .client import ProjectHandle, SketchForgeClient
from .environment import PROJECT_ENV, client_from_environment, target_project_from_environment
from .errors import SketchForgeApiError, SketchForgeError, SketchForgeTransportError

MacroParameterValue = Union[int, float, str, bool]

PROJECT_MODES = ("fresh", "replace", "reuse", "target")


@dataclass
class MacroContext:
    client: SketchForgeClient
    #: The project the mode resolved to, already created or emptied as declared.
    project: ProjectHandle
    params: Dict[str, MacroParameterValue]
    #: The layout arithmetic, handed to the macro rather than imported by it.
    layout: ModuleType
    #: Progress, on stderr, so a macro's own result can be piped.
    log: Callable[[str], None]


@dataclass
class Macro:
    name: str
    run: Callable[[MacroContext], Any]
    #: One of PROJECT_MODES, optionally as ``(mode, project name)``.
    project: Union[str, Sequence[str]] = "fresh"
    description: str = ""
    #: Defaults for every parameter the macro takes. They double as the schema:
    #: an override is coerced to the type of the default, and an undeclared name
    #: is refused rather than passed through as a string the macro misreads.
    params: Dict[str, MacroParameterValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        mode, _ = _project_spec(self.project)
        if mode not in PROJECT_MODES:
            raise ValueError(
                'A macro\'s project must be one of "' + '", "'.join(PROJECT_MODES) + f'", not "{mode}".'
            )


def define_macro(
    name: str,
    run: Callable[[MacroContext], Any],
    project: Union[str, Sequence[str]] = "fresh",
    description: str = "",
    params: Optional[Mapping[str, MacroParameterValue]] = None,
) -> Macro:
    return Macro(
        name=name,
        run=run,
        project=project,
        description=description,
        params=dict(params or {}),
    )


def _project_spec(project: Union[str, Sequence[str]]) -> "tuple[str, Optional[str]]":
    if isinstance(project, str):
        return project, None
    parts = list(project)
    return (parts[0] if parts else "fresh"), (parts[1] if len(parts) > 1 else None)


def run_stamp(now: Optional[_datetime.datetime] = None) -> str:
    """A stamp that sorts chronologically and survives a project name: ``20260102-114530``."""
    moment = now or _datetime.datetime.now(_datetime.timezone.utc)
    return moment.strftime("%Y%m%d-%H%M%S")


@dataclass
class ResolvedProject:
    project: ProjectHandle
    created: bool
    cleared: int


def resolve_macro_project(
    client: SketchForgeClient,
    macro: Macro,
    target_project_id: Optional[str] = None,
    now: Optional[_datetime.datetime] = None,
) -> ResolvedProject:
    """
    The project a macro runs in, per its declared mode.

    ``replace`` and ``reuse`` look the project up by name, which the API does not
    index -- so they list every project and match. That is fine for the handful
    a workshop has and would not be for thousands.
    """
    mode, declared_name = _project_spec(macro.project)
    wanted_name = declared_name or macro.name

    if mode == "target":
        if not target_project_id:
            raise SketchForgeError(
                f'Macro "{macro.name}" runs in an existing project: set {PROJECT_ENV} or pass --project.'
            )
        # Read it before the macro starts, so a wrong id fails as a 404 here
        # rather than halfway through a part.
        client.projects.get(target_project_id)
        return ResolvedProject(project=client.project(target_project_id), created=False, cleared=0)

    if mode == "fresh":
        created = client.projects.create(f"{wanted_name} {run_stamp(now)}")
        return ResolvedProject(project=client.project(created.id), created=True, cleared=0)

    existing = client.projects.find_by_name(wanted_name)
    if existing is None:
        created = client.projects.create(wanted_name)
        return ResolvedProject(project=client.project(created.id), created=True, cleared=0)

    handle = client.project(existing.id)
    cleared = handle.clear() if mode == "replace" else 0
    return ResolvedProject(project=handle, created=False, cleared=cleared)


_TRUE = ("true", "1", "yes")
_FALSE = ("false", "0", "no")


def resolve_macro_params(
    defaults: Mapping[str, MacroParameterValue],
    overrides: Mapping[str, str],
) -> Dict[str, MacroParameterValue]:
    """A macro's parameters, with overrides coerced to the type of each default."""
    resolved: Dict[str, MacroParameterValue] = dict(defaults)
    for key, raw in overrides.items():
        if key not in resolved:
            known = ", ".join(sorted(resolved)) or "no parameters"
            raise SketchForgeError(f'Unknown parameter "{key}". This macro takes: {known}.')
        fallback = resolved[key]
        if isinstance(fallback, bool):
            if raw.lower() not in _TRUE + _FALSE:
                raise SketchForgeError(f'Parameter "{key}" must be true or false, not "{raw}".')
            resolved[key] = raw.lower() in _TRUE
        elif isinstance(fallback, int):
            try:
                resolved[key] = int(raw, 10)
            except ValueError:
                raise SketchForgeError(f'Parameter "{key}" must be a whole number, not "{raw}".') from None
        elif isinstance(fallback, float):
            try:
                resolved[key] = float(raw)
            except ValueError:
                raise SketchForgeError(f'Parameter "{key}" must be a number, not "{raw}".') from None
        else:
            resolved[key] = raw
    return resolved


@dataclass
class MacroRunReport:
    macro: str
    project_id: str
    project_created: bool
    shapes_cleared: int
    shape_count: int
    duration_ms: int
    result: Any

    def as_dict(self) -> Dict[str, Any]:
        return {
            "macro": self.macro,
            "projectId": self.project_id,
            "projectCreated": self.project_created,
            "shapesCleared": self.shapes_cleared,
            "shapeCount": self.shape_count,
            "durationMs": self.duration_ms,
            "result": self.result,
        }


def run_macro(
    client: SketchForgeClient,
    macro: Macro,
    params: Optional[Mapping[str, str]] = None,
    target_project_id: Optional[str] = None,
    log: Optional[Callable[[str], None]] = None,
    now: Optional[_datetime.datetime] = None,
) -> MacroRunReport:
    """Runs a macro and reports what it did to the project, as the CLI prints it."""
    emit = log or (lambda message: None)
    resolved_params = resolve_macro_params(macro.params, params or {})
    started = time.monotonic()
    resolved = resolve_macro_project(client, macro, target_project_id=target_project_id, now=now)

    if resolved.created:
        emit(f"project {resolved.project.id} created")
    if resolved.cleared:
        emit(f"{resolved.cleared} existing shape(s) removed")

    result = macro.run(
        MacroContext(
            client=client,
            project=resolved.project,
            params=resolved_params,
            layout=layout_module,
            log=emit,
        )
    )
    shapes = resolved.project.list_shapes()

    return MacroRunReport(
        macro=macro.name,
        project_id=resolved.project.id,
        project_created=resolved.created,
        shapes_cleared=resolved.cleared,
        shape_count=len(shapes),
        duration_ms=int((time.monotonic() - started) * 1000),
        result=result,
    )


def macro_from_module(module: Any, fallback_name: str) -> Macro:
    """
    A macro module's export, whichever way it was written.

    ``MACRO = define_macro(...)`` is the documented form; a module with a bare
    ``run`` function is accepted as the smallest thing that can work, and runs in
    a fresh project because that is the only mode safe to assume.
    """
    candidate = getattr(module, "MACRO", None) or getattr(module, "macro", None)
    if isinstance(candidate, Macro):
        return candidate if candidate.name else define_macro(fallback_name, candidate.run)

    runner = getattr(module, "run", None)
    if callable(runner):
        return define_macro(fallback_name, runner, project="fresh")

    raise SketchForgeError(
        f"{fallback_name} does not look like a macro: set MACRO = define_macro(...), "
        "or define run(context)."
    )


def load_macro_file(path: str) -> Macro:
    """Imports a macro file by path, under its own module name."""
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        raise SketchForgeError(f"No macro file at {absolute}.")
    stem = os.path.splitext(os.path.basename(absolute))[0]
    spec = importlib.util.spec_from_file_location(f"sketchforge_macro_{stem.replace('-', '_')}", absolute)
    if spec is None or spec.loader is None:
        raise SketchForgeError(f"{absolute} could not be imported as a Python module.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return macro_from_module(module, stem)


def parse_parameters(pairs: Sequence[str]) -> Dict[str, str]:
    """``--count=5`` style overrides, as argparse leaves them."""
    parsed: Dict[str, str] = {}
    for pair in pairs:
        name, separator, value = pair.lstrip("-").partition("=")
        if not separator or not name:
            raise SketchForgeError(f'Expected --name=value, got "{pair}".')
        parsed[name] = value
    return parsed


def describe_report(report: MacroRunReport) -> str:
    lines = [
        f"macro      {report.macro}",
        f"project    {report.project_id}{' (created)' if report.project_created else ''}",
    ]
    if report.shapes_cleared:
        lines.append(f"cleared    {report.shapes_cleared}")
    lines.append(f"shapes     {report.shape_count}")
    lines.append(f"took       {report.duration_ms} ms")
    if report.result is not None:
        lines.append(f"result     {json.dumps(report.result, default=str)}")
    return "\n".join(lines)


def _explain(error: BaseException) -> str:
    """A failure a macro author can act on, rather than a stack trace through urllib."""
    if isinstance(error, SketchForgeTransportError):
        return f"{error}\nIs the server running, and is SKETCHFORGE_URL pointing at it?"
    if isinstance(error, SketchForgeApiError):
        if error.looks_disabled:
            return "The server has no SKETCHFORGE_API_TOKEN set, so its REST API is switched off."
        if error.needs_storage:
            return "The server has no SKETCHFORGE_PROJECTS_DIR set, so it has nowhere to store projects."
    return str(error)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m sketchforge3d.macro",
        description="Run a SketchForge macro file against the server named by the environment.",
        epilog=(
            "Environment: SKETCHFORGE_API_TOKEN (required), SKETCHFORGE_URL "
            "(default http://127.0.0.1:3000), SKETCHFORGE_PROJECT_ID (for a target macro)."
        ),
    )
    parser.add_argument("file", help="the macro file to run")
    parser.add_argument("--project", dest="project_id", help="the project for a target macro")
    parser.add_argument("--json", action="store_true", help="print the run report as JSON")
    parsed, extra = parser.parse_known_args(list(argv) if argv is not None else sys.argv[1:])

    try:
        overrides = parse_parameters(extra)
        macro = load_macro_file(parsed.file)
        client = client_from_environment()
        report = run_macro(
            client,
            macro,
            params=overrides,
            target_project_id=parsed.project_id or target_project_from_environment(),
            log=lambda message: print(message, file=sys.stderr),
        )
    except SketchForgeError as error:
        print(_explain(error), file=sys.stderr)
        return 1

    print(json.dumps(report.as_dict(), indent=2, default=str) if parsed.json else describe_report(report))
    return 0
