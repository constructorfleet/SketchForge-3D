import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import { boundsForShapes, groupedShapeFromSelection, refittedGroupRecord, restoreGroupedChildren } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { sketchConstraintBindingIssues } from "@constructorfleet/sketchforge-engine/sketchConstraintBindings";
import { shapeBindingIssues } from "@constructorfleet/sketchforge-engine/expressionBindings";
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
  const outputIn = (group: WorkplaneShape) => group.groupedShapes!.find((shape) => shape.sketchSourceId)!;
  const widerProfile = (profile: SketchProfile): SketchProfile => ({
    ...profile,
    points: profile.points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: point.x + 2 } : point)),
    constraints: profile.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, valueMm: 4 } : constraint)),
  });

  it.each(["group", "cut"] as const)("returns the nested output from changeShape as the %s stores it after the refit", async (combine) => {
    const group = await groupedSketch(`returned-${combine}`, combine, false);
    const child = outputIn((await document(`returned-${combine}`)).shapes[0]!);

    const changed = value(await engine.changeShape(`returned-${combine}`, `sketch/returned-${combine}`, { sketchProfile: widerProfile(child.sketchProfile!) }));

    const stored = (await document(`returned-${combine}`)).shapes.find((shape) => shape.id === group.id)!;
    expect(stored.width).toBeCloseTo(combine === "cut" ? 4 : 14, 4);
    const frame = ({ id, x, z, elevation, width, depth, height, size, rotation, sketchProfile }: WorkplaneShape) =>
      ({ id, x, z, elevation, width, depth, height, size, rotation, sketchProfile });
    expect(frame(changed.shape)).toEqual(frame(outputIn(stored)));
  }, CAD_TEST_TIMEOUT_MS);

  /** Edits a grouped output with `field` bound and the same output unbound; both groups must match. */
  async function expectUnboundEditMatches(
    name: string,
    create: (projectId: string) => Promise<string[]>,
    field: string,
    expression: string,
    edit: (child: WorkplaneShape) => Record<string, unknown>,
  ) {
    const run = async (projectId: string, bind: boolean) => {
      await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
      const group = value(await engine.group(projectId, await create(projectId))).shape;
      const child = outputIn((await document(projectId)).shapes[0]!);
      if (bind) {
        value(await engine.addParameter(projectId, { name: "k", expression, dimension: "angle" }));
        value(await engine.bindShapeField(projectId, child.id, field, "k"));
      }
      value(await engine.changeShape(projectId, child.sketchSourceId!, edit(child)));
      const stored = (await document(projectId)).shapes[0]!;
      expect(outputIn(stored).expressions?.[field]).toBeUndefined();
      expectFrameFitsChildren(stored);
      return { stored, solid: value(await engine.properties(projectId, group.id)) };
    };
    const bound = await run(`${name}-bound`, true);
    const plain = await run(`${name}-plain`, false);
    expect(bound.solid.volume).toBeCloseTo(plain.solid.volume, 3);
    for (const axis of ["x", "y", "z"] as const) expect(bound.solid.centerOfMass[axis]).toBeCloseTo(plain.solid.centerOfMass[axis], 3);
    expect(outputIn(bound.stored).x).toBeCloseTo(outputIn(plain.stored).x, 6);
  }

  it("keeps a nested draft extrusion in place when a literal replaces its bound angle during a profile edit", async () => {
    await expectUnboundEditMatches("draft", async (projectId) => {
      const created = value(await engine.addShapes(projectId, [
        { kind: "box", width: 2, depth: 2, height: 3 },
        { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
      ])).shapes;
      const current = await document(projectId);
      await store.write(projectId, current, current.shapes.map((shape, index) => (index === 0 ? {
        ...shape, sketchOperation: "extrude" as const, sketchProfile: rectangle(), sketchSourceId: `sketch/${projectId}`,
        cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
      } : shape)));
      value(await engine.draftPrism(projectId, created[0]!.id, 5));
      return created.map((shape) => shape.id);
    }, "draftPrismAngle", "5 deg", (child) => ({ sketchProfile: widerProfile(child.sketchProfile!), draftPrismAngle: 8 }));
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a nested revolve in place when a literal replaces its bound sweep angle", async () => {
    await expectUnboundEditMatches("revolve", async (projectId) => value(await engine.addShapes(projectId, [
      { kind: "revolve", name: "Revolve", profile: [[0, -2], [2, -2], [2, 2], [0, 2]], sides: 32 },
      { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
    ])).shapes.map((shape) => shape.id), "revolve.sweepAngle", "360 deg", () => ({ sweepAngle: 180 }));
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a group size binding and a nested constraint binding together, either way round", async () => {
    const group = await groupedSketch("size-conflict", "group");
    value(await engine.addParameter("size-conflict", { name: "gw", expression: "12", dimension: "length" }));
    const before = JSON.stringify(await document("size-conflict"));

    expect(await engine.bindShapeField("size-conflict", group.id, "width", "gw")).toMatchObject({
      ok: false,
      failure: { reason: "binding_invalid", error: { code: "conflictingBinding", shapeId: group.id, field: "width", constraintIds: ["width"] } },
    });
    expect(JSON.stringify(await document("size-conflict"))).toBe(before);

    value(await engine.bindSketchConstraint("size-conflict", "sketch/size-conflict", "width", null));
    value(await engine.bindShapeField("size-conflict", group.id, "width", "gw"));
    const bound = JSON.stringify(await document("size-conflict"));
    expect(await engine.bindSketchConstraint("size-conflict", "sketch/size-conflict", "width", "w")).toMatchObject({
      ok: false,
      failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", constraintId: "width", fields: ["width"] } },
    });
    const child = outputIn((await document("size-conflict")).shapes[0]!);
    const tagged = {
      ...child.sketchProfile!,
      constraints: child.sketchProfile!.constraints!.map((constraint) => (constraint.id === "depth" ? { ...constraint, expression: "w" } : constraint)),
    };
    expect(await engine.changeShape("size-conflict", "sketch/size-conflict", { sketchProfile: tagged })).toMatchObject({
      ok: false,
      failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", constraintId: "depth", fields: ["width"] } },
    });
    expect(JSON.stringify(await document("size-conflict"))).toBe(bound);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a group size binding and a nested feature binding together, either way round", async () => {
    await writeProjectMetadata(root, "feature-conflict", { id: "feature-conflict", name: "feature-conflict", createdAt: 1, revision: 1 });
    const ids = value(await engine.addShapes("feature-conflict", [
      { kind: "revolve", name: "Revolve", profile: [[0, -2], [2, -2], [2, 2], [0, 2]], sides: 32 },
      { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
    ])).shapes.map((shape) => shape.id);
    const group = value(await engine.group("feature-conflict", ids)).shape;
    const child = outputIn((await document("feature-conflict")).shapes[0]!);
    value(await engine.addParameter("feature-conflict", { name: "sweep", expression: "360 deg", dimension: "angle" }));
    value(await engine.addParameter("feature-conflict", { name: "gh", expression: "4", dimension: "length" }));
    value(await engine.bindShapeField("feature-conflict", child.id, "revolve.sweepAngle", "sweep"));

    expect(await engine.bindShapeField("feature-conflict", group.id, "height", "gh")).toMatchObject({
      ok: false, failure: { reason: "binding_invalid", error: { code: "conflictingBinding", shapeId: group.id, field: "height" } },
    });
    value(await engine.bindShapeField("feature-conflict", child.id, "revolve.sweepAngle", null));
    value(await engine.bindShapeField("feature-conflict", group.id, "height", "gh"));
    expect(await engine.bindShapeField("feature-conflict", child.id, "revolve.sweepAngle", "sweep")).toMatchObject({
      ok: false, failure: { reason: "binding_invalid", error: { code: "conflictingBinding", shapeId: child.id, field: "revolve.sweepAngle" } },
    });
  }, CAD_TEST_TIMEOUT_MS);

  it("drops a stored group size binding that a refit moves, and reports the conflict on load", async () => {
    await groupedSketch("stale-size", "group");
    value(await engine.addParameter("stale-size", { name: "gw", expression: "12", dimension: "length" }));
    const current = await document("stale-size");
    // As a project written before the refusal existed could hold it.
    await store.write("stale-size", current, [{ ...current.shapes[0]!, expressions: { width: "gw" } }]);
    const loaded = await document("stale-size");
    expect(sketchConstraintBindingIssues(loaded.shapes, loaded.parameters ?? [])).toEqual([
      expect.objectContaining({ code: "conflictingBinding", constraintId: "width", fields: ["width"], shapeId: outputIn(loaded.shapes[0]!).id }),
    ]);

    const written = value(await engine.updateParameter("stale-size", "w", { expression: "4" }));

    const stored = (await document("stale-size")).shapes[0]!;
    expect(stored.expressions?.width).toBeUndefined();
    // The write's rebuilt shapes carry the group without the binding it dropped.
    expect(written.shapes.find((shape) => shape.id === stored.id)?.expressions?.width).toBeUndefined();
    expect(stored).toMatchObject({ x: -4, width: 14 });
    expectFrameFitsChildren(stored);
    // gw no longer drives the group, so changing it leaves the solid alone.
    value(await engine.updateParameter("stale-size", "gw", { expression: "13" }));
    expect((await document("stale-size")).shapes[0]!.width).toBe(14);
    expect(value(await engine.properties("stale-size", stored.id)).volume).toBeCloseTo(36, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("names a group's size binding that a nested source edit drops in the changeShape result (#654)", async () => {
    const group = await groupedSketch("dropped", "group");
    value(await engine.addParameter("dropped", { name: "gw", expression: "12", dimension: "length" }));
    const current = await document("dropped");
    // As a project written before the refusal existed could hold it.
    await store.write("dropped", current, [{ ...current.shapes[0]!, expressions: { width: "gw" } }]);
    const child = outputIn((await document("dropped")).shapes[0]!);

    const changed = value(await engine.changeShape("dropped", "sketch/dropped", { sketchProfile: widerProfile(child.sketchProfile!) }));

    expect(changed.droppedBindings).toEqual([{ shapeId: group.id, fields: ["width"] }]);
    expect((await document("dropped")).shapes[0]!.expressions?.width).toBeUndefined();
    // An edit that drops nothing says nothing.
    const renamed = value(await engine.changeShape("dropped", group.id, { name: "Renamed" }));
    expect(renamed).not.toHaveProperty("droppedBindings");
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a stored group size binding when a re-solve leaves the children's bounds alone", async () => {
    await groupedSketch("same-size", "group");
    value(await engine.addParameter("same-size", { name: "gw", expression: "37/3", dimension: "length" }));
    const current = await document("same-size");
    const group = current.shapes[0]!;
    // A size off the refit's 0.001 mm grid, as a project written before the refusal could hold it.
    await store.write("same-size", current, [{ ...group, width: 37 / 3, size: 37 / 3, expressions: { width: "gw" } }]);
    const child = outputIn((await document("same-size")).shapes[0]!);

    value(await engine.changeShape("same-size", "sketch/same-size", { sketchProfile: child.sketchProfile }));

    const stored = (await document("same-size")).shapes[0]!;
    expect(stored.expressions).toMatchObject({ width: "gw" });
    expect(stored.width).toBe(37 / 3);
    expect(stored.x).toBeCloseTo(group.x, 9);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a bound group size when a bound fillet amount inside it changes", async () => {
    await writeProjectMetadata(root, "fillet", { id: "fillet", name: "fillet", createdAt: 1, revision: 1 });
    const created = value(await engine.addShapes("fillet", [
      { kind: "box", width: 2, depth: 2, height: 3 },
      { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
    ])).shapes;
    const current = await document("fillet");
    await store.write("fillet", current, current.shapes.map((shape, index) => (index === 0 ? {
      ...shape, sketchOperation: "extrude" as const, sketchProfile: rectangle(), sketchSourceId: "sketch/fillet",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    } : shape)));
    value(await engine.treat("fillet", created[0]!.id, { kind: "fillet", amount: 0.1 }));
    const group = value(await engine.group("fillet", created.map((shape) => shape.id))).shape;
    const child = outputIn((await document("fillet")).shapes[0]!);
    value(await engine.addParameter("fillet", { name: "f", expression: "0.1", dimension: "length" }));
    value(await engine.addParameter("fillet", { name: "gw", expression: "37/3", dimension: "length" }));
    value(await engine.bindShapeField("fillet", child.id, "edgeTreatments.0.amount", "f"));
    value(await engine.bindShapeField("fillet", group.id, "width", "gw"));
    const before = value(await engine.properties("fillet", group.id));

    value(await engine.updateParameter("fillet", "f", { expression: "0.2" }));

    const stored = (await document("fillet")).shapes[0]!;
    expect(stored.expressions).toMatchObject({ width: "gw" });
    expect(stored.width).toBeCloseTo(37 / 3, 9);
    expect(outputIn(stored).edgeTreatments?.[0]?.amount).toBe(0.2);
    const after = value(await engine.properties("fillet", group.id));
    expect(stored.x).toBeCloseTo(group.x, 9);
    // The larger fillet removes material symmetrically about the filleted body's own centre.
    const removed = before.volume - after.volume;
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(0.5);
    const body = restoreGroupedChildren(stored).find((shape) => shape.sketchSourceId)!;
    expect(after.centerOfMass.x).toBeCloseTo((before.centerOfMass.x * before.volume - removed * body.x) / after.volume, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("reports a bound group size next to a nested bound feature field on load", async () => {
    await writeProjectMetadata(root, "feature-issue", { id: "feature-issue", name: "feature-issue", createdAt: 1, revision: 1 });
    const ids = value(await engine.addShapes("feature-issue", [
      { kind: "revolve", name: "Revolve", profile: [[0, -2], [2, -2], [2, 2], [0, 2]], sides: 32 },
      { kind: "box", width: 2, depth: 2, height: 3, x: -10 },
    ])).shapes.map((shape) => shape.id);
    const group = value(await engine.group("feature-issue", ids)).shape;
    value(await engine.addParameter("feature-issue", { name: "sweep", expression: "360 deg", dimension: "angle" }));
    value(await engine.addParameter("feature-issue", { name: "gh", expression: "4", dimension: "length" }));
    const child = outputIn((await document("feature-issue")).shapes[0]!);
    value(await engine.bindShapeField("feature-issue", child.id, "revolve.sweepAngle", "sweep"));
    const current = await document("feature-issue");
    await store.write("feature-issue", current, [{ ...current.shapes[0]!, expressions: { height: "gh" } }]);
    const loaded = await document("feature-issue");

    expect(shapeBindingIssues(loaded.shapes, loaded.parameters ?? [])).toEqual([
      expect.objectContaining({ code: "conflictingBinding", shapeId: group.id, field: "height" }),
    ]);
  }, CAD_TEST_TIMEOUT_MS);

  it("refits a group inside a mirrored, resized group, in one undo step", async () => {
    const inner = await groupedSketch("nested", "group", false);
    const [box] = value(await engine.addShapes("nested", [{ kind: "box", width: 2, depth: 2, height: 2, z: 10 }])).shapes;
    const outer = value(await engine.group("nested", [inner.id, box!.id])).shape;
    const current = await document("nested");
    await store.write("nested", current, current.shapes.map((shape) => (shape.id === outer.id ? { ...shape, width: shape.width! * 2, mirrorX: true } : shape)));
    value(await engine.addParameter("nested", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("nested", "sketch/nested", "width", "w"));
    const before = await document("nested");

    value(await engine.updateParameter("nested", "w", { expression: "4" }));

    const after = await document("nested");
    const stored = after.shapes[0]!;
    expectFrameFitsChildren(stored);
    expectFrameFitsChildren(stored.groupedShapes!.find((shape) => shape.groupedShapes)!);
    expect(stored.mirrorX).toBe(true);
    expect(stored.width! / stored.groupedBaseWidth!).toBeCloseTo(2, 6);
    // Doubled in x and mirrored about the outer centre: the sketch, inner box and outer box centre at -17, 5 and -15.
    const solid = value(await engine.properties("nested", outer.id));
    expect(solid.volume).toBeCloseTo(48 + 24 + 16, 2);
    expect(solid.centerOfMass.x).toBeCloseTo((48 * -17 + 24 * 5 + 16 * -15) / 88, 3);
    expect(solid.centerOfMass.y).toBeCloseTo((48 * 1.5 + 24 * 1.5 + 16 * 1) / 88, 3);
    expect(solid.centerOfMass.z).toBeCloseTo((16 * 10) / 88, 3);
    expect(after.history).toHaveLength(before.history.length + 1);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("refittedGroupRecord", () => {
  const box = (id: string, x: number, width: number): WorkplaneShape => ({
    id, name: id, kind: "box", color: "#888888", x, z: 1, elevation: 2, size: width, width, depth: 2, height: 3, rotation: 0,
  });
  const placed = (shape: WorkplaneShape) => restoreGroupedChildren(shape).map((child) => ({
    numbers: [child.x, child.z, child.elevation ?? 0, child.width!, child.depth!, child.height, child.rotation, child.rotationX ?? 0, child.rotationZ ?? 0],
    mirrors: [Boolean(child.mirrorX), Boolean(child.mirrorY), Boolean(child.mirrorZ)],
  }));

  it.each([
    ["mirrored in Z", { mirrorZ: true }],
    ["mirrored in X", { mirrorX: true }],
    ["mirrored in Y", { mirrorY: true }],
    ["mirrored in X and Y", { mirrorX: true, mirrorY: true }],
  ] as const)("leaves every child where it was under a turned, resized group %s", (_label, mirrors) => {
    const built = groupedShapeFromSelection([box("a", 0, 2), { ...box("b", -10, 2), mirrorX: true }])!;
    const group: WorkplaneShape = { ...built, ...mirrors, width: built.width! * 2, height: built.height * 1.5, depth: built.depth! * 0.5, rotation: 30, rotationX: 10, x: 7, elevation: 4 };
    // `a` grows 3 mm in +x, 2 mm up and 1 mm in +z inside the group, as a re-solved sketch would.
    const children = group.groupedShapes!.map((child) => (child.name === "a"
      ? { ...child, width: 5, size: 5, x: child.x + 1.5, height: 5, depth: 3, z: child.z + 0.5 }
      : child));
    const stale = { ...group, groupedShapes: children };

    const refitted = refittedGroupRecord(group, children);

    const expected = placed(stale);
    placed(refitted).forEach((child, index) => {
      child.numbers.forEach((field, axis) => expect(field).toBeCloseTo(expected[index]!.numbers[axis]!, 6));
      expect(child.mirrors).toEqual(expected[index]!.mirrors);
    });
    expect(refitted.groupedBaseWidth).toBeCloseTo(15, 6);
    expect(refitted.groupedBaseHeight).toBeCloseTo(5, 6);
    expect(refitted.groupedBaseDepth).toBeCloseTo(3, 6);
    expect(refitted.width).toBeCloseTo(30, 6);
    expect(refitted.height).toBeCloseTo(7.5, 6);
    expect(refitted.depth).toBeCloseTo(1.5, 6);
    expect(refitted).toMatchObject({ rotation: 30, rotationX: 10, ...mirrors });
  });
});
