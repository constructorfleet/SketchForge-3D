"""
N tapped holes on a ring of radius R, in a round flange.

``fresh`` rather than ``replace``: a bolt circle is the thing someone generates
several of to compare, so every run is its own project and no run can overwrite
one that is being looked at.
"""

from typing import Any, Dict, List

from sketchforge3d import MacroContext, define_macro


def build(context: MacroContext) -> Dict[str, Any]:
    params = context.params
    layout = context.layout
    bolt_diameter = float(str(params["size"]).lstrip("Mm") or 6)
    holes = int(params["holes"])
    radius = float(params["radius"])
    thickness = float(params["thickness"])
    bore = float(params["bore"])

    outer_diameter = 2 * (radius + bolt_diameter + 6)
    positions = layout.ring(holes, radius, start_angle=float(params["start_angle"]))
    context.log(f"flange {outer_diameter} mm across, {holes} {params['size']} holes on a {radius} mm ring")

    shapes: List[Dict[str, Any]] = [
        {
            "kind": "cylinder",
            "name": "Flange",
            "width": outer_diameter,
            "depth": outer_diameter,
            "height": thickness,
        }
    ]
    for index, position in enumerate(positions, start=1):
        shapes.append(
            {
                "kind": "thread",
                "name": f"{params['size']} hole {index}",
                "size": params["size"],
                "length": thickness + 2,
                "hole": True,
                "x": layout.mm(position.x),
                "z": layout.mm(position.z),
                "elevation": -1,
            }
        )
    if bore > 0:
        shapes.append(
            {
                "kind": "cylinder",
                "name": "Bore",
                "width": bore,
                "depth": bore,
                "height": thickness + 2,
                "elevation": -1,
                "hole": True,
            }
        )

    written = context.project.add_many(shapes)
    return {
        "outerDiameter": outer_diameter,
        "holes": len(positions),
        # The angles are worth reporting: a wrong start angle is the usual way a
        # bolt circle comes out unusable, and it is invisible in a shape count.
        "angles": [layout.mm(layout.angle_of(position)) for position in positions],
        "shapesWritten": len(written.shapes),
    }


MACRO = define_macro(
    name="Bolt circle",
    description="A flange with N tapped holes on a ring of radius R.",
    project="fresh",
    params={
        "holes": 6,
        "radius": 30.0,
        "size": "M6",
        "thickness": 10.0,
        # A central through hole; 0 leaves the flange solid.
        "bore": 20.0,
        "start_angle": 0.0,
    },
    run=build,
)
