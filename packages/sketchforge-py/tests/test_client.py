from __future__ import annotations

import unittest

from sketchforge3d import SketchForgeApiError, SketchForgeClient, SketchForgeTransportError, chunk
from sketchforge3d._http import Transport, build_url, normalize_base_url
from sketchforge3d.types import MAX_SHAPES_PER_REQUEST

from support import FakeOpener, project_payload, shape_payload


def client(opener: FakeOpener) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener)


class NormalizeBaseUrlTests(unittest.TestCase):
    def test_appends_the_api_prefix(self) -> None:
        self.assertEqual(normalize_base_url("http://localhost:3000"), "http://localhost:3000/api/v1")

    def test_is_idempotent(self) -> None:
        self.assertEqual(normalize_base_url("http://h/api/v1/"), "http://h/api/v1")

    def test_refuses_an_empty_base_url(self) -> None:
        with self.assertRaises(ValueError):
            normalize_base_url("  ")


class BuildUrlTests(unittest.TestCase):
    def test_puts_ids_in_the_query_string(self) -> None:
        self.assertEqual(
            build_url("http://h/api/v1", "/shapes", {"projectId": "p1", "shapeId": "s2"}),
            "http://h/api/v1/shapes?projectId=p1&shapeId=s2",
        )

    def test_omits_missing_parameters(self) -> None:
        self.assertEqual(
            build_url("http://h/api/v1", "/shapes", {"projectId": "p1", "shapeId": None}),
            "http://h/api/v1/shapes?projectId=p1",
        )

    def test_escapes_a_value(self) -> None:
        self.assertIn("projectId=a+b%26c", build_url("http://h/api/v1", "/projects", {"projectId": "a b&c"}))


class ChunkTests(unittest.TestCase):
    def test_splits_into_runs(self) -> None:
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_refuses_a_size_of_zero(self) -> None:
        with self.assertRaises(ValueError):
            chunk([1], 0)


class TransportTests(unittest.TestCase):
    def test_sends_the_token_as_a_bearer_header(self) -> None:
        opener = FakeOpener({"projects": []})
        client(opener).projects.list()
        self.assertEqual(opener.calls[0].headers["authorization"], "Bearer t")

    def test_sends_a_content_type_only_with_a_body(self) -> None:
        opener = FakeOpener({"projects": []}, (201, {"project": project_payload("p1", "Plate")}))
        instance = client(opener)
        instance.projects.list()
        instance.projects.create("Plate")
        self.assertNotIn("content-type", opener.calls[0].headers)
        self.assertEqual(opener.calls[1].headers["content-type"], "application/json")
        self.assertEqual(opener.calls[1].body, {"name": "Plate"})

    def test_raises_the_servers_message_with_its_status(self) -> None:
        opener = FakeOpener((422, {"error": "too large for this shape's edges"}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).treatments.fillet("p1", "s1", 9)
        self.assertEqual(caught.exception.status, 422)
        self.assertEqual(caught.exception.detail, "too large for this shape's edges")

    def test_recognises_the_api_being_switched_off(self) -> None:
        opener = FakeOpener((404, {"error": "The REST API is disabled. Set SKETCHFORGE_API_TOKEN."}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.list("p1")
        self.assertTrue(caught.exception.looks_disabled)

    def test_retries_a_write_that_lost_the_project_lock(self) -> None:
        opener = FakeOpener(
            (409, {"error": "That project is being changed; try again."}),
            (201, {"shapes": [shape_payload()], "revision": 7}),
        )
        created = client(opener).shapes.create("p1", {"kind": "box"})
        self.assertEqual(created.id, "s1")
        self.assertEqual(len(opener.calls), 2)

    def test_does_not_retry_a_locked_shape(self) -> None:
        opener = FakeOpener((409, {"error": "That shape is locked."}))
        with self.assertRaises(SketchForgeApiError):
            client(opener).shapes.delete("p1", "s1")
        self.assertEqual(len(opener.calls), 1)

    def test_gives_up_after_the_configured_retries(self) -> None:
        opener = FakeOpener((409, {"error": "That project is being changed; try again."}))
        instance = SketchForgeClient(base_url="http://h", token="t", retry_on_busy=2, opener=opener)
        with self.assertRaises(SketchForgeApiError):
            instance.shapes.create("p1", {"kind": "box"})
        self.assertEqual(len(opener.calls), 3)

    def test_reports_a_connection_failure_as_a_transport_error(self) -> None:
        class Refusing:
            def open(self, request, timeout=None):  # noqa: ANN001, ANN202 - test double
                raise OSError("ECONNREFUSED")

        transport = Transport(base_url="http://h", token="t", opener=Refusing())
        with self.assertRaises(SketchForgeTransportError):
            transport.send("GET", "/projects")


class ShapesTests(unittest.TestCase):
    def test_sends_a_batch_as_one_request(self) -> None:
        opener = FakeOpener((201, {"shapes": [shape_payload()], "revision": 3}))
        client(opener).shapes.create_many("p1", [{"kind": "box"}] * 5)
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(len(opener.calls[0].body["shapes"]), 5)

    def test_splits_a_batch_longer_than_the_server_accepts(self) -> None:
        opener = FakeOpener((201, {"shapes": [shape_payload()], "revision": 3}))
        written = client(opener).shapes.create_many("p1", [{"kind": "box"}] * (MAX_SHAPES_PER_REQUEST + 1))
        self.assertEqual(len(opener.calls), 2)
        self.assertEqual(len(opener.calls[0].body["shapes"]), MAX_SHAPES_PER_REQUEST)
        self.assertEqual(len(opener.calls[1].body["shapes"]), 1)
        self.assertEqual(len(written.shapes), 2)

    def test_writes_nothing_for_an_empty_batch(self) -> None:
        opener = FakeOpener((201, {}))
        written = client(opener).shapes.create_many("p1", [])
        self.assertEqual(written.shapes, [])
        self.assertEqual(opener.calls, [])

    def test_unlocks_a_locked_shape_before_deleting_it(self) -> None:
        opener = FakeOpener(
            {"shapes": [shape_payload("s1", locked=True)]},
            {"shape": shape_payload("s1"), "revision": 2},
            {"deleted": True, "id": "s1"},
        )
        client(opener).shapes.delete_all("p1")
        self.assertEqual([call.method for call in opener.calls], ["GET", "PATCH", "DELETE"])
        self.assertEqual(opener.calls[1].body, {"locked": False})

    def test_reads_unknown_fields_into_extra(self) -> None:
        opener = FakeOpener({"shapes": [shape_payload("s1", sides=6, groupedCount=3)]})
        shape = client(opener).shapes.list("p1")[0]
        self.assertEqual(shape.sides, 6)
        self.assertEqual(shape.grouped_count, 3)


class EdgesAndTreatmentsTests(unittest.TestCase):
    def test_reports_only_the_treatable_edges(self) -> None:
        def edge(index: int, filletable: bool):
            return {
                "index": index,
                "length": 10,
                "curveType": "line",
                "midpoint": {"x": 0, "y": 0, "z": 0},
                "filletable": filletable,
            }

        opener = FakeOpener({"edges": [edge(0, True), edge(1, False), edge(2, True)]})
        self.assertEqual(client(opener).edges.filletable_indexes("p1", "s1"), [0, 2])

    def test_omits_angle_and_edges_when_a_fillet_does_not_name_them(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 100, "revision": 4})
        client(opener).treatments.fillet("p1", "s1", 3)
        self.assertEqual(opener.calls[0].body, {"kind": "fillet", "amount": 3})
        self.assertEqual(
            opener.calls[0].url, "http://localhost:3100/api/v1/treatments?projectId=p1&shapeId=s1"
        )

    def test_passes_a_chamfers_angle_and_edge_list_through(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 100, "revision": 4})
        client(opener).treatments.chamfer("p1", "s1", 2, angle=30, edges=[0, 1])
        self.assertEqual(opener.calls[0].body, {"kind": "chamfer", "amount": 2, "angle": 30, "edges": [0, 1]})


class CheckTests(unittest.TestCase):
    def test_names_the_missing_server_configuration(self) -> None:
        opener = FakeOpener((503, {"error": "needs server-side project storage"}))
        health = client(opener).check()
        self.assertFalse(health["ok"])
        self.assertIn("SKETCHFORGE_PROJECTS_DIR", str(health["reason"]))

    def test_counts_the_projects_when_working(self) -> None:
        opener = FakeOpener({"projects": [project_payload("p1", "a")]})
        self.assertEqual(client(opener).check(), {"ok": True, "projects": 1})


if __name__ == "__main__":
    unittest.main()
