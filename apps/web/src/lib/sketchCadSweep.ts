import { TransitionMode, type OcctKernel, type ShapeHandle, type Vec3 } from "occt-wasm";
import { cadSketchSweepPaths, type OrderedCadSketchPath } from "@/lib/sketchCadProfile";
import type { SketchPoint, SketchSweepFrame } from "@/types/sketchforge";
import { deriveSketchSweepFrames, sketchSweepSpinePointInSection } from "@constructorfleet/sketchforge-engine/sketchSweepFrames";

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
  const defaultSection: SketchSweepFrame = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  };
  const frames = profile.sweepFrames ?? deriveSketchSweepFrames(defaultSection);
  // The builder returns geometry in the section frame's canonical coordinates.
  // The editor applies the selected workplane transform once after meshing.
  const sectionInWorkplane = (point: Pick<SketchPoint, "x" | "z">): Vec3 => ({ x: point.x, y: 0, z: point.z });
  const spineInOrthogonalPlane = (point: Pick<SketchPoint, "x" | "z">): Vec3 => sketchSweepSpinePointInSection(frames, point);
  return cad.sweep(
    pathWire(cad, section, sectionInWorkplane),
    pathWire(cad, spine, spineInOrthogonalPlane),
    TransitionMode.RoundCorner,
  );
}
