"""
A plate with a computed row of tapped holes.

``replace`` rather than ``fresh``: a plate is a part someone iterates on, and
re-running with a different hole count should give one plate with the new holes
rather than a second plate beside the first.

The holes are ``kind="thread"`` with ``hole=True``, which cuts the thread form
wider by a clearance and marks the shape as a hole. Grouping these thread meshes
with the plate subtracts the bore and thread form to tap it. The REST API also
supports this through ``POST /groups`` or ``POST /booleans``.
"""

from typing import Any, Dict, List

from sketchforge3d import MacroContext, define_macro


def build(context: MacroContext) -> Dict[str, Any]:
    params = context.params
    layout = context.layout
    bolt_diameter = float(str(params["size"]).lstrip("Mm") or 8)
    margin = float(params["margin"])
    thickness = float(params["thickness"])
    holes = int(params["holes"])
    spacing = float(params["spacing"])

    width = (holes - 1) * spacing + 2 * (bolt_diameter / 2 + margin)
    depth = bolt_diameter + 2 * margin
    context.log(f"plate {layout.mm(width)} x {depth} x {thickness} mm, {holes} {params['size']} holes")

    positions = layout.row(holes, spacing)
    shapes: List[Dict[str, Any]] = [
        {"kind": "box", "name": "Plate", "width": layout.mm(width), "depth": depth, "height": thickness}
    ]
    for index, position in enumerate(positions, start=1):
        shapes.append(
            {
                "kind": "thread",
                "name": f"{params['size']} hole {index}",
                "size": params["size"],
                # Match the plate thickness; longer helical meshes can fail OCCT STL import.
                "length": thickness,
                "hole": True,
                "x": layout.mm(position.x),
                "z": layout.mm(position.z),
                "elevation": 0,
            }
        )

    written = context.project.add_many(shapes)
    return {
        "plate": {"width": layout.mm(width), "depth": depth, "thickness": thickness},
        "holes": len(positions),
        "shapesWritten": len(written.shapes),
        "revision": written.revision,
    }


MACRO = define_macro(
    name="Bolt plate",
    description="A plate with a row of tapped holes, centred on it.",
    project=("replace", "Bolt plate (python)"),
    params={
        "holes": 5,
        "spacing": 25.0,
        "size": "M8",
        "thickness": 8.0,
        # Material left beyond the outermost hole, which sets the plate's size.
        "margin": 12.0,
    },
    run=build,
)
