/**
 * The retained face and prism drafts of a sketch extrusion, on a kernel the
 * caller supplies.
 *
 * Browser-safe: nothing here loads a kernel, so the editor's CAD worker runs
 * these on its own OCCT instance and the server runs the same functions inside
 * `withCadKernel`. A draft the editor makes must be the same feature, with the
 * same record and placement, that `PATCH faceDraft` or `POST /draft-prism`
 * makes, and the way to keep two callers from drifting is for both to call one
 * implementation. Shared here, and called by both: which face a draft names
 * (`resolveRetainedFaceDraft`, legacy segment inference included), the draft
 * itself (`draftSketchFace`), result face IDs, the records, and where the
 * drafted part is placed (`retainedDraftSourcePlacement`).
 *
 * Errors carry the messages the REST API has always returned; each caller
 * wraps them in its own error type.
 */

import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import * as THREE from "three";
import type { CadBrepFrame, SketchFaceDraft, SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
import { cadSketchRegions } from "./sketchCadProfile.js";
import { createLocalId } from "./localIds.js";
import { sketchExtrusionSolid } from "./sketchExtrusionSolid.js";

const MATCH_TOLERANCE = 1e-6;
/** How far apart two unit normals may be and still name the same face. */
const NORMAL_MATCH_TOLERANCE = 1e-5;

export const SKETCH_FACE_DRAFT_PULL_AXES = {
  x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 },
  "-x": { x: -1, y: 0, z: 0 }, "-y": { x: 0, y: -1, z: 0 }, "-z": { x: 0, y: 0, z: -1 },
} as const;

export type SketchFaceDraftPullDirection = keyof typeof SKETCH_FACE_DRAFT_PULL_AXES;

export type SketchFaceDraftRequest = {
  sourceFaceId: string;
  angle: number;
  pullDirection: SketchFaceDraftPullDirection;
};

export type SketchFaceSegmentMatch =
  | { status: "unsupported" }
  | { status: "cap" }
  | { status: "matched"; segmentId: string; faceId: string; normal: Vec3 }
  | { status: "missing" }
  | { status: "ambiguous" };

/** What a face-draft lookup needs of the undrafted source extrusion. */
export type SketchFaceDraftSource = Pick<WorkplaneShape, "id" | "sketchOperation" | "sketchProfile" | "cadBrep" | "faceIds" | "cadBrepFrame" | "height">;

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

/**
 * A face's outward normal at the middle of its parameter range, or null.
 *
 * The same sample the REST face listing reports, so a normal recorded here
 * compares equal to one a script read from `GET /faces`.
 */
export function sketchFaceNormal(cad: OcctKernel, face: ShapeHandle): Vec3 | null {
  try {
    const bounds = cad.uvBounds(face);
    const normal = cad.surfaceNormal(face, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
    return [normal.x, normal.y, normal.z].every(Number.isFinite) ? normal : null;
  } catch {
    return null;
  }
}

/** Map a selected source face to its exact sketch line segment, when supported. */
export function sketchSegmentForDraftFaceOnKernel(cad: OcctKernel, shape: SketchFaceDraftSource, faceId: string): SketchFaceSegmentMatch {
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
  const normal = sketchFaceNormal(cad, face);
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

/** Find the unique source face corresponding to a retained sketch segment. */
export function draftFaceForSketchSegmentOnKernel(cad: OcctKernel, shape: SketchFaceDraftSource, segmentId: string): SketchFaceSegmentMatch {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) return { status: "unsupported" };
  const segments = segmentEndpoints(shape.sketchProfile);
  if (!segments) return { status: "unsupported" };
  const segmentMatches = segments.filter((segment) => segment.id === segmentId);
  if (segmentMatches.length !== 1) return { status: "missing" };

  let solid: ShapeHandle;
  try {
    solid = cad.fromBREP(shape.cadBrep);
  } catch {
    return { status: "missing" };
  }
  const faces = cad.getSubShapes(solid, "face");
  if (faces.length !== shape.faceIds?.length) return { status: "missing" };
  const height = shape.cadBrepFrame?.height ?? shape.height;
  const matchingFaces = faces.flatMap((face, index) =>
    sideFaceSegmentMatch(cad, face, segmentMatches, height).status === "matched" && shape.faceIds?.[index]
      ? [{ face, faceId: shape.faceIds[index]! }]
      : []);
  if (matchingFaces.length !== 1) return { status: matchingFaces.length === 0 ? "missing" : "ambiguous" };
  const normal = sketchFaceNormal(cad, matchingFaces[0]!.face);
  return normal
    ? { status: "matched", segmentId, faceId: matchingFaces[0]!.faceId, normal }
    : { status: "missing" };
}

function canonicalDraftRotation(direction: SketchFaceDraftPullDirection) {
  switch (direction) {
    case "x": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: -Math.PI / 2 };
    case "-x": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI / 2 };
    case "y": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: Math.PI / 2 };
    case "-y": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: -Math.PI / 2 };
    case "z": return null;
    case "-z": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI };
  }
}

function rotateVector(vector: Vec3, axis: Vec3, angle: number) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const dot = axis.x * vector.x + axis.y * vector.y + axis.z * vector.z;
  const cross = { x: axis.y * vector.z - axis.z * vector.y, y: axis.z * vector.x - axis.x * vector.z, z: axis.x * vector.y - axis.y * vector.x };
  return {
    x: vector.x * cosine + cross.x * sine + axis.x * dot * (1 - cosine),
    y: vector.y * cosine + cross.y * sine + axis.y * dot * (1 - cosine),
    z: vector.z * cosine + cross.z * sine + axis.z * dot * (1 - cosine),
  };
}

/**
 * Draft one face of a solid about a signed local pull axis, or null when the
 * kernel cannot.
 *
 * OCCT's draft only reliably takes +Z as the pull direction, so when the
 * direct call refuses, the solid is turned until the requested axis is +Z, the
 * face found again on the turned solid by its normal and centre, drafted, and
 * turned back.
 */
export function draftSketchFace(
  cad: OcctKernel,
  solid: ShapeHandle,
  face: ShapeHandle,
  request: { angle: number; pullDirection: SketchFaceDraftPullDirection },
): ShapeHandle | null {
  const direction = SKETCH_FACE_DRAFT_PULL_AXES[request.pullDirection];
  const angle = request.angle * Math.PI / 180;
  try {
    return cad.draft(solid, face, angle, direction);
  } catch {
    const rotation = canonicalDraftRotation(request.pullDirection);
    try {
      if (!rotation) throw new Error("No canonical rotation for the selected pull axis.");
      const rotatedSolid = cad.rotate(solid, rotation.axis, rotation.angle);
      const oldNormal = sketchFaceNormal(cad, face);
      if (!oldNormal) throw new Error("The selected face has no usable normal.");
      const targetNormal = rotateVector(oldNormal, rotation.axis.direction, rotation.angle);
      const targetCenter = rotateVector(cad.getSurfaceCenterOfMass(face), rotation.axis.direction, rotation.angle);
      const bounds = cad.getBoundingBox(solid, false);
      const scale = Math.max(1, Math.hypot(bounds.xmax - bounds.xmin, bounds.ymax - bounds.ymin, bounds.zmax - bounds.zmin));
      const matches = cad.getSubShapes(rotatedSolid, "face").filter((candidate) => {
        const normal = sketchFaceNormal(cad, candidate);
        const center = cad.getSurfaceCenterOfMass(candidate);
        return normal && Math.hypot(normal.x - targetNormal.x, normal.y - targetNormal.y, normal.z - targetNormal.z) <= 1e-7
          && Math.hypot(center.x - targetCenter.x, center.y - targetCenter.y, center.z - targetCenter.z) <= scale * 1e-8;
      });
      if (matches.length !== 1) throw new Error("Could not uniquely identify the selected face after rotating the solid.");
      const canonicalDraft = cad.draft(rotatedSolid, matches[0]!, angle, { x: 0, y: 0, z: 1 });
      return cad.rotate(canonicalDraft, rotation.axis, -rotation.angle);
    } catch {
      return null;
    }
  }
}

/**
 * Face IDs for a result, inherited from the source where a face is plainly
 * the same one.
 *
 * Keep an ID only when an exact face BREP or a unique planar support surface
 * occurs on each side. OCCT face ordering and hash codes are kernel details,
 * so an unmatched or ambiguous face receives a new application ID.
 */
export function faceIdsForCadResult(
  cad: OcctKernel,
  source: Pick<WorkplaneShape, "id" | "faceIds">,
  resultFaces: ShapeHandle[],
  sourceSolid: ShapeHandle,
): string[] {
  const sourceFaces = cad.getSubShapes(sourceSolid, "face");
  const fingerprint = (face: ShapeHandle) => {
    const brep = cad.toBREP(face);
    try {
      if (cad.surfaceType(face) !== "plane") return `brep:${brep}`;
      const bounds = cad.uvBounds(face);
      const normal = cad.surfaceNormal(face, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
      const center = cad.getSurfaceCenterOfMass(face);
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      const n = [round(normal.x), round(normal.y), round(normal.z)];
      const offset = round(center.x * normal.x + center.y * normal.y + center.z * normal.z);
      return `plane:${n.join(",")}:${offset}`;
    } catch {
      return `brep:${brep}`;
    }
  };
  const sourceByBrep = new Map<string, number[]>();
  sourceFaces.forEach((face, index) => {
    const key = fingerprint(face);
    sourceByBrep.set(key, [...(sourceByBrep.get(key) ?? []), index]);
  });
  const resultCounts = new Map<string, number>();
  const resultBreps = resultFaces.map((face) => {
    const key = fingerprint(face);
    resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
    return key;
  });
  const used = new Set<string>();
  return resultBreps.map((brep, index) => {
    const matches = sourceByBrep.get(brep) ?? [];
    const sourceIndex = matches.length === 1 && resultCounts.get(brep) === 1 ? matches[0] : undefined;
    const inherited = sourceIndex === undefined
      ? undefined
      : source.faceIds?.[sourceIndex] ?? `face_${encodeURIComponent(source.id)}_${sourceIndex}`;
    if (inherited && !used.has(inherited)) {
      used.add(inherited);
      return inherited;
    }
    const fresh = createLocalId(`${source.id}-face-${index}`);
    used.add(fresh);
    return fresh.startsWith("face_") ? fresh : `face_${fresh}`;
  });
}

/**
 * Why a retained face draft could not be made, for a caller that words it
 * itself: the face it names cannot be found (`unresolved`), the angle is out of
 * range, the kernel refuses that face, axis and angle (`incompatible`), or the
 * result is not a valid solid. The message is the REST API's.
 */
export class SketchFaceDraftError extends Error {
  readonly reason: "unresolved" | "angle" | "incompatible" | "invalid-result";

  constructor(message: string, reason: SketchFaceDraftError["reason"]) {
    super(message);
    this.name = "SketchFaceDraftError";
    this.reason = reason;
  }
}

function unresolved(message: string): never {
  throw new SketchFaceDraftError(message, "unresolved");
}

/** The single solid a stored B-rep describes, healed the way the server reads one. */
export function solidFromBrepOnKernel(cad: OcctKernel, brep: string): ShapeHandle {
  let exact = cad.fromBREP(brep);
  const isValidSolid = (shape: ShapeHandle) => {
    try {
      return Boolean(cad.isValid(shape)) && cad.isSolid(shape);
    } catch {
      return false;
    }
  };
  const solids = cad.getSubShapes(exact, "solid");
  if (isValidSolid(exact) || solids.length > 0) return solids.length === 1 ? solids[0]! : exact;
  exact = cad.fixShape(exact);
  exact = cad.fixFaceOrientations(exact);
  const healed = cad.getSubShapes(exact, "solid");
  if (isValidSolid(exact) || healed.length > 0) return healed.length === 1 ? healed[0]! : exact;
  throw new Error("The stored exact geometry for that shape could not be read.");
}

/** A face as the REST face listing describes it. */
type ListedFace = { id: string; index: number; surfaceType: string; normal: Vec3 | null };

/**
 * A solid's faces with the IDs `GET /faces` gives them: the shape's own when it
 * has one per face, otherwise `face_<shape id>_<index>`.
 */
function listedFaces(cad: OcctKernel, solid: ShapeHandle, shape: Pick<WorkplaneShape, "id" | "faceIds">): ListedFace[] {
  const faces = cad.getSubShapes(solid, "face");
  const stored = shape.faceIds?.length === faces.length ? shape.faceIds : undefined;
  return faces.map((face, index) => {
    let surfaceType = "unknown";
    try {
      surfaceType = cad.surfaceType(face);
    } catch {
      // Not every surface reports a type.
    }
    return {
      id: stored?.[index] ?? `face_${encodeURIComponent(shape.id)}_${index}`,
      index,
      surfaceType,
      normal: sketchFaceNormal(cad, face),
    };
  });
}

function normalsMatch(left: Vec3, right: Vec3) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= NORMAL_MATCH_TOLERANCE;
}

/** What a face-draft resolution needs of the shape the draft was asked of. */
export type RetainedFaceDraftPrior = Pick<WorkplaneShape,
  | "id" | "faceIds" | "cadBrep" | "cadBrepFrame" | "height" | "sketchOperation" | "sketchProfile"
  | "faceDraft" | "faceDraftSourceFaceIds" | "faceDraftSourceSegmentId" | "faceDraftSourceFrame">;

/**
 * The solid a resolution lists faces on. The server passes its oriented solid,
 * which carries a shape's mirror; the default is the stored B-rep as it is.
 */
export type RetainedFaceDraftSolidOf = (cad: OcctKernel, shape: RetainedFaceDraftPrior | SketchFaceDraftSource) => ShapeHandle;

const storedSolid: RetainedFaceDraftSolidOf = (cad, shape) => {
  if (!shape.cadBrep) throw new Error("The shape has no exact geometry.");
  return solidFromBrepOnKernel(cad, shape.cadBrep);
};

/**
 * Infer the sketch segment of a draft saved before segments were recorded,
 * from its saved source face ID or, failing that, its normal on the extrusion
 * rebuilt from its sketch.
 */
export function legacyDraftSegmentOnKernel(cad: OcctKernel, shape: RetainedFaceDraftPrior): SketchFaceSegmentMatch {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.faceDraft) return { status: "unsupported" };
  const frame = shape.faceDraftSourceFrame ?? shape.cadBrepFrame;
  const height = frame?.height ?? shape.height;
  const solid = sketchExtrusionSolid(cad, shape.sketchProfile, height);
  const faces = cad.getSubShapes(solid, "face");
  const faceIds = shape.faceDraftSourceFaceIds?.length === faces.length
    ? [...shape.faceDraftSourceFaceIds]
    : faces.map((_, index) => `face_${createLocalId(`${shape.id}-face-${index}`)}`);
  const source: SketchFaceDraftSource = {
    id: shape.id,
    sketchOperation: "extrude",
    sketchProfile: shape.sketchProfile,
    cadBrep: cad.toBREP(solid),
    faceIds,
    cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 1, depth: 1, height },
    height,
  };
  const listing = listedFaces(cad, solid, source);
  let selected = listing.find((face) => face.id === shape.faceDraft!.sourceFaceId);
  const savedNormal = shape.faceDraft.sourceFaceNormal;
  if (!selected && savedNormal) {
    const matches = listing.filter((face) => face.surfaceType === "plane" && face.normal && normalsMatch(face.normal, savedNormal));
    if (matches.length > 1) return { status: "ambiguous" };
    selected = matches[0];
  }
  if (!selected) return { status: "missing" };
  return sketchSegmentForDraftFaceOnKernel(cad, source, selected.id);
}

/** The face a retained draft acts on, with the evidence its record keeps. */
export type ResolvedSketchFaceDraftSource = {
  faceId: string;
  normal: Vec3;
  segmentMatch: SketchFaceSegmentMatch;
};

export type RetainedFaceDraftResolution = {
  /** The shape the draft was asked of: undrafted for a new draft, drafted for an edit or replay. */
  existing: RetainedFaceDraftPrior;
  /** The undrafted extrusion the draft is made on, with a stable ID per face. */
  source: SketchFaceDraftSource;
  request: { sourceFaceId: string; angle: number; pullDirection: SketchFaceDraftPullDirection };
  /** Whether the sketch profile was replaced, so faces must be found by segment or normal. */
  profileChanged: boolean;
};

/**
 * Resolve which face of the undrafted source a retained face draft acts on.
 *
 * The one implementation behind both `PATCH faceDraft` on a sketch extrusion
 * and the editor's draft, edit and replay. In order: a draft already on the
 * same face keeps its recorded normal; a new face is looked up by ID, on the
 * rebuilt source when the sketch is unchanged and on the prior shape
 * otherwise; after a profile edit the recorded sketch segment, or the one a
 * legacy draft's saved face implies, must still bound exactly one side face;
 * failing an ID, exactly one flat face must carry the normal. Whatever face is
 * chosen must not match two segments, nor be a side no segment bounds. Each
 * refusal carries the message the API returns for it.
 */
export function resolveRetainedFaceDraft(
  cad: OcctKernel,
  { existing, source, request, profileChanged }: RetainedFaceDraftResolution,
  solidOf: RetainedFaceDraftSolidOf = storedSolid,
): ResolvedSketchFaceDraftSource {
  const sourceFaces = () => listedFaces(cad, solidOf(cad, source), source);
  const priorReference = existing.faceDraft?.sourceFaceId === request.sourceFaceId
    ? existing.faceDraft.sourceFaceNormal
    : undefined;
  const selectedOnPrior = priorReference ? undefined
    : listedFaces(cad, solidOf(cad, existing), existing).find((face) => face.id === request.sourceFaceId);
  const isReselection = existing.faceDraft !== undefined && request.sourceFaceId !== existing.faceDraft.sourceFaceId;
  const exactReselectedSourceFace = isReselection
    ? sourceFaces().find((face) => face.id === request.sourceFaceId)
    : undefined;
  const exactSelectedSourceFace = !profileChanged && !existing.faceDraft
    ? sourceFaces().find((face) => face.id === request.sourceFaceId)
    : undefined;
  const legacySegmentMatch = profileChanged && existing.faceDraft && !existing.faceDraftSourceSegmentId
    ? legacyDraftSegmentOnKernel(cad, existing)
    : undefined;
  if (legacySegmentMatch?.status === "ambiguous") unresolved("The saved face draft does not identify one source sketch segment.");
  const retainedSourceSegmentId = existing.faceDraftSourceSegmentId
    ?? (legacySegmentMatch?.status === "matched" ? legacySegmentMatch.segmentId : undefined);
  const retainedSegmentFace = profileChanged && retainedSourceSegmentId
    ? draftFaceForSketchSegmentOnKernel(cad, source, retainedSourceSegmentId)
    : undefined;
  if (retainedSegmentFace && retainedSegmentFace.status !== "matched") {
    unresolved("The selected sketch segment no longer maps to exactly one extrusion side face.");
  }
  let faceId = retainedSegmentFace?.status === "matched"
    ? retainedSegmentFace.faceId
    : exactReselectedSourceFace?.surfaceType === "plane" ? exactReselectedSourceFace.id
      : exactSelectedSourceFace?.surfaceType === "plane" ? exactSelectedSourceFace.id : undefined;
  const normal = retainedSegmentFace?.status === "matched"
    ? retainedSegmentFace.normal
    : exactReselectedSourceFace?.normal ?? exactSelectedSourceFace?.normal ?? priorReference ?? selectedOnPrior?.normal;
  if (!normal || selectedOnPrior && selectedOnPrior.surfaceType !== "plane") {
    unresolved("The selected source face has no stable planar reference.");
  }
  if (!faceId) {
    const matches = sourceFaces().filter((face) => face.surfaceType === "plane" && face.normal && normalsMatch(face.normal, normal));
    faceId = matches.length === 1 ? matches[0]!.id : undefined;
  }
  if (!faceId) unresolved("The selected source face is missing or ambiguous after the sketch edit.");
  const segmentMatch = retainedSegmentFace?.status === "matched"
    ? retainedSegmentFace
    : sketchSegmentForDraftFaceOnKernel(cad, source, faceId);
  if (segmentMatch.status === "ambiguous") unresolved("The selected lateral face matches multiple sketch segments.");
  if (segmentMatch.status === "missing") unresolved("The selected extrusion side face has no exact sketch-segment boundary match.");
  return { faceId, normal, segmentMatch };
}

/** The fields a retained face draft adds to its shape. */
export type RetainedFaceDraftFields = {
  faceDraft: SketchFaceDraft;
  faceDraftSourceFaceIds: string[] | undefined;
  faceDraftSourceSegmentId: string | undefined;
  faceDraftSourceFrame: CadBrepFrame | undefined;
};

/**
 * The record of a retained face draft.
 *
 * `sourceFaceIds` are the IDs of the undrafted source it was resolved on, and
 * `frameSource` the shape the draft was asked of: its earlier source frame is
 * kept through every replay, so a sketch edit never loses where it started.
 */
export function retainedFaceDraftFields(
  sourceFaceIds: string[] | undefined,
  frameSource: Pick<WorkplaneShape, "faceDraftSourceFrame" | "cadBrepFrame">,
  resolved: Pick<ResolvedSketchFaceDraftSource, "faceId" | "normal" | "segmentMatch">,
  request: { angle: number; pullDirection: SketchFaceDraftPullDirection },
): RetainedFaceDraftFields {
  return {
    faceDraft: {
      sourceFaceId: resolved.faceId,
      angle: request.angle,
      pullDirection: request.pullDirection,
      sourceFaceNormal: resolved.normal,
    },
    faceDraftSourceFaceIds: sourceFaceIds,
    faceDraftSourceSegmentId: resolved.segmentMatch.status === "matched" ? resolved.segmentMatch.segmentId : undefined,
    faceDraftSourceFrame: frameSource.faceDraftSourceFrame ?? frameSource.cadBrepFrame,
  };
}

/**
 * Resolve and draft a retained face draft on the undrafted source.
 *
 * The editor's CAD worker runs this. The drafted solid is in the source
 * B-rep's own frame; `sourceFaceIds` are the source's listed IDs and
 * `resultFaceIds` inherit them for faces the draft left alone.
 */
export function retainedSketchFaceDraft(
  cad: OcctKernel,
  resolution: RetainedFaceDraftResolution,
): { solid: ShapeHandle; resolved: ResolvedSketchFaceDraftSource; sourceFaceIds: string[]; resultFaceIds: string[] } {
  const { source, request } = resolution;
  if (!Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45) {
    throw new SketchFaceDraftError("The face draft angle must be non-zero and between -45 and 45 degrees.", "angle");
  }
  if (source.sketchOperation !== "extrude" || !source.sketchProfile || !source.cadBrep) {
    unresolved("Face drafts require an exact retained sketch extrusion, sweep, or plain full-turn revolve.");
  }
  const resolved = resolveRetainedFaceDraft(cad, resolution);
  const solid = solidFromBrepOnKernel(cad, source.cadBrep);
  const sourceFaceIds = listedFaces(cad, solid, source).map((face) => face.id);
  if (new Set(sourceFaceIds).size !== sourceFaceIds.length) unresolved("Face drafting requires a complete, unique stable face ID list.");
  const face = cad.getSubShapes(solid, "face")[sourceFaceIds.indexOf(resolved.faceId)];
  if (!face) unresolved("The selected source face is no longer available.");
  const drafted = draftSketchFace(cad, solid, face, request);
  if (!drafted) {
    throw new SketchFaceDraftError("The selected source face cannot be drafted along that local pull axis and angle.", "incompatible");
  }
  if (!cad.isValid(drafted) || !cad.isSolid(drafted)) {
    throw new SketchFaceDraftError("The face draft did not produce a valid solid.", "invalid-result");
  }
  const identified = { id: source.id, faceIds: sourceFaceIds };
  return {
    solid: drafted,
    resolved,
    sourceFaceIds,
    resultFaceIds: faceIdsForCadResult(cad, identified, cad.getSubShapes(drafted, "face"), solid),
  };
}

/** The fields a retained prism draft adds to its shape. */
export function retainedPrismDraftFields(shape: Pick<WorkplaneShape, "draftPrismSourceFrame" | "draftPrismSourceHeight" | "cadBrepFrame" | "height">, angle: number) {
  const sourceFrame = shape.draftPrismSourceFrame ?? shape.cadBrepFrame;
  return {
    draftPrismAngle: angle,
    draftPrismSourceHeight: shape.draftPrismSourceHeight ?? shape.height,
    ...(sourceFrame ? { draftPrismSourceFrame: sourceFrame } : {}),
  };
}

/**
 * The centre of a profile's bounds: where a prism draft's B-rep is centred,
 * and where a straight extrusion of it has its frame.
 */
export function draftPrismProfileOffset(profile: Pick<SketchProfile, "points">) {
  const xs = profile.points.map(({ x }) => x);
  const zs = profile.points.map(({ z }) => z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: 0,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

/**
 * Where the REST API places the undrafted extrusion a retained draft is
 * rebuilt on, and so the drafted result, which keeps it.
 *
 * The shape's position is moved by however far the rebuilt extrusion's frame
 * is from the source frame the draft first started from. Frame offsets are in
 * sketch coordinates, so rotate them by the shape's placement before adding
 * them to its world position. The editor and REST use this same rule so one
 * record means one placement whichever side wrote it (#384, #435).
 */
export function retainedDraftSourcePlacement(
  existing: Pick<WorkplaneShape, "x" | "z" | "elevation" | "rotation" | "rotationX" | "rotationZ" | "mirrorX" | "mirrorY" | "mirrorZ" | "faceDraftSourceFrame" | "draftPrismSourceFrame" | "cadBrepFrame">,
  rebuiltFrame: Pick<CadBrepFrame, "x" | "z" | "elevation">,
  sourceFrameOverride?: Pick<CadBrepFrame, "x" | "z" | "elevation">,
) {
  const sourceFrame = sourceFrameOverride ?? existing.faceDraftSourceFrame ?? existing.draftPrismSourceFrame ?? existing.cadBrepFrame;
  const offset = new THREE.Vector3(
    (rebuiltFrame.x - (sourceFrame?.x ?? 0)) * (existing.mirrorX ? -1 : 1),
    (rebuiltFrame.elevation - (sourceFrame?.elevation ?? 0)) * (existing.mirrorY ? -1 : 1),
    (rebuiltFrame.z - (sourceFrame?.z ?? 0)) * (existing.mirrorZ ? -1 : 1),
  ).applyEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(existing.rotationX ?? 0),
    THREE.MathUtils.degToRad(existing.rotation ?? 0),
    THREE.MathUtils.degToRad(existing.rotationZ ?? 0),
    "XYZ",
  ));
  return {
    x: existing.x + offset.x,
    z: existing.z + offset.z,
    elevation: (existing.elevation ?? 0) + offset.y,
  };
}
