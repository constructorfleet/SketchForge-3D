import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { exactPartSolid } from "@/lib/engine/exactBooleanSolids";
import { exactBooleanPlacement } from "@/lib/engine/exactBooleanParts";
import { buildEditorShell } from "@/lib/engine/editorShell";
import { LocalizedError } from "@/i18n/LocalizedError";
import { parseShellFaceNumbers, shellRequestForShape, shellUnavailable, shelledShapeFields, type ShellOpenFace } from "@/lib/shellEditor";
import type { WorkplaneShape } from "@/types/sketchforge";

/** A 20 mm cube standing on the workplane, because every number here is a closed form of one. */
function cube(overrides: Record<string, unknown> = {}) {
  return shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20, ...overrides }) as WorkplaneShape;
}

/**
 * Hollow `shape` the way the editor's CAD worker does: build the request the
 * inspector sends, rebuild the solid from its part, and shell it.
 */
async function hollowInEditor(shape: WorkplaneShape, thickness: number, openFaces: ShellOpenFace[] = []) {
  const cad = await serverCadKernel();
  const request = shellRequestForShape(shape, thickness, openFaces);
  if (!request) throw new Error("the inspector would not send this request");
  expect(request.part.exact).toBeDefined();
  const solid = exactPartSolid(cad, request.part.exact!);
  const result = buildEditorShell(cad, solid, { thickness: request.thickness, openFaces: request.openFaces });
  const stored = cad.fromBREP(result.brep);
  return { result, volume: cad.getVolume(stored), centre: cad.getCenterOfMass(stored) };
}

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalizedError);
    return (error as LocalizedError).key;
  }
  throw new Error("expected the shell to be refused");
}

// The kernel, not the test, needs the time: see support/cadTestTimeout.ts.
describe("hollowing a shape in the editor", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("hollows a sealed cube to the volume the arithmetic says, still balanced on its centre", async () => {
    const { result, volume, centre } = await hollowInEditor(cube(), 2);
    // 20^3 - 16^3: the wall is measured inwards, so the outside stays 20 mm.
    expect(volume).toBeCloseTo(3904, 4);
    expect(result.volume).toBeCloseTo(3904, 4);
    expect(result.sourceVolume).toBeCloseTo(8000, 4);
    expect(centre.x).toBeCloseTo(0, 4);
    expect(centre.y).toBeCloseTo(10, 4);
    expect(centre.z).toBeCloseTo(0, 4);
  });

  it("leaves the lid off a tray, which moves its weight down onto the floor", async () => {
    const { volume, centre, result } = await hollowInEditor(cube(), 2, ["top"]);
    // 20^3 - 16 x 16 x 18: the cavity runs out through the open top.
    expect(volume).toBeCloseTo(3392, 4);
    // A tray is heavier at the floor than at the open rim; a sealed box would sit at 10.
    expect(centre.y).toBeLessThan(10);
    expect(centre.y).toBeCloseTo(8.6415, 3);
    // A tray has the five outer faces, five inner ones and the rim.
    expect(result.faceCount).toBe(11);
  });

  it("measures the directions where the shape stands, not at the origin", async () => {
    const { centre, volume } = await hollowInEditor(cube({ x: 40, z: -30, elevation: 5 }), 2, ["top"]);
    expect(volume).toBeCloseTo(3392, 4);
    expect(centre.x).toBeCloseTo(40, 4);
    expect(centre.z).toBeCloseTo(-30, 4);
    expect(centre.y).toBeCloseTo(5 + 8.6415, 3);
  });

  it("opens a face named by index the same as by direction", async () => {
    const cad = await serverCadKernel();
    const solid = exactPartSolid(cad, { shape: cube(), transform: exactBooleanPlacement(cube()) });
    const faces = cad.getSubShapes(solid, "face");
    const topIndex = faces.findIndex((face) => Math.abs(cad.getSurfaceCenterOfMass(face).y - 20) < 1e-6);
    expect(topIndex).toBeGreaterThanOrEqual(0);
    const byIndex = await hollowInEditor(cube(), 2, [topIndex]);
    expect(byIndex.volume).toBeCloseTo(3392, 4);
    expect(byIndex.centre.y).toBeCloseTo(8.6415, 3);
  });

  it("says a wall is too thick in the person's language rather than storing nothing", async () => {
    expect(await refusalOf(() => hollowInEditor(cube(), 11))).toBe("errors.cadModifier.shell.tooThick");
    expect(await refusalOf(() => hollowInEditor(cube(), 11, ["top"]))).toBe("errors.cadModifier.shell.tooThick");
  });

  it("refuses to open every face", async () => {
    expect(await refusalOf(() => hollowInEditor(cube(), 2, ["top", "bottom", "left", "right", "front", "back"])))
      .toBe("errors.cadModifier.shell.everyFaceOpen");
  });

  it("refuses a direction a sphere has no flat face for, and a face that is not there", async () => {
    const ball = shapeFromRequest({ kind: "sphere", width: 40, depth: 40, height: 40 }) as WorkplaneShape;
    expect(await refusalOf(() => hollowInEditor(ball, 2, ["top"]))).toBe("errors.cadModifier.shell.noFlatFace");
    expect(await refusalOf(() => hollowInEditor(cube(), 2, [6]))).toBe("errors.cadModifier.shell.faceIndexInvalid");
  });

  it("says a spline skin cannot be offset", async () => {
    const egg = shapeFromRequest({ kind: "sphere", width: 40, depth: 40, height: 20 }) as WorkplaneShape;
    expect(await refusalOf(() => hollowInEditor(egg, 2))).toBe("errors.cadModifier.shell.cannotOffset");
  });
});

describe("the shell request the inspector sends", () => {
  it("builds a primitive from its own parameters, placed where it stands", () => {
    const shape = cube({ x: 12, z: 3, elevation: 4 });
    const request = shellRequestForShape(shape, 2, ["top"]);
    expect(request?.part.exact?.shape).toBe(shape);
    expect(request?.part.exact?.transform).toEqual(exactBooleanPlacement(shape));
    expect(request?.part.brep).toBeUndefined();
    expect(request).toMatchObject({ thickness: 2, openFaces: ["top"] });
  });

  it("works from a shape's exact B-rep when it has one, so face numbers mean its faces", () => {
    const shape: WorkplaneShape = {
      ...cube(),
      kind: "mesh",
      cadBrep: "BREP",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 20, depth: 20, height: 20 },
    };
    const request = shellRequestForShape(shape, 1.5, [2]);
    expect(request?.part.brep).toBe("BREP");
    expect(request?.part.exact).toBeUndefined();
    expect(request?.openFaces).toEqual([2]);
  });

  it("refuses what the REST path refuses, and what cannot be built exactly", () => {
    expect(shellUnavailable(cube())).toBeNull();
    expect(shellUnavailable({ ...cube(), edgeTreatments: [{ kind: "fillet", amount: 1, edgeCount: 12 }] }))
      .toBe("errors.cadModifier.shell.treated");
    expect(shellUnavailable({ ...cube(), faceDraft: { angle: 5, pullDirection: "y" } as never })).toBe("errors.cadModifier.shell.treated");
    expect(shellUnavailable({ ...cube(), draftPrismAngle: 5 })).toBe("errors.cadModifier.shell.treated");
    expect(shellUnavailable({ ...cube(), hole: true })).toBe("errors.cadModifier.shell.unsupported");
    expect(shellUnavailable({ ...cube(), mirrorX: true })).toBe("errors.cadModifier.shell.unsupported");
    expect(shellUnavailable({ ...cube(), groupedShapes: [cube(), cube({ x: 30 })] })).toBe("errors.cadModifier.shell.unsupported");
    expect(shellRequestForShape({ ...cube(), draftPrismAngle: 5 }, 2, [])).toBeNull();
  });

  it("refuses a wall of zero or less before the kernel is asked", () => {
    expect(shellRequestForShape(cube(), 0, [])).toBeNull();
    expect(shellRequestForShape(cube(), -1, [])).toBeNull();
    expect(shellRequestForShape(cube(), Number.NaN, [])).toBeNull();
  });

  it("reads face numbers as people count them, from 1", () => {
    expect(parseShellFaceNumbers("", 6)).toEqual([]);
    expect(parseShellFaceNumbers("1, 3 3", 6)).toEqual([0, 2]);
    expect(parseShellFaceNumbers("0", 6)).toBeNull();
    expect(parseShellFaceNumbers("7", 6)).toBeNull();
    expect(parseShellFaceNumbers("1.5", 6)).toBeNull();
    expect(parseShellFaceNumbers("top", 6)).toBeNull();
  });
});

describe("a shelled shape", () => {
  it("records the shell and new face identities, and drops what described the old faces", () => {
    const fields = shelledShapeFields("box-1", 11, { thickness: 2, openFaces: ["top", 3] });
    expect(fields.shell).toEqual({ thickness: 2, openFaces: ["top", 3] });
    expect(fields.faceIds).toHaveLength(11);
    expect(new Set(fields.faceIds).size).toBe(11);
    expect(fields.faceColors).toBeUndefined();
    expect(fields.edgeTreatments).toBeUndefined();
    expect(shelledShapeFields("box-1", 6, { thickness: 2, openFaces: [] }).shell).toEqual({ thickness: 2 });
  });

  it("keeps its shell through a .skf save and load", { timeout: CAD_TEST_TIMEOUT_MS }, async () => {
    const shelled: WorkplaneShape = {
      ...cube(),
      id: "tray",
      name: "tray",
      kind: "mesh",
      cadBrep: "DBRep_DrawableShape\n",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 20, depth: 20, height: 20 },
      importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], baseWidth: 20, baseDepth: 20, baseHeight: 20, triangleCount: 1, sourceFormat: "json" },
      ...shelledShapeFields("tray", 11, { thickness: 2, openFaces: ["top"] }),
    };
    const bytes = await exportSkfProject({
      projectName: "Tray", createdAt: 1, modifiedAt: 1, shapes: [shelled],
      history: [editorHistoryEntry([shelled], [])], historyIndex: 0, assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    const restored = (await importSkfProject(bytes)).shapes[0];
    expect(restored?.shell).toEqual({ thickness: 2, openFaces: ["top"] });
    expect(restored?.cadBrep).toBe(shelled.cadBrep);
    expect(restored?.faceIds).toEqual(shelled.faceIds);
  });
});
