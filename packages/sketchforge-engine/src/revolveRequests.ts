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
import * as THREE from "three";
import { createLocalId } from "./localIds.js";
import { sceneShape } from "./shapeCatalog.js";
import { buildSketchRevolveMesh, normalizeSketchRevolveSettings } from "./sketchRevolve.js";
import {
  coreOverlapForPitch,
  DEFAULT_THREAD_SIZE,
  THREAD_SIZES,
  threadCoreRadius,
  threadGeometry,
  threadSize,
  threadTurnsForLength,
} from "./threadCatalog.js";
import { canonicalizeShape, meshYawDegrees, mirrorSign } from "./workplaneShapes.js";
import type { SketchProfile, SketchRevolveSettings, WorkplaneShape } from "./domain/sketchforge.js";

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
 * The outline a stored profile came from, or null when it was not written here.
 *
 * `profileFromOutline` builds a single closed ring whose segments follow its
 * points, so recognising that shape is enough to hand the outline back in the
 * form it arrived in -- mirrored to the positive distances a request writes.
 * A profile drawn in the editor can be several paths, can carry curve handles,
 * and need not be in point order; reporting nothing is honest there, where
 * reordering its points would be a guess dressed up as the original.
 */
export function outlineFromProfile(profile: SketchProfile): RevolveRequestPoint[] | null {
  const points = profile.points;
  if (points.length < MIN_PROFILE_POINTS || profile.segments.length !== points.length) return null;
  const closedRing = profile.segments.every((segment, index) =>
    segment.kind === "line"
    && segment.startId === points[index].id
    && segment.endId === points[(index + 1) % points.length].id);
  if (!closedRing) return null;
  if (points.some((point) => point.handleIn || point.handleOut)) return null;
  return points.map(({ x, z }): RevolveRequestPoint => [Math.abs(x), z]);
}

/** Whether a shape is a revolve or a thread rather than any other mesh. */
export function isRevolveShape(shape: WorkplaneShape) {
  return shape.sketchOperation === "revolve" && Boolean(shape.sketchProfile) && Boolean(shape.sketchRevolve);
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

export type RevolveAxis = { x: number; z: number };

/**
 * Where a revolve's box centre sits from its axis, in world X/Z.
 *
 * The offset is recorded in the mesh's natural frame, so it is put through the
 * same resize, mirror and rotation the viewport applies to the mesh -- the
 * order `transformMesh` uses, about the shape's mid-height.
 */
function centreFromAxis(shape: WorkplaneShape, offset: RevolveAxis): RevolveAxis {
  const mesh = shape.importedMesh;
  const ratio = (drawn: number, natural: number | undefined) => (natural && natural > 0 && drawn > 0 ? drawn / natural : 1);
  const local = new THREE.Vector3(
    offset.x * ratio(shape.width, mesh?.baseWidth) * mirrorSign(shape.mirrorX),
    0,
    offset.z * ratio(shape.depth, mesh?.baseDepth) * mirrorSign(shape.mirrorZ),
  ).applyEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(shape.rotationX ?? 0),
    THREE.MathUtils.degToRad(meshYawDegrees(shape)),
    THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
    "XYZ",
  ));
  return { x: local.x, z: local.z };
}

/**
 * The world X/Z of a revolve's axis, or null when it was never recorded.
 *
 * A shape's `x`/`z` is its box centre, as for every shape. A full turn is
 * symmetric, so that is its axis too; a partial sweep's box centre is off to
 * one side, which is what #503 lost.
 */
export function revolveAxisPosition(shape: WorkplaneShape): RevolveAxis | null {
  if (!shape.revolveAxisOffset) return null;
  const centre = centreFromAxis(shape, shape.revolveAxisOffset);
  return { x: shape.x - centre.x, z: shape.z - centre.z };
}

/**
 * Where a revolve's axis stands, for reporting, or null when it has no one place.
 *
 * Tilted by `rotationX` or `rotationZ`, the axis is no longer vertical, so it
 * crosses the workplane's X/Z at a different point at every height and no
 * single `{ x, z }` says where it is. `revolveAxisPosition` still works there
 * -- it is the point on the axis at the shape's mid-height, which is what
 * placement uses -- but reporting it would read as the axis standing there.
 * A half turn of tilt leaves the axis vertical, so it is reported again.
 */
export function reportedRevolveAxis(shape: WorkplaneShape): RevolveAxis | null {
  const upright = (degrees: number | undefined) => Math.abs(Math.sin(THREE.MathUtils.degToRad(degrees ?? 0))) < 1e-9;
  if (!upright(shape.rotationX) || !upright(shape.rotationZ)) return null;
  return revolveAxisPosition(shape);
}

/** The revolve moved so its axis is at `axis`, its orientation and size unchanged. */
export function placeRevolveOnAxis<T extends WorkplaneShape>(shape: T, axis: RevolveAxis): T {
  const centre = centreFromAxis(shape, shape.revolveAxisOffset ?? { x: 0, z: 0 });
  return { ...shape, x: axis.x + centre.x, z: axis.z + centre.z };
}

/**
 * The axis offset a revolve carries once its transform is baked into its mesh.
 *
 * Baking moves the triangles into place, drops the rotation and mirror, and
 * re-centres the mesh on its new box, so the offset recorded in the old mesh
 * frame no longer says where the axis is. It is measured again from where the
 * axis was, in the baked mesh's natural frame (its drawn size over the size
 * its triangles are stored at). A revolve with no recorded axis keeps none.
 */
export function bakedRevolveAxisOffset(original: WorkplaneShape, baked: WorkplaneShape): RevolveAxis | undefined {
  const axis = revolveAxisPosition(original);
  if (!axis) return original.revolveAxisOffset;
  const natural = (stored: number | undefined, drawn: number) => (stored && stored > 0 && drawn > 0 ? stored / drawn : 1);
  return {
    x: (baked.x - axis.x) * natural(baked.importedMesh?.baseWidth, baked.width),
    z: (baked.z - axis.z) * natural(baked.importedMesh?.baseDepth, baked.depth),
  };
}

/**
 * A revolve's axis, recovering it from the sweep when it was not recorded.
 *
 * A revolve saved before the offset was kept (#503) sits wherever its box was
 * put. Its own profile and settings still describe the sweep it was built
 * from, so building that again says where its axis was, and its first rebuild
 * keeps it in place rather than jumping by the offset. A shape whose sweep
 * cannot be rebuilt keeps its box centre as the axis, which is what it had.
 */
export function recoveredRevolveAxis(runtime: ManifoldToplevel, shape: WorkplaneShape): RevolveAxis {
  const recorded = revolveAxisPosition(shape);
  if (recorded) return recorded;
  if (!shape.sketchProfile || !shape.sketchRevolve) return { x: shape.x, z: shape.z };
  try {
    const { axisOffset } = buildSketchRevolveMesh(runtime, shape.sketchProfile, shape.sketchRevolve);
    return revolveAxisPosition({ ...shape, revolveAxisOffset: axisOffset }) ?? { x: shape.x, z: shape.z };
  } catch {
    return { x: shape.x, z: shape.z };
  }
}

/**
 * The shape a revolve request asks for, built with the given manifold runtime.
 *
 * Returns the same kind of record the editor's own revolve produces -- a mesh
 * carrying its profile and settings -- so a thread made over the API is still
 * editable as a revolve afterwards, with its pitch and turns in the inspector.
 *
 * `x` and `z` place the axis of revolution, not the box: a quarter ring asked
 * for at the origin spans the quarter it turns through, rather than being
 * centred on the origin (#503). For a full turn the two are the same point.
 */
export function revolvedShapeFromRequest(
  runtime: ManifoldToplevel,
  parsed: { profile: SketchProfile; settings: SketchRevolveSettings },
  base: { name?: string; color?: string; x?: number; z?: number; elevation?: number; hole?: boolean; rotation?: number },
) {
  const mesh = buildSketchRevolveMesh(runtime, parsed.profile, parsed.settings);
  const shape = sceneShape({
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
    revolveAxisOffset: mesh.axisOffset,
  });
  return placeRevolveOnAxis({ ...shape, sketchSourceId: `sketch/${shape.id}` }, { x: base.x ?? 0, z: base.z ?? 0 });
}

/**
 * An existing revolve swept again with changed settings, keeping its identity.
 *
 * A revolve's pitch, turns and outline are its geometry rather than a property
 * of it, so changing one means sweeping the mesh again -- there is nothing to
 * edit in place. What survives is everything that is not geometry: the shape's
 * id, so references to it still resolve, and its placement, name and flags.
 *
 * Placement means the axis. A changed sweep angle moves the box centre, and
 * keeping that instead would slide the solid round its own axis on every edit.
 *
 * The scale survives too. A revolve resized after it was made carries a ratio
 * between its mesh's natural size and the size it is drawn at, and a fresh
 * sweep is at natural size; dropping the ratio would silently resize a thread
 * whose pitch was the only thing asked about.
 */
export function rebuiltRevolveShape(
  runtime: ManifoldToplevel,
  shape: WorkplaneShape,
  parsed: { profile: SketchProfile; settings: SketchRevolveSettings },
): WorkplaneShape {
  const axis = recoveredRevolveAxis(runtime, shape);
  const rebuilt = revolvedShapeFromRequest(runtime, parsed, {
    name: shape.name,
    color: shape.color,
    x: shape.x,
    z: shape.z,
    elevation: shape.elevation,
    hole: shape.hole,
    rotation: shape.rotation,
  });
  const previous = shape.importedMesh;
  const scale = (drawn: number, base: number | undefined) => (base && base > 0 ? drawn / base : 1);
  const widthScale = scale(shape.width, previous?.baseWidth);
  const depthScale = scale(shape.depth, previous?.baseDepth);
  const heightScale = scale(shape.height, previous?.baseHeight);
  const width = Math.max(0.01, rebuilt.width * widthScale);
  const depth = Math.max(0.01, rebuilt.depth * depthScale);
  return placeRevolveOnAxis(canonicalizeShape({
    ...rebuilt,
    id: shape.id,
    sketchSourceId: shape.sketchSourceId ?? `sketch/${shape.id}`,
    width,
    depth,
    height: Math.max(0.01, rebuilt.height * heightScale),
    size: Math.max(width, depth),
    rotationX: shape.rotationX,
    rotationZ: shape.rotationZ,
    locked: shape.locked,
    hidden: shape.hidden,
  }), axis);
}

/**
 * `kind: "thread"` is `kind: "revolve"` with the outline filled in.
 *
 * A size from the catalog carries its own pitch, so "M8" is enough; an
 * explicit diameter and pitch still work for anything unlisted. `hole: true`
 * cuts the form wider by a clearance so a bolt of that size fits, and marks
 * the shape as a hole for the boolean to subtract.
 *
 * A request already carrying a `profile` is passed through: the caller has
 * described the outline itself, and the catalog has nothing to add to it.
 */
export function resolvedThreadRequest(
  request: Record<string, unknown>,
): { request: Record<string, unknown>; error?: undefined } | { error: string; request?: undefined } {
  if (request.profile) return { request };
  const resolved = resolveThreadRequest(request);
  if ("error" in resolved) return { error: resolved.error };
  return {
    request: {
      ...request,
      profile: resolved.profile,
      pitch: resolved.pitch,
      turns: resolved.turns,
      coreRadius: resolved.coreRadius,
      hole: resolved.hole,
      name: typeof request.name === "string" ? request.name : (resolved.hole ? `${resolved.designation} hole` : resolved.designation),
    },
  };
}

/**
 * The settings a change names, over the ones a revolve already has.
 *
 * `sides` means the sweep's angular resolution here, not a facet count, which
 * is why a revolve's settings are read apart from the per-kind parameters: the
 * stored kind is `mesh`, and a mesh has no facets to count.
 */
export const REVOLVE_SETTING_NAMES = ["startAngle", "sweepAngle", "sides", "quality", "pitch", "turns", "coreRadius"] as const;

/**
 * The change fields that can only mean a sweep.
 *
 * `sides` is left out because it is also a prism's facet count, and a cylinder
 * naming it is asking about facets, not about a helix it does not have.
 */
export const REVOLVE_ONLY_FIELDS = ["startAngle", "sweepAngle", "quality", "pitch", "turns", "coreRadius", "revolve", "profile", "outline"] as const;

/** Everything a change to a swept shape may name that belongs to the sweep. */
export const REVOLVE_CHANGE_FIELDS = [...REVOLVE_SETTING_NAMES, "revolve", "profile", "outline"] as const;

/**
 * A revolve's settings with the ones a change named replaced.
 *
 * Settings may arrive nested under `revolve`, which is how the shape summary
 * reports them, or flat alongside the rest of the change -- so reading a shape
 * back and sending it with one number changed works either way.
 */
export function requestedRevolveSettings(
  existing: SketchRevolveSettings,
  body: Record<string, unknown>,
): SketchRevolveSettings {
  const nested = body.revolve && typeof body.revolve === "object" && !Array.isArray(body.revolve)
    ? (body.revolve as Record<string, unknown>)
    : {};
  const requested: Record<string, unknown> = { ...existing };
  for (const name of REVOLVE_SETTING_NAMES) {
    const value = nested[name] ?? body[name];
    if (value !== undefined) requested[name] = value;
  }
  return normalizeSketchRevolveSettings(requested as Partial<SketchRevolveSettings>);
}
