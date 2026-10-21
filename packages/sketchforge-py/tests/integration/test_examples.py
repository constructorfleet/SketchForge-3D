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


if __name__ == "__main__":
    unittest.main()
