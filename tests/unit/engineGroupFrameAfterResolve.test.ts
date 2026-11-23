import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import { boundsForShapes, groupedShapeFromSelection, refittedGroupRecord, restoreGroupedChildren } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

/** A 2 x 2 rectangle with corner `a` fixed at (-1, -1) and both sides dimensioned. */
function rectangle(): SketchProfile {
  return {
    points: [
      { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
      { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
    constraints: [
      { id: "fix-a", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 },
      { id: "h-ab", kind: "horizontal", segmentId: "ab" },
      { id: "v-bc", kind: "vertical", segmentId: "bc" },
      { id: "h-cd", kind: "horizontal", segmentId: "cd" },
      { id: "v-da", kind: "vertical", segmentId: "da" },
      { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2 },
      { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
    ],
  };
}

/** Asserts the group's stored frame is the box around its children, as placed by that frame. */
function expectFrameFitsChildren(group: WorkplaneShape) {
  const bounds = boundsForShapes(restoreGroupedChildren(group));
  expect(group.x).toBeCloseTo((bounds.minX + bounds.maxX) / 2, 4);
  expect(group.z).toBeCloseTo((bounds.minZ + bounds.maxZ) / 2, 4);
  expect(group.elevation ?? 0).toBeCloseTo(bounds.minY, 4);
  expect(group.width).toBeCloseTo(bounds.maxX - bounds.minX, 4);
  expect(group.depth).toBeCloseTo(bounds.maxZ - bounds.minZ, 4);
  expect(group.height).toBeCloseTo(bounds.maxY - bounds.minY, 4);
}

describe("a group's frame after a nested sketch output is re-solved (#637)", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  const document = async (projectId: string) => (await store.read(projectId))!;

  /**
   * A 2 x 2 x 3 sketch extrusion at the origin, grouped with a 2 x 2 x 3 box at x = -10
   * (spanning x -11..1, so at x = -5 and 12 wide), or cut by a 0.5 mm hole at its centre.
   */
  async function groupedSketch(projectId: string, combine: "group" | "cut", bind = true) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    const created = value(await engine.addShapes(projectId, [
      { kind: "box", width: 2, depth: 2, height: 3 },
      combine === "cut"
        ? { kind: "box", width: 0.5, depth: 0.5, height: 1, elevation: 1, hole: true }
        : { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
    ])).shapes;
    const current = await document(projectId);
    await store.write(projectId, current, current.shapes.map((shape, index) => (index === 0 ? {
      ...shape,
      sketchOperation: "extrude" as const,
      sketchProfile: rectangle(),
      sketchSourceId: `sketch/${projectId}`,
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    } : shape)));
    const ids = created.map((shape) => shape.id);
    const group = combine === "cut"
      ? value(await engine.cut(projectId, { solidIds: [ids[0]!], holeIds: [ids[1]!] })).shape
      : value(await engine.group(projectId, ids)).shape;
    if (bind) {
      value(await engine.addParameter(projectId, { name: "w", expression: "2", dimension: "length" }));
      value(await engine.bindSketchConstraint(projectId, `sketch/${projectId}`, "width", "w"));
    }
    return group;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-group-frame-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refits a group around a sketch output that a parameter change grows, in one undo step", async () => {
    const group = await groupedSketch("grow", "group");
    expectFrameFitsChildren((await document("grow")).shapes[0]!);
    const before = await document("grow");

    value(await engine.updateParameter("grow", "w", { expression: "4" }));

    const after = await document("grow");
    const stored = after.shapes[0]!;
    expect(stored.id).toBe(group.id);
    // The sketch now spans x -1..3; the box still spans -11..-9.
    expect(stored).toMatchObject({ x: -4, width: 14, depth: 2, height: 3, z: 0, elevation: 0 });
    expectFrameFitsChildren(stored);
    const solid = value(await engine.properties("grow", group.id));
    expect(solid.volume).toBeCloseTo(4 * 2 * 3 + 2 * 2 * 3, 3);
    expect(solid.centerOfMass.x).toBeCloseTo((24 * 1 + 12 * -10) / 36, 4);
    expect(solid.centerOfMass.y).toBeCloseTo(1.5, 4);
    expect(solid.centerOfMass.z).toBeCloseTo(0, 4);
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(after.history[after.historyIndex - 1]!.shapes[0]).toEqual(before.shapes[0]);
  }, CAD_TEST_TIMEOUT_MS);

  it("refits a group after a nested profile edit through the sketch source", async () => {
    const group = await groupedSketch("profile", "group", false);
    const child = (await document("profile")).shapes[0]!.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/profile")!;
    const wider: SketchProfile = {
      ...child.sketchProfile!,
      points: child.sketchProfile!.points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: point.x + 2 } : point)),
      constraints: child.sketchProfile!.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, valueMm: 4 } : constraint)),
    };
    const before = await document("profile");

    value(await engine.changeShape("profile", "sketch/profile", { sketchProfile: wider }));

    const stored = (await document("profile")).shapes[0]!;
    expect(stored).toMatchObject({ x: -4, width: 14 });
    expectFrameFitsChildren(stored);
    expect((await document("profile")).history).toHaveLength(before.history.length + 1);
    const solid = value(await engine.properties("profile", group.id));
    expect(solid.volume).toBeCloseTo(36, 3);
    expect(solid.centerOfMass.x).toBeCloseTo((24 * 1 + 12 * -10) / 36, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("re-applies a group's bound x after a nested re-solve refits it", async () => {
    const group = await groupedSketch("bound-x", "group");
    value(await engine.addParameter("bound-x", { name: "p", expression: "-5", dimension: "length" }));
    value(await engine.bindShapeField("bound-x", group.id, "x", "p"));

    value(await engine.updateParameter("bound-x", "w", { expression: "4" }));

    let stored = (await document("bound-x")).shapes[0]!;
    expect(stored.expressions).toMatchObject({ x: "p" });
    expect(stored).toMatchObject({ x: -5, width: 14 });
    expectFrameFitsChildren(stored);
    // The refit put the group at -4; holding it at -5 moves both bodies 1 mm in -x.
    let solid = value(await engine.properties("bound-x", group.id));
    expect(solid.volume).toBeCloseTo(36, 3);
    expect(solid.centerOfMass.x).toBeCloseTo((24 * 0 + 12 * -11) / 36, 4);

    // A profile edit by hand grows the sketch to z -1..2; the bound z holds the group at 0.
    value(await engine.addParameter("bound-x", { name: "q", expression: "0", dimension: "length" }));
    value(await engine.bindShapeField("bound-x", group.id, "z", "q"));
    const child = stored.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/bound-x")!;
    const deeper: SketchProfile = {
      ...child.sketchProfile!,
      points: child.sketchProfile!.points.map((point) => (point.id === "c" || point.id === "d" ? { ...point, z: point.z + 1 } : point)),
      constraints: child.sketchProfile!.constraints!.map((constraint) => (constraint.id === "depth" ? { ...constraint, valueMm: 3 } : constraint)),
    };
    value(await engine.changeShape("bound-x", "sketch/bound-x", { sketchProfile: deeper }));

    stored = (await document("bound-x")).shapes[0]!;
    expect(stored.expressions).toMatchObject({ x: "p", z: "q" });
    expect(stored).toMatchObject({ x: -5, z: 0, width: 14, depth: 3 });
    expectFrameFitsChildren(stored);
    solid = value(await engine.properties("bound-x", group.id));
    expect(solid.volume).toBeCloseTo(4 * 3 * 3 + 12, 3);
    // Held at z = 0, the sketch spans -1.5..1.5 and the box -1.5..0.5.
    expect(solid.centerOfMass.z).toBeCloseTo((36 * 0 + 12 * -0.5) / 48, 4);
    expect(solid.centerOfMass.x).toBeCloseTo((36 * 0 + 12 * -11) / 48, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("re-applies a cut's bound x after its sketch operand is re-solved", async () => {
    const cut = await groupedSketch("bound-cut", "cut");
    // The cut spans the sketch alone: x -1..1.
    expect(cut.x).toBeCloseTo(0, 6);
    value(await engine.addParameter("bound-cut", { name: "p", expression: "0", dimension: "length" }));
    value(await engine.bindShapeField("bound-cut", cut.id, "x", "p"));
    const before = await document("bound-cut");

    value(await engine.updateParameter("bound-cut", "w", { expression: "4" }));

    const after = await document("bound-cut");
    const stored = after.shapes[0]!;
    expect(stored.expressions).toMatchObject({ x: "p" });
    expect(stored.x).toBeCloseTo(0, 6);
    expect(stored.width).toBeCloseTo(4, 4);
    expectFrameFitsChildren(stored);
    // The refit put the cut at x = 1; held at 0, the solid spans -2..2 and the hole sits at -1.
    const solid = value(await engine.properties("bound-cut", cut.id));
    const hole = 0.5 * 0.5 * 1;
    expect(solid.volume).toBeCloseTo(24 - hole, 3);
    expect(solid.centerOfMass.x).toBeCloseTo((24 * 0 - hole * -1) / (24 - hole), 4);
    expect(after.history).toHaveLength(before.history.length + 1);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("refittedGroupRecord", () => {
  it("leaves every child where it was in the parent frame under a turned, mirrored, resized group", () => {
    const box = (id: string, x: number, width: number): WorkplaneShape => ({
      id, name: id, kind: "box", color: "#888888", x, z: 1, elevation: 2, size: width, width, depth: 2, height: 3, rotation: 0,
    });
    const built = groupedShapeFromSelection([box("a", 0, 2), box("b", -10, 2)])!;
    const group: WorkplaneShape = { ...built, width: built.width! * 2, height: built.height * 1.5, rotation: 30, rotationX: 10, mirrorZ: true, x: 7, elevation: 4 };
    // `a` grows 3 mm in +x inside the group, as a re-solved sketch would.
    const children = group.groupedShapes!.map((child) => (child.name === "a" ? { ...child, width: 5, size: 5, x: child.x + 1.5 } : child));
    const stale = { ...group, groupedShapes: children };

    const refitted = refittedGroupRecord(group, children);

    const placed = (shape: WorkplaneShape) => restoreGroupedChildren(shape).map(({ x, z, elevation, width, depth, height, rotation, rotationX, rotationZ }) =>
      [x, z, elevation ?? 0, width, depth, height, rotation, rotationX ?? 0, rotationZ ?? 0]);
    placed(refitted).forEach((fields, index) => fields.forEach((field, axis) => expect(field).toBeCloseTo(placed(stale)[index]![axis]!, 6)));
    expect(refitted.groupedBaseWidth).toBeCloseTo(15, 6);
    expect(refitted.width).toBeCloseTo(30, 6);
    expect(refitted.height).toBeCloseTo(4.5, 6);
    expect(refitted).toMatchObject({ rotation: 30, rotationX: 10, mirrorZ: true });
  });
});
