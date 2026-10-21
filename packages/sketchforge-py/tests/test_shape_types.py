import unittest
from typing import get_type_hints

import sketchforge3d


class ShapeRequestTypeTests(unittest.TestCase):
    def test_typed_requests_are_public_and_keep_kind_required(self):
        self.assertIs(sketchforge3d.BoxShapeRequest, sketchforge3d.types.BoxShapeRequest)
        self.assertEqual(sketchforge3d.types.BoxShapeRequest.__required_keys__, frozenset({"kind"}))
        self.assertIn("width", sketchforge3d.types.BoxShapeRequest.__optional_keys__)
        for request_type in sketchforge3d.types.ShapeSpec.__args__:
            self.assertIn("kind", request_type.__required_keys__, request_type.__name__)

    def test_specialized_requests_expose_kind_specific_fields(self):
        self.assertIn("sides", sketchforge3d.types.CylinderShapeRequest.__optional_keys__)
        self.assertIn("teeth", sketchforge3d.types.GearShapeRequest.__optional_keys__)
        self.assertIn("loftTopShape", sketchforge3d.types.LoftShapeRequest.__optional_keys__)
        self.assertIn("profile", sketchforge3d.types.RevolveShapeRequest.__required_keys__)
        self.assertIn("clearance", sketchforge3d.types.ThreadShapeRequest.__optional_keys__)

    def test_request_union_covers_all_supported_create_kinds(self):
        self.assertEqual(
            sketchforge3d.types.REQUESTABLE_SHAPE_KINDS,
            (
                "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus",
                "tube", "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge",
                "icosahedron", "text", "loft", "gear", "revolve", "thread",
            ),
        )
        self.assertEqual(sketchforge3d.types.ShapeRequest, sketchforge3d.types.Mapping[str, sketchforge3d.types.Any])
        self.assertIsNotNone(get_type_hints(sketchforge3d.Shapes.create))


if __name__ == "__main__":
    unittest.main()
