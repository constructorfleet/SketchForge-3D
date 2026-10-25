from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import unittest
import urllib.error

from sketchforge3d import (
    API_ERROR_CODES,
    BooleanCutResult,
    ExportResult,
    Imports,
    SketchForgeApiError,
    SketchForgeClient,
    SketchForgeTransportError,
    ShapeCollectionResult,
    chunk,
)
from sketchforge3d._http import Transport, build_url, normalize_base_url
from sketchforge3d.types import (
    MAX_SHAPES_PER_REQUEST,
    SHAPE_DESCRIPTION_FIELDS,
    MEASUREMENT_ANGLE_UNAVAILABLE_CODES,
    MEASUREMENT_RADIUS_UNAVAILABLE_CODES,
    MEASUREMENT_UNAVAILABLE_CODES,
    ShapeSummary,
)

from support import FakeOpener, project_payload, shape_payload


class RawResponse(io.BytesIO):
    def __init__(self, payload: bytes, headers: dict[str, str]) -> None:
        super().__init__(payload)
        self.headers = headers
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class TransferOpener:
    def __init__(self, payload: bytes = b"", headers: dict[str, str] | None = None) -> None:
        self.payload = payload
        self.headers = headers or {}
        self.request = None
        self.response = None

    def open(self, request, timeout=None):
        self.request = request
        self.response = RawResponse(self.payload, self.headers)
        return self.response


class FailingDownloadOpener:
    def open(self, request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url,
            422,
            "geometry failed",
            {},
            io.BytesIO(b'{"error":"geometry failed","code":"geometry_failed"}'),
        )


class BusyThenSuccessOpener:
    def __init__(self) -> None:
        self.calls = 0

    def open(self, request, timeout=None):
        self.calls += 1
        if self.calls == 1:
            raise urllib.error.HTTPError(
                request.full_url,
                409,
                "project busy",
                {},
                io.BytesIO(b'{"error":"That project is being changed; try again."}'),
            )
        return RawResponse(
            json.dumps({"shape": shape_payload("m1"), "triangles": 4, "revision": 9}).encode(),
            {},
        )


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
    def test_lists_a_project_page(self) -> None:
        opener = FakeOpener({"projects": [project_payload("p1", "Plate")], "nextCursor": "Mg"})
        page = client(opener).projects.list_page(limit=2, cursor="MQ")
        self.assertEqual([project.id for project in page.items], ["p1"])
        self.assertEqual(page.next_cursor, "Mg")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/projects?limit=2&cursor=MQ")

    def test_lists_a_shape_page(self) -> None:
        opener = FakeOpener({"shapes": [shape_payload("s1")], "nextCursor": None})
        page = client(opener).shapes.list_page("p1", limit=2)
        self.assertEqual([shape.id for shape in page.items], ["s1"])
        self.assertIsNone(page.next_cursor)
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/shapes?projectId=p1&limit=2")

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

    def test_sends_expected_revision_only_on_writes(self) -> None:
        opener = FakeOpener({"projects": []}, (201, {"project": project_payload("p1", "Plate")}))
        instance = SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener, expected_revision=42)
        instance.projects.list()
        instance.projects.create("Plate")
        self.assertNotIn("if-match", opener.calls[0].headers)
        self.assertEqual(opener.calls[1].headers["if-match"], '"42"')

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
    def test_sends_a_retained_sketch_sweep_profile_unchanged(self) -> None:
        profile = {
            "points": [
                {"id": "a", "x": -1, "z": -1}, {"id": "b", "x": 1, "z": -1},
                {"id": "c", "x": 1, "z": 1}, {"id": "d", "x": -1, "z": 1},
                {"id": "p0", "x": 0, "z": 0}, {"id": "p1", "x": 10, "z": 0},
            ],
            "segments": [
                {"id": "ab", "startId": "a", "endId": "b"}, {"id": "bc", "startId": "b", "endId": "c"},
                {"id": "cd", "startId": "c", "endId": "d"}, {"id": "da", "startId": "d", "endId": "a"},
                {"id": "spine", "startId": "p0", "endId": "p1"},
            ],
        }
        opener = FakeOpener((201, {"shapes": [shape_payload(sketchOperation="sweep", sketchProfile=profile)], "revision": 4}))
        result = client(opener).shapes.create("p1", {"kind": "sketchSweep", "profile": profile})
        self.assertEqual(result.sketch_operation, "sweep")
        self.assertEqual(opener.calls[0].body, {"kind": "sketchSweep", "profile": profile})

    def test_updates_a_sweep_profile_with_the_wire_field(self) -> None:
        profile = {
            "points": [{"id": "a", "x": 0, "z": 0}],
            "segments": [{"id": "edge", "startId": "a", "endId": "a"}],
        }
        opener = FakeOpener((200, {"shape": shape_payload(sketchOperation="sweep", sketchProfile=profile), "revision": 5}))
        client(opener).shapes.update("p1", "s1", {"sketchProfile": profile})
        self.assertEqual(opener.calls[0].method, "PATCH")
        self.assertEqual(opener.calls[0].body, {"sketchProfile": profile})

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


class BooleanAndGroupingTests(unittest.TestCase):
    def test_cuts_named_solids_with_named_holes(self) -> None:
        opener = FakeOpener((201, {
            "shape": shape_payload("cut", kind="mesh"),
            "triangles": 128,
            "revision": 7,
        }))

        result = client(opener).booleans.cut("p1", ["plate"], ["bore"])

        self.assertIsInstance(result, BooleanCutResult)
        self.assertEqual(result.shape.id, "cut")
        self.assertEqual(result.triangles, 128)
        self.assertEqual(result.revision, 7)
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/booleans?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"solidIds": ["plate"], "holeIds": ["bore"]})

    def test_groups_shapes_and_returns_the_group(self) -> None:
        opener = FakeOpener((201, {"shape": shape_payload("group"), "revision": 4}))

        result = client(opener).groups.group("p1", ["plate", "bore"])

        self.assertEqual(result.shape.id, "group")
        self.assertEqual(result.revision, 4)
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/groups?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"ids": ["plate", "bore"]})

    def test_ungroups_a_shape_and_parses_children(self) -> None:
        opener = FakeOpener({"shapes": [shape_payload("plate"), shape_payload("bore")], "revision": 5})

        result = client(opener).groups.ungroup("p1", "group")

        self.assertIsInstance(result, ShapeCollectionResult)
        self.assertEqual([shape.id for shape in result.shapes], ["plate", "bore"])
        self.assertEqual(result.revision, 5)
        self.assertEqual(opener.calls[0].method, "DELETE")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/groups?projectId=p1&shapeId=group")

    def test_separates_disconnected_parts(self) -> None:
        opener = FakeOpener({"shapes": [shape_payload("left"), shape_payload("right")], "revision": 8})

        result = client(opener).parts.separate("p1", "cut")

        self.assertEqual([shape.id for shape in result.shapes], ["left", "right"])
        self.assertEqual(result.revision, 8)
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/parts?projectId=p1&shapeId=cut")
        self.assertIsNone(opener.calls[0].body)

    def test_exposes_operations_on_the_project_handle(self) -> None:
        opener = FakeOpener(
            (201, {"shape": shape_payload("group"), "revision": 2}),
            {"shapes": [shape_payload("plate"), shape_payload("bore")], "revision": 3},
            {"shapes": [shape_payload("left"), shape_payload("right")], "revision": 4},
            (201, {"shape": shape_payload("cut"), "triangles": 12, "revision": 5}),
        )
        project = client(opener).project("p1")

        self.assertEqual(project.group(["plate", "bore"]).shape.id, "group")
        self.assertEqual([shape.id for shape in project.ungroup("group").shapes], ["plate", "bore"])
        self.assertEqual([shape.id for shape in project.separate("group").shapes], ["left", "right"])
        self.assertEqual(project.cut(["plate"], ["bore"]).shape.id, "cut")


class ExportsTests(unittest.TestCase):
    def test_decodes_an_export_and_preserves_metadata(self) -> None:
        opener = FakeOpener({
            "format": "stl",
            "filename": "Bracket.stl",
            "mimeType": "model/stl",
            "bytes": 4,
            "shapeCount": 2,
            "base64": "AQIDBA==",
            "exportedCount": 2,
            "skipped": [],
        })

        result = client(opener).exports.export("p1", "stl", ["s1", "s2"], name="Bracket")

        self.assertIsInstance(result, ExportResult)
        self.assertEqual(result.data, bytes([1, 2, 3, 4]))
        self.assertEqual(result.filename, "Bracket.stl")
        self.assertEqual(result.mime_type, "model/stl")
        self.assertEqual(result.shape_count, 2)
        self.assertEqual(result.exported_count, 2)
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/exports?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"format": "stl", "shapeIds": ["s1", "s2"], "name": "Bracket"})

    def test_sends_the_drawing_view_only_for_an_svg_export(self) -> None:
        opener = FakeOpener({
            "format": "svg",
            "filename": "Bracket.svg",
            "mimeType": "image/svg+xml",
            "bytes": 5,
            "shapeCount": 1,
            "base64": "PHN2Zz4=",
        })

        result = client(opener).exports.export("p1", "svg", view="top")

        self.assertEqual(result.mime_type, "image/svg+xml")
        self.assertEqual(result.data, b"<svg>")
        self.assertEqual(opener.calls[0].body, {"format": "svg", "view": "top"})

    def test_sends_a_named_section_plane_for_an_svg_export(self) -> None:
        opener = FakeOpener({
            "format": "svg",
            "filename": "Bracket.svg",
            "mimeType": "image/svg+xml",
            "bytes": 5,
            "shapeCount": 1,
            "base64": "PHN2Zz4=",
        })

        result = client(opener).project("p1").export("svg", section={"plane": "xy", "offset": 3})

        self.assertEqual(result.data, b"<svg>")
        self.assertEqual(opener.calls[0].body, {"format": "svg", "section": {"plane": "xy", "offset": 3}})

    def test_writes_export_bytes_to_a_file(self) -> None:
        artifact = bytes(range(256)) * 600
        opener = TransferOpener(
            artifact,
            {
                "Content-Type": "text/plain",
                "Content-Disposition": 'attachment; filename="Part.obj"',
                "X-SketchForge-Metadata": "%7B%22format%22%3A%22obj%22%2C%22filename%22%3A%22Part.obj%22%2C%22mimeType%22%3A%22text%2Fplain%22%2C%22shapeCount%22%3A1%7D",
            },
        )
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "part.obj")
            result = client(opener).project("p1").export_file("obj", path)
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), artifact)
        self.assertEqual(result.filename, "Part.obj")
        self.assertEqual(result.data, b"")
        self.assertEqual(opener.request.get_method(), "POST")
        self.assertIn("download=1", opener.request.full_url)
        self.assertEqual(json.loads(opener.request.data), {"format": "obj"})
        self.assertGreater(len(opener.response.read_sizes), 2)
        self.assertTrue(all(size == 64 * 1024 for size in opener.response.read_sizes))
        self.assertTrue(opener.response.closed)

    def test_failed_download_preserves_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "part.obj")
            with open(path, "wb") as handle:
                handle.write(b"previous artifact")

            with self.assertRaises(SketchForgeApiError):
                client(FailingDownloadOpener()).project("p1").export_file("obj", path)

            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), b"previous artifact")
            self.assertEqual(os.listdir(directory), ["part.obj"])


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


class DraftPrismTests(unittest.TestCase):
    def test_sends_angle_to_draft_prism_endpoint(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 100, "revision": 4})
        client(opener).draft_prisms.apply("p1", "s1", 5)
        self.assertEqual(opener.calls[0].body, {"angle": 5})
        self.assertEqual(
            opener.calls[0].url,
            "http://localhost:3100/api/v1/draft-prism?projectId=p1&shapeId=s1",
        )


class FacesAndShellTests(unittest.TestCase):
    @staticmethod
    def _face(index: int, facing):
        return {
            "id": f"face_demo_{index}",
            "index": index,
            "surfaceType": "plane",
            "area": 400,
            "centroid": {"x": 0, "y": index, "z": 0},
            "normal": {"x": 0, "y": 1, "z": 0},
            "facing": facing,
        }

    def test_reports_the_faces_pointing_a_given_way(self) -> None:
        opener = FakeOpener({"faces": [self._face(0, "top"), self._face(1, None), self._face(2, "bottom")]})
        self.assertEqual(client(opener).faces.facing("p1", "s1", "top"), [0])
        self.assertEqual(
            opener.calls[0].url, "http://localhost:3100/api/v1/faces?projectId=p1&shapeId=s1"
        )

    def test_reads_the_stable_face_id_the_server_reports(self) -> None:
        # The id is what a face color is keyed by, and it survives an operation
        # where the index does not. A client that cannot read it cannot use it.
        opener = FakeOpener({"faces": [self._face(0, "top"), self._face(1, "bottom")]})
        faces = client(opener).faces.list("p1", "s1")
        self.assertEqual([face.id for face in faces], ["face_demo_0", "face_demo_1"])

    def test_reports_stable_ids_for_the_faces_pointing_a_given_way(self) -> None:
        # `facing` answers with indexes for compatibility; this is the form a
        # caller should persist, because an index is only true until the next
        # operation reorders the faces.
        opener = FakeOpener({"faces": [self._face(0, "top"), self._face(1, None), self._face(2, "bottom")]})
        self.assertEqual(client(opener).faces.ids_facing("p1", "s1", "top"), ["face_demo_0"])

    def test_keeps_a_face_without_an_id_readable(self) -> None:
        # A server from before stable identity sends no id at all.
        payload = self._face(0, "top")
        del payload["id"]
        face = client(FakeOpener({"faces": [payload]})).faces.list("p1", "s1")[0]
        self.assertIsNone(face.id)
        self.assertEqual(face.index, 0)

    def test_reads_a_face_with_no_normal(self) -> None:
        payload = self._face(0, None)
        payload["normal"] = None
        opener = FakeOpener({"faces": [payload]})
        face = client(opener).faces.list("p1", "s1")[0]
        self.assertIsNone(face.normal)
        self.assertIsNone(face.facing)
        self.assertEqual(face.centroid.y, 0)

    def test_omits_open_faces_entirely_for_a_sealed_hollow(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 24, "revision": 5})
        client(opener).shell.hollow("p1", "s1", 2)
        # A missing list is what the server reads as "seal it"; sending an empty
        # one would say the same thing by accident rather than on purpose.
        self.assertEqual(opener.calls[0].body, {"thickness": 2})
        self.assertEqual(
            opener.calls[0].url, "http://localhost:3100/api/v1/shell?projectId=p1&shapeId=s1"
        )

    def test_opens_the_top_by_default_for_a_tray(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 28, "revision": 6})
        result = client(opener).shell.tray("p1", "s1", 2)
        self.assertEqual(opener.calls[0].body, {"thickness": 2, "openFaces": ["top"]})
        self.assertEqual(result.triangles, 28)
        self.assertEqual(result.revision, 6)

    def test_takes_indexes_as_well_as_direction_names(self) -> None:
        opener = FakeOpener({"shape": shape_payload(), "triangles": 28, "revision": 6})
        client(opener).shell.apply("p1", "s1", 1.5, ["top", 4])
        self.assertEqual(opener.calls[0].body, {"thickness": 1.5, "openFaces": ["top", 4]})


class MeasurementsTests(unittest.TestCase):
    @staticmethod
    def _measurement(**overrides):
        payload = {
            "entity": "edge",
            "index": 0,
            "geometryType": "line",
            "length": 10,
            "area": None,
            "radius": None,
            "diameter": None,
            "sweepDegrees": None,
            "radiusUnavailable": "notCircular",
        }
        payload.update(overrides)
        return payload

    def test_lists_a_shapes_edges_and_faces(self) -> None:
        opener = FakeOpener(
            {
                "measurements": [
                    self._measurement(),
                    self._measurement(
                        entity="face",
                        index=1,
                        geometryType="cylinder",
                        length=None,
                        area=50,
                        radius=4,
                        diameter=8,
                        radiusUnavailable=None,
                    ),
                ]
            }
        )
        measurements = client(opener).measurements.list("p1", "s1")
        self.assertEqual(
            opener.calls[0].url,
            "http://localhost:3100/api/v1/measurements?projectId=p1&shapeId=s1",
        )
        self.assertEqual(opener.calls[0].method, "GET")
        self.assertEqual(measurements[0].entity, "edge")
        self.assertEqual(measurements[0].geometry_type, "line")
        self.assertEqual(measurements[0].length, 10.0)
        self.assertEqual(measurements[0].radius_unavailable, "notCircular")
        self.assertEqual(measurements[1].area, 50.0)
        self.assertEqual(measurements[1].diameter, 8.0)
        self.assertIsNone(measurements[1].radius_unavailable)

    def test_reads_what_does_not_apply_as_none_rather_than_zero(self) -> None:
        opener = FakeOpener({"measurements": [self._measurement()]})
        measurement = client(opener).measurements.list("p1", "s1")[0]
        # A radius of 0.0 would read as a measurement rather than the absence of
        # one, which is the whole reason the server sends null.
        self.assertIsNone(measurement.radius)
        self.assertIsNone(measurement.diameter)
        self.assertIsNone(measurement.area)
        self.assertIsNone(measurement.sweep_degrees)



    def test_reports_only_the_entries_carrying_a_radius(self) -> None:
        opener = FakeOpener(
            {
                "measurements": [
                    self._measurement(),
                    self._measurement(
                        index=1, geometryType="circle", radius=3, diameter=6, sweepDegrees=360, radiusUnavailable=None
                    ),
                    self._measurement(entity="face", index=2, geometryType="plane", length=None, area=400, radiusUnavailable="notCurved"),
                ]
            }
        )
        found = client(opener).measurements.with_radius("p1", "s1")
        self.assertEqual([measurement.index for measurement in found], [1])
        self.assertEqual(found[0].sweep_degrees, 360.0)

    def test_sends_both_ends_of_a_between_request(self) -> None:
        opener = FakeOpener({"distance": 12.5, "angleDegrees": 90, "angleUnavailable": None})
        pair = client(opener).measurements.between(
            "p1", {"shapeId": "s1", "entity": "face", "index": 2}, {"shapeId": "s2", "entity": "face", "index": 0}
        )
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/measurements?projectId=p1")
        self.assertEqual(
            opener.calls[0].body,
            {
                "from": {"shapeId": "s1", "entity": "face", "index": 2},
                "to": {"shapeId": "s2", "entity": "face", "index": 0},
            },
        )
        self.assertEqual(pair.distance, 12.5)
        self.assertEqual(pair.angle_degrees, 90.0)
        self.assertIsNone(pair.angle_unavailable)

    def test_omits_entity_and_index_for_a_whole_shape_end(self) -> None:
        opener = FakeOpener({"distance": 60, "angleDegrees": None, "angleUnavailable": "notPlanar"})
        pair = client(opener).measurements.between("p1", {"shapeId": "s1"}, {"shapeId": "s2"})
        # The server reads a missing entity as the whole shape and refuses an
        # index alongside it, so neither can be sent as a null.
        self.assertEqual(opener.calls[0].body, {"from": {"shapeId": "s1"}, "to": {"shapeId": "s2"}})
        self.assertIsNone(pair.angle_degrees)
        self.assertEqual(pair.angle_unavailable, "notPlanar")

    def test_binds_the_project_id_through_a_handle(self) -> None:
        opener = FakeOpener({"measurements": [self._measurement()]})
        client(opener).project("p9").measurements("s1")
        self.assertEqual(
            opener.calls[0].url,
            "http://localhost:3100/api/v1/measurements?projectId=p9&shapeId=s1",
        )

    def test_names_the_two_reason_sets_each_field_draws_from(self) -> None:
        # The server keeps one union for both, but the derivations are disjoint:
        # a radius is never missing because a face was not planar.
        self.assertEqual(
            MEASUREMENT_RADIUS_UNAVAILABLE_CODES,
            (
                "notCircular",
                "ellipseHasNoSingleRadius",
                "degenerateCurve",
                "notCurved",
                "radiusVariesOverSurface",
                "radiusNotReportedByKernel",
                "degenerateSurface",
            ),
        )
        self.assertEqual(MEASUREMENT_ANGLE_UNAVAILABLE_CODES, ("notPlanar", "degenerateNormal"))
        self.assertEqual(
            set(MEASUREMENT_RADIUS_UNAVAILABLE_CODES) & set(MEASUREMENT_ANGLE_UNAVAILABLE_CODES),
            set(),
        )
        self.assertEqual(
            MEASUREMENT_UNAVAILABLE_CODES,
            MEASUREMENT_RADIUS_UNAVAILABLE_CODES + MEASUREMENT_ANGLE_UNAVAILABLE_CODES,
        )


class ShapePropertiesTests(unittest.TestCase):
    def test_reads_shape_properties_and_keeps_tessellated_provenance(self) -> None:
        opener = FakeOpener({"properties": {
            "volume": 120, "area": 148,
            "centerOfMass": {"x": 12, "y": 3, "z": -4},
            "bbox": {"xmin": 10, "ymin": 0, "zmin": -6, "xmax": 14, "ymax": 6, "zmax": -2},
            "isValid": True, "provenance": {"source": "mesh", "precision": "tessellated"},
        }})
        result = client(opener).properties.get("p1", "s1")
        self.assertEqual(opener.calls[0].method, "GET")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/properties?projectId=p1&shapeId=s1")
        self.assertEqual(result.volume, 120)
        self.assertEqual(result.provenance.source, "mesh")
        self.assertEqual(result.provenance.precision, "tessellated")


class InterferenceTests(unittest.TestCase):
    def test_checks_exact_interference_and_parses_pair_precision(self) -> None:
        opener = FakeOpener({
            "shapesChecked": 2, "candidatePairsChecked": 1, "clearance": 0.5,
            "method": "OCCT exact distance and common volume; AABB candidate prefilter",
            "pairs": [{
                "a": {"id": "a", "name": "A"}, "b": {"id": "b", "name": "B"},
                "gap": 0.25, "overlapVolume": 0, "precision": "tessellated",
            }],
        })
        result = client(opener).project("p1").check_interference(ids=["a", "b"], clearance=0.5)
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/interference?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"ids": ["a", "b"], "clearance": 0.5})
        self.assertEqual(result.pairs[0].gap, 0.25)
        self.assertEqual(result.pairs[0].precision, "tessellated")


class ArrangeTests(unittest.TestCase):
    def test_sends_the_axis_and_target_and_leaves_an_absent_anchor_out(self) -> None:
        opener = FakeOpener(
            {"moved": 2, "axis": "y", "target": "max", "anchorId": None, "shapes": [], "revision": 1}
        )
        result = client(opener).align.tops("p1", ["a", "b"])
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/align?projectId=p1")
        # An anchor sent as null would be a different request from one not
        # sent: the server reads an absent one as "use the whole selection".
        self.assertEqual(opener.calls[0].body, {"ids": ["a", "b"], "axis": "y", "target": "max"})
        self.assertEqual(result.moved, 2)
        self.assertIsNone(result.anchor_id)

    def test_reports_the_anchor_the_server_actually_used(self) -> None:
        # A locked shape in the selection cannot move, so it anchors the
        # alignment whatever was asked for -- and this is the only way a caller
        # finds that out.
        opener = FakeOpener(
            {"moved": 1, "axis": "x", "target": "min", "anchorId": "locked", "shapes": [], "revision": 2}
        )
        result = client(opener).align.apply("p1", ["a", "locked"], "x", "min", "a")
        self.assertEqual(opener.calls[0].body["anchorId"], "a")
        self.assertEqual(result.anchor_id, "locked")

    def test_leaves_the_axis_out_so_the_server_picks_the_row(self) -> None:
        opener = FakeOpener({"moved": 1, "axis": "z", "spacing": "centers", "shapes": [], "revision": 3})
        result = client(opener).distribute.pitch("p1", ["a", "b", "c"])
        self.assertEqual(opener.calls[0].body, {"ids": ["a", "b", "c"], "spacing": "centers"})
        self.assertEqual(result.axis, "z")

    def test_bakes_an_exact_mirror_via_the_mirrors_route(self) -> None:
        opener = FakeOpener({"moved": 2, "axis": "x", "shapes": [], "revision": 4})
        result = client(opener).project("p1").mirror_baked(["a", "b"], "x")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/mirrors?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"ids": ["a", "b"], "axis": "x"})
        self.assertEqual(result.moved, 2)
        self.assertEqual(result.axis, "x")

    def test_sends_a_rows_pitch_and_a_rings_centre(self) -> None:
        opener = FakeOpener({"created": 3, "kind": "linear", "shapes": [], "revision": 4})
        api = client(opener)

        api.patterns.row("p1", ["boss"], 4, 25)
        self.assertEqual(
            opener.calls[0].body, {"ids": ["boss"], "kind": "linear", "count": 4, "stepX": 25}
        )

        api.patterns.ring("p1", ["hole"], 6, (0.0, 12.0), rotate_copies=False)
        self.assertEqual(
            opener.calls[1].body,
            {
                "ids": ["hole"],
                "kind": "circular",
                "count": 6,
                "centerX": 0.0,
                "centerZ": 12.0,
                "rotateCopies": False,
            },
        )

    def test_keeps_a_zero_step_and_a_false_rotate_which_a_falsy_check_would_drop(self) -> None:
        # All three of these are meaningful and all three are falsy: a zero
        # step is a row running purely along the other axis, a zero centre is
        # the origin, and rotate_copies=False is a vane keeping its heading.
        opener = FakeOpener({"created": 1, "kind": "circular", "shapes": [], "revision": 5})
        client(opener).patterns.apply(
            "p1", ["v"], "circular", 2, step_x=0, center_x=0, rotate_copies=False
        )
        self.assertEqual(opener.calls[0].body["stepX"], 0)
        self.assertEqual(opener.calls[0].body["centerX"], 0)
        self.assertIs(opener.calls[0].body["rotateCopies"], False)

    def test_binds_the_project_id_through_a_handle(self) -> None:
        opener = FakeOpener({"created": 2, "kind": "linear", "shapes": [], "revision": 6})
        result = client(opener).project("p9").row(["boss"], 3, 20)
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/patterns?projectId=p9")
        self.assertEqual(result.created, 2)


class ImportTests(unittest.TestCase):
    def test_sends_the_bytes_as_base64_under_the_name_that_chooses_the_importer(self) -> None:
        opener = FakeOpener((201, {"shape": shape_payload("m1"), "triangles": 12, "revision": 7}))
        result = client(opener).imports.apply("p1", "plate.stl", b"solid")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/imports?projectId=p1")
        self.assertEqual(opener.calls[0].body, {"fileName": "plate.stl", "data": "c29saWQ="})
        self.assertEqual(result.triangles, 12)

    def test_encodes_bytes_that_are_not_text(self) -> None:
        # A model file is binary: an STL written by a slicer is, and an encoder
        # that round-tripped through a string would corrupt it.
        opener = FakeOpener((201, {"shape": shape_payload("m1"), "triangles": 0, "revision": 8}))
        payload = bytes(range(256))
        client(opener).imports.apply("p1", "binary.stl", payload)
        self.assertEqual(
            base64.b64decode(opener.calls[0].body["data"]), payload
        )

    def test_reads_the_name_and_the_bytes_off_a_path(self) -> None:
        opener = TransferOpener(json.dumps({"shape": shape_payload("m1"), "triangles": 4, "revision": 9}).encode())
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "bracket.stl")
            with open(path, "wb") as handle:
                handle.write(b"solid bracket")
            client(opener).project("p1").import_file(path)
        # The base name rather than the whole path: the server uses it to
        # choose the importer and to name the stored asset, and a temporary
        # directory is not part of either.
        content_type = opener.request.get_header("Content-type")
        self.assertIn("multipart/form-data; boundary=", content_type)
        boundary = content_type.split("boundary=", 1)[1]
        self.assertIn(b'name="fileName"\r\n\r\nbracket.stl', opener.request.data)
        self.assertIn(b'name="file"; filename="bracket.stl"', opener.request.data)
        self.assertIn(b"Content-Type: model/stl", opener.request.data)
        self.assertIn(b"solid bracket", opener.request.data)
        self.assertTrue(opener.request.data.endswith(("--" + boundary + "--\r\n").encode()))

    def test_retries_a_multipart_upload_when_the_project_is_busy(self) -> None:
        opener = BusyThenSuccessOpener()
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "bracket.stl")
            with open(path, "wb") as handle:
                handle.write(b"solid bracket")
            result = client(opener).project("p1").import_file(path)
        self.assertEqual(result.shape.id, "m1")
        self.assertEqual(opener.calls, 2)

    def test_says_which_file_names_the_server_will_even_try(self) -> None:
        self.assertTrue(Imports.readable("bracket.STL"))
        self.assertTrue(Imports.readable("logo.svg"))
        self.assertFalse(Imports.readable("part.step"))
        self.assertFalse(Imports.readable("notes"))


class ShapeSummaryTests(unittest.TestCase):
    def test_step_component_ancestry_is_typed_and_description_only(self):
        summary = ShapeSummary.from_payload({
            **shape_payload(),
            "stepAssembly": [{"id": "step-node:0", "name": "MainAssembly", "children": [{"id": "step-occurrence:8", "name": "Sensors", "children": []}]}],
            "stepComponent": {
                "id": "step-occurrence:12/solid-1",
                "occurrenceId": "step-occurrence:12",
                "path": [{"id": "step-node:0", "name": "MainAssembly"}, {"id": "step-occurrence:8", "name": "Sensors"}],
            },
        })
        self.assertEqual(summary.step_assembly[0].name, "MainAssembly")
        self.assertEqual(summary.step_assembly[0].id, "step-node:0")
        self.assertEqual(summary.step_assembly[0].children[0].name, "Sensors")
        self.assertEqual(summary.step_component.id, "step-occurrence:12/solid-1")
        self.assertEqual(summary.step_component.occurrence_id, "step-occurrence:12")
        self.assertEqual(summary.step_component.path[-1].name, "Sensors")
        self.assertIn("stepAssembly", SHAPE_DESCRIPTION_FIELDS)
        self.assertIn("stepComponent", SHAPE_DESCRIPTION_FIELDS)
        self.assertNotIn("stepComponent", summary.as_patch())

    def test_collects_the_per_kind_parameters(self) -> None:
        summary = ShapeSummary.from_payload(
            shape_payload(kind="cylinder", requestKind="cylinder", sides=12, bevel=2)
        )
        self.assertEqual(summary.request_kind, "cylinder")
        self.assertEqual(summary.sides, 12)
        self.assertEqual(summary.parameters, {"sides": 12, "bevel": 2})

    def test_reads_a_sweep_and_the_outline_it_ran_round(self) -> None:
        revolve = {"startAngle": 0, "sweepAngle": 360, "sides": 64, "quality": 6, "pitch": 1.25, "turns": 4, "coreRadius": 3}
        summary = ShapeSummary.from_payload(
            shape_payload(kind="mesh", requestKind="revolve", sketchOperation="revolve", revolve=revolve, profile=[[3, 0], [4, 1], [3, 2]])
        )
        self.assertEqual(summary.pitch, 1.25)
        self.assertEqual(summary.sketch_operation, "revolve")
        self.assertEqual(summary.profile, [[3.0, 0.0], [4.0, 1.0], [3.0, 2.0]])

    def test_a_shape_with_no_sweep_has_no_pitch(self) -> None:
        self.assertIsNone(ShapeSummary.from_payload(shape_payload()).pitch)

    def test_as_patch_carries_the_rest_while_one_field_changes(self) -> None:
        summary = ShapeSummary.from_payload(shape_payload(kind="cylinder", sides=12, bevel=2))
        patch = summary.as_patch(sides=6)
        self.assertEqual(patch["sides"], 6)
        self.assertEqual(patch["bevel"], 2)
        self.assertEqual(patch["width"], 1)

    def test_as_patch_drops_what_only_describes_the_shape(self) -> None:
        summary = ShapeSummary.from_payload(
            shape_payload(requestKind="box", sketchOperation="revolve", groupedCount=2)
        )
        patch = summary.as_patch()
        for field in ("id", "kind", "requestKind", "sketchOperation", "groupedCount"):
            self.assertNotIn(field, patch)

    def test_as_patch_keeps_the_editable_sweep_profile(self) -> None:
        profile = {"points": [{"id": "a", "x": 0, "z": 0}], "segments": []}
        summary = ShapeSummary.from_payload(shape_payload(sketchOperation="sweep", sketchProfile=profile))
        self.assertEqual(summary.as_patch()["sketchProfile"], profile)


class ErrorCodeTests(unittest.TestCase):
    def test_exposes_current_revision_when_a_conditional_write_is_stale(self) -> None:
        opener = FakeOpener((409, {"error": "The project changed since the supplied revision.", "code": "revision_mismatch", "revision": 17}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.update("p1", "s1", {"x": 1})
        self.assertTrue(caught.exception.is_revision_mismatch)
        self.assertEqual(caught.exception.current_revision, 17)

    def test_recognizes_new_and_legacy_limit_codes(self) -> None:
        self.assertIn("limit_exceeded", API_ERROR_CODES)
        self.assertIn("too_many_shapes", API_ERROR_CODES)
        for code in ("limit_exceeded", "too_many_shapes"):
            opener = FakeOpener((413, {"error": "limit reached", "code": code}))
            with self.assertRaises(SketchForgeApiError) as caught:
                client(opener).projects.list()
            self.assertTrue(caught.exception.is_limit_exceeded)

    def test_tells_a_busy_project_from_a_locked_shape_by_code(self) -> None:
        opener = FakeOpener((409, {"error": "Hold on.", "code": "shape_locked"}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.update("p1", "s1", {"x": 1})
        self.assertTrue(caught.exception.is_shape_locked)
        self.assertFalse(caught.exception.is_project_busy)
        # A locked shape is not worth retrying, and the code says so outright.
        self.assertEqual(len(opener.calls), 1)

    def test_tells_a_missing_project_from_a_missing_shape(self) -> None:
        opener = FakeOpener((404, {"error": "Gone.", "code": "shape_not_found"}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.list("p1")
        self.assertTrue(caught.exception.is_shape_missing)
        self.assertFalse(caught.exception.is_project_missing)
        self.assertFalse(caught.exception.looks_disabled)

    def test_names_the_fields_a_change_could_not_be_applied_to(self) -> None:
        opener = FakeOpener((422, {"error": "cannot take: sides.", "code": "unapplicable_fields", "fields": ["sides"]}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.update("p1", "s1", {"sides": 6})
        self.assertTrue(caught.exception.has_unapplicable_fields)
        self.assertEqual(caught.exception.unapplicable_fields, ["sides"])

    def test_falls_back_to_the_wording_against_a_server_without_codes(self) -> None:
        opener = FakeOpener((409, {"error": "That project is being changed; try again."}))
        with self.assertRaises(SketchForgeApiError) as caught:
            client(opener).shapes.update("p1", "s1", {"x": 1})
        self.assertIsNone(caught.exception.code)
        self.assertTrue(caught.exception.is_project_busy)


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
