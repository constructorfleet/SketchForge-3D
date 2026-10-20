/**
 * Revolved and helical profiles described as data (upstream #51's neighbour:
 * threads over the API).
 *
 * A thread is a shape nobody wants to place by hand -- its profile is a few
 * points and its pitch is a number from a table -- so it is the clearest case
 * for the scripting surfaces. This turns a request into a sketch profile and
 * revolve settings, and is shared by the REST API and the MCP bridge so both
 * accept the same shorthand.
 *
 * The profile is given as a closed outline of `[x, z]` points in the sketch
 * plane, where x is the distance from the axis of revolution and z runs along
 * it. A triangle makes a thread, a rectangle makes a tube or a coil of square
 * wire, and a many-sided polygon approximates a round spring.
 */

import type { ManifoldToplevel } from "manifold-3d";
import { createLocalId } from "@/lib/localIds";
import { sceneShape } from "@/lib/shapeCatalog";
import { buildSketchRevolveMesh, normalizeSketchRevolveSettings } from "@/lib/sketchRevolve";
import {
  coreOverlapForPitch,
  DEFAULT_THREAD_SIZE,
  THREAD_SIZES,
  threadCoreRadius,
  threadGeometry,
  threadSize,
  threadTurnsForLength,
} from "@/lib/threadCatalog";
import type { SketchProfile, SketchRevolveSettings } from "@/types/sketchforge";

/** Turns to sweep when a request says neither turns nor a length. */
export const DEFAULT_THREAD_TURNS = 8;

export const MIN_PROFILE_POINTS = 3;
export const MAX_PROFILE_POINTS = 2000;

export type RevolveRequestPoint = [number, number];

export type ParsedRevolveRequest =
  | { ok: true; profile: SketchProfile; settings: SketchRevolveSettings }
  | { ok: false; error: string };

function isPoint(value: unknown): value is RevolveRequestPoint {
  return Array.isArray(value)
    && value.length === 2
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * The outline as a sketch profile.
 *
 * The editor revolves whatever lies on one side of the axis, so a request
 * giving positive distances -- the natural way to write "from 4mm out to 5mm
 * out" -- is mirrored onto the side the revolve uses rather than coming back
 * empty.
 */
export function profileFromOutline(points: RevolveRequestPoint[]): SketchProfile {
  const onRevolveSide = points.map(([x, z]): RevolveRequestPoint => [x > 0 ? -x : x, z]);
  const sketchPoints = onRevolveSide.map(([x, z]) => ({ id: createLocalId("api-revolve-point"), x, z, mode: "corner" as const }));
  return {
    points: sketchPoints,
    segments: sketchPoints.map((point, index) => ({
      id: createLocalId("api-revolve-segment"),
      startId: point.id,
      endId: sketchPoints[(index + 1) % sketchPoints.length].id,
      kind: "line" as const,
    })),
    images: [],
  };
}

/**
 * A revolve request, or why it cannot be one.
 *
 * Errors are plain sentences: both callers hand them straight to whoever asked,
 * and a script reading "the outline needs at least 3 points" can fix itself.
 */
export function parseRevolveRequest(request: Record<string, unknown>): ParsedRevolveRequest {
  const outline = request.profile ?? request.outline;
  if (!Array.isArray(outline)) {
    return { ok: false, error: 'A revolve needs a "profile": a closed outline of [x, z] points, where x is the distance from the axis.' };
  }
  if (outline.length < MIN_PROFILE_POINTS) {
    return { ok: false, error: `The outline needs at least ${MIN_PROFILE_POINTS} points to enclose an area.` };
  }
  if (outline.length > MAX_PROFILE_POINTS) {
    return { ok: false, error: `The outline may have at most ${MAX_PROFILE_POINTS} points.` };
  }
  const invalid = outline.findIndex((entry) => !isPoint(entry));
  if (invalid >= 0) {
    return { ok: false, error: `Point ${invalid} of the outline is not a pair of finite numbers.` };
  }

  const requested = request.revolve;
  const revolve = requested && typeof requested === "object" && !Array.isArray(requested)
    ? (requested as Partial<SketchRevolveSettings>)
    : (request as Partial<SketchRevolveSettings>);
  // `coreRadius` travels with the outline rather than being a separate step:
  // the outline is drawn to overlap it, so the two only make sense together.

  return {
    ok: true,
    profile: profileFromOutline(outline as RevolveRequestPoint[]),
    settings: normalizeSketchRevolveSettings(revolve),
  };
}

/**
 * The outline of one turn of an ISO metric thread.
 *
 * A convenience worth having: the profile is a 60-degree V whose depth follows
 * from the pitch, which is a formula nobody should have to look up to ask for
 * an M8 bolt. `majorDiameter` is the thread's outside diameter.
 */
export function metricThreadOutline(majorDiameter: number, pitch: number, coreOverlap = 0): RevolveRequestPoint[] {
  const crest = Math.max(0.05, majorDiameter / 2);
  // ISO 68-1: the thread's height is 0.613 of the pitch.
  const root = Math.max(0.01, crest - 0.613 * pitch);
  // Sunk into the core when there is one, so the union has something to bite.
  const inner = Math.max(0.005, root - coreOverlap);
  return [[inner, 0], [crest, pitch / 2], [inner, pitch]];
}

export type ThreadRequest = {
  /** A catalog designation such as "M8" or "1/4-20". */
  size?: unknown;
  diameter?: unknown;
  pitch?: unknown;
  turns?: unknown;
  length?: unknown;
  hole?: unknown;
  clearance?: unknown;
  /** `false` leaves the bare helix, with no shank or drilled hole. */
  core?: unknown;
};

export type ResolvedThreadRequest = {
  profile: RevolveRequestPoint[];
  pitch: number;
  turns: number;
  hole: boolean;
  designation: string;
  /** The shank a bolt stands on, or the drill a tapped hole cuts. 0 leaves the bare helix. */
  coreRadius: number;
};

/**
 * A thread request as an outline and a pitch.
 *
 * A `size` from the catalog is the easy road -- "M8" carries its own pitch --
 * and an explicit `diameter` and `pitch` remain for anything the catalog does
 * not list. `length` is offered instead of `turns` because a bolt is specified
 * by how long its thread is, not by how many times it goes round.
 *
 * A hole is the same form cut larger by the clearance, so the bolt it is for
 * still fits, and comes back marked as a hole for the boolean to subtract.
 */
export function resolveThreadRequest(request: ThreadRequest): ResolvedThreadRequest | { error: string } {
  const hole = request.hole === true;
  const named = typeof request.size === "string" ? threadSize(request.size) : null;
  if (typeof request.size === "string" && !named) {
    return {
      error: `Unknown thread size "${request.size}". Known sizes: ${THREAD_SIZES.map((size) => size.designation).join(", ")}.`,
    };
  }

  const fallback = named ?? threadSize(DEFAULT_THREAD_SIZE)!;
  const diameter = typeof request.diameter === "number" && request.diameter > 0 ? request.diameter : fallback.diameter;
  const requestedPitch = typeof request.pitch === "number" && request.pitch !== 0 ? Math.abs(request.pitch) : fallback.pitch;
  const geometry = threadGeometry(
    { ...fallback, diameter, pitch: requestedPitch },
    { hole, clearance: typeof request.clearance === "number" ? request.clearance : undefined },
  );

  const turns = typeof request.turns === "number" && request.turns > 0
    ? request.turns
    : typeof request.length === "number" && request.length > 0
      ? threadTurnsForLength(geometry.pitch, request.length)
      : DEFAULT_THREAD_TURNS;

  // A left-hand thread is asked for with a negative pitch, and that sign
  // belongs to the sweep rather than to the diameter.
  const handedness = typeof request.pitch === "number" && request.pitch < 0 ? -1 : 1;

  // A thread with no core is a helical ribbon floating in space, which is
  // almost never what someone picking "M8" wants: a bolt is the thread on its
  // shank, and a tapped hole is the thread plus the hole it is cut into. The
  // core is therefore part of the feature, and opting out is explicit.
  const wantsCore = request.core !== false;
  const coreRadius = wantsCore ? threadCoreRadius(geometry.diameter, geometry.pitch) : 0;
  const overlap = wantsCore ? coreOverlapForPitch(geometry.pitch) : 0;

  return {
    profile: metricThreadOutline(geometry.diameter, geometry.pitch, overlap),
    pitch: geometry.pitch * handedness,
    turns,
    hole,
    designation: named?.designation ?? `${diameter}x${geometry.pitch}`,
    coreRadius,
  };
}

/**
 * The shape a revolve request asks for, built with the given manifold runtime.
 *
 * Returns the same kind of record the editor's own revolve produces -- a mesh
 * carrying its profile and settings -- so a thread made over the API is still
 * editable as a revolve afterwards, with its pitch and turns in the inspector.
 */
export function revolvedShapeFromRequest(
  runtime: ManifoldToplevel,
  parsed: { profile: SketchProfile; settings: SketchRevolveSettings },
  base: { name?: string; color?: string; x?: number; z?: number; elevation?: number; hole?: boolean; rotation?: number },
) {
  const mesh = buildSketchRevolveMesh(runtime, parsed.profile, parsed.settings);
  return sceneShape({
    name: base.name?.trim() || (parsed.settings.pitch === 0 ? "Revolve" : "Thread"),
    kind: "mesh",
    color: base.color?.trim() || "#78b96b",
    hole: base.hole,
    x: base.x ?? 0,
    z: base.z ?? 0,
    elevation: base.elevation ?? 0,
    rotation: base.rotation ?? 0,
    size: Math.max(mesh.width, mesh.depth),
    width: mesh.width,
    depth: mesh.depth,
    height: mesh.height,
    importedMesh: {
      positions: mesh.positions,
      baseWidth: mesh.width,
      baseDepth: mesh.depth,
      baseHeight: mesh.height,
      triangleCount: mesh.triangleCount,
      sourceFormat: "json",
    },
    sketchProfile: parsed.profile,
    sketchOperation: "revolve",
    sketchRevolve: parsed.settings,
  });
}
