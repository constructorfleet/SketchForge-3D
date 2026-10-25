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
        # A revolve's resolution is two counts: facets per turn and curve
        # sampling, 1 to 10. Neither is text (#504).
        revolve_hints = get_type_hints(sketchforge3d.types.RevolveShapeRequest)
        self.assertIs(revolve_hints["sides"], int)
        self.assertIs(revolve_hints["quality"], int)
        self.assertIn("clearance", sketchforge3d.types.ThreadShapeRequest.__optional_keys__)
        self.assertIn("profile", sketchforge3d.types.SketchSweepShapeRequest.__required_keys__)

    def test_request_union_covers_all_supported_create_kinds(self):
        self.assertEqual(
            sketchforge3d.types.REQUESTABLE_SHAPE_KINDS,
            (
                "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus",
                "tube", "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge",
                "icosahedron", "text", "loft", "gear", "revolve", "thread", "sketchSweep",
            ),
        )
        self.assertEqual(sketchforge3d.types.ShapeRequest, sketchforge3d.types.Mapping[str, sketchforge3d.types.Any])
        self.assertIsNotNone(get_type_hints(sketchforge3d.Shapes.create))

    def test_sketch_profile_is_a_named_shape_summary_field(self):
        summary = sketchforge3d.ShapeSummary.from_payload({
            "id": "s1", "name": "Sweep", "kind": "mesh", "color": "#d41721",
            "hole": False, "locked": False, "hidden": False, "x": 0, "z": 0,
            "elevation": 0, "width": 2, "depth": 2, "height": 10,
            "rotation": 0, "rotationX": 0, "rotationZ": 0,
            "sketchOperation": "sweep", "sketchSourceId": "sketch/s1", "sketchProfile": {"points": [], "segments": []},
        })
        self.assertEqual(summary.sketch_profile, {"points": [], "segments": []})
        self.assertEqual(summary.sketch_source_id, "sketch/s1")
        self.assertNotIn("sketchProfile", summary.extra)
        self.assertNotIn("sketchSourceId", summary.extra)

    def test_face_draft_is_a_named_summary_field_and_round_trips_in_patch(self):
        face_draft = {
            "sourceFaceId": "face_s1_1", "angle": 5, "pullDirection": "z",
            "sourceFaceNormal": {"x": 1, "y": 0, "z": 0},
        }
        summary = sketchforge3d.ShapeSummary.from_payload({
            "id": "s1", "name": "Draft", "kind": "mesh", "color": "#d41721",
            "hole": False, "locked": False, "hidden": False, "x": 0, "z": 0,
            "elevation": 0, "width": 2, "depth": 2, "height": 3,
            "rotation": 0, "rotationX": 0, "rotationZ": 0, "faceDraft": face_draft,
        })

        self.assertEqual(summary.face_draft, face_draft)
        self.assertEqual(summary.as_patch()["faceDraft"], face_draft)
        self.assertNotIn("faceDraft", summary.extra)


if __name__ == "__main__":
    unittest.main()


class FaceIdentityTypeTests(unittest.TestCase):
    """
    Face colors are keyed by a stable, project-persisted face id rather than by
    the face's position in the CAD listing, which OCCT reorders after any
    operation. The client has to expose both halves: the ids a shape carries,
    and the colors keyed by them.
    """

    def test_shape_summary_exposes_face_ids_and_colors(self):
        summary = sketchforge3d.types.ShapeSummary.from_payload({
            "id": "s1",
            "name": "Bracket",
            "kind": "box",
            "color": "#d41721",
            "hole": False,
            "locked": False,
            "hidden": False,
            "x": 0,
            "z": 0,
            "elevation": 0,
            "width": 20,
            "depth": 20,
            "height": 10,
            "rotation": 0,
            "rotationX": 0,
            "rotationZ": 0,
            "faceIds": ["face_a", "face_b"],
            "faceColors": {"face_a": "#00ff00"},
        })

        self.assertEqual(summary.face_ids, ["face_a", "face_b"])
        self.assertEqual(summary.face_colors, {"face_a": "#00ff00"})
        # Recognised fields do not also land in `extra`, or a caller reading
        # both sees the same data twice under two names.
        self.assertNotIn("faceIds", summary.extra)
        self.assertNotIn("faceColors", summary.extra)

    def test_shape_summary_defaults_face_identity_for_an_older_server(self):
        summary = sketchforge3d.types.ShapeSummary.from_payload({
            "id": "s1",
            "name": "Bracket",
            "kind": "box",
            "color": "#d41721",
            "hole": False,
            "locked": False,
            "hidden": False,
            "x": 0,
            "z": 0,
            "elevation": 0,
            "width": 20,
            "depth": 20,
            "height": 10,
            "rotation": 0,
            "rotationX": 0,
            "rotationZ": 0,
        })

        self.assertEqual(summary.face_ids, [])
        self.assertEqual(summary.face_colors, {})

    def test_numeric_face_color_keys_from_an_older_project_stay_readable(self):
        # The server still accepts numeric keys, so the client must not lose
        # them when reading a project saved before stable identity.
        summary = sketchforge3d.types.ShapeSummary.from_payload({
            "id": "s1",
            "name": "Bracket",
            "kind": "box",
            "color": "#d41721",
            "hole": False,
            "locked": False,
            "hidden": False,
            "x": 0,
            "z": 0,
            "elevation": 0,
            "width": 20,
            "depth": 20,
            "height": 10,
            "rotation": 0,
            "rotationX": 0,
            "rotationZ": 0,
            "faceColors": {"3": "#0000ff"},
        })

        self.assertEqual(summary.face_colors, {"3": "#0000ff"})

    def test_face_summary_declares_an_optional_id(self):
        hints = get_type_hints(sketchforge3d.types.FaceSummary)
        self.assertIn("id", hints)
