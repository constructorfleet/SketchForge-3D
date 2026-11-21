import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import type { SketchConstraint, SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

/** A 2 x 2 rectangle with corner `a` fixed and both side lengths dimensioned; `width` binds when given. */
function rectangle(widthExpression?: string): SketchProfile {
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
      { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2, ...(widthExpression ? { expression: widthExpression } : {}) } as SketchConstraint,
      { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
    ],
  };
}

/** The same section swept along a 10 mm spine. */
function sweepProfile(widthExpression?: string): SketchProfile {
  const section = rectangle(widthExpression);
  return {
    points: [
      ...section.points.map((point) => ({ ...point, sweepRole: "section" as const })),
      { id: "p0", x: 0, z: 0, sweepRole: "spine" }, { id: "p1", x: 10, z: 0, sweepRole: "spine" },
    ],
    segments: [...section.segments, { id: "spine", startId: "p0", endId: "p1" }],
    constraints: section.constraints,
  };
}

const constraintOf = (shape: WorkplaneShape, id: string) => shape.sketchProfile!.constraints!.find((constraint) => constraint.id === id)!;

describe("a shape field binding and a sketch constraint binding on one dimension", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  /** A sketch extrusion of `rectangle()`, 3 mm tall, with `w = 3` and `h = 3` in the table. */
  async function sketchProject(projectId: string, profile = rectangle()): Promise<WorkplaneShape> {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    value(await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    const current = await document(projectId);
    await store.write(projectId, current, [{
      ...current.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: profile,
      sketchSourceId: `sketch/${projectId}`,
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }]);
    value(await engine.addParameter(projectId, { name: "w", expression: "3", dimension: "length" }));
    value(await engine.addParameter(projectId, { name: "h", expression: "3", dimension: "length" }));
    return (await document(projectId)).shapes[0]!;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-dimension-conflicts-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a width binding on an extrusion whose sketch has a bound constraint, and the reverse", async () => {
    const output = await sketchProject("field-second");
    value(await engine.bindSketchConstraint("field-second", output.id, "width", "w * 2"));
    const before = JSON.stringify(await document("field-second"));

    expect(await engine.bindShapeField("field-second", output.id, "width", "w")).toMatchObject({
      ok: false,
      failure: { reason: "binding_invalid", error: { code: "conflictingBinding", shapeId: output.id, field: "width", constraintIds: ["width"] } },
    });
    expect(await engine.changeShape("field-second", output.id, { expressions: { depth: "w" } })).toMatchObject({
      ok: false,
      failure: { reason: "binding_invalid", error: { code: "conflictingBinding", field: "depth", constraintIds: ["width"] } },
    });
    expect(JSON.stringify(await document("field-second"))).toBe(before);

    const other = await sketchProject("constraint-second");
    value(await engine.bindShapeField("constraint-second", other.id, "width", "w"));
    const unchanged = JSON.stringify(await document("constraint-second"));
    expect(await engine.bindSketchConstraint("constraint-second", other.id, "depth", "w")).toMatchObject({
      ok: false,
      failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", shapeId: other.id, constraintId: "depth", fields: ["width"] } },
    });
    expect(JSON.stringify(await document("constraint-second"))).toBe(unchanged);
    // Clearing either side is never refused.
    value(await engine.bindSketchConstraint("constraint-second", other.id, "depth", null));
    value(await engine.bindShapeField("constraint-second", other.id, "width", null));
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps an extrusion's height bindable beside its constraint bindings, and both drive the solid", async () => {
    const output = await sketchProject("height");
    const original = value(await engine.properties("height", output.id));
    value(await engine.bindSketchConstraint("height", output.id, "width", "w + 1"));
    value(await engine.bindShapeField("height", output.id, "height", "h"));

    value(await engine.updateParameter("height", "w", { expression: "5" }));
    value(await engine.updateParameter("height", "h", { expression: "6" }));

    const shape = (await document("height")).shapes[0]!;
    expect(shape.expressions).toEqual({ height: "h" });
    expect(constraintOf(shape, "width")).toMatchObject({ valueMm: 6, expression: "w + 1" });
    const solved = value(await engine.properties("height", output.id));
    // 6 x 2 x 6, grown from 2 x 2 x 3 with corner `a` held: the centre moves +2 in x and up by 1.5.
    expect(original.volume).toBeCloseTo(12, 3);
    expect(solved.volume).toBeCloseTo(72, 3);
    expect(solved.centerOfMass.x - original.centerOfMass.x).toBeCloseTo(2, 4);
    expect(solved.centerOfMass.y - original.centerOfMass.y).toBeCloseTo(1.5, 4);
    expect(solved.centerOfMass.z).toBeCloseTo(original.centerOfMass.z, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a stored conflict usable: the constraint is solved, then the bound size applies last", async () => {
    // The #629 reproduction, as a file written before the check would hold it.
    const output = await sketchProject("stored", rectangle("w * 2"));
    const current = await document("stored");
    await store.write("stored", current, [{ ...current.shapes[0]!, expressions: { width: "w" } }]);

    value(await engine.bindShapeField("stored", output.id, "x", "w"));
    value(await engine.updateParameter("stored", "w", { expression: "4" }));

    const shape = (await document("stored")).shapes[0]!;
    expect(constraintOf(shape, "width")).toMatchObject({ valueMm: 8, expression: "w * 2" });
    expect(shape).toMatchObject({ x: 4, expressions: { width: "w", x: "w" } });
    expect(shape.width).toBeCloseTo(4, 6);
    const solid = value(await engine.properties("stored", output.id));
    expect(solid.volume).toBeCloseTo(4 * 2 * 3, 3);
    expect(solid.centerOfMass.x).toBeCloseTo(4, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a constraint binding on a revolve whose height is bound", async () => {
    await writeProjectMetadata(root, "revolve", { id: "revolve", name: "revolve", createdAt: 1, revision: 1 });
    value(await engine.addParameter("revolve", { name: "w", expression: "12", dimension: "length" }));
    const created = value(await engine.addShapes("revolve", [{ kind: "revolve", profile: [[1, -5], [2, -5], [2, 5], [1, 5]], sides: 32 }])).shapes[0]!;
    const [first, second] = created.sketchProfile!.points;
    const current = await document("revolve");
    await store.write("revolve", current, [{
      ...current.shapes[0]!,
      sketchProfile: { ...created.sketchProfile!, constraints: [{ id: "edge", kind: "distance", pointIds: [first!.id, second!.id], valueMm: 1 }] },
    }]);
    value(await engine.bindShapeField("revolve", created.id, "height", "w"));
    const before = JSON.stringify(await document("revolve"));

    expect(await engine.bindSketchConstraint("revolve", created.id, "edge", "w / 12")).toMatchObject({
      ok: false,
      failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", constraintId: "edge", fields: ["height"] } },
    });
    expect(JSON.stringify(await document("revolve"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("drops constraint bindings when a literal size resizes the sketch, and keeps them on an echo", async () => {
    const output = await sketchProject("resize");
    value(await engine.bindSketchConstraint("resize", output.id, "width", "w"));
    const bound = (await document("resize")).shapes[0]!;

    value(await engine.changeShape("resize", output.id, { width: bound.width, name: "Echo" }));
    expect(constraintOf((await document("resize")).shapes[0]!, "width")).toMatchObject({ valueMm: 3, expression: "w" });

    const resized = value(await engine.changeShape("resize", output.id, { width: 6 }));
    expect(constraintOf(resized.shape, "width")).toEqual({ id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 3 });
    expect(value(await engine.properties("resize", output.id)).volume).toBeCloseTo(6 * 2 * 3, 3);

    // Nothing is bound any more, so a parameter change leaves the solid alone.
    value(await engine.updateParameter("resize", "w", { expression: "5" }));
    expect(value(await engine.properties("resize", output.id)).volume).toBeCloseTo(6 * 2 * 3, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("reapplies a bound placement after every sketch re-solve, so it is neither stale nor dropped", async () => {
    const output = await sketchProject("placed");
    value(await engine.addParameter("placed", { name: "p", expression: "5", dimension: "length" }));
    value(await engine.bindShapeField("placed", output.id, "x", "p"));
    const placedAt = async () => {
      const shape = (await document("placed")).shapes[0]!;
      expect(shape.expressions).toMatchObject({ x: "p" });
      expect(shape.x).toBe(5);
      return value(await engine.properties("placed", output.id));
    };
    expect((await placedAt()).centerOfMass.x).toBeCloseTo(5, 4);

    value(await engine.bindSketchConstraint("placed", output.id, "width", "w"));
    let solid = await placedAt();
    expect(solid.volume).toBeCloseTo(3 * 2 * 3, 3);
    expect(solid.centerOfMass.x).toBeCloseTo(5, 4);

    value(await engine.updateParameter("placed", "w", { expression: "4" }));
    solid = await placedAt();
    expect(solid.volume).toBeCloseTo(4 * 2 * 3, 3);
    expect(solid.centerOfMass.x).toBeCloseTo(5, 4);

    // A profile edit by hand moves the sketch's centre too; the bound x still holds.
    const stored = (await document("placed")).shapes[0]!;
    const wider: SketchProfile = {
      ...stored.sketchProfile!,
      points: stored.sketchProfile!.points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: point.x + 2 } : point)),
    };
    value(await engine.changeShape("placed", output.id, { sketchProfile: wider }));
    solid = await placedAt();
    expect(solid.volume).toBeCloseTo(6 * 2 * 3, 3);
    expect(solid.centerOfMass.x).toBeCloseTo(5, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a sweep created with both bindings and writes nothing", async () => {
    await writeProjectMetadata(root, "create", { id: "create", name: "create", createdAt: 1, revision: 1 });
    value(await engine.addParameter("create", { name: "w", expression: "2", dimension: "length" }));
    const before = JSON.stringify(await document("create"));

    expect(await engine.addShapes("create", [{ kind: "sketchSweep", profile: sweepProfile("w * 2"), expressions: { height: "w" } }])).toMatchObject({
      ok: false,
      failure: { reason: "binding_invalid", index: 0, error: { code: "conflictingBinding", field: "height", constraintIds: ["width"] } },
    });
    expect(JSON.stringify(await document("create"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);
});
