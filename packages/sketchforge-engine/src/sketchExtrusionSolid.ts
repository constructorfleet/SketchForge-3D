import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type { SketchProfile } from "./domain/sketchforge.js";
import { cadSketchRegions, type OrderedCadSketchPath } from "./sketchCadProfile.js";

/**
 * A sketch extrusion as exact geometry, on a kernel the caller supplies.
 *
 * Browser-safe, so a face-draft replay that must rebuild an older extrusion
 * (`legacyDraftSegmentOnKernel`) can do it inside whichever kernel is running
 * it. The profile is extruded along +Y from Y=0 in sketch coordinates, which is
 * the frame every retained sketch extrusion's B-rep is stored in.
 */
function pathWire(cad: OcctKernel, path: OrderedCadSketchPath) {
  return cad.makeWire(path.steps.map(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && first && second) {
      return cad.makeBezierEdge([
        { x: from.x, y: 0, z: from.z }, { x: first.x, y: 0, z: first.z },
        { x: second.x, y: 0, z: second.z }, { x: to.x, y: 0, z: to.z },
      ]);
    }
    return cad.makeLineEdge({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z });
  }));
}

export function sketchExtrusionSolid(cad: OcctKernel, profile: SketchProfile, height: number): ShapeHandle {
  const regions = cadSketchRegions(profile);
  if (regions.length === 0) throw new Error("A sketch extrusion requires a closed profile.");
  const solids = regions.map((region) => {
    let face = cad.makeFace(pathWire(cad, region.outer));
    if (region.holes.length) face = cad.addHolesInFace(face, region.holes.map((hole) => pathWire(cad, hole)));
    return cad.extrude(face, 0, height, 0);
  });
  return solids.length === 1 ? solids[0]! : cad.makeCompound(solids);
}
