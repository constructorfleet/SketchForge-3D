"""
A box whose width and position follow one ``wall`` parameter.

The box is created with expressions instead of numbers, then the parameter is
changed: the server rebuilds the bound box in the same write, and the reply
carries the rebuilt shape. The exact volume and centre of mass before and after
show that the solid itself moved and grew, not only its summary.

``fresh``, because a parameter table outlives a ``replace`` run, which only
empties the shapes.
"""

from typing import Any, Dict, Optional

from sketchforge3d import MacroContext, ShapeSummary, define_macro


def build(context: MacroContext) -> Dict[str, Any]:
    params = context.params
    project = context.project
    project.add_parameter("wall", f"{params['wall']} mm", "length")
    box = project.add(
        {
            "kind": "box",
            "name": "Body",
            "depth": 10,
            "height": 10,
            "expressions": {"width": "wall * 5", "x": "wall * 10"},
        }
    )
    before = project.properties_of(box.id)

    changed = project.update_parameter("wall", expression=f"{params['resized']} mm")
    rebuilt: Optional[ShapeSummary] = next((shape for shape in changed.shapes if shape.id == box.id), None)
    context.log(f"wall {params['wall']} -> {changed.parameter.value} mm rebuilt {len(changed.shapes)} shape(s)")
    after = project.properties_of(box.id)

    return {
        "shapeId": box.id,
        "expressions": box.expressions,
        "before": {"width": box.width, "x": box.x, "volume": before.volume, "centerX": before.center_of_mass["x"]},
        "after": {
            "width": rebuilt.width if rebuilt else None,
            "x": rebuilt.x if rebuilt else None,
            "volume": after.volume,
            "centerX": after.center_of_mass["x"],
        },
        "rebuilt": len(changed.shapes),
    }


MACRO = define_macro(
    name="Parametric box",
    description="A box bound to a wall parameter, rebuilt when the parameter changes.",
    project="fresh",
    params={"wall": 2.0, "resized": 3.0},
    run=build,
)
