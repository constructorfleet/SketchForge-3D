from __future__ import annotations

import unittest
from typing import Any, Dict

from sketchforge3d import (
    ConstraintBindingIssue,
    SketchConstraintBindResult,
    SketchConstraintSummary,
    SketchForgeApiError,
    SketchForgeClient,
)

from support import FakeOpener, shape_payload

WIDTH: Dict[str, Any] = {"id": "width", "kind": "distance", "value": 3, "expression": "w"}
BAR = shape_payload("s1", width=3, sketchConstraints=[WIDTH, {"id": "depth", "kind": "distance", "value": 2}])


def client(opener: FakeOpener, expected_revision: Any = None) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener, expected_revision=expected_revision)


class SketchConstraintTests(unittest.TestCase):
    def test_binds_a_constraint_with_patch_naming_shape_and_constraint(self) -> None:
        opener = FakeOpener({"shape": BAR, "constraint": WIDTH, "revision": 5})

        result = client(opener, expected_revision=4).sketch_constraints.bind("p1", "s1", "width", "w")

        call = opener.calls[0]
        self.assertEqual(call.method, "PATCH")
        self.assertEqual(call.url, "http://localhost:3100/api/v1/sketch-constraints?projectId=p1&shapeId=s1&constraintId=width")
        self.assertEqual(call.body, {"expression": "w"})
        self.assertEqual(call.headers["if-match"], '"4"')
        self.assertIsInstance(result, SketchConstraintBindResult)
        self.assertEqual(result.constraint, SketchConstraintSummary(id="width", kind="distance", value=3.0, expression="w"))
        self.assertEqual(result.shape.sketch_constraints[1], SketchConstraintSummary(id="depth", kind="distance", value=2.0))
        self.assertEqual(result.revision, 5)

    def test_unbinds_with_null_sent_in_the_body(self) -> None:
        opener = FakeOpener({"shape": BAR, "constraint": {"id": "width", "kind": "distance", "value": 3}, "revision": 6})

        result = client(opener).sketch_constraints.unbind("p1", "sketch/s1", "width")

        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/sketch-constraints?projectId=p1&shapeId=sketch%2Fs1&constraintId=width")
        self.assertEqual(opener.calls[0].body, {"expression": None})
        self.assertIsNone(result.constraint.expression)

    def test_refuses_an_empty_expression_and_surfaces_a_constraint_refusal(self) -> None:
        empty = FakeOpener({})
        with self.assertRaises(ValueError):
            client(empty).sketch_constraints.bind("p1", "s1", "width", "  ")
        self.assertEqual(empty.calls, [])

        refused = FakeOpener((422, {"error": "width: out of range", "code": "invalid_expression", "constraintId": "width", "reason": "outOfRange"}))
        with self.assertRaises(SketchForgeApiError) as raised:
            client(refused).sketch_constraints.bind("p1", "s1", "width", "-w")
        self.assertEqual(raised.exception.status, 422)
        self.assertEqual(raised.exception.code, "invalid_expression")
        self.assertEqual(raised.exception.body["constraintId"], "width")

    def test_project_handle_and_parameter_list_report_constraint_bindings(self) -> None:
        opener = FakeOpener(
            {"shape": BAR, "constraint": WIDTH, "revision": 5},
            {
                "parameters": [],
                "bindingIssues": [],
                "constraintBindingIssues": [
                    {"shapeId": "s1", "constraintId": "width", "code": "conflictingBinding", "message": "Conflict.", "fields": ["width"]}
                ],
                "revision": 5,
            },
        )
        project = client(opener).project("p1")

        project.bind_sketch_constraint("s1", "width", "w")
        listed = project.parameters()

        self.assertEqual(opener.calls[0].body, {"expression": "w"})
        self.assertEqual(
            listed.constraint_binding_issues,
            [ConstraintBindingIssue(shape_id="s1", constraint_id="width", code="conflictingBinding", message="Conflict.", fields=["width"])],
        )


if __name__ == "__main__":
    unittest.main()
