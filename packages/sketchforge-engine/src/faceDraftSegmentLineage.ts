import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import type { SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
import { cadSketchRegions } from "./sketchCadProfile.js";
import { sketchExtrusionShapeFromRequest } from "./sketchExtrusionRequest.js";
import { withCadKernel } from "./serverCadKernel.js";
import { shapeFaces } from "./serverCadShell.js";

const MATCH_TOLERANCE = 1e-6;

export type SketchFaceSegmentMatch =
  | { status: "unsupported" }
  | { status: "cap" }
  | { status: "matched"; segmentId: string; faceId: string; normal: Vec3 }
  | { status: "missing" }
  | { status: "ambiguous" };

type SegmentEndpoints = { id: string; start: { x: number; z: number }; end: { x: number; z: number } };
type BoundaryEdge = { curveType: string; vertices: Vec3[] };

function segmentEndpoints(profile: SketchProfile): SegmentEndpoints[] | null {
  let regions;
  try {
    regions = cadSketchRegions(profile);
  } catch {
    return null;
  }
  if (regions.length !== 1 || regions[0]?.holes.length !== 0 || !profile.segments.length
    || regions[0].outer.steps.length !== profile.segments.length) return null;
  if (profile.segments.some((segment) => segment.kind !== undefined && segment.kind !== "line")) return null;

  const pointsById = new Map<string, SketchProfile["points"][number]>();
  for (const point of profile.points) {
    if (!point.id || pointsById.has(point.id)) return null;
    pointsById.set(point.id, point);
  }
  const segmentIds = new Set<string>();
  const endpoints: SegmentEndpoints[] = [];
  for (const segment of profile.segments) {
    if (!segment.id || segmentIds.has(segment.id)) return null;
    segmentIds.add(segment.id);
    const start = pointsById.get(segment.startId);
    const end = pointsById.get(segment.endId);
    if (!start || !end) return null;
    if (segment.kind === undefined
      && ((start.handleOut && end.handleIn) || (start.handleIn && end.handleOut))) return null;
    endpoints.push({ id: segment.id, start: { x: start.x, z: start.z }, end: { x: end.x, z: end.z } });
  }
  return endpoints;
}

function close(left: number, right: number) {
  return Math.abs(left - right) <= MATCH_TOLERANCE;
}

function edgeMatchesSegmentAtY(vertices: Vec3[], y: number, segment: SegmentEndpoints) {
  if (vertices.length !== 2) return false;
  const [first, second] = vertices;
  if (!first || !second || !close(first.y, y) || !close(second.y, y)) return false;
  const direct = close(first.x, segment.start.x) && close(first.z, segment.start.z)
    && close(second.x, segment.end.x) && close(second.z, segment.end.z);
  const reversed = close(first.x, segment.end.x) && close(first.z, segment.end.z)
    && close(second.x, segment.start.x) && close(second.z, segment.start.z);
  return direct || reversed;
}

export function uniqueSketchSegmentForSideBoundary(
  boundary: BoundaryEdge[],
  segments: SegmentEndpoints[],
  height: number,
): { status: "matched"; segmentId: string } | { status: "missing" | "ambiguous" } {
  if (boundary.length < 4 || boundary.some((edge) => edge.curveType !== "line" || edge.vertices.length !== 2)) {
    return { status: "missing" };
  }
  const matched = segments.filter((segment) => {
    const bottom = boundary.filter((edge) => edgeMatchesSegmentAtY(edge.vertices, 0, segment)).length;
    const top = boundary.filter((edge) => edgeMatchesSegmentAtY(edge.vertices, height, segment)).length;
    return bottom === 1 && top === 1;
  });
  if (matched.length === 1) return { status: "matched", segmentId: matched[0]!.id };
  return { status: matched.length === 0 ? "missing" : "ambiguous" };
}

function sideFaceSegmentMatch(cad: OcctKernel, face: ShapeHandle, segments: SegmentEndpoints[], height: number) {
  const edges = cad.getSubShapes(face, "edge");
  const boundary = edges.map((edge) => ({
    curveType: cad.curveType(edge),
    vertices: cad.getSubShapes(edge, "vertex").map((vertex) => cad.vertexPosition(vertex)),
  }));
  return uniqueSketchSegmentForSideBoundary(boundary, segments, height);
}

function faceNormal(cad: OcctKernel, face: ShapeHandle): Vec3 | null {
  try {
    const bounds = cad.uvBounds(face);
    return cad.surfaceNormal(face, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
  } catch {
    return null;
  }
}

function matchFace(cad: OcctKernel, shape: WorkplaneShape, faceId: string): SketchFaceSegmentMatch {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) return { status: "unsupported" };
  const segments = segmentEndpoints(shape.sketchProfile);
  if (!segments) return { status: "unsupported" };
  const faceIndexes = shape.faceIds?.flatMap((id, index) => id === faceId ? [index] : []) ?? [];
  if (faceIndexes.length !== 1) return { status: "missing" };

  let solid: ShapeHandle;
  try {
    solid = cad.fromBREP(shape.cadBrep);
  } catch {
    return { status: "missing" };
  }
  const faces = cad.getSubShapes(solid, "face");
  if (faces.length !== shape.faceIds?.length) return { status: "missing" };
  const face = faces[faceIndexes[0]!];
  if (!face || cad.surfaceType(face) !== "plane") return { status: "unsupported" };
  const normal = faceNormal(cad, face);
  if (!normal) return { status: "missing" };
  if (Math.abs(normal.y) > 1 - MATCH_TOLERANCE) return { status: "cap" };

  const height = shape.cadBrepFrame?.height ?? shape.height;
  const faceMatch = sideFaceSegmentMatch(cad, face, segments, height);
  if (faceMatch.status !== "matched") return faceMatch;

  const segmentId = faceMatch.segmentId;
  const segment = segments.find((candidate) => candidate.id === segmentId)!;
  const matchingFaces = faces.filter((candidate) => sideFaceSegmentMatch(cad, candidate, [segment], height).status === "matched");
  if (matchingFaces.length !== 1) return { status: "ambiguous" };
  return { status: "matched", segmentId, faceId, normal };
}

/** Map a selected source face to its exact sketch line segment, when supported. */
export function sketchSegmentForDraftFace(shape: WorkplaneShape, faceId: string): Promise<SketchFaceSegmentMatch> {
  return withCadKernel((cad) => matchFace(cad, shape, faceId));
}

/** Find the unique source face corresponding to a retained sketch segment. */
export function draftFaceForSketchSegment(shape: WorkplaneShape, segmentId: string): Promise<SketchFaceSegmentMatch> {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) {
    return Promise.resolve({ status: "unsupported" });
  }
  const segments = segmentEndpoints(shape.sketchProfile);
  if (!segments) return Promise.resolve({ status: "unsupported" });
  const segmentMatches = segments.filter((segment) => segment.id === segmentId);
  if (segmentMatches.length !== 1) return Promise.resolve({ status: "missing" });

  return withCadKernel((cad) => {
    let solid: ShapeHandle;
    try {
      solid = cad.fromBREP(shape.cadBrep!);
    } catch {
      return { status: "missing" } as const;
    }
    const faces = cad.getSubShapes(solid, "face");
    if (faces.length !== shape.faceIds?.length) return { status: "missing" } as const;
    const height = shape.cadBrepFrame?.height ?? shape.height;
    const matchingFaces = faces.flatMap((face, index) =>
      sideFaceSegmentMatch(cad, face, segmentMatches, height).status === "matched" && shape.faceIds?.[index]
        ? [{ face, faceId: shape.faceIds[index]! }]
        : []);
    if (matchingFaces.length !== 1) return { status: matchingFaces.length === 0 ? "missing" : "ambiguous" } as const;
    const normal = faceNormal(cad, matchingFaces[0]!.face);
    return normal
      ? { status: "matched", segmentId, faceId: matchingFaces[0]!.faceId, normal } as const
      : { status: "missing" } as const;
  });
}

/** Infer segment identity for a legacy draft from its persisted source geometry or saved normal. */
export async function legacyDraftSegmentForShape(shape: WorkplaneShape): Promise<SketchFaceSegmentMatch> {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.faceDraft) return { status: "unsupported" };
  const frame = shape.faceDraftSourceFrame ?? shape.cadBrepFrame;
  const source = await sketchExtrusionShapeFromRequest({
    id: shape.id,
    sketchSourceId: shape.sketchSourceId,
    name: shape.name,
    color: shape.color,
    hole: shape.hole,
    profile: shape.sketchProfile,
    height: frame?.height ?? shape.height,
    x: shape.x - (frame?.x ?? 0),
    z: shape.z - (frame?.z ?? 0),
    elevation: (shape.elevation ?? 0) - (frame?.elevation ?? 0),
    rotation: shape.rotation,
    rotationX: shape.rotationX,
    rotationZ: shape.rotationZ,
  });
  if (shape.faceDraftSourceFaceIds && source.faceIds
    && shape.faceDraftSourceFaceIds.length === source.faceIds.length) {
    source.faceIds = [...shape.faceDraftSourceFaceIds];
  }

  let selectedFace = (await shapeFaces(source)).find((face) => face.id === shape.faceDraft!.sourceFaceId);
  if (!selectedFace && shape.faceDraft.sourceFaceNormal) {
    const normal = shape.faceDraft.sourceFaceNormal;
    const matches = (await shapeFaces(source)).filter((face) => face.surfaceType === "plane" && face.normal
      && Math.hypot(face.normal.x - normal.x, face.normal.y - normal.y, face.normal.z - normal.z) <= 1e-5);
    if (matches.length > 1) return { status: "ambiguous" };
    selectedFace = matches[0];
  }
  if (!selectedFace) return { status: "missing" };
  return sketchSegmentForDraftFace(source, selectedFace.id);
}
