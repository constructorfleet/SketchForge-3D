from __future__ import annotations

import unittest
import urllib.parse
from typing import Any, Dict

from sketchforge3d import (
    PARAMETER_DIMENSIONS,
    BindingIssue,
    ExpressionError,
    ExpressionSpan,
    ParameterDeleteResult,
    ParameterList,
    ParameterWriteResult,
    ProjectParameter,
    ShapeDependent,
    SketchForgeApiError,
    SketchForgeClient,
)
from sketchforge3d.types import ShapeSummary

from support import FakeOpener, shape_payload

WALL: Dict[str, Any] = {"name": "wall", "expression": "2 mm", "dimension": "length", "value": 2}
BOUND_BOX = shape_payload("s1", width=10, expressions={"width": "wall * 5"})
WRITTEN = {"parameter": WALL, "parameters": [WALL], "shapes": [BOUND_BOX], "revision": 4}


def client(opener: FakeOpener) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener)


def query(url: str) -> Dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


class ParametersTests(unittest.TestCase):
    def test_lists_the_table_with_its_binding_issues_and_revision(self) -> None:
        stale = {
            **WALL,
            "name": "gap",
            "expression": "missing + 1",
            "value": None,
            "error": {
                "code": "invalidExpression",
                "message": "Unknown name missing.",
                "expressionError": {"code": "unknownName", "message": "Unknown name missing.", "span": {"start": 0, "end": 7}},
            },
        }
        issue = {"shapeId": "s1", "field": "width", "code": "invalidExpression", "message": "Unknown name gap."}
        opener = FakeOpener({"parameters": [WALL, stale], "bindingIssues": [issue], "revision": 3})

        listed = client(opener).parameters.list("p1")

        self.assertEqual(opener.calls[0].method, "GET")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/parameters?projectId=p1")
        self.assertIsInstance(listed, ParameterList)
        self.assertEqual([(entry.name, entry.value) for entry in listed.parameters], [("wall", 2.0), ("gap", None)])
        self.assertIsNone(listed.parameters[0].error)
        stale_error = listed.parameters[1].error
        assert stale_error is not None and stale_error.expression_error is not None
        self.assertEqual(stale_error.code, "invalidExpression")
        self.assertEqual(stale_error.expression_error.span, ExpressionSpan(start=0, end=7))
        self.assertEqual(listed.binding_issues, [BindingIssue(shape_id="s1", field="width", code="invalidExpression", message="Unknown name gap.")])
        self.assertEqual(listed.revision, 3)

    def test_creates_a_parameter_with_its_name_expression_and_dimension(self) -> None:
        opener = FakeOpener((201, WRITTEN))

        result = client(opener).parameters.create("p1", "wall", "2 mm", "length")

        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/parameters?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"name": "wall", "expression": "2 mm", "dimension": "length"})
        self.assertIsInstance(result, ParameterWriteResult)
        self.assertEqual(result.parameter, ProjectParameter(name="wall", expression="2 mm", dimension="length", value=2.0))
        self.assertEqual(result.shapes[0].expressions, {"width": "wall * 5"})
        self.assertEqual(result.revision, 4)

    def test_refuses_a_dimension_the_server_does_not_know(self) -> None:
        opener = FakeOpener((201, WRITTEN))
        with self.assertRaisesRegex(ValueError, "length, angle, unitless"):
            client(opener).parameters.create("p1", "wall", "2", "volume")  # type: ignore[arg-type]
        self.assertEqual(opener.calls, [])

    def test_changes_a_parameter_by_name_sending_only_what_changes(self) -> None:
        opener = FakeOpener(WRITTEN)

        client(opener).parameters.update("p1", "wall", expression="3 mm")

        self.assertEqual(opener.calls[0].method, "PATCH")
        self.assertEqual(query(opener.calls[0].url), {"projectId": "p1", "name": "wall"})
        self.assertEqual(opener.calls[0].body, {"expression": "3 mm"})

    def test_refuses_an_empty_change_before_it_reaches_the_server(self) -> None:
        opener = FakeOpener(WRITTEN)
        with self.assertRaisesRegex(ValueError, "expression or a dimension"):
            client(opener).parameters.update("p1", "wall")
        self.assertEqual(opener.calls, [])

    def test_renames_with_the_new_name_alone(self) -> None:
        opener = FakeOpener({**WRITTEN, "parameter": {**WALL, "name": "shell"}})

        result = client(opener).parameters.rename("p1", "wall", "shell")

        self.assertEqual(opener.calls[0].method, "PATCH")
        self.assertEqual(query(opener.calls[0].url), {"projectId": "p1", "name": "wall"})
        self.assertEqual(opener.calls[0].body, {"name": "shell"})
        self.assertEqual(result.parameter.name, "shell")

    def test_deletes_a_parameter_by_name(self) -> None:
        opener = FakeOpener({"deleted": True, "name": "wall", "parameters": [], "shapes": [], "revision": 5})

        result = client(opener).parameters.delete("p1", "wall")

        self.assertEqual(opener.calls[0].method, "DELETE")
        self.assertEqual(query(opener.calls[0].url), {"projectId": "p1", "name": "wall"})
        self.assertIsNone(opener.calls[0].body)
        self.assertEqual(result, ParameterDeleteResult(deleted=True, name="wall", parameters=[], shapes=[], revision=5))

    def test_escapes_a_parameter_name(self) -> None:
        opener = FakeOpener(WRITTEN)
        client(opener).parameters.update("p1", "a&b=c", dimension="angle")
        self.assertEqual(query(opener.calls[0].url)["name"], "a&b=c")

    def test_binds_the_project_id_through_a_handle(self) -> None:
        opener = FakeOpener(
            {"parameters": [WALL], "bindingIssues": [], "revision": 3},
            (201, WRITTEN),
            WRITTEN,
            WRITTEN,
            {"deleted": True, "name": "shell", "parameters": [], "shapes": [], "revision": 7},
            {"shape": BOUND_BOX, "revision": 8},
        )
        project = client(opener).project("p1")

        project.parameters()
        project.add_parameter("wall", "2 mm", "length")
        project.update_parameter("wall", expression="3 mm")
        project.rename_parameter("wall", "shell")
        project.delete_parameter("shell")
        project.bind_expressions("s1", {"width": "wall * 5", "height": None})

        self.assertEqual(
            [(call.method, query(call.url)) for call in opener.calls],
            [
                ("GET", {"projectId": "p1"}),
                ("POST", {"projectId": "p1"}),
                ("PATCH", {"projectId": "p1", "name": "wall"}),
                ("PATCH", {"projectId": "p1", "name": "wall"}),
                ("DELETE", {"projectId": "p1", "name": "shell"}),
                ("PATCH", {"projectId": "p1", "shapeId": "s1"}),
            ],
        )
        self.assertEqual(opener.calls[5].body, {"expressions": {"width": "wall * 5", "height": None}})

    def test_names_the_dimensions_the_api_contract_does(self) -> None:
        self.assertEqual(PARAMETER_DIMENSIONS, ("length", "angle", "unitless"))


class ShapeExpressionsTests(unittest.TestCase):
    def test_sends_expressions_on_create_beside_the_numbers(self) -> None:
        opener = FakeOpener((201, {"shapes": [BOUND_BOX], "revision": 2}))

        created = client(opener).shapes.create(
            "p1", {"kind": "box", "depth": 10, "height": 10, "expressions": {"width": "wall * 5", "revolve.sweepAngle": "sweep"}}
        )

        self.assertEqual(opener.calls[0].body["expressions"], {"width": "wall * 5", "revolve.sweepAngle": "sweep"})
        self.assertEqual(created.expressions, {"width": "wall * 5"})
        self.assertNotIn("expressions", created.extra)

    def test_clears_a_binding_with_none_on_update(self) -> None:
        opener = FakeOpener({"shape": shape_payload("s1"), "revision": 3})

        updated = client(opener).shapes.update("p1", "s1", {"expressions": {"width": None}})

        self.assertEqual(opener.calls[0].body, {"expressions": {"width": None}})
        self.assertEqual(updated.expressions, {})

    def test_echoes_a_summarys_expressions_back(self) -> None:
        summary = ShapeSummary.from_payload(BOUND_BOX)
        patch = summary.as_patch(height=20)
        self.assertEqual(patch["expressions"], {"width": "wall * 5"})
        self.assertEqual(patch["width"], 10)
        self.assertEqual(patch["height"], 20)
        self.assertNotIn("expressions", ShapeSummary.from_payload(shape_payload("s2")).as_patch())


class ParameterErrorTests(unittest.TestCase):
    def refusal(self, opener: FakeOpener, call: Any) -> SketchForgeApiError:
        with self.assertRaises(SketchForgeApiError) as caught:
            call(client(opener))
        return caught.exception

    def test_reads_an_expression_failures_evaluator_detail(self) -> None:
        detail = {"code": "cycle", "message": "Reference cycle: a → b → a.", "span": {"start": 0, "end": 1}, "cycle": ["a", "b", "a"]}
        opener = FakeOpener((422, {"error": "Cycle.", "code": "invalid_expression", "parameter": "a", "reason": "invalidExpression", "expressionError": detail}))

        error = self.refusal(opener, lambda api: api.parameters.update("p1", "a", expression="b"))

        self.assertTrue(error.is_invalid_expression)
        self.assertEqual(error.parameter, "a")
        self.assertEqual(error.reason, "invalidExpression")
        self.assertEqual(
            error.expression_error,
            ExpressionError(code="cycle", message="Reference cycle: a → b → a.", span=ExpressionSpan(0, 1), cycle=["a", "b", "a"]),
        )

    def test_tells_a_missing_parameter_from_a_taken_name(self) -> None:
        missing = self.refusal(
            FakeOpener((404, {"error": "No parameter.", "code": "parameter_not_found", "parameter": "x"})),
            lambda api: api.parameters.delete("p1", "x"),
        )
        self.assertTrue(missing.is_parameter_missing)
        self.assertFalse(missing.is_parameter_duplicate)

        taken = self.refusal(
            FakeOpener((409, {"error": "Taken.", "code": "parameter_exists", "parameter": "wall"})),
            lambda api: api.parameters.create("p1", "wall", "1", "length"),
        )
        self.assertTrue(taken.is_parameter_duplicate)
        self.assertFalse(taken.is_parameter_missing)
        self.assertFalse(taken.is_project_busy)

    def test_lists_what_still_uses_a_parameter(self) -> None:
        opener = FakeOpener((409, {
            "error": "In use.",
            "code": "parameter_in_use",
            "parameter": "wall",
            "dependents": ["gap"],
            "shapeDependents": [{"shapeId": "s1", "fields": ["width", "x"]}],
        }))

        error = self.refusal(opener, lambda api: api.parameters.delete("p1", "wall"))

        self.assertTrue(error.is_parameter_in_use)
        self.assertFalse(error.is_project_busy)
        self.assertEqual(error.dependents, ["gap"])
        self.assertEqual(error.shape_dependents, [ShapeDependent(shape_id="s1", fields=["width", "x"])])

    def test_names_the_shape_field_and_batch_index_of_a_binding_refusal(self) -> None:
        contradiction = self.refusal(
            FakeOpener((400, {"error": "Disagree.", "code": "invalid_request", "shapeId": "s1", "field": "width"})),
            lambda api: api.shapes.update("p1", "s1", {"width": 3, "expressions": {"width": "wall"}}),
        )
        self.assertEqual(contradiction.shape_id, "s1")
        self.assertEqual(contradiction.field, "width")
        self.assertIsNone(contradiction.index)

        batch = self.refusal(
            FakeOpener((422, {"error": "Bad.", "code": "invalid_expression", "index": 1, "field": "width", "reason": "outOfRange"})),
            lambda api: api.shapes.create_many("p1", [{"kind": "box"}, {"kind": "box"}]),
        )
        self.assertEqual(batch.index, 1)
        self.assertIsNone(batch.shape_id)

        locked = self.refusal(
            FakeOpener((409, {"error": "Locked.", "code": "shape_locked", "shapeId": "s1", "fields": ["width"]})),
            lambda api: api.parameters.update("p1", "wall", expression="4"),
        )
        self.assertTrue(locked.is_shape_locked)
        self.assertEqual(locked.fields, ["width"])

    def test_answers_empty_details_when_the_body_carries_none(self) -> None:
        error = self.refusal(
            FakeOpener((404, {"error": "Gone.", "code": "shape_not_found"})),
            lambda api: api.shapes.delete("p1", "s1"),
        )
        self.assertIsNone(error.parameter)
        self.assertIsNone(error.reason)
        self.assertIsNone(error.expression_error)
        self.assertEqual(error.dependents, [])
        self.assertEqual(error.shape_dependents, [])
        self.assertEqual(error.fields, [])


if __name__ == "__main__":
    unittest.main()
