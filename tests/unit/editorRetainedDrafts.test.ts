import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { applyDraftPrism, meshedCadResult, shapeWithCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { retainedDraftSourcePlacement, retainedSketchFaceDraft, SketchFaceDraftError } from "@constructorfleet/sketchforge-engine/sketchFaceDraftKernel";
import {
  retainedDraftReplayBlocked,
  retainedFaceDraftRebuildBase,
  retainedFaceDraftResolution,
  retainedFaceDraftShape,
  retainedFaceDraftUnavailable,
  retainedPrismDraftAvailable,
  retainedPrismDraftShape,
  withDraftFaceIds,
} from "@/lib/retainedDrafts";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const PROJECT = "retained";

function projectStore(shapes: WorkplaneShape[]) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Editor retained drafts", createdAt: 1,
    shapes, history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === PROJECT ? document : null,
    write: async (_projectId: string, _before: ProjectDocument, next: WorkplaneShape[]) => {
      document.shapes = next;
      writes += 1;
      document.metadata.revision = writes;
      return { revision: writes };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return createEngine(store);
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

// An irregular quadrilateral: no two sides share a normal, and its bounds are
// not centred on the sketch origin, so a placement that ignored either would
// show up in the centre of mass.
const quad: SketchProfile = {
  points: [
    { id: "a", x: 1, z: -1 }, { id: "b", x: 5, z: -2 },
    { id: "c", x: 6, z: 3 }, { id: "d", x: 2, z: 2 },
  ],
  segments: [
    { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
    { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
  ],
};

/** The same outline with one corner moved, which moves the centre of its bounds. */
function moved(corner: { x: number; z: number }): SketchProfile {
  return { ...quad, points: quad.points.map((point) => point.id === "c" ? { ...point, ...corner } : { ...point }) };
}

/** An undrafted sketch extrusion, moved and turned on the workplane as the editor places one. */
async function placedExtrusion(profile = quad) {
  const shape = await sketchExtrusionShapeFromRequest({
    id: "retained-extrusion", sketchSourceId: "sketch/retained-extrusion", name: "Retained extrusion",
    profile, height: 4,
  });
  return { ...shape, x: shape.x + 7, z: shape.z - 3, elevation: 2, rotation: 35, rotationX: 20, rotationZ: -15 } satisfies WorkplaneShape;
}

/** The editor's sketch worker rebuilds an extrusion in sketch coordinates; the server builder does the same here. */
function rebuiltExtrusion(profile: SketchProfile) {
  return sketchExtrusionShapeFromRequest({ id: "retained-extrusion", sketchSourceId: "sketch/retained-extrusion", name: "Retained extrusion", profile, height: 4 });
}

/** The editor turns a worker mesh into a shape, unrotated; the server's equivalent does the same here. */
function meshedShape(source: WorkplaneShape, meshed: ReturnType<typeof meshedCadResult>) {
  return { ...shapeWithCadResult(source, meshed), rotation: 0, rotationX: 0, rotationZ: 0 };
}

/** What the editor stores for a face draft, with its worker run on the server's kernel instead. */
async function editorFaceDraft(
  existing: WorkplaneShape,
  base: WorkplaneShape,
  draft: { sourceFaceId?: string; angle: number; pullDirection: "y" | "z" },
  profileChanged: boolean,
) {
  const outcome = await withCadKernel((cad) => {
    const drafted = retainedSketchFaceDraft(cad, retainedFaceDraftResolution(existing, base, draft, profileChanged));
    return { ...drafted, meshed: meshedCadResult(cad, drafted.solid) };
  });
  return retainedFaceDraftShape(base, meshedShape(base, outcome.meshed), outcome, draft, existing);
}

/** The editor's replay of a drafted shape after `profile` replaced its sketch. */
async function editorReplay(existing: WorkplaneShape, profile: SketchProfile) {
  const base = retainedFaceDraftRebuildBase(existing, await rebuiltExtrusion(profile), "profile-changed");
  return editorFaceDraft(existing, base, { angle: existing.faceDraft!.angle, pullDirection: existing.faceDraft!.pullDirection as "y" }, true);
}

/** Two shapes are the same placed solid: equal volume and centre of mass in the world, as drawn. */
async function expectSamePlacedSolid(actual: WorkplaneShape, expected: WorkplaneShape) {
  const [drawn, reference] = await Promise.all([shapeProperties(actual), shapeProperties(expected)]);
  expect(drawn.volume).toBeCloseTo(reference.volume, 3);
  expect(drawn.centerOfMass.x).toBeCloseTo(reference.centerOfMass.x, 4);
  expect(drawn.centerOfMass.y).toBeCloseTo(reference.centerOfMass.y, 4);
  expect(drawn.centerOfMass.z).toBeCloseTo(reference.centerOfMass.z, 4);
}

async function sideFace(source: WorkplaneShape) {
  return (await shapeFaces(source)).find((face) => face.surfaceType === "plane" && face.normal && Math.abs(face.normal.y) < 0.5)!;
}

// Outward drafts grow the bounds and move their centre, which is where two
// placement conventions part; at -6° they were 0.2 mm apart.
const OUTWARD = { angle: -6, pullDirection: "y" as const };

describe("retained drafts made in the editor", () => {
  it("record a side-face draft from the face listing, and place it where the REST draft is", async () => {
    const source = await placedExtrusion();
    const side = await sideFace(source);

    const editorShape = await editorFaceDraft(source, source, { ...OUTWARD, sourceFaceId: side.id }, false);
    expect(editorShape.faceDraft).toEqual({ sourceFaceId: side.id, ...OUTWARD, sourceFaceNormal: side.normal });
    expect(editorShape.faceDraftSourceFaceIds).toEqual(source.faceIds);
    expect(editorShape.faceDraftSourceFrame).toEqual(source.cadBrepFrame);
    expect(quad.segments.map((segment) => segment.id)).toContain(editorShape.faceDraftSourceSegmentId);
    expect(editorShape.rotation).toBe(35);
    expect({ x: editorShape.x, z: editorShape.z, elevation: editorShape.elevation }).toEqual(
      retainedDraftSourcePlacement(source, editorShape.cadBrepFrame!),
    );

    const viaRest = value(await projectStore([source]).changeShape(PROJECT, source.id, {
      faceDraft: { sourceFaceId: side.id, ...OUTWARD },
    })).shape;
    expect(editorShape.faceDraftSourceSegmentId).toBe(viaRest.faceDraftSourceSegmentId);
    await expectSamePlacedSolid(editorShape, viaRest);
  }, CAD_TEST_TIMEOUT_MS);

  it("rotates a sketch-frame placement shift before applying it to a turned shape", () => {
    const placement = retainedDraftSourcePlacement({
      x: 10, z: -4, elevation: 3,
      rotation: 35, rotationX: 20, rotationZ: -15,
      faceDraftSourceFrame: { x: 1, z: 2, elevation: 0, width: 1, depth: 1, height: 1 },
    }, { x: 4, z: 5, elevation: 2 });
    // XYZ rotation used by transformMesh, applied to the sketch-local delta (3, 2, 3).
    expect(placement.x).toBeCloseTo(14.5185, 3);
    expect(placement.z).toBeCloseTo(-3.1364, 3);
    expect(placement.elevation).toBeCloseTo(3.9152, 3);
  });

  it("record a cap draft with no sketch segment, placed where the REST draft is", async () => {
    const source = await placedExtrusion();
    const top = (await shapeFaces(source)).find((face) => face.normal && face.normal.y > 0.99)!;
    const draft = { angle: 4, pullDirection: "z" as const };
    const editorShape = await editorFaceDraft(source, source, { ...draft, sourceFaceId: top.id }, false);
    expect(editorShape.faceDraft).toEqual({ sourceFaceId: top.id, ...draft, sourceFaceNormal: top.normal });
    expect(editorShape.faceDraftSourceSegmentId).toBeUndefined();

    const viaRest = value(await projectStore([source]).changeShape(PROJECT, source.id, {
      faceDraft: { sourceFaceId: top.id, ...draft },
    })).shape;
    await expectSamePlacedSolid(editorShape, viaRest);
  }, CAD_TEST_TIMEOUT_MS);

  it("replay an editor draft and a REST draft through a profile edit to the REST replay, in the same place", async () => {
    const source = await placedExtrusion();
    // The side extruded from segment bc, whose normal the corner move changes:
    // only the recorded segment can find it again.
    const sides = (await shapeFaces(source)).filter((face) => face.surfaceType === "plane" && face.normal && Math.abs(face.normal.y) < 0.5);
    let editorDrafted: WorkplaneShape | undefined;
    for (const face of sides) {
      const drafted = await editorFaceDraft(source, source, { ...OUTWARD, sourceFaceId: face.id }, false);
      if (drafted.faceDraftSourceSegmentId === "bc") editorDrafted = drafted;
    }
    expect(editorDrafted).toBeDefined();
    const side = { id: editorDrafted!.faceDraft!.sourceFaceId };
    const edited = moved({ x: 8, z: 4 });
    const restDrafted = value(await projectStore([source]).changeShape(PROJECT, source.id, {
      faceDraft: { sourceFaceId: side.id, ...OUTWARD },
    })).shape;

    for (const drafted of [editorDrafted!, restDrafted]) {
      const viaRest = value(await projectStore([drafted]).changeShape(PROJECT, source.id, { sketchProfile: edited })).shape;
      const viaEditor = await editorReplay(drafted, edited);
      expect(viaEditor.faceDraftSourceSegmentId).toBe("bc");
      expect(viaEditor.faceDraft!.sourceFaceNormal).not.toEqual(drafted.faceDraft!.sourceFaceNormal);
      expect(viaEditor.faceDraft!.sourceFaceNormal).toEqual(viaRest.faceDraft!.sourceFaceNormal);
      expect(viaEditor.faceDraftSourceFrame).toEqual(source.cadBrepFrame);
      expect(viaEditor.faceDraftSourceFaceIds).toContain(viaEditor.faceDraft!.sourceFaceId);
      await expectSamePlacedSolid(viaEditor, viaRest);
    }
  }, CAD_TEST_TIMEOUT_MS);

  it("change a kept draft's angle and direction to what PATCH faceDraft gives, in the same place", async () => {
    const source = await placedExtrusion();
    const side = await sideFace(source);
    const drafted = await editorFaceDraft(source, source, { ...OUTWARD, sourceFaceId: side.id }, false);
    const changed = { angle: -9, pullDirection: "y" as const };

    const base = retainedFaceDraftRebuildBase(drafted, await rebuiltExtrusion(quad), "unchanged");
    expect(base.faceIds).toEqual(drafted.faceDraftSourceFaceIds);
    const viaEditor = await editorFaceDraft(drafted, base, changed, false);
    const viaRest = value(await projectStore([drafted]).changeShape(PROJECT, source.id, {
      faceDraft: { sourceFaceId: drafted.faceDraft!.sourceFaceId, ...changed },
    })).shape;
    expect(viaEditor.faceDraft).toMatchObject({ sourceFaceId: side.id, ...changed });
    await expectSamePlacedSolid(viaEditor, viaRest);
  }, CAD_TEST_TIMEOUT_MS);

  it("record a prism draft and place it where POST draft-prism does", async () => {
    const source = await placedExtrusion();
    const meshed = await applyDraftPrism(source, { angle: -7 });
    const editorShape = retainedPrismDraftShape(source, meshedShape(source, meshed), -7);
    expect(editorShape.draftPrismAngle).toBe(-7);
    expect(editorShape.draftPrismSourceHeight).toBe(source.height);
    expect(editorShape.draftPrismSourceFrame).toEqual(source.cadBrepFrame);

    const viaRest = value(await projectStore([source]).draftPrism(PROJECT, source.id, -7)).shape;
    await expectSamePlacedSolid(editorShape, viaRest);
  }, CAD_TEST_TIMEOUT_MS);

  it("replay a prism draft on a profile whose bounds moved, to the REST replay", async () => {
    const source = await placedExtrusion();
    const drafted = retainedPrismDraftShape(source, meshedShape(source, await applyDraftPrism(source, { angle: -7 })), -7);
    const edited = moved({ x: 10, z: 6 });
    const replayedMesh = await applyDraftPrism({ ...drafted, sketchProfile: edited }, { angle: -7 });
    const viaEditor = retainedPrismDraftShape(drafted, meshedShape(drafted, replayedMesh), -7, edited);
    expect(viaEditor.sketchProfile).toEqual(edited);

    const viaRest = value(await projectStore([drafted]).changeShape(PROJECT, source.id, { sketchProfile: edited })).shape;
    expect(viaRest.draftPrismAngle).toBe(-7);
    await expectSamePlacedSolid(viaEditor, viaRest);
  }, CAD_TEST_TIMEOUT_MS);

  it("say why the kernel refused rather than calling every failure an unnameable face", async () => {
    const source = await placedExtrusion();
    const side = await sideFace(source);
    const reason = (draft: { angle: number; pullDirection: "y" | "z" }) => withCadKernel((cad) => {
      try {
        retainedSketchFaceDraft(cad, retainedFaceDraftResolution(source, source, { ...draft, sourceFaceId: side.id }, false));
        return "drafted";
      } catch (error) {
        return error instanceof SketchFaceDraftError ? error.reason : "other";
      }
    });
    expect(await reason({ angle: 50, pullDirection: "y" })).toBe("angle");
    const unnamed = await withCadKernel((cad) => {
      try {
        retainedSketchFaceDraft(cad, retainedFaceDraftResolution(source, source, { ...OUTWARD, sourceFaceId: "no-such-face" }, false));
        return "drafted";
      } catch (error) {
        return error instanceof SketchFaceDraftError ? error.reason : "other";
      }
    });
    expect(unnamed).toBe("unresolved");
  }, CAD_TEST_TIMEOUT_MS);

  it("name an editor extrusion's faces as the REST face listing does, so a numbered face is one the record can keep", async () => {
    const source = await placedExtrusion();
    // As the editor's sketch worker hands it over: a mesh with face groups, and no face IDs.
    const meshed = await withCadKernel((cad) => meshedCadResult(cad, cad.fromBREP(source.cadBrep!)));
    const editorBuilt = { ...shapeWithCadResult(source, meshed), id: "sketch extrusion/1", faceIds: undefined };
    expect(editorBuilt.importedMesh?.faceGroups?.length).toBeGreaterThan(0);
    const listed = (await shapeFaces(editorBuilt)).map((face) => face.id);
    expect(withDraftFaceIds(editorBuilt).faceIds).toEqual(listed);
    expect(withDraftFaceIds(source).faceIds).toBe(source.faceIds);
  }, CAD_TEST_TIMEOUT_MS);

  it("keep a draft only where it can be replayed, and refuse to replay one the shape has outgrown", async () => {
    const source = await placedExtrusion();
    expect(retainedFaceDraftUnavailable(source)).toBeNull();
    expect(retainedPrismDraftAvailable(source)).toBe(true);
    expect(retainedFaceDraftUnavailable({ ...source, sketchOperation: "revolve" })).toBe("not-sketch-extrusion");
    expect(retainedFaceDraftUnavailable({ ...source, mirrorX: true })).toBe("mirrored");
    expect(retainedFaceDraftUnavailable({ ...source, width: source.width * 2 })).toBe("resized");
    expect(retainedFaceDraftUnavailable({ ...source, edgeTreatments: [{ kind: "fillet", amount: 1, edgeCount: 1, allEdges: true }] })).toBe("treated");
    expect(retainedFaceDraftUnavailable({ ...source, cadBrep: undefined })).toBe("no-exact-source");
    expect(retainedPrismDraftAvailable({ ...source, mirrorZ: true })).toBe(false);

    // A second draft is refused, not baked over the first.
    const side = await sideFace(source);
    const faceDrafted = await editorFaceDraft(source, source, { ...OUTWARD, sourceFaceId: side.id }, false);
    const prismDrafted = retainedPrismDraftShape(source, meshedShape(source, await applyDraftPrism(source, { angle: -7 })), -7);
    expect(retainedFaceDraftUnavailable(faceDrafted)).toBe("draft-retained");
    expect(retainedFaceDraftUnavailable(prismDrafted)).toBe("draft-retained");
    expect(retainedPrismDraftAvailable(faceDrafted)).toBe(false);
    expect(retainedPrismDraftAvailable(prismDrafted)).toBe(true);

    // Done to the part after the draft, and not in its record: replaying would undo it.
    for (const drafted of [faceDrafted, prismDrafted]) {
      expect(retainedDraftReplayBlocked(drafted)).toBeNull();
      expect(retainedDraftReplayBlocked({ ...drafted, mirrorX: true })).toBe("mirrored");
      expect(retainedDraftReplayBlocked({ ...drafted, edgeTreatments: [{ kind: "chamfer", amount: 1, edgeCount: 1, allEdges: true }] })).toBe("treated");
      expect(retainedDraftReplayBlocked({ ...drafted, height: drafted.height * 1.5 })).toBe("resized");
    }
    expect(retainedPrismDraftAvailable({ ...prismDrafted, height: prismDrafted.height * 1.5 })).toBe(false);
  }, CAD_TEST_TIMEOUT_MS);
});
