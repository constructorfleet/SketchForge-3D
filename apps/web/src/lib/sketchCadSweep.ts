import { TransitionMode, type OcctKernel, type ShapeHandle, type Vec3 } from "occt-wasm";
import { cadSketchSweepPaths, type OrderedCadSketchPath } from "@/lib/sketchCadProfile";
import type { SketchPoint } from "@/types/sketchforge";

function pathWire(cad: OcctKernel, path: OrderedCadSketchPath, map: (point: Pick<SketchPoint, "x" | "z">) => Vec3 = (point) => ({ x: point.x, y: 0, z: point.z })) {
  const edges = path.steps.map(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && first && second) {
      return cad.makeBezierEdge([map(from), map(first), map(second), map(to)]);
    }
    return cad.makeLineEdge(map(from), map(to));
  });
  return cad.makeWire(edges);
}

export function buildCadSketchSweep(cad: OcctKernel, profile: Parameters<typeof cadSketchSweepPaths>[0]): ShapeHandle {
  const { section, spine } = cadSketchSweepPaths(profile);
  const sectionInWorkplane = (point: Pick<SketchPoint, "x" | "z">): Vec3 => ({ x: point.x, y: 0, z: point.z });
  const spineInOrthogonalPlane = (point: Pick<SketchPoint, "x" | "z">): Vec3 => ({ x: point.x, y: point.z, z: 0 });
  return cad.sweep(
    pathWire(cad, section, sectionInWorkplane),
    pathWire(cad, spine, spineInOrthogonalPlane),
    TransitionMode.RoundCorner,
  );
}
