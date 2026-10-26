/**
 * Where a cut result's stored B-rep is put back in the world (#548).
 *
 * Both cut writers -- the editor's exact cut and the server's -- store the
 * result's B-rep in the result's own frame: centred in X and Z, base on y = 0.
 * They used to record the result's *world* placement in `cadBrepFrame`, which
 * every reader takes to mean "the B-rep is here", so `cadBrepTransformForShape`
 * cancelled the placement out and left the solid at the origin. Interference,
 * a cut of the cut and a shell then worked on a copy that was not where the
 * part is drawn.
 *
 * Every check is by volume and centre of mass. A misplaced copy has the right
 * volume and the wrong centre; a bounding box alone cannot tell a moved solid
 * from a mirrored one.
 */

import { describe, expect, it } from "vitest";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { interferenceBetweenSolids } from "@constructorfleet/sketchforge-engine/cadAnalysis";
import { cadBrepTransformForShape } from "@constructorfleet/sketchforge-engine/cadBakeMetadata";
import { exactCutPartsForSelection, withExactBooleanBrep } from "@constructorfleet/sketchforge-engine/exactBooleanParts";
import { exactCutFromParts } from "@constructorfleet/sketchforge-engine/exactBooleanSolids";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { buildGroupFromSelection } from "@constructorfleet/sketchforge-engine/serverShapeBooleans";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { groupedShapeFromSelection, meshShapeFromWorldPositions, restoreGroupedChildren, shapeAsGroupChild, worldMeshForShape } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { isPre548CutResult, migratePre548CutBrepFrames } from "@constructorfleet/sketchforge-engine/cutBrepFrameMigration";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { cadModifierBoolean } from "@/lib/cadModifierBoolean";
import { reconstructSolid } from "@/lib/cadModifierParts";
import { draftFaceRequestForShape, draftFaceResultMetadata } from "@/lib/draftFaceEditor";
import { buildFaceDraft } from "@/lib/engine/draftFace";
import { CLEARED_RETAINED_DRAFT_FIELDS } from "@/lib/retainedDrafts";
import { sceneAnalysisOperand } from "@/lib/sceneAnalysis";
import { shellRequestForShape } from "@/lib/shellEditor";
import type { WorkplaneShape } from "@/types/sketchforge";

// The cut is placed well away from the origin on every axis: a cut left
// where it was made at the origin subtracts zero and hides the bug.
const AT = { x: 30, y: 3, z: -12 };
const PLATE = { width: 40, depth: 40, height: 10 };
const PLATE_VOLUME = PLATE.width * PLATE.depth * PLATE.height;
// A blind round pocket, off-centre in X and Z so a mirror would show too.
const POCKET = { radius: 6, depth: 4, dx: 8, dz: -5 };
const POCKET_VOLUME = Math.PI * POCKET.radius ** 2 * POCKET.depth;
const CUT_VOLUME = PLATE_VOLUME - POCKET_VOLUME;

function shape(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return sceneShape({ name: overrides.kind, color: "#d41721", ...overrides });
}

const plate = () => shape({
  id: "plate",
  kind: "box",
  ...PLATE,
  size: PLATE.width,
  x: AT.x,
  z: AT.z,
  elevation: AT.y,
});

const pocket = () => shape({
  id: "pocket",
  kind: "cylinder",
  hole: true,
  width: POCKET.radius * 2,
  depth: POCKET.radius * 2,
  size: POCKET.radius * 2,
  height: POCKET.depth,
  x: AT.x + POCKET.dx,
  z: AT.z + POCKET.dz,
  elevation: AT.y + PLATE.height - POCKET.depth,
});

type Centre = { x: number; y: number; z: number };

/** Where the plate-with-pocket's centre of mass is, by the arithmetic. */
function cutCentre(offset: Centre = { x: 0, y: 0, z: 0 }): Centre {
  const plateCentre = { x: AT.x, y: AT.y + PLATE.height / 2, z: AT.z };
  const pocketCentre = { x: AT.x + POCKET.dx, y: AT.y + PLATE.height - POCKET.depth / 2, z: AT.z + POCKET.dz };
  const weighted = (axis: keyof Centre) => (plateCentre[axis] * PLATE_VOLUME - pocketCentre[axis] * POCKET_VOLUME) / CUT_VOLUME + offset[axis];
  return { x: weighted("x"), y: weighted("y"), z: weighted("z") };
}

/**
 * The worker places a stored B-rep with `generalTransform`, which turns the
 * pocket's cylinder into a B-spline even for a rigid move, and OCCT integrates
 * that a few cubic millimetres short. So the volume is held to a part in two
 * thousand rather than to the arithmetic. Neither tolerance comes near what a
 * misplaced copy misses by: a whole overlap or slot, and 30 mm of centre.
 */
function expectSolidAt(cad: OcctKernel, solid: ShapeHandle, volume: number, centre: Centre) {
  expect(Math.abs(cad.getVolume(solid) - volume)).toBeLessThan(volume * 5e-4);
  const measured = cad.getCenterOfMass(solid);
  expect(measured.x).toBeCloseTo(centre.x, 2);
  expect(measured.y).toBeCloseTo(centre.y, 2);
  expect(measured.z).toBeCloseTo(centre.z, 2);
}

/** The cut the editor makes: exact in its worker, then grouped and given its B-rep. */
async function editorCut(): Promise<WorkplaneShape> {
  const cad = await serverCadKernel();
  const selection = [plate(), pocket()];
  const request = exactCutPartsForSelection(selection);
  if (!request) throw new Error("expected an exact cut request");
  const meshed = cadModifierBoolean(cad, request.parts, (part) => reconstructSolid(cad, part));
  const group = meshShapeFromWorldPositions(Array.from(meshed.positions), {
    id: "editor-cut",
    name: "Group",
    color: "#d41721",
    groupOperation: "group",
    groupedShapes: selection,
  });
  if (!group) throw new Error("expected a group");
  return withExactBooleanBrep(group, { normals: meshed.normals, brep: meshed.brep });
}

/** The cut the server makes for the REST and MCP group/cut paths. */
async function serverCut(): Promise<WorkplaneShape> {
  const outcome = await buildGroupFromSelection([plate(), pocket()]);
  if (!("group" in outcome) || !outcome.group) throw new Error(`expected a group: ${JSON.stringify(outcome)}`);
  return outcome.group;
}

/**
 * A cut stored before #548: the B-rep in its own frame, the frame recording
 * the result's world placement instead.
 */
function asStoredBefore548(cut: WorkplaneShape): WorkplaneShape {
  return { ...cut, cadBrepFrame: { ...cut.cadBrepFrame!, x: cut.x, z: cut.z, elevation: cut.elevation ?? 0 } };
}

/** Volume and centre of mass of the triangles the viewport draws for a shape, by signed tetrahedra. */
function meshMassProperties(drawn: WorkplaneShape) {
  const mesh = worldMeshForShape(drawn);
  if (!mesh) throw new Error("expected a display mesh");
  let sixVolume = 0;
  const moment = { x: 0, y: 0, z: 0 };
  for (const [ai, bi, ci] of mesh.faces) {
    const [a, b, c] = [mesh.vertices[ai]!, mesh.vertices[bi]!, mesh.vertices[ci]!];
    const signed = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    sixVolume += signed;
    moment.x += signed * (a[0] + b[0] + c[0]) / 4;
    moment.y += signed * (a[1] + b[1] + c[1]) / 4;
    moment.z += signed * (a[2] + b[2] + c[2]) / 4;
  }
  return {
    volume: Math.abs(sixVolume) / 6,
    centre: { x: moment.x / sixVolume, y: moment.y / sixVolume, z: moment.z / sixVolume },
  };
}

function operandSolid(cad: OcctKernel, cut: WorkplaneShape) {
  const operand = sceneAnalysisOperand(cut, () => null);
  if (!operand?.part || operand.tessellated) throw new Error("expected the cut's exact B-rep as the operand");
  return reconstructSolid(cad, operand.part);
}

const writers: Array<[string, () => Promise<WorkplaneShape>]> = [
  ["the editor's exact cut", editorCut],
  ["the server's cut", serverCut],
];

describe.each(writers)("a cut placed away from the origin, made by %s (#548)", { timeout: CAD_TEST_TIMEOUT_MS }, (_name, makeCut) => {
  it("records in cadBrepFrame where its B-rep is, not where the part is", async () => {
    // The project file is read by more than this app's readers, so the frame
    // has to say the true thing on disk, not only be corrected on the way in.
    const cut = await makeCut();
    expect(cut.x).toBeCloseTo(AT.x, 6);
    expect(cut.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0, width: PLATE.width, depth: PLATE.depth, height: PLATE.height });
    const cad = await serverCadKernel();
    try {
      // Centred in X and Z, base on y = 0: the frame the mesh is stored in.
      const stored = cad.fromBREP(cut.cadBrep!);
      const centreOfPlate = cutCentre({ x: -AT.x, y: -AT.y, z: -AT.z });
      expectSolidAt(cad, stored, CUT_VOLUME, centreOfPlate);
    } finally {
      cad.releaseAll();
    }
  });

  it("is analysed for interference where it is drawn", async () => {
    const cut = await makeCut();
    const cad = await serverCadKernel();
    try {
      expectSolidAt(cad, operandSolid(cad, cut), CUT_VOLUME, cutCentre());

      // A 10 mm cube sunk into a solid corner of the plate, clear of the
      // pocket: it overlaps the cut by its whole volume, and a copy of the cut
      // at the origin by none of it.
      const probe = shape({ id: "probe", kind: "box", width: 10, depth: 10, height: 10, size: 10, x: AT.x - 14, z: AT.z + 14, elevation: AT.y });
      const operands = [cut, probe].map((candidate) => sceneAnalysisOperand(candidate, () => null)!);
      const result = interferenceBetweenSolids(cad, operands, (operand) => reconstructSolid(cad, operand.part!), 0);
      if (!result.ok) throw new Error(JSON.stringify(result.refusal));
      expect(result.value.pairs).toHaveLength(1);
      expect(result.value.pairs[0]!.overlapVolume).toBeCloseTo(1000, 3);
    } finally {
      cad.releaseAll();
    }
  });

  it("is cut again exactly where it is drawn", async () => {
    const cut = await makeCut();
    const cad = await serverCadKernel();
    try {
      // A 4 x 4 slot through the full height, in solid plate clear of the pocket.
      const slot = shape({
        id: "slot",
        kind: "box",
        hole: true,
        width: 4,
        depth: 4,
        size: 4,
        height: PLATE.height + 2,
        x: AT.x - 10,
        z: AT.z + 10,
        elevation: AT.y - 1,
      });
      const request = exactCutPartsForSelection([cut, slot]);
      if (!request) throw new Error("expected an exact cut request");
      const { cut: nested } = exactCutFromParts(cad, request.parts, (part) => reconstructSolid(cad, part));

      const slotVolume = 4 * 4 * PLATE.height;
      const volume = CUT_VOLUME - slotVolume;
      const before = cutCentre();
      const slotCentre = { x: AT.x - 10, y: AT.y + PLATE.height / 2, z: AT.z + 10 };
      const centre = {
        x: (before.x * CUT_VOLUME - slotCentre.x * slotVolume) / volume,
        y: (before.y * CUT_VOLUME - slotCentre.y * slotVolume) / volume,
        z: (before.z * CUT_VOLUME - slotCentre.z * slotVolume) / volume,
      };
      expectSolidAt(cad, nested, volume, centre);
    } finally {
      cad.releaseAll();
    }
  });

  it("follows the part when it is moved after the cut", async () => {
    const cut = await makeCut();
    const moved = { ...cut, x: cut.x - 7, z: cut.z + 4, elevation: (cut.elevation ?? 0) + 2 };
    const cad = await serverCadKernel();
    try {
      expectSolidAt(cad, operandSolid(cad, moved), CUT_VOLUME, cutCentre({ x: -7, y: 2, z: 4 }));
    } finally {
      cad.releaseAll();
    }
  });

  it("is hollowed from where it is drawn, placed the same way analysis places it", async () => {
    const cut = await makeCut();
    const shell = shellRequestForShape(cut, 1, []);
    expect(shell?.part.brep).toBe(cut.cadBrep);
    expect(shell?.part.brepTransform).toEqual(cadBrepTransformForShape(cut));
    const cad = await serverCadKernel();
    try {
      expectSolidAt(cad, reconstructSolid(cad, shell!.part), CUT_VOLUME, cutCentre());
    } finally {
      cad.releaseAll();
    }
  });

  it("follows the part when it is turned, mirrored or resized after the cut, to where its mesh is drawn", async () => {
    const cut = await makeCut();
    const edits: Array<[string, WorkplaneShape]> = [
      ["turned", { ...cut, rotation: 90 }],
      ["tilted", { ...cut, rotationX: 30, rotation: 45 }],
      ["mirrored", { ...cut, mirrorX: true }],
      ["resized", { ...cut, width: (cut.width ?? cut.size) * 1.5 }],
    ];
    const cad = await serverCadKernel();
    try {
      for (const [edit, edited] of edits) {
        // The display mesh is what the viewport draws; the exact solid has to
        // sit on it. Its faceting costs it a little volume and no centre.
        const drawn = meshMassProperties(edited);
        const solid = operandSolid(cad, edited);
        const volume = Math.abs(cad.getVolume(solid));
        expect(Math.abs(volume - drawn.volume), edit).toBeLessThan(drawn.volume * 2e-3);
        const centre = cad.getCenterOfMass(solid);
        expect(Math.hypot(centre.x - drawn.centre.x, centre.y - drawn.centre.y, centre.z - drawn.centre.z), edit).toBeLessThan(0.02);
      }
      // And by the arithmetic, for the resize: the plate and pocket both
      // stretch 1.5 times along x about the cut's centre.
      const resized = operandSolid(cad, edits[3]![1]);
      const unscaled = cutCentre();
      expect(Math.abs(cad.getVolume(resized) - CUT_VOLUME * 1.5)).toBeLessThan(CUT_VOLUME * 1.5 * 5e-4);
      expect(cad.getCenterOfMass(resized).x).toBeCloseTo(AT.x + (unscaled.x - AT.x) * 1.5, 2);
    } finally {
      cad.releaseAll();
    }
  });

  it("is placed where it stands as a member of a group the Fillet/Chamfer tool opens", async () => {
    // The tool takes a group record apart into its members and sends a member
    // that carries a B-rep as that B-rep, placed by `cadBrepTransformForShape`
    // (SketchForgeEditor's `startEdgeModifier`). The group is moved after it
    // was made, so the member's placement comes from the group, not the cut.
    const cut = await makeCut();
    const neighbour = shape({ id: "neighbour", kind: "box", width: 10, depth: 10, height: 10, size: 10, x: AT.x + 40, z: AT.z, elevation: AT.y });
    const group = groupedShapeFromSelection([cut, neighbour]);
    if (!group) throw new Error("expected a group record");
    const moved = { ...group, x: group.x + 6, z: group.z - 3 };
    const member = restoreGroupedChildren(moved).find((child) => child.cadBrep);
    if (!member) throw new Error("expected the cut among the members");
    const cad = await serverCadKernel();
    try {
      const part = { brep: member.cadBrep!, brepTransform: cadBrepTransformForShape(member), hole: false };
      expectSolidAt(cad, reconstructSolid(cad, part), CUT_VOLUME, cutCentre({ x: 6, y: 0, z: -3 }));
    } finally {
      cad.releaseAll();
    }
  });

  it("is corrected once when a project saved before the fix is opened, and keeps its place through undo", async () => {
    const cut = await makeCut();
    const legacy = asStoredBefore548(cut);
    const movedLegacy = { ...legacy, x: legacy.x + 5 };
    const cad = await serverCadKernel();
    try {
      // Read as stored, the old frame puts the solid at the origin: the reader
      // has one convention and does not guess.
      expect(cad.getCenterOfMass(operandSolid(cad, legacy)).x).toBeCloseTo(cutCentre().x - AT.x, 1);

      const opened = await importSkfProject(await packaged([movedLegacy], [[legacy], [movedLegacy]]));
      expect(opened.shapes[0]!.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0 });
      expectSolidAt(cad, operandSolid(cad, opened.shapes[0]!), CUT_VOLUME, cutCentre({ x: 5, y: 0, z: 0 }));
      // The undo state it came from is corrected too, so undo does not put
      // the cut back at the origin.
      expectSolidAt(cad, operandSolid(cad, opened.history[0]!.shapes[0]!), CUT_VOLUME, cutCentre());
    } finally {
      cad.releaseAll();
    }
  });

  it("is unchanged by saving and reopening, however often", async () => {
    // Every load runs the correction; a cut saved since the fix has its frame
    // at the origin, which the correction leaves alone.
    const cut = await makeCut();
    const once = (await importSkfProject(await packaged([cut], [[cut]]))).shapes[0]!;
    const twice = (await importSkfProject(await packaged([once], [[once]]))).shapes[0]!;
    expect(twice.cadBrepFrame).toEqual(cut.cadBrepFrame);
    const cad = await serverCadKernel();
    try {
      expectSolidAt(cad, operandSolid(cad, once), CUT_VOLUME, cutCentre());
      expectSolidAt(cad, operandSolid(cad, twice), CUT_VOLUME, cutCentre());
    } finally {
      cad.releaseAll();
    }
  });
});

/** A package holding these shapes, as any release writes it: the format did not change for #548. */
async function packaged(shapes: WorkplaneShape[], states: WorkplaneShape[][]) {
  return exportSkfProject({
    projectName: "Cut", createdAt: 1, modifiedAt: 1, shapes,
    history: states.map((state) => editorHistoryEntry(state, [])), historyIndex: states.length - 1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
}

describe("which old shapes the migration corrects (#548)", () => {
  // `sceneShape` keeps only parametric fields, so stored geometry is spread on.
  const oldCut: WorkplaneShape = {
    ...shape({ kind: "mesh", width: 10, depth: 10, height: 10, size: 10, x: 20, z: -6, elevation: 4 }),
    groupedShapes: [shape({ kind: "box" }), shape({ kind: "cylinder", hole: true })],
    importedMesh: { positions: new Array(9).fill(0), baseWidth: 10, baseDepth: 10, baseHeight: 10, triangleCount: 1, sourceFormat: "json" },
    cadBrep: "CASCADE Topology V1",
    cadBrepFrame: { x: 20, z: -6, elevation: 4, width: 10, depth: 10, height: 10 },
  };
  const feature = { kind: "fillet", amount: 1, edgeCount: 1 } as NonNullable<WorkplaneShape["edgeTreatments"]>[number];

  it("corrects a cut as the old cut writers left it, wherever it sits in the project", () => {
    expect(isPre548CutResult(oldCut)).toBe(true);
    const [migrated] = migratePre548CutBrepFrames([oldCut]);
    expect(migrated!.cadBrepFrame).toEqual({ x: 0, z: 0, elevation: 0, width: 10, depth: 10, height: 10 });
    const holder = { ...shape({ kind: "box" }), groupedShapes: [oldCut, shape({ kind: "box" })] };
    expect(migratePre548CutBrepFrames([holder])[0]!.groupedShapes![0]!.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0 });
    const filleted = { ...shape({ kind: "mesh" }), edgeTreatmentHistory: [{ id: "h", createdAt: 1, feature, before: oldCut }] };
    expect(migratePre548CutBrepFrames([filleted])[0]!.edgeTreatmentHistory![0]!.before.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0 });
  });

  it("leaves alone every shape another writer stored a world-space B-rep on", () => {
    const others: Array<[string, WorkplaneShape]> = [
      ["edge-treated", { ...oldCut, edgeTreatments: [feature] }],
      ["with a treated member", { ...oldCut, groupedShapes: [{ ...shape({ kind: "box" }), edgeTreatments: [feature] }, shape({ kind: "cylinder", hole: true })] }],
      ["a Fillet/Chamfer group parent", { ...oldCut, edgeResizeMode: "scale" }],
      ["shelled", { ...oldCut, shell: { thickness: 1 } }],
      ["face-drafted, with the face IDs a draft assigns", { ...oldCut, faceIds: ["face_a", "face_b"] }],
      ["carrying B-rep face ranges", { ...oldCut, importedMesh: { ...oldCut.importedMesh!, faceGroups: [0, 1, 0] } }],
      ["a group of solids", { ...oldCut, groupedShapes: [shape({ kind: "box" }), shape({ kind: "box" })] }],
      ["already at the origin", { ...oldCut, cadBrepFrame: { ...oldCut.cadBrepFrame!, x: 0, z: 0, elevation: 0 } }],
      ["with a baked source transform", { ...oldCut, cadBrepFrame: { ...oldCut.cadBrepFrame!, sourceTransform: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0] } }],
    ];
    for (const [name, other] of others) {
      expect(isPre548CutResult(other), name).toBe(false);
      expect(migratePre548CutBrepFrames([other])[0], name).toBe(other);
    }
  });

  it("reads every frame as written: the reader does no correcting of its own", () => {
    expect(cadBrepTransformForShape(oldCut)).toBeUndefined();
  });
});

/**
 * A baked face draft of a cut (the Faces panel's Draft: `applyDraftFaceToSelection`
 * sends `draftFaceRequestForShape`, the worker runs `buildFaceDraft`, and the
 * result goes through `shapeFromCadMesh` with the draft's face groups, then
 * `draftFaceResultMetadata` and `CLEARED_RETAINED_DRAFT_FIELDS`). The result
 * keeps the cut's members, hole included, and stores the drafted B-rep in
 * world space with the frame at its bounds.
 */
describe("a face-drafted cut placed away from the origin (#548)", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  /**
   * `shapeFromCadMesh` is private to the editor component, so its placement is
   * restated here from the worker's real output: the triangles rebased to their
   * bounds' centre and base, the bounds as the shape's placement and frame, and
   * the worker's face groups kept on the mesh.
   */
  function bakedFromCadMesh(source: WorkplaneShape, result: ReturnType<typeof buildFaceDraft>): WorkplaneShape {
    const { positions, indices, faceGroups, brep } = result;
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
      minX = Math.min(minX, positions[index]!); maxX = Math.max(maxX, positions[index]!);
      minY = Math.min(minY, positions[index + 1]!); maxY = Math.max(maxY, positions[index + 1]!);
      minZ = Math.min(minZ, positions[index + 2]!); maxZ = Math.max(maxZ, positions[index + 2]!);
    }
    const x = (minX + maxX) / 2;
    const z = (minZ + maxZ) / 2;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const height = maxY - minY;
    const flattened: number[] = [];
    for (const vertex of indices) flattened.push(positions[vertex * 3]! - x, positions[vertex * 3 + 1]! - minY, positions[vertex * 3 + 2]! - z);
    return {
      ...source,
      kind: "mesh",
      x, z, elevation: minY, width, depth, height,
      size: Math.max(width, depth),
      rotation: 0, rotationX: 0, rotationZ: 0,
      importedMesh: {
        positions: flattened, baseWidth: width, baseDepth: depth, baseHeight: height,
        triangleCount: Math.floor(indices.length / 3), sourceFormat: "json",
        ...(faceGroups.length ? { faceGroups: [...faceGroups] } : {}),
      },
      cadBrep: brep,
      cadBrepFrame: { x, z, elevation: minY, width, depth, height },
      cadPrimitiveFrame: undefined,
    };
  }

  async function draftedCut() {
    const cut = await editorCut();
    const cad = await serverCadKernel();
    const faceCount = cad.getSubShapes(cad.fromBREP(cut.cadBrep!), "face").length;
    let result: ReturnType<typeof buildFaceDraft> | null = null;
    for (let face = 0; face < faceCount && !result; face += 1) {
      const request = draftFaceRequestForShape(cut, face, 5, "y");
      try {
        result = request ? buildFaceDraft(cad, request) : null;
      } catch {
        // Not every face can be drafted along y; take the first that can.
      }
    }
    if (!result) throw new Error("expected a draftable face");
    expect(result.faceGroups.length).toBeGreaterThan(0);
    const drafted: WorkplaneShape = {
      ...bakedFromCadMesh(cut, result),
      ...draftFaceResultMetadata(cut.id, result.faceCount)!,
      ...CLEARED_RETAINED_DRAFT_FIELDS,
    };
    const truth = cad.fromBREP(result.brep);
    const centre = cad.getCenterOfMass(truth);
    return { drafted, volume: cad.getVolume(truth), centre: { x: centre.x, y: centre.y, z: centre.z } };
  }

  function expectReadWhereDrafted(cad: OcctKernel, drafted: WorkplaneShape, volume: number, centre: Centre) {
    // The interference operand, and the part a further exact cut sends.
    expectSolidAt(cad, operandSolid(cad, drafted), volume, centre);
    const cutter = shape({ id: "cutter", kind: "box", hole: true, width: 2, depth: 2, height: 2, size: 2, x: centre.x, z: centre.z, elevation: centre.y });
    const request = exactCutPartsForSelection([drafted, cutter]);
    if (!request) throw new Error("expected an exact cut request");
    expectSolidAt(cad, reconstructSolid(cad, request.parts[0]!), volume, centre);
  }

  it("is read where it was drafted", async () => {
    const { drafted, volume, centre } = await draftedCut();
    const cad = await serverCadKernel();
    try {
      expectReadWhereDrafted(cad, drafted, volume, centre);
    } finally {
      cad.releaseAll();
    }
  });

  it("is left where it was drafted when the project is saved and reopened", async () => {
    const { drafted, volume, centre } = await draftedCut();
    const opened = await importSkfProject(await packaged([drafted], [[drafted]]));
    expect(opened.shapes[0]!.cadBrepFrame).toEqual(drafted.cadBrepFrame);
    const cad = await serverCadKernel();
    try {
      expectReadWhereDrafted(cad, opened.shapes[0]!, volume, centre);
    } finally {
      cad.releaseAll();
    }
  });
});

/**
 * The parent the editor commits when the Fillet/Chamfer tool treats one
 * member of a group (`groupedShapeWithComponentEdgeTreatment`, also behind the
 * MCP bridge's `apply_edge_treatment`). It looks like a cut -- members, a mesh
 * and a B-rep, no treatment of its own -- but its B-rep is the treated group
 * in world space, with the frame at that B-rep's bounds, and the record of the
 * treatment is on the member. Read as a cut saved before #548, it was moved a
 * second time. Built here as that writer builds it, from a world-space solid.
 */
describe("a group whose member the Fillet/Chamfer tool treated (#548)", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  const feature: NonNullable<WorkplaneShape["edgeTreatments"]>[number] = { kind: "fillet", amount: 1, edgeCount: 1 };

  function treatedMember(member: WorkplaneShape): WorkplaneShape {
    return {
      ...member,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{ id: "history-1", createdAt: 1, feature, before: member }],
    };
  }

  /** The committed parent, around the world-space solid the tool built. */
  function treatedGroupParent(cad: OcctKernel, world: ShapeHandle, members: WorkplaneShape[], withResizeMode: boolean): WorkplaneShape {
    const bounds = cad.getBoundingBox(world, false);
    const x = (bounds.xmin + bounds.xmax) / 2;
    const z = (bounds.zmin + bounds.zmax) / 2;
    const elevation = bounds.ymin;
    const width = bounds.xmax - bounds.xmin;
    const depth = bounds.zmax - bounds.zmin;
    const height = bounds.ymax - bounds.ymin;
    return {
      ...shape({ id: "treated-group", kind: "mesh", width, depth, height, size: Math.max(width, depth), x, z, elevation }),
      groupOperation: "group",
      ...(withResizeMode ? { edgeResizeMode: "scale" as const } : {}),
      importedMesh: { positions: new Array(9).fill(0), baseWidth: width, baseDepth: depth, baseHeight: height, triangleCount: 1, sourceFormat: "json" },
      cadBrep: cad.toBREP(world),
      cadBrepFrame: { x, z, elevation, width, depth, height },
      groupedBaseWidth: width,
      groupedBaseDepth: depth,
      groupedBaseHeight: height,
      groupedShapes: members.map((member) => shapeAsGroupChild(member, x, z, elevation)),
    };
  }

  /** Every reader the issue names, each checked by volume and centre of mass. */
  function expectEveryReaderPlacesItAt(cad: OcctKernel, parent: WorkplaneShape, volume: number, centre: Centre) {
    expectSolidAt(cad, operandSolid(cad, parent), volume, centre);
    const shell = shellRequestForShape(parent, 1, []);
    if (!shell) throw new Error("expected a shell request");
    expectSolidAt(cad, reconstructSolid(cad, shell.part), volume, centre);
    // The part an exact cut of it would send.
    const request = exactCutPartsForSelection([parent, shape({ id: "cutter", kind: "box", hole: true, width: 2, depth: 2, height: 2, size: 2, x: centre.x, z: centre.z, elevation: centre.y })]);
    if (!request) throw new Error("expected an exact cut request");
    expectSolidAt(cad, reconstructSolid(cad, request.parts[0]!), volume, centre);
    // Left where it was made, it needs no transform at all, and opening a
    // package saved before #548 does not take it for an old cut.
    expect(cadBrepTransformForShape(parent)).toBeUndefined();
    expect(migratePre548CutBrepFrames([parent])[0]).toBe(parent);
  }

  it("of plain boxes stays where its B-rep was built", async () => {
    const cad = await serverCadKernel();
    try {
      const near = shape({ id: "near", kind: "box", width: 10, depth: 10, height: 10, size: 10, x: 30, z: -12, elevation: 3 });
      const far = shape({ id: "far", kind: "box", width: 10, depth: 10, height: 10, size: 10, x: 30, z: 0, elevation: 3 });
      // Two boxes 2 mm apart in z, as the tool's parts come back: one solid each.
      const world = cad.fuse(
        cad.makeBoxFromCorners({ x: 25, y: 3, z: -17 }, { x: 35, y: 13, z: -7 }),
        cad.makeBoxFromCorners({ x: 25, y: 3, z: -5 }, { x: 35, y: 13, z: 5 }),
      );
      for (const withResizeMode of [true, false]) {
        const parent = treatedGroupParent(cad, world, [treatedMember(near), far], withResizeMode);
        expectEveryReaderPlacesItAt(cad, parent, 2000, { x: 30, y: 8, z: -6 });
      }
    } finally {
      cad.releaseAll();
    }
  });

  it("of a cut, whose members include its hole, stays where its B-rep was built", async () => {
    // Reachable: the tool opens a cut group into its members, holes included,
    // and the treated plate carries the record.
    const cad = await serverCadKernel();
    try {
      const request = exactCutPartsForSelection([plate(), pocket()]);
      if (!request) throw new Error("expected an exact cut request");
      const { cut: world } = exactCutFromParts(cad, request.parts, (part) => reconstructSolid(cad, part));
      for (const withResizeMode of [true, false]) {
        const parent = treatedGroupParent(cad, world, [treatedMember(plate()), pocket()], withResizeMode);
        expectEveryReaderPlacesItAt(cad, parent, CUT_VOLUME, cutCentre());
      }
    } finally {
      cad.releaseAll();
    }
  });
});
