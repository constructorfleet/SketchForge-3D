from __future__ import annotations

import datetime
import contextlib
import io
import json
import os
import tempfile
import unittest

from sketchforge3d import (
    MissingConfigurationError,
    SketchForgeClient,
    SketchForgeError,
    client_from_environment,
    define_macro,
    load_macro_file,
    resolve_macro_params,
    resolve_macro_project,
    run_macro,
    run_stamp,
    target_project_from_environment,
)
from sketchforge3d.macro import describe_report, macro_from_module, parse_parameters, main

from support import FakeOpener, project_payload, shape_payload


def client(opener: FakeOpener) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener)


class RunStampTests(unittest.TestCase):
    def test_is_a_sortable_date_and_time(self) -> None:
        moment = datetime.datetime(2026, 1, 2, 11, 45, 30, tzinfo=datetime.timezone.utc)
        self.assertEqual(run_stamp(moment), "20260102-114530")


class ParameterTests(unittest.TestCase):
    def test_coerces_an_override_to_the_type_of_its_default(self) -> None:
        resolved = resolve_macro_params(
            {"count": 5, "radius": 2.5, "name": "Plate", "tapped": True},
            {"count": "9", "radius": "7.25", "name": "Rail", "tapped": "no"},
        )
        self.assertEqual(resolved, {"count": 9, "radius": 7.25, "name": "Rail", "tapped": False})

    def test_keeps_defaults_nobody_overrode(self) -> None:
        self.assertEqual(resolve_macro_params({"count": 5}, {}), {"count": 5})

    def test_refuses_an_undeclared_parameter(self) -> None:
        with self.assertRaises(SketchForgeError) as caught:
            resolve_macro_params({"count": 5}, {"cuont": "9"})
        self.assertIn("count", str(caught.exception))


    def test_refuses_a_whole_number_that_is_not_one(self) -> None:
        with self.assertRaises(SketchForgeError):
            resolve_macro_params({"count": 5}, {"count": "4.5"})

    def test_refuses_a_boolean_that_is_neither(self) -> None:
        with self.assertRaises(SketchForgeError):
            resolve_macro_params({"tapped": True}, {"tapped": "maybe"})

    def test_parses_name_value_pairs_and_keeps_an_inner_equals(self) -> None:
        self.assertEqual(parse_parameters(["--count=5", "--label=a=b"]), {"count": "5", "label": "a=b"})

    def test_refuses_a_flag_with_no_value(self) -> None:
        with self.assertRaises(SketchForgeError):
            parse_parameters(["--count"])


class DescribeMacroTests(unittest.TestCase):
    def test_cli_describes_defaults_without_executing_the_macro_file(self) -> None:
        source = '''
raise RuntimeError("describe must not execute macro code")
def build(context):
    pass
MACRO = define_macro(
    name="Bracket",
    project=("replace", "Bracket prototype"),
    description="A reusable bracket",
    params={"width": 24.0, "holes": 4, "label": "M8"},
    run=build,
)
'''
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "bracket.py")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(source)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exit_code = main([path, "--describe", "--json"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(output.getvalue()), {
            "name": "Bracket",
            "description": "A reusable bracket",
            "project": {"mode": "replace", "name": "Bracket prototype"},
            "params": {"width": 24.0, "holes": 4, "label": "M8"},
        })


class ProjectModeTests(unittest.TestCase):
    def test_stamps_a_fresh_projects_name(self) -> None:
        opener = FakeOpener((201, {"project": project_payload("p9", "Bolt plate 20260102-114530")}))
        macro = define_macro("Bolt plate", lambda _: None, project="fresh")
        moment = datetime.datetime(2026, 1, 2, 11, 45, 30, tzinfo=datetime.timezone.utc)
        resolved = resolve_macro_project(client(opener), macro, now=moment)
        self.assertEqual(opener.calls[0].body, {"name": "Bolt plate 20260102-114530"})
        self.assertTrue(resolved.created)
        self.assertEqual(resolved.project.id, "p9")

    def test_empties_an_existing_project_for_replace(self) -> None:
        opener = FakeOpener(
            {"projects": [project_payload("p1", "Bolt plate")]},
            {"shapes": [shape_payload("s1")]},
            {"deleted": True, "id": "s1"},
        )
        macro = define_macro("x", lambda _: None, project=("replace", "Bolt plate"))
        resolved = resolve_macro_project(client(opener), macro)
        self.assertFalse(resolved.created)
        self.assertEqual(resolved.cleared, 1)
        self.assertEqual([call.method for call in opener.calls], ["GET", "GET", "DELETE"])

    def test_creates_the_named_project_for_replace_when_absent(self) -> None:
        opener = FakeOpener({"projects": []}, (201, {"project": project_payload("p2", "Bolt plate")}))
        macro = define_macro("x", lambda _: None, project=("replace", "Bolt plate"))
        resolved = resolve_macro_project(client(opener), macro)
        self.assertTrue(resolved.created)
        self.assertEqual(opener.calls[1].body, {"name": "Bolt plate"})

    def test_leaves_an_existing_project_alone_for_reuse(self) -> None:
        opener = FakeOpener({"projects": [project_payload("p1", "Shelf")]})
        macro = define_macro("Shelf", lambda _: None, project="reuse")
        resolved = resolve_macro_project(client(opener), macro)
        self.assertEqual((resolved.created, resolved.cleared), (False, 0))
        self.assertEqual(len(opener.calls), 1)

    def test_refuses_to_guess_a_project_for_target(self) -> None:
        opener = FakeOpener({})
        macro = define_macro("Add rib", lambda _: None, project="target")
        with self.assertRaises(SketchForgeError) as caught:
            resolve_macro_project(client(opener), macro)
        self.assertIn("SKETCHFORGE_PROJECT_ID", str(caught.exception))
        self.assertEqual(opener.calls, [])

    def test_checks_the_named_project_exists_first(self) -> None:
        opener = FakeOpener(
            {"project": {"id": "p5", "name": "Frame", "createdAt": 0, "snapGrid": {}, "workspace": {}, "shapes": []}}
        )
        macro = define_macro("Add rib", lambda _: None, project="target")
        resolved = resolve_macro_project(client(opener), macro, target_project_id="p5")
        self.assertIn("projectId=p5", opener.calls[0].url)
        self.assertEqual(resolved.project.id, "p5")

    def test_refuses_an_unknown_mode_when_the_macro_is_defined(self) -> None:
        with self.assertRaises(ValueError):
            define_macro("x", lambda _: None, project="append")


class RunMacroTests(unittest.TestCase):
    def test_hands_the_macro_its_project_and_reports_what_landed(self) -> None:
        opener = FakeOpener(
            (201, {"project": project_payload("p3", "Row 20260102-114530")}),
            (201, {"shapes": [shape_payload("s1")], "revision": 2}),
            {"shapes": [shape_payload("s1"), shape_payload("s2")]},
        )

        def build(context):  # noqa: ANN001, ANN202 - a macro body
            context.project.add({"kind": "box", "width": context.params["count"]})
            return {"count": context.params["count"]}

        macro = define_macro("Row", build, project="fresh", params={"count": 2})
        report = run_macro(client(opener), macro, params={"count": "3"})
        self.assertEqual(report.project_id, "p3")
        self.assertTrue(report.project_created)
        self.assertEqual(report.shape_count, 2)
        self.assertEqual(report.result, {"count": 3})
        self.assertEqual(opener.calls[1].body, {"kind": "box", "width": 3})

    def test_refuses_a_bad_parameter_before_creating_anything(self) -> None:
        opener = FakeOpener({})
        macro = define_macro("Row", lambda _: None, project="fresh", params={"count": 2})
        with self.assertRaises(SketchForgeError):
            run_macro(client(opener), macro, params={"count": "lots"})
        self.assertEqual(opener.calls, [])

    def test_mentions_clearing_only_when_something_was_cleared(self) -> None:
        opener = FakeOpener(
            {"projects": [project_payload("p1", "Plate")]},
            {"shapes": [shape_payload("s1")]},
            {"deleted": True, "id": "s1"},
        )
        macro = define_macro("Plate", lambda _: None, project=("replace", "Plate"))
        report = run_macro(client(opener), macro)
        self.assertEqual(report.shapes_cleared, 1)
        self.assertIn("cleared    1", describe_report(report))


class MacroLoadingTests(unittest.TestCase):
    def test_takes_a_defined_macro_from_the_module(self) -> None:
        class Module:
            MACRO = define_macro("Plate", lambda _: None, project="replace")

        self.assertEqual(macro_from_module(Module, "file").name, "Plate")

    def test_takes_a_bare_run_function_as_a_fresh_macro(self) -> None:
        class Module:
            @staticmethod
            def run(context):  # noqa: ANN001, ANN205 - a macro body
                return None

        macro = macro_from_module(Module, "bolt-plate")
        self.assertEqual((macro.name, macro.project), ("bolt-plate", "fresh"))

    def test_explains_itself_when_the_module_is_not_a_macro(self) -> None:
        class Module:
            pass

        with self.assertRaises(SketchForgeError) as caught:
            macro_from_module(Module, "bolt-plate")
        self.assertIn("define_macro", str(caught.exception))

    def test_loads_a_macro_from_a_file(self) -> None:
        source = (
            "from sketchforge3d import define_macro\n"
            "MACRO = define_macro('From file', lambda context: None, project='reuse')\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "my-macro.py")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(source)
            macro = load_macro_file(path)
        self.assertEqual((macro.name, macro.project), ("From file", "reuse"))

    def test_says_so_when_the_file_is_not_there(self) -> None:
        with self.assertRaises(SketchForgeError):
            load_macro_file("/nowhere/at/all.py")


class EnvironmentTests(unittest.TestCase):
    def test_explains_the_missing_token(self) -> None:
        with self.assertRaises(MissingConfigurationError) as caught:
            client_from_environment({})
        self.assertIn("SKETCHFORGE_API_TOKEN", str(caught.exception))

    def test_defaults_the_base_url_to_the_local_dev_server(self) -> None:
        instance = client_from_environment({"SKETCHFORGE_API_TOKEN": "t"})
        self.assertEqual(instance.api_root, "http://127.0.0.1:3000/api/v1")

    def test_takes_the_base_url_from_the_environment(self) -> None:
        instance = client_from_environment({"SKETCHFORGE_API_TOKEN": "t", "SKETCHFORGE_URL": "http://box:3100"})
        self.assertEqual(instance.api_root, "http://box:3100/api/v1")

    def test_treats_an_empty_project_id_as_unset(self) -> None:
        self.assertIsNone(target_project_from_environment({"SKETCHFORGE_PROJECT_ID": ""}))
        self.assertEqual(target_project_from_environment({"SKETCHFORGE_PROJECT_ID": "p1"}), "p1")


if __name__ == "__main__":
    unittest.main()
