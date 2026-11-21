"""
The worked examples, run against a real server.

These are the integration tests: the examples are the thing most likely to break
when the API changes, and running them proves the client, the macro runner and
the geometry together. They are kept out of the unit run because they need a
server with a token and a projects directory -- see the package README.
"""

from __future__ import annotations

import math
import os
import unittest
from typing import Any, Dict, List

from sketchforge3d import SketchForgeApiError, client_from_environment, load_macro_file, run_macro

EXAMPLES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "examples")


class ExampleMacroTests(unittest.TestCase):
    created: List[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        cls.client = client_from_environment()
        health = cls.client.check()
        if not health.get("ok"):
            raise unittest.SkipTest(
                "The integration tests need a live SketchForge server: "
                f"{health.get('reason')}. Start one with SKETCHFORGE_PROJECTS_DIR, "
                "SKETCHFORGE_API_TOKEN and PORT set, then point SKETCHFORGE_URL at it."
            )

    @classmethod
    def tearDownClass(cls) -> None:
        for project_id in dict.fromkeys(cls.created):
            try:
                cls.client.projects.delete(project_id)
            except SketchForgeApiError:
                pass

    def run_example(self, name: str, **params: str) -> Any:
        macro = load_macro_file(os.path.join(EXAMPLES, name))
        report = run_macro(self.client, macro, params=params)
        type(self).created.append(report.project_id)
        return report

    def test_bolt_plate_is_sized_around_its_row_of_tapped_holes(self) -> None:
        report = self.run_example("bolt_plate.py", holes="5", spacing="25", size="M8", thickness="8")
        result: Dict[str, Any] = report.result

        self.assertEqual(result["holes"], 5)
        # Four 25mm gaps, plus the bolt's radius and the margin at each end.
        self.assertEqual(result["plate"]["width"], 132)
        self.assertEqual(result["plate"]["depth"], 32)
        self.assertEqual(report.shape_count, 6)

        shapes = self.client.shapes.list(report.project_id)
        holes = [shape for shape in shapes if shape.hole]
        self.assertEqual(len(holes), 5)
        self.assertEqual([round(hole.x) for hole in holes], [-50, -25, 0, 25, 50])
        # A thread is built by manifold and stored as a mesh, whatever it was asked for.
        self.assertEqual({hole.kind for hole in holes}, {"mesh"})

    def test_bolt_plate_rerun_leaves_one_plate(self) -> None:
        first = self.run_example("bolt_plate.py", holes="3", spacing="20")
        second = self.run_example("bolt_plate.py", holes="3", spacing="20")
        self.assertEqual(second.project_id, first.project_id)
        self.assertEqual(second.shapes_cleared, 4)
        self.assertEqual(second.shape_count, 4)

    def test_bolt_circle_puts_n_holes_on_a_ring_of_radius_r(self) -> None:
        report = self.run_example("bolt_circle.py", holes="6", radius="30", size="M6", bore="20")
        result: Dict[str, Any] = report.result

        self.assertEqual(result["holes"], 6)
        self.assertEqual(result["angles"], [0, 60, 120, 180, -120, -60])
        self.assertEqual(result["outerDiameter"], 84)
        # The flange, six holes, and the bore.
        self.assertEqual(report.shape_count, 8)

        shapes = self.client.shapes.list(report.project_id)
        for hole in [shape for shape in shapes if shape.name.startswith("M6")]:
            self.assertAlmostEqual(math.hypot(hole.x, hole.z), 30, places=3)

    def test_bolt_circle_creates_a_new_project_per_run(self) -> None:
        first = self.run_example("bolt_circle.py", holes="3")
        second = self.run_example("bolt_circle.py", holes="4")
        self.assertNotEqual(second.project_id, first.project_id)
        self.assertTrue(second.project_created)

    def test_filleted_box_rounds_every_roundable_edge(self) -> None:
        report = self.run_example("filleted_box.py", width="60", depth="40", height="20", radius="4")
        result: Dict[str, Any] = report.result

        self.assertEqual(result["edges"], 12)
        self.assertEqual(result["rounded"], 12)
        self.assertGreater(result["triangles"], 0)
        self.assertEqual(result["size"], {"width": 60, "depth": 40, "height": 20})

    def test_face_colors_survive_a_fillet_by_stable_id(self) -> None:
        report = self.run_example("face_colors.py", width="60", depth="40", height="20", radius="4")
        result: Dict[str, Any] = report.result

        # The top and bottom of a box are the same faces after its vertical
        # edges are rounded, so their colors are still keyed by the same ids.
        self.assertEqual(result["painted"], 2)
        self.assertEqual(result["coloredBefore"], 2)
        self.assertEqual(result["survived"], 2)
        self.assertEqual(result["lost"], 0)
        self.assertEqual(sorted(result["colorsAfter"].values()), ["#1565c0", "#2e7d32"])
        # And the keys are ids, not indexes -- the whole point of the feature.
        for face_id in result["colorsAfter"]:
            self.assertTrue(face_id.startswith("face_"), face_id)

    def test_filleted_box_refuses_a_radius_the_geometry_cannot_take(self) -> None:
        with self.assertRaises(SketchForgeApiError) as caught:
            self.run_example("filleted_box.py", width="30", depth="30", height="2", radius="9")
        self.assertEqual(caught.exception.status, 422)

    def test_parametric_box_rebuilds_the_bound_solid_when_its_parameter_changes(self) -> None:
        report = self.run_example("parametric_box.py", wall="2", resized="3")
        result: Dict[str, Any] = report.result

        self.assertEqual(result["expressions"], {"width": "wall * 5", "x": "wall * 10"})
        self.assertEqual(result["rebuilt"], 1)
        self.assertEqual((result["before"]["width"], result["before"]["x"]), (10, 20))
        self.assertEqual((result["after"]["width"], result["after"]["x"]), (15, 30))
        # 10 x 10 x (wall * 5), centred on wall * 10.
        self.assertAlmostEqual(result["before"]["volume"], 1000, places=3)
        self.assertAlmostEqual(result["before"]["centerX"], 20, places=3)
        self.assertAlmostEqual(result["after"]["volume"], 1500, places=3)
        self.assertAlmostEqual(result["after"]["centerX"], 30, places=3)

    def test_parametric_box_parameter_lifecycle(self) -> None:
        report = self.run_example("parametric_box.py")
        project = self.client.project(report.project_id)
        shape_id = report.result["shapeId"]

        with self.assertRaises(SketchForgeApiError) as refused:
            project.delete_parameter("wall")
        self.assertTrue(refused.exception.is_parameter_in_use)
        self.assertEqual(
            [(entry.shape_id, sorted(entry.fields)) for entry in refused.exception.shape_dependents],
            [(shape_id, ["width", "x"])],
        )

        renamed = project.rename_parameter("wall", "shell")
        bound = next(shape for shape in renamed.shapes if shape.id == shape_id)
        self.assertEqual(bound.expressions, {"width": "shell * 5", "x": "shell * 10"})

        with self.assertRaises(SketchForgeApiError) as invalid:
            project.update_parameter("shell", expression="shell + 1")
        self.assertTrue(invalid.exception.is_invalid_expression)
        self.assertIsNotNone(invalid.exception.expression_error)

        cleared = project.bind_expressions(shape_id, {"width": None, "x": None})
        self.assertEqual(cleared.expressions, {})
        self.assertEqual(cleared.width, 15)
        self.assertAlmostEqual(project.properties_of(shape_id).volume, 1500, places=3)

        deleted = project.delete_parameter("shell")
        self.assertTrue(deleted.deleted)
        listed = project.parameters()
        self.assertEqual((listed.parameters, listed.binding_issues), ([], []))

    def test_if_match_guards_a_stale_summary_round_trip_and_its_absence_unbinds(self) -> None:
        project_id = self.client.projects.create("Stale parameter round trip (python)").id
        type(self).created.append(project_id)
        project = self.client.project(project_id)
        project.add_parameter("wall", "2 mm", "length")
        written = project.add_many([{"kind": "box", "depth": 10, "height": 10, "expressions": {"width": "wall * 5"}}])
        box, read_at = written.shapes[0], written.revision
        stale = box.as_patch()
        changed = project.update_parameter("wall", expression="3 mm")
        self.assertGreater(changed.revision, read_at)

        guarded = client_from_environment(expected_revision=read_at)
        for write in (
            lambda: guarded.shapes.update(project_id, box.id, stale),
            lambda: guarded.parameters.update(project_id, "wall", expression="4 mm"),
        ):
            with self.assertRaises(SketchForgeApiError) as refused:
                write()
            self.assertTrue(refused.exception.is_revision_mismatch)
            self.assertEqual(refused.exception.current_revision, changed.revision)
        self.assertAlmostEqual(project.properties_of(box.id).volume, 1500, places=3)

        # The stale width counts as an edit, so the number replaces the binding.
        unguarded = project.update(box.id, stale)
        self.assertEqual(unguarded.expressions, {})
        self.assertEqual(unguarded.width, 10)
        self.assertAlmostEqual(project.properties_of(box.id).volume, 1000, places=3)

        latest = next(entry.revision for entry in self.client.projects.list() if entry.id == project_id)
        current = client_from_environment(expected_revision=latest)
        result = current.parameters.update(project_id, "wall", expression="4 mm")
        assert result.parameter is not None
        self.assertEqual(result.parameter.value, 4)


if __name__ == "__main__":
    unittest.main()
