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

/** A 2 x 2 rectangle, fully constrained: corner `a` fixed, edges level, both side lengths dimensioned. */
function rectangle(extra: SketchConstraint[] = []): SketchProfile {
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
      ...extra,
    ],
  };
}

/** A constrained 2 x 2 section swept along a 10 mm spine; `width` carries `expression` when given. */
function sweepProfile(expression?: string): SketchProfile {
  const section = rectangle();
  return {
    points: [
      ...section.points.map((point) => ({ ...point, sweepRole: "section" as const })),
      { id: "p0", x: 0, z: 0, sweepRole: "spine" }, { id: "p1", x: 10, z: 0, sweepRole: "spine" },
    ],
    segments: [...section.segments, { id: "spine", startId: "p0", endId: "p1" }],
    constraints: section.constraints!.map((constraint) =>
      (constraint.id === "width" && expression ? { ...constraint, expression } as SketchConstraint : constraint)),
  };
}

const constraintOf =(shape: WorkplaneShape, id: string) => shape.sketchProfile!.constraints!.find((constraint) => constraint.id === id)!;

function withoutExpressions(profile: SketchProfile): SketchProfile {
  return {
    ...profile,
    constraints: profile.constraints!.map((constraint) => {
      const { expression: _expression, ...rest } = constraint as SketchConstraint & { expression?: string };
      return rest as SketchConstraint;
    }),
  };
}

describe("expression-bound sketch constraints", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function project(projectId: string) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
  }

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  /** Writes the first shape as a sketch extrusion recipe drawn from `profile`. */
  async function asSketchExtrusion(projectId: string, sketchSourceId: string, profile: SketchProfile) {
    const current = await document(projectId);
    const [first, ...rest] = current.shapes;
    await store.write(projectId, current, [{
      ...first!,
      sketchOperation: "extrude",
      sketchProfile: profile,
      sketchSourceId,
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }, ...rest]);
  }

  async function sketchProject(projectId: string, profile = rectangle()) {
    await project(projectId);
    value(await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    await asSketchExtrusion(projectId, `sketch/${projectId}`, profile);
    return (await document(projectId)).shapes[0]!;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-constraint-bindings-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("re-solves a bound sketch and rebuilds its extrusion in one write and one undo step", async () => {
    const output = await sketchProject("bound");
    await sketchProject("manual");
    value(await engine.addParameter("bound", { name: "w", expression: "2", dimension: "length" }));
    const bound = value(await engine.bindSketchConstraint("bound", "sketch/bound", "width", "w"));
    expect(constraintOf(bound.shape, "width")).toMatchObject({ valueMm: 2, expression: "w" });
    const original = value(await engine.properties("bound", output.id));
    const before = await document("bound");

    const changed = value(await engine.updateParameter("bound", "w", { expression: "4" }));

    expect(changed.parameters).toEqual([{ name: "w", expression: "4", dimension: "length", value: 4 }]);
    const after = await document("bound");
    expect(after.history).toHaveLength(before.history.length + 1);
    const rebuilt = after.shapes[0]!;
    expect(constraintOf(rebuilt, "width")).toMatchObject({ valueMm: 4, expression: "w" });
    const points = new Map(rebuilt.sketchProfile!.points.map((point) => [point.id, point]));
    expect(points.get("a")).toMatchObject({ x: -1, z: -1 });
    expect(points.get("b")!.x).toBeCloseTo(3, 6);
    expect(points.get("c")!.x).toBeCloseTo(3, 6);
    expect(points.get("d")!.x).toBeCloseTo(-1, 6);

    // The same profile entered by hand gives the same solid.
    value(await engine.changeShape("manual", "sketch/manual", { sketchProfile: withoutExpressions(rebuilt.sketchProfile!) }));
    const solved = value(await engine.properties("bound", output.id));
    const manual = value(await engine.properties("manual", (await document("manual")).shapes[0]!.id));
    expect(original.volume).toBeCloseTo(12, 3);
    expect(solved.volume).toBeCloseTo(24, 3);
    expect(solved.volume).toBeCloseTo(manual.volume, 6);
    expect(solved.centerOfMass.x).toBeCloseTo(manual.centerOfMass.x, 6);
    expect(solved.centerOfMass.y).toBeCloseTo(manual.centerOfMass.y, 6);
    expect(solved.centerOfMass.z).toBeCloseTo(manual.centerOfMass.z, 6);
    expect(Math.abs(solved.centerOfMass.x - original.centerOfMass.x)).toBeGreaterThan(0.5);

    const undone = after.history[after.historyIndex - 1]!;
    expect(undone.parameters).toEqual([{ name: "w", expression: "2", dimension: "length", value: 2 }]);
    expect(constraintOf(undone.shapes[0]!, "width")).toMatchObject({ valueMm: 2, expression: "w" });
    expect(undone.shapes[0]!.sketchProfile!.points.find((point) => point.id === "b")).toMatchObject({ x: 1 });
  }, CAD_TEST_TIMEOUT_MS);

  it("rebuilds a cut built from a bound sketch exactly as a manual profile edit does", async () => {
    const setUp = async (projectId: string) => {
      await project(projectId);
      const created = value(await engine.addShapes(projectId, [
        { kind: "box", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
        { kind: "box", width: 0.5, depth: 0.5, height: 1, x: 12, z: -4, elevation: 8, hole: true },
      ])).shapes;
      await asSketchExtrusion(projectId, "sketch/cut", rectangle());
      return value(await engine.cut(projectId, { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
    };
    const boundCut = await setUp("bound-cut");
    const manualCut = await setUp("manual-cut");
    value(await engine.addParameter("bound-cut", { name: "depth", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("bound-cut", "sketch/cut", "depth", "depth"));
    const original = value(await engine.properties("bound-cut", boundCut.id));

    value(await engine.updateParameter("bound-cut", "depth", { expression: "3mm" }));
    const child = (await document("bound-cut")).shapes[0]!.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/cut")!;
    expect(constraintOf(child, "depth")).toMatchObject({ valueMm: 3, expression: "depth" });
    value(await engine.changeShape("manual-cut", "sketch/cut", { sketchProfile: withoutExpressions(child.sketchProfile!) }));

    const bound = value(await engine.properties("bound-cut", boundCut.id));
    const manual = value(await engine.properties("manual-cut", manualCut.id));
    expect(bound.volume - original.volume).toBeCloseTo(2 * 3, 3);
    expect(bound.volume).toBeCloseTo(manual.volume, 6);
    expect(bound.centerOfMass.x).toBeCloseTo(manual.centerOfMass.x, 6);
    expect(bound.centerOfMass.y).toBeCloseTo(manual.centerOfMass.y, 6);
    expect(bound.centerOfMass.z).toBeCloseTo(manual.centerOfMass.z, 6);
    // Corner `a` stays put, so the 2 x 3 x 3 solid spans z -5..-2 around the unmoved 0.5 x 0.5 x 1 hole at z -4.
    const solid = 2 * 3 * 3;
    const hole = 0.5 * 0.5 * 1;
    expect(bound.volume).toBeCloseTo(solid - hole, 4);
    expect(bound.centerOfMass.x).toBeCloseTo(12, 4);
    expect(bound.centerOfMass.y).toBeCloseTo(8.5, 4);
    expect(bound.centerOfMass.z).toBeCloseTo((solid * -3.5 - hole * -4) / (solid - hole), 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses to bind, tag or unbind a sketch output inside a locked group, and writes nothing", async () => {
    await project("locked-group");
    const created = value(await engine.addShapes("locked-group", [
      { kind: "box", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
      { kind: "box", width: 0.5, depth: 0.5, height: 1, x: 12, z: -4, elevation: 8, hole: true },
    ])).shapes;
    await asSketchExtrusion("locked-group", "sketch/locked", rectangle([
      { id: "tagged", kind: "distance", pointIds: ["c", "d"], valueMm: 2, expression: "w" },
    ]));
    const cut = value(await engine.cut("locked-group", { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
    value(await engine.addParameter("locked-group", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.changeShape("locked-group", cut.id, { locked: true }));
    const before = JSON.stringify(await document("locked-group"));

    const refusal = { ok: false, failure: { reason: "shape_locked", ids: [cut.id] } };
    expect(await engine.bindSketchConstraint("locked-group", "sketch/locked", "width", "w * 2")).toMatchObject(refusal);
    expect(await engine.bindSketchConstraint("locked-group", "sketch/locked", "depth", "w")).toMatchObject(refusal);
    expect(await engine.bindSketchConstraint("locked-group", "sketch/locked", "tagged", null)).toMatchObject(refusal);
    expect(JSON.stringify(await document("locked-group"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("treats a shelled sketch as not rebuildable: refuses a bind and leaves a stored binding stale", async () => {
    const output = await sketchProject("shelled");
    const current = await document("shelled");
    await store.write("shelled", current, [{ ...current.shapes[0]!, shell: { thickness: 0.2 } }]);
    value(await engine.addParameter("shelled", { name: "w", expression: "2", dimension: "length" }));

    expect(await engine.bindSketchConstraint("shelled", output.id, "width", "w"))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "sketchNotRebuildable" } } });

    const stored = await document("shelled");
    await store.write("shelled", stored, [{
      ...stored.shapes[0]!,
      sketchProfile: {
        ...stored.shapes[0]!.sketchProfile!,
        constraints: stored.shapes[0]!.sketchProfile!.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, expression: "w" } : constraint)),
      },
    }]);
    value(await engine.updateParameter("shelled", "w", { expression: "4" }));
    expect(constraintOf((await document("shelled")).shapes[0]!, "width")).toMatchObject({ valueMm: 2, expression: "w" });
  }, CAD_TEST_TIMEOUT_MS);

  it("replays a retained all-edge fillet after a constraint-driven re-solve", async () => {
    await sketchProject("filleted");
    await sketchProject("filleted-manual");
    for (const projectId of ["filleted", "filleted-manual"]) {
      value(await engine.treat(projectId, (await document(projectId)).shapes[0]!.id, { kind: "fillet", amount: 0.2 }));
    }
    const output = (await document("filleted")).shapes[0]!;
    value(await engine.addParameter("filleted", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("filleted", output.id, "width", "w"));
    const original = value(await engine.properties("filleted", output.id));

    value(await engine.updateParameter("filleted", "w", { expression: "4" }));

    const rebuilt = (await document("filleted")).shapes[0]!;
    expect(rebuilt.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: 0.2, allEdges: true })]);
    value(await engine.changeShape("filleted-manual", "sketch/filleted-manual", { sketchProfile: withoutExpressions(rebuilt.sketchProfile!) }));
    const bound = value(await engine.properties("filleted", output.id));
    const manual = value(await engine.properties("filleted-manual", (await document("filleted-manual")).shapes[0]!.id));
    expect(bound.volume).toBeGreaterThan(original.volume + 5);
    expect(bound.volume).toBeLessThan(24);
    expect(bound.volume).toBeCloseTo(manual.volume, 6);
    expect(bound.centerOfMass.x).toBeCloseTo(manual.centerOfMass.x, 6);
    expect(bound.centerOfMass.y).toBeCloseTo(manual.centerOfMass.y, 6);
    expect(bound.centerOfMass.z).toBeCloseTo(manual.centerOfMass.z, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("applies a shape binding and a constraint binding on the same output in one change", async () => {
    const output = await sketchProject("both");
    await sketchProject("both-manual");
    value(await engine.addParameter("both", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("both", output.id, "width", "w"));
    value(await engine.bindShapeField("both", output.id, "height", "w + 1"));
    const before = await document("both");

    value(await engine.updateParameter("both", "w", { expression: "4" }));

    const after = await document("both");
    expect(after.history).toHaveLength(before.history.length + 1);
    const stored = after.shapes[0]!;
    expect(stored).toMatchObject({ height: 5, expressions: { height: "w + 1" } });
    expect(constraintOf(stored, "width")).toMatchObject({ valueMm: 4, expression: "w" });
    value(await engine.changeShape("both-manual", "sketch/both-manual", { sketchProfile: withoutExpressions(stored.sketchProfile!) }));
    value(await engine.changeShape("both-manual", (await document("both-manual")).shapes[0]!.id, { height: 5 }));
    const bound = value(await engine.properties("both", output.id));
    const manual = value(await engine.properties("both-manual", (await document("both-manual")).shapes[0]!.id));
    expect(bound.volume).toBeCloseTo(4 * 2 * 5, 3);
    expect(bound.volume).toBeCloseTo(manual.volume, 6);
    expect(bound.centerOfMass.x).toBeCloseTo(manual.centerOfMass.x, 6);
    expect(bound.centerOfMass.y).toBeCloseTo(manual.centerOfMass.y, 6);
    expect(bound.centerOfMass.z).toBeCloseTo(manual.centerOfMass.z, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("resolves constraint expressions on create, rebuilds a bound sweep, and refuses invalid ones", async () => {
    await project("sweep");
    await project("sweep-manual");
    value(await engine.addParameter("sweep", { name: "w", expression: "2", dimension: "length" }));
    // The stored value says 2, but the expression wins on create, as for shape expressions.
    const created = value(await engine.addShapes("sweep", [{ kind: "sketchSweep", name: "Bar", profile: sweepProfile("w * 2") }])).shapes[0]!;
    expect(constraintOf(created, "width")).toMatchObject({ valueMm: 4, expression: "w * 2" });
    expect(value(await engine.properties("sweep", created.id)).volume).toBeCloseTo(4 * 2 * 10, 2);
    const first = value(await engine.properties("sweep", created.id));

    value(await engine.updateParameter("sweep", "w", { expression: "3" }));

    const rebuilt = (await document("sweep")).shapes[0]!;
    expect(constraintOf(rebuilt, "width")).toMatchObject({ valueMm: 6, expression: "w * 2" });
    // The twin takes the same path by hand: a literal create, then the same two profile edits.
    const manual = value(await engine.addShapes("sweep-manual", [{ kind: "sketchSweep", name: "Bar", profile: sweepProfile() }])).shapes[0]!;
    for (const edit of [created.sketchProfile!, rebuilt.sketchProfile!]) {
      value(await engine.changeShape("sweep-manual", manual.sketchSourceId!, { sketchProfile: withoutExpressions(edit) }));
    }
    const bound = value(await engine.properties("sweep", created.id));
    const reference = value(await engine.properties("sweep-manual", manual.id));
    expect(bound.volume).toBeCloseTo(6 * 2 * 10, 2);
    expect(bound.volume).toBeCloseTo(reference.volume, 4);
    expect(bound.centerOfMass.x).toBeCloseTo(reference.centerOfMass.x, 4);
    expect(bound.centerOfMass.y).toBeCloseTo(reference.centerOfMass.y, 4);
    expect(bound.centerOfMass.z).toBeCloseTo(reference.centerOfMass.z, 4);
    expect(bound.volume / first.volume).toBeCloseTo(6 / 4, 4);

    const before = JSON.stringify(await document("sweep"));
    const horizontal = sweepProfile();
    horizontal.constraints = horizontal.constraints!.map((constraint) => (constraint.id === "h-ab" ? { ...constraint, expression: "w" } as SketchConstraint : constraint));
    expect(await engine.addShapes("sweep", [{ kind: "sketchSweep", profile: horizontal }]))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "constraintNotBindable", constraintId: "h-ab" } } });
    expect(await engine.addShapes("sweep", [{ kind: "sketchSweep", profile: sweepProfile("unknown") }]))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "invalidExpression", constraintId: "width" } } });
    expect(JSON.stringify(await document("sweep"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("re-solves a bound revolve profile and keeps the solid on its axis", async () => {
    await project("revolve");
    const created = value(await engine.addShapes("revolve", [{
      kind: "revolve", name: "Sleeve", profile: [[1, -5], [2, -5], [2, 5], [1, 5]], sides: 48, x: 12, z: -4, elevation: 7,
    }])).shapes[0]!;
    const profile = created.sketchProfile!;
    const at = (x: number, z: number) => profile.points.find((point) => Math.abs(point.x - x) < 1e-9 && Math.abs(point.z - z) < 1e-9)!.id;
    const between = (start: string, end: string) => profile.segments.find((segment) =>
      (segment.startId === start && segment.endId === end) || (segment.startId === end && segment.endId === start))!.id;
    // The stored sketch mirrors the outline across the axis, so radii read as negative x.
    const [p0, p1, p2, p3] = [at(-1, -5), at(-2, -5), at(-2, 5), at(-1, 5)];
    const constrained: SketchProfile = {
      ...profile,
      constraints: [
        { id: "fix-0", kind: "fixed", pointId: p0, xMm: -1, zMm: -5 },
        { id: "fix-3", kind: "fixed", pointId: p3, xMm: -1, zMm: 5 },
        { id: "h-bottom", kind: "horizontal", segmentId: between(p0, p1) },
        { id: "h-top", kind: "horizontal", segmentId: between(p2, p3) },
        { id: "v-outer", kind: "vertical", segmentId: between(p1, p2) },
        { id: "wall", kind: "distance", pointIds: [p0, p1], valueMm: 1 },
      ],
    };
    value(await engine.changeShape("revolve", created.sketchSourceId!, { sketchProfile: constrained }));
    value(await engine.addParameter("revolve", { name: "wall", expression: "1", dimension: "length" }));
    value(await engine.bindSketchConstraint("revolve", created.id, "wall", "wall"));
    const thin = value(await engine.properties("revolve", created.id));

    value(await engine.updateParameter("revolve", "wall", { expression: "2" }));

    const thick = value(await engine.properties("revolve", created.id));
    // Annulus area goes from 2^2 - 1^2 to 3^2 - 1^2 at the same height and facet count.
    expect(thick.volume / thin.volume).toBeCloseTo(8 / 3, 3);
    expect(thick.centerOfMass.x).toBeCloseTo(thin.centerOfMass.x, 4);
    expect(thick.centerOfMass.y).toBeCloseTo(thin.centerOfMass.y, 4);
    expect(thick.centerOfMass.z).toBeCloseTo(thin.centerOfMass.z, 4);
    expect(constraintOf((await document("revolve")).shapes[0]!, "wall")).toMatchObject({ valueMm: 2, expression: "wall" });
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses an unsolvable re-solve with a structured error and writes nothing", async () => {
    // The diagonal pins the rectangle, so changing one side cannot be solved.
    const diagonal: SketchConstraint = { id: "diagonal", kind: "distance", pointIds: ["a", "c"], valueMm: Math.hypot(2, 2) };
    const output = await sketchProject("pinned", rectangle([diagonal]));
    const box = value(await engine.addShapes("pinned", [{ kind: "box", width: 2, depth: 2, height: 2, x: 10 }])).shapes[0]!;
    value(await engine.addParameter("pinned", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("pinned", box.id, "width", "w"));
    value(await engine.bindSketchConstraint("pinned", output.id, "width", "w"));
    const before = JSON.stringify(await document("pinned"));

    const refused = await engine.updateParameter("pinned", "w", { expression: "4" });

    expect(refused).toMatchObject({
      ok: false,
      failure: { reason: "sketch_unsolvable", shapeId: output.id, constraintIds: expect.arrayContaining(["diagonal"]) },
    });
    expect(JSON.stringify(await document("pinned"))).toBe(before);

    const refusedBind = await engine.bindSketchConstraint("pinned", output.id, "depth", "w * 3");
    expect(refusedBind).toMatchObject({ ok: false, failure: { reason: "sketch_unsolvable", shapeId: output.id } });
    expect(JSON.stringify(await document("pinned"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("binds to a new value by solving and rebuilding in one write", async () => {
    const output = await sketchProject("direct");
    const before = await document("direct");

    const bound = value(await engine.bindSketchConstraint("direct", "sketch/direct", "width", "4"));

    expect(constraintOf(bound.shape, "width")).toMatchObject({ valueMm: 4, expression: "4" });
    expect((await document("direct")).history).toHaveLength(before.history.length + 1);
    const properties = value(await engine.properties("direct", output.id));
    expect(properties.volume).toBeCloseTo(24, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses to bind a profile with no rebuild recipe, and leaves such a stale binding out of a parameter change", async () => {
    await project("plain");
    value(await engine.addShapes("plain", [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    const current = await document("plain");
    const plain = { ...current.shapes[0]!, sketchProfile: rectangle() };
    await store.write("plain", current, [plain]);
    value(await engine.addParameter("plain", { name: "w", expression: "2", dimension: "length" }));

    expect(await engine.bindSketchConstraint("plain", plain.id, "width", "w"))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "sketchNotRebuildable", shapeId: plain.id } } });

    // As loaded from a file: the binding is kept, reported, and does not block the parameter.
    const stored = await document("plain");
    const tagged = stored.shapes.map((shape) => ({
      ...shape,
      sketchProfile: {
        ...shape.sketchProfile!,
        constraints: shape.sketchProfile!.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, expression: "w" } : constraint)),
      },
    }));
    await store.write("plain", stored, tagged);
    value(await engine.updateParameter("plain", "w", { expression: "4" }));
    expect(constraintOf((await document("plain")).shapes[0]!, "width")).toMatchObject({ valueMm: 2, expression: "w" });
  }, CAD_TEST_TIMEOUT_MS);

  it("does not let a constraint the editor already left unsatisfied block a re-solve", async () => {
    // The editor commits a profile with unsatisfied constraints and shows a notice; these two can never agree.
    const base = rectangle([
      { id: "fix-e1", kind: "fixed", pointId: "e", xMm: 5, zMm: 5 },
      { id: "fix-e2", kind: "fixed", pointId: "e", xMm: 6, zMm: 6 },
    ]);
    const output = await sketchProject("unsatisfied", { ...base, points: [...base.points, { id: "e", x: 5, z: 5 }] });
    value(await engine.addParameter("unsatisfied", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("unsatisfied", output.id, "width", "w"));

    value(await engine.updateParameter("unsatisfied", "w", { expression: "4" }));

    const stored = (await document("unsatisfied")).shapes[0]!;
    expect(constraintOf(stored, "width")).toMatchObject({ valueMm: 4, expression: "w" });
    expect(stored.sketchProfile!.points.find((point) => point.id === "b")!.x).toBeCloseTo(3, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a parameter change that would rebuild a locked sketch output, and writes nothing", async () => {
    const output = await sketchProject("locked");
    const box = value(await engine.addShapes("locked", [{ kind: "box", width: 2, depth: 2, height: 2, x: 10 }])).shapes[0]!;
    value(await engine.addParameter("locked", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("locked", box.id, "width", "w"));
    value(await engine.bindSketchConstraint("locked", output.id, "width", "w"));
    value(await engine.changeShape("locked", output.id, { locked: true }));
    const before = JSON.stringify(await document("locked"));

    const refused = await engine.updateParameter("locked", "w", { expression: "4" });

    expect(refused).toMatchObject({
      ok: false,
      failure: { reason: "binding_failed", shapeId: output.id, constraintIds: ["width"], failure: { reason: "shape_locked" } },
    });
    expect(JSON.stringify(await document("locked"))).toBe(before);
    expect(await engine.bindSketchConstraint("locked", output.id, "depth", "w"))
      .toMatchObject({ ok: false, failure: { reason: "shape_locked", ids: [output.id] } });
  }, CAD_TEST_TIMEOUT_MS);

  it("reports bind errors, removes a binding on null, and drops one a literal profile edit replaces", async () => {
    const output = await sketchProject("edits");
    value(await engine.addParameter("edits", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.addParameter("edits", { name: "tilt", expression: "10 deg", dimension: "angle" }));

    expect(await engine.bindSketchConstraint("edits", output.id, "missing", "w"))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "constraintNotFound", constraintId: "missing" } } });
    expect(await engine.bindSketchConstraint("edits", output.id, "h-ab", "w"))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "constraintNotBindable" } } });
    expect(await engine.bindSketchConstraint("edits", output.id, "width", "tilt"))
      .toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "invalidExpression" } } });
    expect(await engine.bindSketchConstraint("edits", "nowhere", "width", "w"))
      .toMatchObject({ ok: false, failure: { reason: "shapes_not_found" } });

    value(await engine.bindSketchConstraint("edits", output.id, "width", "w"));
    value(await engine.bindSketchConstraint("edits", output.id, "depth", "w"));
    const echoed = (await document("edits")).shapes[0]!.sketchProfile!;
    value(await engine.changeShape("edits", "sketch/edits", { sketchProfile: echoed }));
    expect(constraintOf((await document("edits")).shapes[0]!, "width")).toMatchObject({ expression: "w" });

    const literal: SketchProfile = {
      ...echoed,
      points: echoed.points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: 2 } : point)),
      constraints: echoed.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, valueMm: 3 } : constraint)),
    };
    value(await engine.changeShape("edits", "sketch/edits", { sketchProfile: literal }));
    let stored = (await document("edits")).shapes[0]!;
    expect(constraintOf(stored, "width")).toEqual({ id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 3 });
    expect(constraintOf(stored, "depth")).toMatchObject({ valueMm: 2, expression: "w" });

    const unbound = value(await engine.bindSketchConstraint("edits", output.id, "depth", null));
    expect(constraintOf(unbound.shape, "depth")).toEqual({ id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 });
    stored = (await document("edits")).shapes[0]!;
    expect(constraintOf(stored, "depth")).not.toHaveProperty("expression");
  }, CAD_TEST_TIMEOUT_MS);

  it("renames constraint bindings, refuses to delete their parameter, and keeps a stale one until it resolves", async () => {
    const output = await sketchProject("names");
    value(await engine.addParameter("names", { name: "w", expression: "2", dimension: "length" }));
    value(await engine.bindSketchConstraint("names", output.id, "width", "w"));

    value(await engine.renameParameter("names", "w", "side"));
    expect(constraintOf((await document("names")).shapes[0]!, "width")).toMatchObject({ expression: "side" });
    expect(await engine.deleteParameter("names", "side")).toMatchObject({
      ok: false,
      failure: { reason: "parameter_invalid", error: { code: "parameterInUse", sketchConstraintDependents: [{ shapeId: output.id, constraintIds: ["width"] }] } },
    });

    // A binding saved against a name the table lacks loads stale and blocks nothing.
    const current = await document("names");
    const stale = current.shapes.map((shape) => ({
      ...shape,
      sketchProfile: {
        ...shape.sketchProfile!,
        constraints: shape.sketchProfile!.constraints!.map((constraint) => (constraint.id === "depth" ? { ...constraint, expression: "later" } : constraint)),
      },
    }));
    await store.write("names", current, stale);
    value(await engine.updateParameter("names", "side", { expression: "2.5" }));
    let stored = (await document("names")).shapes[0]!;
    expect(constraintOf(stored, "width")).toMatchObject({ valueMm: 2.5 });
    expect(constraintOf(stored, "depth")).toMatchObject({ valueMm: 2, expression: "later" });

    value(await engine.addParameter("names", { name: "later", expression: "3", dimension: "length" }));
    stored = (await document("names")).shapes[0]!;
    expect(constraintOf(stored, "depth")).toMatchObject({ valueMm: 3, expression: "later" });
    expect(value(await engine.properties("names", output.id)).volume).toBeCloseTo(2.5 * 3 * 3, 3);
  }, CAD_TEST_TIMEOUT_MS);
});
