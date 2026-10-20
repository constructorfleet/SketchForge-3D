/**
 * The engine's operations, bound to a project store (upstream issue #55).
 *
 * `docs/ENGINE_EXTRACTION.md` section 5 names the thing this file is: the seven
 * `v1` route handlers were each re-assembling the same eight steps -- take the
 * project lock, read the document, resolve the ids, refuse a locked shape, run
 * the geometry, write the document, bump the revision, summarise the result --
 * and the geometry was one call in the middle. Two of them (`booleans` and
 * `groups`) had drifted into saying the same thing twice in different words.
 *
 * What stays out of here is HTTP. An operation reports *what happened* as a
 * tagged `EngineFailure`; the caller decides what status code and what sentence
 * that is worth. That split is what lets a macro runner reuse the orchestration
 * -- including the project lock, which a macro writing a directory needs and
 * does not have today -- without pulling `next/server` in with it.
 */

import {
  applyEdgeTreatment,
  shapeEdges,
  shapeWithCadResult,
  ServerCadError,
  type ServerCadEdge,
  type ServerCadTreatment,
} from "@/lib/engine/serverCadOperations";
import {
  applyShell,
  shapeFaces,
  type ServerCadFace,
  type ServerCadShellRequest,
} from "@/lib/engine/serverCadShell";
import { buildGroupFromSelection } from "@/lib/engine/serverShapeBooleans";
import { restoreGroupedChildren, separateShapeParts } from "@/lib/engine/serverShapeGroups";
import { withHoleMode } from "@/lib/engine/workplaneShapes";
import type { ProjectDocument, ProjectStore } from "@/lib/engine/projectStore";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * Why an operation did not happen.
 *
 * Deliberately a tag and not a status code. A status is too coarse to carry the
 * distinction -- `409` is both "the project is busy, retry" and "that shape is
 * locked, do not" -- and a sentence is the caller's to choose: the REST API
 * answers a script in English prose, and the editor would want a translated
 * `LocalizedError` for the same refusal.
 *
 * `cad_refused` is the kernel saying why, in words already fit to show a
 * caller, with the status `ServerCadError` chose. `cad_failed` is anything else
 * the kernel threw, which has no caller-facing wording -- the two read-only
 * routes and the two write routes word that case differently, and that is
 * their business, not the engine's.
 */
export type EngineFailure =
  | { reason: "project_busy" }
  | { reason: "project_not_found" }
  | { reason: "shapes_not_found"; ids: string[] }
  | { reason: "shape_locked"; ids: string[] }
  | { reason: "not_a_group" }
  | { reason: "single_body" }
  | { reason: "hole_has_no_parts" }
  | { reason: "cut_removed_nothing" }
  | { reason: "geometry_failed"; message: string; status: number }
  | { reason: "cad_refused"; message: string; status: number }
  | { reason: "cad_failed" };

export type EngineResult<T> = { ok: true; value: T } | { ok: false; failure: EngineFailure };

/** One shape written, with the revision the write landed on. */
export type ShapeWritten = { shape: WorkplaneShape; revision: number };
/** Several shapes written, with the revision the write landed on. */
export type ShapesWritten = { shapes: WorkplaneShape[]; revision: number };

export type CutRequest = { solidIds: string[]; holeIds: string[] };

export type Engine = {
  /** Subtract `holeIds` from `solidIds`, leaving one group where the operands were. */
  cut(projectId: string, request: CutRequest): Promise<EngineResult<ShapeWritten>>;
  /** Bundle shapes into one group; a selection holding a hole comes back cut. */
  group(projectId: string, ids: string[]): Promise<EngineResult<ShapeWritten>>;
  /** Take a group apart, leaving its children where they appeared. */
  ungroup(projectId: string, shapeId: string): Promise<EngineResult<ShapesWritten>>;
  /** Split a shape into the separate bodies it is made of. */
  separate(projectId: string, shapeId: string): Promise<EngineResult<ShapesWritten>>;
  /** A shape's edges, numbered as a treatment request refers to them. */
  edges(projectId: string, shapeId: string): Promise<EngineResult<ServerCadEdge[]>>;
  /** A shape's faces, numbered as a shell request refers to them. */
  faces(projectId: string, shapeId: string): Promise<EngineResult<ServerCadFace[]>>;
  /** Round or cut a shape's edges. */
  treat(projectId: string, shapeId: string, treatment: ServerCadTreatment): Promise<EngineResult<ShapeWritten>>;
  /** Hollow a shape out, optionally leaving faces open. */
  shell(projectId: string, shapeId: string, request: ServerCadShellRequest): Promise<EngineResult<ShapeWritten>>;
};

function ok<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

function failed<T>(failure: EngineFailure): EngineResult<T> {
  return { ok: false, failure };
}

/**
 * The shapes `ids` names, in **document order**, or the ids that are not there.
 *
 * Document order rather than request order: for a cut it decides which solid's
 * colour the result takes, and a project's own order is the one the editor
 * would have used. The `booleans` and `groups` handlers each resolved this
 * themselves, by different means, and only one of them said why.
 */
function shapesByIds(document: ProjectDocument, ids: readonly string[]): EngineResult<WorkplaneShape[]> {
  const wanted = new Set(ids);
  const found = document.shapes.filter((shape) => wanted.has(shape.id));
  if (found.length !== wanted.size) {
    const present = new Set(found.map((shape) => shape.id));
    return failed({ reason: "shapes_not_found", ids: ids.filter((id) => !present.has(id)) });
  }
  return ok(found);
}

function oneShape(document: ProjectDocument, shapeId: string): EngineResult<WorkplaneShape> {
  const shape = document.shapes.find((candidate) => candidate.id === shapeId);
  return shape ? ok(shape) : failed({ reason: "shapes_not_found", ids: [shapeId] });
}

/**
 * The ids of the shapes that are locked, or null when none is.
 *
 * The whole operation is refused rather than the locked members skipped: a
 * group missing one member is not the group the caller asked for.
 */
function lockedIds(shapes: readonly WorkplaneShape[]): string[] | null {
  const locked = shapes.filter((shape) => shape.locked).map((shape) => shape.id);
  return locked.length > 0 ? locked : null;
}

/** `ServerCadError` keeps its own wording and status; anything else has none to keep. */
function cadFailure(error: unknown): EngineFailure {
  return error instanceof ServerCadError
    ? { reason: "cad_refused", message: error.message, status: error.status }
    : { reason: "cad_failed" };
}

export function createEngine(store: ProjectStore): Engine {
  /** Read the project under its lock, run `work`, and report a busy project as a failure. */
  async function mutating<T>(
    projectId: string,
    work: (document: ProjectDocument) => Promise<EngineResult<T>>,
  ): Promise<EngineResult<T>> {
    const locked = await store.withLock(projectId, async () => {
      const document = await store.read(projectId);
      return document ? work(document) : failed<T>({ reason: "project_not_found" });
    });
    // `result` is present exactly when the lock was taken; the cast is the type
    // system's price for `withLock` reporting both outcomes in one object.
    return locked.busy ? failed({ reason: "project_busy" }) : locked.result as EngineResult<T>;
  }

  /**
   * Read the project without taking the lock.
   *
   * The read-only operations do not lock, which is how the handlers they
   * replace behaved: a reader that locked would make two concurrent `GET
   * /edges` calls fight, and reading a project mid-write is no worse than
   * reading it a millisecond earlier.
   */
  async function reading<T>(
    projectId: string,
    work: (document: ProjectDocument) => Promise<EngineResult<T>>,
  ): Promise<EngineResult<T>> {
    const document = await store.read(projectId);
    return document ? work(document) : failed({ reason: "project_not_found" });
  }

  /** The shared tail of every write: swap the shapes in and report the revision. */
  async function writeShapes(
    projectId: string,
    document: ProjectDocument,
    shapes: WorkplaneShape[],
  ): Promise<number> {
    const { revision } = await store.write(projectId, document, shapes);
    return revision;
  }

  /**
   * A group or a cut, which are the same operation.
   *
   * Grouping is how the app subtracts, so a selection carrying a shape marked
   * `hole: true` comes back cut rather than merely bundled. The only difference
   * between the two endpoints is where the hole marks come from: `groups` reads
   * them off the stored shapes, `booleans` is told which operands to treat as
   * holes. `holes` being undefined is the former.
   */
  async function combine(
    projectId: string,
    ids: string[],
    holes: Set<string> | undefined,
  ): Promise<EngineResult<ShapeWritten>> {
    return mutating(projectId, async (document) => {
      const resolved = shapesByIds(document, ids);
      if (!resolved.ok) return resolved;
      const locked = lockedIds(resolved.value);
      if (locked) return failed({ reason: "shape_locked", ids: locked });

      const operands = holes
        ? resolved.value.map((shape) => withHoleMode(shape, holes.has(shape.id)))
        : resolved.value;
      const outcome = await buildGroupFromSelection(operands);
      if ("error" in outcome) {
        return failed({ reason: "geometry_failed", message: outcome.error, status: outcome.status });
      }
      // Nothing was removed, so this is not the operation the caller asked for.
      // Refused before the project is written, and refused rather than answered
      // with the solid unchanged, which is the one reply a script cannot tell
      // from success. The editor treats the same case as a failed cut.
      if (outcome.cutRemovedNothing) return failed({ reason: "cut_removed_nothing" });

      const consumed = new Set(ids);
      const shapes = [...document.shapes.filter((shape) => !consumed.has(shape.id)), outcome.group];
      return ok({ shape: outcome.group, revision: await writeShapes(projectId, document, shapes) });
    });
  }

  /** The shared tail of `treat` and `shell`: run the kernel, store the result on the shape. */
  async function cadTreatment(
    projectId: string,
    shapeId: string,
    run: (shape: WorkplaneShape) => Promise<WorkplaneShape>,
  ): Promise<EngineResult<ShapeWritten>> {
    return mutating(projectId, async (document) => {
      const found = oneShape(document, shapeId);
      if (!found.ok) return found;
      if (found.value.locked) return failed({ reason: "shape_locked", ids: [shapeId] });

      let changed: WorkplaneShape;
      try {
        changed = await run(found.value);
      } catch (error) {
        return failed(cadFailure(error));
      }
      const shapes = document.shapes.map((candidate) => (candidate.id === shapeId ? changed : candidate));
      return ok({ shape: changed, revision: await writeShapes(projectId, document, shapes) });
    });
  }

  return {
    cut: (projectId, request) => combine(
      projectId,
      [...request.solidIds, ...request.holeIds],
      new Set(request.holeIds),
    ),

    group: (projectId, ids) => combine(projectId, ids, undefined),

    ungroup: (projectId, shapeId) => mutating(projectId, async (document) => {
      const found = oneShape(document, shapeId);
      if (!found.ok) return found;
      if (found.value.locked) return failed({ reason: "shape_locked", ids: [shapeId] });
      if (!found.value.groupedShapes?.length) return failed({ reason: "not_a_group" });

      // A group can have been moved, turned and resized since it was made, so
      // its children come back carrying all of that.
      const children = restoreGroupedChildren(found.value);
      const shapes = [...document.shapes.filter((shape) => shape.id !== shapeId), ...children];
      return ok({ shapes: children, revision: await writeShapes(projectId, document, shapes) });
    }),

    separate: (projectId, shapeId) => mutating(projectId, async (document) => {
      const found = oneShape(document, shapeId);
      if (!found.ok) return found;
      if (found.value.locked) return failed({ reason: "shape_locked", ids: [shapeId] });
      if (found.value.hole) return failed({ reason: "hole_has_no_parts" });

      const parts = separateShapeParts(found.value);
      // A shape built from parameters is one body by construction, so this is
      // answered without meshing anything.
      if (parts.length <= 1) return failed({ reason: "single_body" });

      const shapes = [...document.shapes.filter((candidate) => candidate.id !== shapeId), ...parts];
      return ok({ shapes: parts, revision: await writeShapes(projectId, document, shapes) });
    }),

    edges: (projectId, shapeId) => reading(projectId, async (document) => {
      const found = oneShape(document, shapeId);
      if (!found.ok) return found;
      try {
        return ok(await shapeEdges(found.value));
      } catch (error) {
        return failed(cadFailure(error));
      }
    }),

    faces: (projectId, shapeId) => reading(projectId, async (document) => {
      const found = oneShape(document, shapeId);
      if (!found.ok) return found;
      try {
        return ok(await shapeFaces(found.value));
      } catch (error) {
        return failed(cadFailure(error));
      }
    }),

    treat: (projectId, shapeId, treatment) => cadTreatment(projectId, shapeId, async (shape) => (
      shapeWithCadResult(shape, await applyEdgeTreatment(shape, treatment))
    )),

    shell: (projectId, shapeId, request) => cadTreatment(projectId, shapeId, async (shape) => (
      shapeWithCadResult(shape, await applyShell(shape, request))
    )),
  };
}
