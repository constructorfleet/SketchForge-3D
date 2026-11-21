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

/** A 2 x 2 rectangle with corner `a` fixed and both side lengths dimensioned. */
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

/** Sets `patch` on the constraint `id`. */
function withConstraint(profile: SketchProfile, id: string, patch: Record<string, unknown>): SketchProfile {
  return {
    ...profile,
    constraints: profile.constraints!.map((constraint) => (constraint.id === id ? { ...constraint, ...patch } as SketchConstraint : constraint)),
  };
}

const constraintOf = (shape: WorkplaneShape, id: string) => shape.sketchProfile!.constraints!.find((constraint) => constraint.id === id)!;

describe("constraint expressions sent in a profile change", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  /** A 2 x 2 x 3 sketch extrusion of `rectangle()`, with `w = 3` in the table. */
  async function sketchProject(projectId: string): Promise<WorkplaneShape> {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    value(await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    const current = await document(projectId);
    await store.write(projectId, current, [{
      ...current.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: rectangle(),
      sketchSourceId: `sketch/${projectId}`,
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }]);
    value(await engine.addParameter(projectId, { name: "w", expression: "3", dimension: "length" }));
    return (await document(projectId)).shapes[0]!;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-profile-bindings-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("binds a new expression sent with the echoed value, solves the sketch with it, and keeps it bound", async () => {
    const output = await sketchProject("bind");
    const original = value(await engine.properties("bind", output.id));
    const before = (await document("bind")).history.length;

    const changed = value(await engine.changeShape("bind", "sketch/bind", {
      sketchProfile: withConstraint(output.sketchProfile!, "width", { expression: "w" }),
    }));

    expect(constraintOf(changed.shape, "width")).toMatchObject({ valueMm: 3, expression: "w" });
    expect((await document("bind")).history).toHaveLength(before + 1);
    const bound = value(await engine.properties("bind", output.id));
    // 3 x 2 x 3 with corner `a` held: the centre moves +0.5 in x only.
    expect(bound.volume).toBeCloseTo(18, 3);
    expect(bound.centerOfMass.x - original.centerOfMass.x).toBeCloseTo(0.5, 4);
    expect(bound.centerOfMass.y).toBeCloseTo(original.centerOfMass.y, 4);
    expect(bound.centerOfMass.z).toBeCloseTo(original.centerOfMass.z, 4);

    value(await engine.updateParameter("bind", "w", { expression: "4" }));
    const recomputed = value(await engine.properties("bind", output.id));
    expect(constraintOf((await document("bind")).shapes[0]!, "width")).toMatchObject({ valueMm: 4, expression: "w" });
    expect(recomputed.volume).toBeCloseTo(24, 3);
    expect(recomputed.centerOfMass.x - original.centerOfMass.x).toBeCloseTo(1, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a changed value and a changed expression that disagree, writing nothing", async () => {
    const output = await sketchProject("contradiction");
    const before = JSON.stringify(await document("contradiction"));

    expect(await engine.changeShape("contradiction", output.id, {
      sketchProfile: withConstraint(output.sketchProfile!, "width", { valueMm: 5, expression: "w" }),
    })).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", shapeId: output.id, constraintId: "width" } });
    expect(await engine.changeShape("contradiction", output.id, {
      sketchProfile: withConstraint(output.sketchProfile!, "width", { expression: "unknown" }),
    })).toMatchObject({ ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "invalidExpression", constraintId: "width" } } });
    expect(JSON.stringify(await document("contradiction"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a literal size and a new constraint binding in one request, writing nothing", async () => {
    const output = await sketchProject("resize-and-bind");
    const before = JSON.stringify(await document("resize-and-bind"));

    expect(await engine.changeShape("resize-and-bind", output.id, {
      width: 6,
      sketchProfile: withConstraint(output.sketchProfile!, "width", { expression: "w" }),
    })).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", shapeId: output.id, field: "width", constraintId: "width" } });
    expect(JSON.stringify(await document("resize-and-bind"))).toBe(before);

    // The reviewed case: refused before the literal-resize rule could unbind it and answer ok.
    expect(await engine.changeShape("resize-and-bind", output.id, {
      width: 10,
      sketchProfile: withConstraint(output.sketchProfile!, "width", { expression: "w * 2" }),
    })).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", shapeId: output.id, field: "width", constraintId: "width" } });
    // So is a rebind of an already bound constraint.
    value(await engine.bindSketchConstraint("resize-and-bind", output.id, "depth", "w"));
    const rebound = JSON.stringify(await document("resize-and-bind"));
    const stored = (await document("resize-and-bind")).shapes[0]!;
    expect(await engine.changeShape("resize-and-bind", output.id, {
      width: 10,
      sketchProfile: withConstraint(stored.sketchProfile!, "depth", { expression: "w * 2" }),
    })).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", field: "width", constraintId: "depth" } });
    expect(JSON.stringify(await document("resize-and-bind"))).toBe(rebound);

    // The same size sent back is an echo, so the binding goes ahead.
    const echoed = value(await engine.changeShape("resize-and-bind", output.id, {
      width: output.width,
      sketchProfile: withConstraint(output.sketchProfile!, "width", { expression: "w" }),
    }));
    expect(constraintOf(echoed.shape, "width")).toMatchObject({ valueMm: 3, expression: "w" });
  }, CAD_TEST_TIMEOUT_MS);

  it("accepts an unchanged sketchConstraints echo and refuses an edited one", async () => {
    const output = await sketchProject("readonly");
    value(await engine.bindSketchConstraint("readonly", output.id, "width", "w"));
    const echo = [
      { id: "width", kind: "distance", value: 3, expression: "w" },
      { id: "depth", kind: "distance", value: 2 },
    ];
    value(await engine.changeShape("readonly", output.id, { name: "Echo", sketchConstraints: echo }));
    const before = JSON.stringify(await document("readonly"));

    for (const edited of [
      [{ ...echo[0], value: 5 }, echo[1]],
      [{ ...echo[0], expression: "w * 2" }, echo[1]],
      [echo[0]],
      "w",
    ]) {
      expect(await engine.changeShape("readonly", output.id, { sketchConstraints: edited })).toMatchObject({
        ok: false, failure: { reason: "invalid_shape_request", shapeId: output.id, field: "sketchConstraints" },
      });
    }
    expect(JSON.stringify(await document("readonly"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a profile binding on a locked output before planning or solving it", async () => {
    const output = await sketchProject("locked");
    value(await engine.changeShape("locked", output.id, { locked: true }));
    const before = JSON.stringify(await document("locked"));

    for (const expression of ["w", "unknown"]) {
      expect(await engine.changeShape("locked", output.id, {
        sketchProfile: withConstraint(output.sketchProfile!, "width", { expression }),
      })).toMatchObject({ ok: false, failure: { reason: "shape_locked", ids: [output.id] } });
    }
    expect(JSON.stringify(await document("locked"))).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a constraint binding beside a bound width unless the same request clears the width", async () => {
    const output = await sketchProject("conflict");
    value(await engine.bindShapeField("conflict", output.id, "width", "w"));
    const stored = (await document("conflict")).shapes[0]!;
    const profile = withConstraint(stored.sketchProfile!, "depth", { expression: "w" });
    const before = JSON.stringify(await document("conflict"));

    expect(await engine.changeShape("conflict", output.id, { sketchProfile: profile })).toMatchObject({
      ok: false,
      failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", constraintId: "depth", fields: ["width"] } },
    });
    expect(JSON.stringify(await document("conflict"))).toBe(before);

    const changed = value(await engine.changeShape("conflict", output.id, { sketchProfile: profile, expressions: { width: null } }));
    expect(changed.shape.expressions ?? {}).not.toHaveProperty("width");
    expect(constraintOf(changed.shape, "depth")).toMatchObject({ valueMm: 3, expression: "w" });
  }, CAD_TEST_TIMEOUT_MS);
});
