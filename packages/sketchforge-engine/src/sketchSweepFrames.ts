import type { PlacementPoint, PlacementWorkplane } from "./placementWorkplane.js";

export type SketchSweepFrames = { section: PlacementWorkplane; spine: PlacementWorkplane };

/** Places the spine plane at right angles to the section, with screen-right along the section normal. */
export function deriveSketchSweepFrames(section: PlacementWorkplane): SketchSweepFrames {
  return {
    section: copyFrame(section),
    spine: {
      origin: { ...section.origin },
      normal: cross(section.xAxis, section.normal),
      xAxis: { ...section.normal },
      zAxis: { ...section.xAxis },
    },
  };
}

/** Expresses a spine point in the canonical local coordinates used by the sketch builder. */
export function sketchSweepSpinePointInSection(
  frames: SketchSweepFrames,
  point: { x: number; z: number },
): PlacementPoint {
  const { section, spine } = frames;
  const delta = add(
    subtract(spine.origin, section.origin),
    add(scale(spine.xAxis, point.x), scale(spine.zAxis, point.z)),
  );
  return {
    x: dot(delta, section.xAxis),
    y: dot(delta, section.normal),
    z: dot(delta, section.zAxis),
  };
}

function copyFrame(frame: PlacementWorkplane): PlacementWorkplane {
  return {
    origin: { ...frame.origin },
    normal: { ...frame.normal },
    xAxis: { ...frame.xAxis },
    zAxis: { ...frame.zAxis },
  };
}

function add(a: PlacementPoint, b: PlacementPoint): PlacementPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: PlacementPoint, b: PlacementPoint): PlacementPoint {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: PlacementPoint, amount: number): PlacementPoint {
  return { x: a.x * amount, y: a.y * amount, z: a.z * amount };
}

function dot(a: PlacementPoint, b: PlacementPoint) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: PlacementPoint, b: PlacementPoint): PlacementPoint {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
