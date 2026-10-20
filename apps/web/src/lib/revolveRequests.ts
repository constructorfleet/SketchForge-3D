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
import type { SketchProfile, SketchRevolveSettings } from "@/types/sketchforge";

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
export function metricThreadOutline(majorDiameter: number, pitch: number): RevolveRequestPoint[] {
  const crest = Math.max(0.05, majorDiameter / 2);
  // ISO 68-1: the thread's height is 0.613 of the pitch.
  const root = Math.max(0.01, crest - 0.613 * pitch);
  return [[root, 0], [crest, pitch / 2], [root, pitch]];
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
