"""
The macro runner's command line: ``python -m sketchforge3d.macro <file> [--name=value ...]``.

Running a module with ``-m`` executes this file as ``__main__``, which is a
second module object with its own copy of everything defined in it. The macro
definitions therefore live in ``_macro`` and are only re-exported here: a macro
file that does ``from sketchforge3d import define_macro`` gets the same ``Macro``
class this runner checks against, rather than an identical-looking twin that
fails every ``isinstance``.
"""

from __future__ import annotations

from ._macro import (
    PROJECT_MODES,
    Macro,
    MacroContext,
    MacroParameterValue,
    MacroRunReport,
    ResolvedProject,
    define_macro,
    describe_report,
    load_macro_file,
    macro_from_module,
    main,
    parse_parameters,
    resolve_macro_params,
    resolve_macro_project,
    run_macro,
    run_stamp,
)

__all__ = [
    "PROJECT_MODES",
    "Macro",
    "MacroContext",
    "MacroParameterValue",
    "MacroRunReport",
    "ResolvedProject",
    "define_macro",
    "describe_report",
    "load_macro_file",
    "macro_from_module",
    "main",
    "parse_parameters",
    "resolve_macro_params",
    "resolve_macro_project",
    "run_macro",
    "run_stamp",
]

if __name__ == "__main__":
    raise SystemExit(main())
