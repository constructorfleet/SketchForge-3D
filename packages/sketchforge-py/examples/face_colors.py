"""
Color a box's faces, then round its edges and find the colors still there.

This is the example for stable face identity. A face color is keyed by the
face's ``id``, not by its position in the CAD listing: OCCT reorders faces
after any operation, so an index is only true until the next one. Color by
index and a fillet either loses the colors or moves them onto the wrong faces.

The macro proves it rather than asserting it: it reads the colors back after
the fillet and reports which ids survived. A box's top and bottom survive a
fillet of its vertical edges; the sides are replaced by new geometry and take
fresh ids, which is why the report separates the two.
"""

from typing import Any, Dict

from sketchforge3d import MacroContext, define_macro

PALETTE = {"top": "#2e7d32", "bottom": "#1565c0"}


def build(context: MacroContext) -> Dict[str, Any]:
    params = context.params
    box = context.project.add(
        {
            "kind": "box",
            "name": "Painted body",
            "width": params["width"],
            "depth": params["depth"],
            "height": params["height"],
        }
    )

    # Faces are chosen by the direction they point, and recorded by id. The
    # index that `facing` returns is fine for choosing one now; it is the id
    # that is still meaningful after the fillet.
    faces = context.project.faces(box.id)
    painted = {
        face.id: PALETTE[face.facing]
        for face in faces
        if face.facing in PALETTE and face.id is not None
    }
    if not painted:
        raise RuntimeError("the server reported no face ids; it is older than stable face identity")

    colored = context.project.update(box.id, {"faceColors": painted})
    context.log(f"painted {len(painted)} of {len(faces)} faces: {sorted(painted.values())}")

    edges = context.project.edges(box.id)
    roundable = [edge.index for edge in edges if edge.filletable]
    treated = context.project.fillet(box.id, float(params["radius"]), roundable)

    survived = sorted(face_id for face_id in painted if face_id in treated.shape.face_colors)
    lost = sorted(face_id for face_id in painted if face_id not in treated.shape.face_colors)
    context.log(f"{len(survived)} of {len(painted)} painted faces kept their color through the fillet")

    return {
        "shapeId": box.id,
        "faces": len(faces),
        "painted": len(painted),
        "coloredBefore": len(colored.face_colors),
        "survived": len(survived),
        "lost": len(lost),
        "colorsAfter": {
            face_id: color
            for face_id, color in treated.shape.face_colors.items()
            if face_id in painted
        },
        "radius": params["radius"],
    }


MACRO = define_macro(
    name="Face colors",
    description="Colors a box's top and bottom, rounds its edges, and reports which colors survived.",
    project=("replace", "Face colors (python)"),
    params={"width": 60.0, "depth": 40.0, "height": 20.0, "radius": 4.0},
    run=build,
)
