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
  const firstStep = spine.steps[0];
  if (!firstStep) throw new Error("Sweep spine has no segments");
  const forward = firstStep.segment.startId === firstStep.from.id;
  const firstHandle = forward ? firstStep.from.handleOut : firstStep.from.handleIn;
  const tangentPoint = firstHandle ?? firstStep.to;
  const dx = tangentPoint.x - firstStep.from.x;
  const dz = tangentPoint.z - firstStep.from.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) throw new Error("Sweep spine has no initial tangent");
  const lateral = { x: -dz / length, z: dx / length };
  const origin = { x: firstStep.from.x, z: firstStep.from.z };
  const sectionPoint = (point: Pick<SketchPoint, "x" | "z">): Vec3 => ({
    x: origin.x + lateral.x * point.x,
    y: point.z,
    z: origin.z + lateral.z * point.x,
  });
  return cad.sweep(pathWire(cad, section, sectionPoint), pathWire(cad, spine), TransitionMode.RoundCorner);
}
