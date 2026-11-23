from __future__ import annotations

import unittest

from sketchforge3d import DroppedBinding, ShapeChangeResult, SketchForgeClient

from support import FakeOpener, shape_payload


def client(opener: FakeOpener) -> SketchForgeClient:
    return SketchForgeClient(base_url="http://localhost:3100", token="t", opener=opener)


class ShapeChangeResultTests(unittest.TestCase):
    def test_reports_bindings_a_nested_edit_dropped_on_another_shape(self) -> None:
        opener = FakeOpener({
            "shape": shape_payload("s1"),
            "revision": 7,
            "droppedBindings": [{"shapeId": "g1", "fields": ["width"]}],
        })

        result = client(opener).shapes.update_result("p1", "sketch/s1", {"name": "Edited"})

        self.assertEqual(opener.calls[0].method, "PATCH")
        self.assertEqual(opener.calls[0].url, "http://localhost:3100/api/v1/shapes?projectId=p1&shapeId=sketch%2Fs1")
        self.assertIsInstance(result, ShapeChangeResult)
        self.assertEqual(result.shape.id, "s1")
        self.assertEqual(result.revision, 7)
        self.assertEqual(result.dropped_bindings, [DroppedBinding(shape_id="g1", fields=["width"])])

    def test_reports_no_dropped_bindings_when_the_reply_has_none(self) -> None:
        opener = FakeOpener({"shape": shape_payload("s1"), "revision": 3})

        result = client(opener).shapes.update_result("p1", "s1", {"name": "Edited"})

        self.assertEqual(result.dropped_bindings, [])
        self.assertEqual(client(opener).shapes.update("p1", "s1", {"name": "Edited"}).id, "s1")


if __name__ == "__main__":
    unittest.main()
