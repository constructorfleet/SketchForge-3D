"""Typed CAD resource calls; pass a connected client and existing shape IDs."""

from sketchforge3d import ExportResult, ShapeCollectionResult, SketchForgeClient, WallThicknessEstimate


def inspect_and_explode(
    client: SketchForgeClient, project_id: str, shape_id: str
) -> tuple[ExportResult, WallThicknessEstimate, ShapeCollectionResult]:
    client.faces.list(project_id, shape_id, topology="exact")
    artifact = client.exports.export(
        project_id, format="dxf", section={"plane": "xy", "offset": 3}
    )
    estimate = client.thickness.estimate(project_id, shape_id)
    components = client.explosions.explode(project_id, shape_id)
    return artifact, estimate, components
