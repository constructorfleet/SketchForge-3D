import { TransitionMode, type OcctKernel, type ShapeHandle, type Vec3 } from "occt-wasm";
import { cadSketchSweepPaths, type OrderedCadSketchPath } from "@/lib/sketchCadProfile";
import type { SketchPoint, SketchSweepFrame } from "@/types/sketchforge";
import { deriveSketchSweepFrames, sketchSweepSpinePointInSection } from "@constructorfleet/sketchforge-engine/sketchSweepFrames";
import { LocalizedError } from "@/i18n/LocalizedError";

function pathWire(cad: OcctKernel, path: OrderedCadSketchPath, map: (point: Pick<SketchPoint, "x" | "z" | "sweepDepth">) => Vec3 = (point) => ({ x: point.x, y: 0, z: point.z })) {
  const edges = path.steps.map(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && first && second) {
      return cad.makeBezierEdge([
        map(from),
        map({ ...first, sweepDepth: first.sweepDepth ?? from.sweepDepth }),
        map({ ...second, sweepDepth: second.sweepDepth ?? to.sweepDepth }),
        map(to),
      ]);
    }
    return cad.makeLineEdge(map(from), map(to));
  });
  return cad.makeWire(edges);
}

export function buildCadSketchSweep(cad: OcctKernel, profile: Parameters<typeof cadSketchSweepPaths>[0]): ShapeHandle {
  const { sections, spine: rawSpine } = cadSketchSweepPaths(profile);
  const defaultSection: SketchSweepFrame = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  };
  const frames = profile.sweepFrames ?? deriveSketchSweepFrames(defaultSection);
  const spineInOrthogonalPlane = (point: Pick<SketchPoint, "x" | "z" | "sweepDepth">): Vec3 => {
    const position = sketchSweepSpinePointInSection(frames, point);
    return { ...position, z: position.z + (point.sweepDepth ?? 0) };
  };
  const spine = orientedSpine(rawSpine, spineInOrthogonalPlane);
  // The builder returns geometry in the section frame's canonical coordinates.
  // The editor applies the selected workplane transform once after meshing.
  const sectionInWorkplane = (point: Pick<SketchPoint, "x" | "z">): Vec3 => ({ x: point.x, y: 0, z: point.z });
  const spineWire = pathWire(cad, spine, spineInOrthogonalPlane);
  const solids = sections.map((region) => {
    const solid = cad.sweep(pathWire(cad, region.outer, sectionInWorkplane), spineWire, TransitionMode.RoundCorner);
    if (region.holes.length === 0) return solid;
    const cut = region.holes.reduce((result, hole) => {
      const holeSolid = cad.sweep(pathWire(cad, hole, sectionInWorkplane), spineWire, TransitionMode.RoundCorner);
      return cad.cut(result, holeSolid);
    }, solid);
    const remainingSolids = cad.getSubShapes(cut, "solid");
    return remainingSolids.length === 1 ? remainingSolids[0]! : cut;
  });
  return solids.length === 1 ? solids[0]! : cad.makeCompound(solids);
}

function orientedSpine(
  path: OrderedCadSketchPath,
  map: (point: Pick<SketchPoint, "x" | "z" | "sweepDepth">) => Vec3,
): OrderedCadSketchPath {
  if (path.steps.length === 0) throw new LocalizedError("errors.sketch.sweepNeedsSectionAndSpine");
  const reversed = reversePath(path);
  const forwardAligned = initialTangentIsNormal(path, map);
  const reverseAligned = initialTangentIsNormal(reversed, map);
  if (!forwardAligned && !reverseAligned) throw new LocalizedError("errors.sketch.sweepSpineDirection");
  if (forwardAligned && reverseAligned) {
    const forwardStart = path.steps[0]!.from;
    const reverseStart = reversed.steps[0]!.from;
    const forwardDistance = forwardStart.x ** 2 + forwardStart.z ** 2 + (forwardStart.sweepDepth ?? 0) ** 2;
    const reverseDistance = reverseStart.x ** 2 + reverseStart.z ** 2 + (reverseStart.sweepDepth ?? 0) ** 2;
    return reverseDistance < forwardDistance ? reversed : path;
  }
  return reverseAligned ? reversed : path;
}

function initialTangentIsNormal(path: OrderedCadSketchPath, map: (point: Pick<SketchPoint, "x" | "z" | "sweepDepth">) => Vec3) {
  const step = path.steps[0];
  if (!step) return false;
  const forward = step.segment.startId === step.from.id;
  const firstControl = forward ? step.from.handleOut : step.from.handleIn;
  const secondControl = forward ? step.to.handleIn : step.to.handleOut;
  const firstHandle = step.segment.kind !== "line" && firstControl && secondControl ? firstControl : undefined;
  const start = map(step.from);
  const tangentEnd = firstHandle
    ? map({ ...firstHandle, sweepDepth: firstHandle.sweepDepth ?? step.from.sweepDepth })
    : map(step.to);
  const dx = tangentEnd.x - start.x;
  const dy = tangentEnd.y - start.y;
  const dz = tangentEnd.z - start.z;
  const length = Math.hypot(dx, dy, dz);
  return length > 0 && Math.hypot(dx, dz) <= length * 1e-6;
}

function reversePath(path: OrderedCadSketchPath): OrderedCadSketchPath {
  return {
    ...path,
    points: [...path.points].reverse(),
    steps: [...path.steps].reverse().map((step) => ({ ...step, from: step.to, to: step.from })),
  };
}
