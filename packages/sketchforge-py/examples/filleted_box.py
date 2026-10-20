"""
A parametric box with every roundable edge filleted, from three numbers.

The fillet runs on the server with OCCT, so this is the one example that needs
real CAD rather than parameters. Two things it demonstrates: the edge listing
says which edges can be treated at all -- a seam in a curved surface cannot --
and every wanted edge goes in one request, because OCCT refuses a second
treatment on edges adjacent to the first.
"""

from typing import Any, Dict

from sketchforge3d import MacroContext, define_macro


def build(context: MacroContext) -> Dict[str, Any]:
    params = context.params
    box = context.project.add(
        {
            "kind": "box",
            "name": "Body",
            "width": params["width"],
            "depth": params["depth"],
            "height": params["height"],
        }
    )

    edges = context.project.edges(box.id)
    roundable = [edge.index for edge in edges if edge.filletable]
    context.log(f"{len(edges)} edges, {len(roundable)} roundable; filleting at {params['radius']} mm")

    treated = context.project.fillet(box.id, float(params["radius"]), roundable)
    return {
        "shapeId": box.id,
        "edges": len(edges),
        "rounded": len(roundable),
        "radius": params["radius"],
        "triangles": treated.triangles,
        "size": {
            "width": treated.shape.width,
            "depth": treated.shape.depth,
            "height": treated.shape.height,
        },
    }


MACRO = define_macro(
    name="Filleted box",
    description="A box of three dimensions, with its edges rounded.",
    project=("replace", "Filleted box (python)"),
    params={"width": 60.0, "depth": 40.0, "height": 20.0, "radius": 4.0},
    run=build,
)
