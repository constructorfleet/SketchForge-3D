from __future__ import annotations

import unittest
import urllib.parse
from typing import Any, Dict

from sketchforge3d import (
    ConfigurationDeleteResult,
    ConfigurationIssue,
    ConfigurationList,
    ConfigurationWriteResult,
    ParameterConfiguration,
    SketchForgeApiError,
    SketchForgeClient,
)

from support import FakeOpener, shape_payload

WALL: Dict[str, Any] = {"name": "wall", "expression": "2 mm", "dimension": "length", "value": 4}
LARGE: Dict[str, Any] = {"name": "Large", "overrides": {"wall": "4"}}
BOUND_BOX = shape_payload("s1", width=20, x=40, expressions={"width": "wall * 5", "x": "wall * 10"})
STATE: Dict[str, Any] = {"configurations": [LARGE], "activeConfiguration": "Large", "parameters": [WALL], "issues": []}
WRITTEN: Dict[str, Any] = {"configuration": LARGE, **STATE, "shapes": [BOUND_BOX], "revision": 6}
PATH = "/api/v1/parameter-configurations"


def client(opener: FakeOpener) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener)


def split(url: str) -> "tuple[str, Dict[str, str]]":
    parts = urllib.parse.urlsplit(url)
    return parts.path, dict(urllib.parse.parse_qsl(parts.query))


class ConfigurationsTests(unittest.TestCase):
    def test_lists_configurations_the_active_one_and_stale_overrides(self) -> None:
        issue = {"configuration": "Old", "parameter": "gone", "code": "unknownParameter", "message": "No parameter gone."}
        opener = FakeOpener({**STATE, "issues": [issue], "revision": 5})

        listed = client(opener).configurations.list("p1")

        self.assertEqual(opener.calls[0].method, "GET")
        self.assertEqual(split(opener.calls[0].url), (PATH, {"projectId": "p1"}))
        self.assertIsInstance(listed, ConfigurationList)
        self.assertEqual(listed.configurations, [ParameterConfiguration(name="Large", overrides={"wall": "4"})])
        self.assertEqual(listed.active_configuration, "Large")
        self.assertEqual(listed.parameters[0].value, 4.0)
        self.assertEqual(listed.issues, [ConfigurationIssue(configuration="Old", parameter="gone", code="unknownParameter", message="No parameter gone.")])
        self.assertEqual(listed.revision, 5)

    def test_creates_a_configuration_with_its_overrides(self) -> None:
        opener = FakeOpener((201, {**WRITTEN, "activeConfiguration": None, "shapes": []}))

        result = client(opener).configurations.create("p1", "Large", {"wall": "4"})

        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].body, {"name": "Large", "overrides": {"wall": "4"}})
        self.assertIsInstance(result, ConfigurationWriteResult)
        self.assertEqual(result.configuration, ParameterConfiguration(name="Large", overrides={"wall": "4"}))
        self.assertIsNone(result.active_configuration)

    def test_creates_a_configuration_without_overrides_by_sending_the_name_alone(self) -> None:
        opener = FakeOpener((201, WRITTEN))
        client(opener).configurations.create("p1", "Small")
        self.assertEqual(opener.calls[0].body, {"name": "Small"})

    def test_renames_sets_and_clears_by_configuration_name(self) -> None:
        opener = FakeOpener(WRITTEN, WRITTEN, WRITTEN)
        api = client(opener)

        api.configurations.rename("p1", "Large", "Big")
        api.configurations.set_override("p1", "Large", "wall", "3")
        api.configurations.clear_override("p1", "Large", "wall")

        self.assertEqual(
            [(call.method, split(call.url), call.body) for call in opener.calls],
            [
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"}), {"name": "Big"}),
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"}), {"parameter": "wall", "expression": "3"}),
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"}), {"parameter": "wall", "expression": None}),
            ],
        )

    def test_refuses_none_as_an_override_expression(self) -> None:
        opener = FakeOpener(WRITTEN)
        with self.assertRaisesRegex(ValueError, "clear_override"):
            client(opener).configurations.set_override("p1", "Large", "wall", None)  # type: ignore[arg-type]
        self.assertEqual(opener.calls, [])

    def test_deletes_a_configuration(self) -> None:
        body = {"deleted": True, "name": "Large", **STATE, "activeConfiguration": None, "shapes": [BOUND_BOX], "revision": 7}
        opener = FakeOpener(body)

        result = client(opener).configurations.delete("p1", "Large")

        self.assertEqual(opener.calls[0].method, "DELETE")
        self.assertEqual(split(opener.calls[0].url), (PATH, {"projectId": "p1", "name": "Large"}))
        self.assertIsNone(opener.calls[0].body)
        self.assertIsInstance(result, ConfigurationDeleteResult)
        self.assertTrue(result.deleted)
        self.assertIsNone(result.active_configuration)
        self.assertEqual(result.shapes[0].id, "s1")

    def test_activates_by_name_or_the_base_table_with_none(self) -> None:
        activated = {key: value for key, value in WRITTEN.items() if key != "configuration"}
        opener = FakeOpener(activated, {**activated, "activeConfiguration": None})
        api = client(opener)

        result = api.configurations.activate("p1", "Large")
        api.configurations.activate("p1", None)

        self.assertEqual(
            [(call.method, split(call.url), call.body) for call in opener.calls],
            [
                ("POST", (f"{PATH}/activate", {"projectId": "p1"}), {"name": "Large"}),
                ("POST", (f"{PATH}/activate", {"projectId": "p1"}), {"name": None}),
            ],
        )
        self.assertIsNone(result.configuration)
        self.assertEqual((result.shapes[0].width, result.shapes[0].x), (20, 40))

    def test_escapes_a_configuration_name(self) -> None:
        opener = FakeOpener(WRITTEN)
        client(opener).configurations.rename("p1", "Extra Large & Co", "XL")
        self.assertEqual(split(opener.calls[0].url)[1]["name"], "Extra Large & Co")

    def test_binds_the_project_id_through_a_handle(self) -> None:
        opener = FakeOpener(
            {**STATE, "revision": 5},
            (201, WRITTEN),
            WRITTEN,
            WRITTEN,
            WRITTEN,
            WRITTEN,
            {"deleted": True, "name": "Big", **STATE, "shapes": [], "revision": 9},
        )
        project = client(opener).project("p1")

        project.configurations()
        project.add_configuration("Large", {"wall": "4"})
        project.set_configuration_override("Large", "wall", "3")
        project.clear_configuration_override("Large", "wall")
        project.rename_configuration("Large", "Big")
        project.activate_configuration("Big")
        project.delete_configuration("Big")

        self.assertEqual(
            [(call.method, split(call.url)) for call in opener.calls],
            [
                ("GET", (PATH, {"projectId": "p1"})),
                ("POST", (PATH, {"projectId": "p1"})),
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"})),
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"})),
                ("PATCH", (PATH, {"projectId": "p1", "name": "Large"})),
                ("POST", (f"{PATH}/activate", {"projectId": "p1"})),
                ("DELETE", (PATH, {"projectId": "p1", "name": "Big"})),
            ],
        )

    def test_reads_the_active_configuration_from_the_parameter_list(self) -> None:
        opener = FakeOpener({"parameters": [WALL], "activeConfiguration": "Large", "bindingIssues": [], "revision": 3})
        self.assertEqual(client(opener).parameters.list("p1").active_configuration, "Large")

    def test_tells_a_missing_configuration_from_a_taken_name(self) -> None:
        missing_opener = FakeOpener((404, {"error": "No configuration.", "code": "configuration_not_found", "configuration": "XL"}))
        with self.assertRaises(SketchForgeApiError) as missing:
            client(missing_opener).configurations.activate("p1", "XL")
        self.assertTrue(missing.exception.is_configuration_missing)
        self.assertFalse(missing.exception.is_configuration_duplicate)
        self.assertEqual(missing.exception.configuration, "XL")

        taken_opener = FakeOpener((409, {"error": "Taken.", "code": "configuration_exists", "configuration": "Large"}))
        with self.assertRaises(SketchForgeApiError) as taken:
            client(taken_opener).configurations.create("p1", "Large")
        self.assertTrue(taken.exception.is_configuration_duplicate)
        self.assertFalse(taken.exception.is_configuration_missing)
        self.assertFalse(taken.exception.is_project_busy)


if __name__ == "__main__":
    unittest.main()
