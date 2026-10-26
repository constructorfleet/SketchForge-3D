/**
 * The correction for cuts saved before #548.
 *
 * Both cut writers -- the editor's exact cut and the server's -- store a cut's
 * B-rep recentred into the result's own frame, at the origin, and before #548
 * recorded the result's *world* placement in `cadBrepFrame`. Every reader
 * takes the frame to mean where the B-rep is, so such a cut was read at the
 * origin. Cuts are now written with an origin frame, and this rewrites the old
 * ones as they come in: every `.skf` load, and every paste.
 *
 * It runs on every load rather than on old files only, so the format did not
 * change and releases from before the fix still read new files (an origin
 * frame places a cut correctly there too). That is safe because a frame
 * already at the origin is left alone: a cut saved since the fix passes
 * through untouched.
 *
 * Data cannot say which shapes are old cuts, so this recognises one by what
 * both writers left: members with a hole among them, a mesh and a B-rep, a
 * frame away from the origin, and no trace of anything having rewritten that
 * B-rep since. Other writers store members, a mesh and a world-space B-rep
 * too -- the parent of a group whose member the Fillet/Chamfer tool treated, a
 * shelled cut, a baked face draft of a cut -- and each leaves a mark that
 * rules it out: an edge treatment record somewhere in it, `edgeResizeMode`,
 * `shell`, a retained draft, the face IDs a draft or shell assigns, or the
 * B-rep face ranges the CAD worker reports. When in doubt it leaves the shape
 * alone, where it reads exactly as it did before #548.
 *
 * INVARIANT for every writer, now and later: a shape that holds members with
 * a hole among them, a mesh and a B-rep, and whose `cadBrepFrame` is away from
 * the origin, must carry one of those marks (`isPre548CutResult` lists them)
 * or a `sourceTransform`. A writer that stores a world-placed B-rep on such a
 * shape without one would have it moved to the origin on the next load or
 * paste. `tests/unit/cutResultBrepFrame.test.ts` checks the writers known
 * today.
 */

import type { WorkplaneShape } from "./domain/sketchforge.js";

function carriesEdgeTreatment(shape: WorkplaneShape): boolean {
  return Boolean(shape.edgeTreatments?.length || shape.edgeTreatmentHistory?.length)
    || Boolean(shape.groupedShapes?.some(carriesEdgeTreatment));
}

function holdsHole(shape: WorkplaneShape): boolean {
  return Boolean(shape.groupedShapes?.some((member) => member.hole || holdsHole(member)));
}

/** Whether this old shape is a cut as a pre-#548 cut writer left it, with its frame at the result's placement. */
export function isPre548CutResult(shape: WorkplaneShape): boolean {
  const frame = shape.cadBrepFrame;
  const mesh = shape.importedMesh;
  if (!frame || frame.sourceTransform || !shape.cadBrep) return false;
  if (frame.x === 0 && frame.z === 0 && frame.elevation === 0) return false;
  if (!shape.groupedShapes?.length || !mesh || (mesh.positions?.length ?? 0) < 9) return false;
  if (!holdsHole(shape) || carriesEdgeTreatment(shape)) return false;
  if (shape.edgeResizeMode !== undefined || shape.shell || shape.faceDraft || shape.draftPrismAngle !== undefined) return false;
  if (shape.faceIds?.length || mesh.faceGroups?.length) return false;
  return true;
}

/**
 * Old shapes with every pre-#548 cut among them -- at any depth, and in the
 * snapshots edge-treatment history keeps -- given the origin frame its B-rep
 * is really in. A shape with nothing to correct is returned as it was, so
 * shapes shared between history states stay shared.
 */
export function migratePre548CutBrepFrames(shapes: WorkplaneShape[], memo = new Map<WorkplaneShape, WorkplaneShape>()): WorkplaneShape[] {
  let changed = false;
  const migrated = shapes.map((shape) => {
    const next = migrateShape(shape, memo);
    if (next !== shape) changed = true;
    return next;
  });
  return changed ? migrated : shapes;
}

function migrateShape(shape: WorkplaneShape, memo: Map<WorkplaneShape, WorkplaneShape>): WorkplaneShape {
  const known = memo.get(shape);
  if (known) return known;
  let next = shape;
  if (shape.groupedShapes?.length) {
    const members = migratePre548CutBrepFrames(shape.groupedShapes, memo);
    if (members !== shape.groupedShapes) next = { ...next, groupedShapes: members };
  }
  if (shape.edgeTreatmentHistory?.length) {
    let historyChanged = false;
    const history = shape.edgeTreatmentHistory.map((entry) => {
      const before = migrateShape(entry.before, memo);
      if (before === entry.before) return entry;
      historyChanged = true;
      return { ...entry, before };
    });
    if (historyChanged) next = { ...next, edgeTreatmentHistory: history };
  }
  if (isPre548CutResult(shape)) {
    next = { ...next, cadBrepFrame: { ...shape.cadBrepFrame!, x: 0, z: 0, elevation: 0 } };
  }
  memo.set(shape, next);
  return next;
}
