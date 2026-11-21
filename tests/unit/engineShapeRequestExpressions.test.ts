import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

/**
 * Shape requests that carry `expressions` (#613).
 *
 * A REST client reads a shape and sends it back. The summary reports each
 * bound field as its resolved number, so echoing it must not read as a literal
 * edit that drops the binding.
 */

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("shape requests with expressions", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function project(projectId: string) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    value(await engine.addParameter(projectId, { name: "wall", expression: "5", dimension: "length" }));
  }

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-request-expressions-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates a shape with bound fields in one write and builds the resolved geometry", async () => {
    await project("create");
    const before = await document("create");

    const [shape] = value(await engine.addShapes("create", [
      { kind: "box", depth: 10, height: 10, expressions: { width: "wall * 4", x: "wall + 1mm" } },
    ])).shapes;

    expect(shape).toMatchObject({ width: 20, x: 6, expressions: { width: "wall * 4", x: "wall + 1mm" } });
    const after = await document("create");
    expect(after.history).toHaveLength(before.history.length + 1);
    const properties = value(await engine.properties("create", shape!.id));
    expect(properties.volume).toBeCloseTo(20 * 10 * 10, 3);
    expect(properties.centerOfMass.x).toBeCloseTo(6, 6);

    value(await engine.updateParameter("create", "wall", { expression: "2" }));
    const moved = value(await engine.properties("create", shape!.id));
    expect(moved.volume).toBeCloseTo(8 * 10 * 10, 3);
    expect(moved.centerOfMass.x).toBeCloseTo(3, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a bad binding on create, names its batch index, and writes nothing", async () => {
    await project("create-invalid");
    const before = await document("create-invalid");

    const refused = await engine.addShapes("create-invalid", [
      { kind: "box" },
      { kind: "box", expressions: { width: "wall *" } },
    ]);
    expect(refused).toMatchObject({ ok: false, failure: { reason: "binding_invalid", index: 1, error: { code: "invalidExpression", field: "width" } } });

    const conflicting = await engine.addShapes("create-invalid", [{ kind: "box", width: 7, expressions: { width: "wall * 4" } }]);
    expect(conflicting).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", index: 0 } });

    const unbindable = await engine.addShapes("create-invalid", [{ kind: "box", expressions: { sides: "6" } }]);
    expect(unbindable).toMatchObject({ ok: false, failure: { reason: "binding_invalid", index: 0, error: { code: "fieldNotBindable" } } });

    const malformed = await engine.addShapes("create-invalid", [{ kind: "box", expressions: { width: 4 } }]);
    expect(malformed).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", index: 0 } });

    const after = await document("create-invalid");
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.shapes).toEqual(before.shapes);
  });

  it("keeps a binding when a change echoes its current value, and drops it when the value differs", async () => {
    await project("echo");
    const [shape] = value(await engine.addShapes("echo", [
      { kind: "box", depth: 10, expressions: { width: "wall * 2", height: "wall * 3" } },
    ])).shapes;

    const echoed = value(await engine.changeShape("echo", shape!.id, { name: "Renamed", width: 10, height: 15, depth: 10 }));
    expect(echoed.shape).toMatchObject({ name: "Renamed", width: 10, height: 15, expressions: { width: "wall * 2", height: "wall * 3" } });

    const edited = value(await engine.changeShape("echo", shape!.id, { width: 12, height: 15 }));
    expect(edited.shape.expressions).toEqual({ height: "wall * 3" });

    value(await engine.updateParameter("echo", "wall", { expression: "4" }));
    expect((await document("echo")).shapes[0]).toMatchObject({ width: 12, height: 12 });
  });

  it("binds, rebinds and clears fields through expressions on a change", async () => {
    await project("change");
    const [shape] = value(await engine.addShapes("change", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;

    const bound = value(await engine.changeShape("change", shape!.id, { name: "Bound", expressions: { width: "wall * 3", depth: "wall" } }));
    expect(bound.shape).toMatchObject({ name: "Bound", width: 15, depth: 5, expressions: { width: "wall * 3", depth: "wall" } });

    // A number agreeing with its expression is the summary sent back whole.
    const agreed = value(await engine.changeShape("change", shape!.id, { width: 15, expressions: { width: "wall * 3" } }));
    expect(agreed.shape.expressions).toEqual({ width: "wall * 3", depth: "wall" });

    const cleared = value(await engine.changeShape("change", shape!.id, { width: 9, expressions: { depth: null, width: null } }));
    expect(cleared.shape.width).toBe(9);
    expect(cleared.shape.depth).toBe(5);
    expect(cleared.shape.expressions).toBeUndefined();
  });

  it("writes nothing when every expression repeats the stored one", async () => {
    await project("repeat");
    const [shape] = value(await engine.addShapes("repeat", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;
    const bound = value(await engine.changeShape("repeat", shape!.id, { expressions: { width: "wall * 3" } }));
    const stored = await document("repeat");

    const again = value(await engine.changeShape("repeat", shape!.id, { expressions: { width: "wall * 3" } }));
    expect(again.revision).toBe(bound.revision);
    expect(again.shape).toMatchObject({ id: shape!.id, width: 15, expressions: { width: "wall * 3" } });
    expect(await document("repeat")).toEqual(stored);
    expect(await engine.changeShape("repeat", "missing", { expressions: { width: "wall" } })).toMatchObject({ ok: false, failure: { reason: "shapes_not_found" } });
  });

  it("refuses a change whose number and expression disagree, and writes nothing", async () => {
    await project("conflict");
    const [shape] = value(await engine.addShapes("conflict", [{ kind: "box", depth: 10, height: 10, expressions: { width: "wall * 2" } }])).shapes;
    const before = await document("conflict");

    // Both sides changed and they disagree.
    const conflicting = await engine.changeShape("conflict", shape!.id, { width: 30, expressions: { width: "wall * 3" } });
    expect(conflicting).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", shapeId: shape!.id, field: "width" } });
    const createConflict = await engine.addShapes("conflict", [{ kind: "box" }, { kind: "box", width: 7, expressions: { width: "wall * 4" } }]);
    expect(createConflict).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request", index: 1, field: "width" } });
    expect((createConflict as { failure: Record<string, unknown> }).failure.shapeId).toBeUndefined();
    const invalid = await engine.changeShape("conflict", shape!.id, { name: "Not applied", expressions: { height: "wall /" } });
    expect(invalid).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "invalidExpression", field: "height" } } });
    const malformed = await engine.changeShape("conflict", shape!.id, { expressions: ["width"] });
    expect(malformed).toMatchObject({ ok: false, failure: { reason: "invalid_shape_request" } });

    const after = await document("conflict");
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.shapes).toEqual(before.shapes);
  });

  it("lets the side a read-modify-write changed win over the side it echoed", async () => {
    await project("rmw");
    const [shape] = value(await engine.addShapes("rmw", [{ kind: "box", depth: 10, height: 10, expressions: { width: "wall * 2" } }])).shapes;
    const summary = { width: 10, depth: 10, height: 10, expressions: { width: "wall * 2" } };

    // Changed number, echoed expression: the number wins and the binding goes.
    const edited = value(await engine.changeShape("rmw", shape!.id, { ...summary, width: 12 }));
    expect(edited.shape.width).toBe(12);
    expect(edited.shape.expressions).toBeUndefined();

    value(await engine.changeShape("rmw", shape!.id, { expressions: { width: "wall * 2" } }));
    // Changed expression, echoed number: the expression wins.
    const rebound = value(await engine.changeShape("rmw", shape!.id, { ...summary, expressions: { width: "wall * 3" } }));
    expect(rebound.shape).toMatchObject({ width: 15, expressions: { width: "wall * 3" } });

    // Both changed and agreeing is a rebind.
    const agreed = value(await engine.changeShape("rmw", shape!.id, { width: 20, expressions: { width: "wall * 4" } }));
    expect(agreed.shape).toMatchObject({ width: 20, expressions: { width: "wall * 4" } });
  });

  it("does not re-resolve an echoed binding that no longer resolves", async () => {
    await project("stale");
    const [shape] = value(await engine.addShapes("stale", [{ kind: "box", width: 4, depth: 10, height: 10 }])).shapes;
    const current = await document("stale");
    await store.write("stale", current, [{ ...current.shapes[0]!, expressions: { width: "gone * 2" } }]);

    const echoed = value(await engine.changeShape("stale", shape!.id, { name: "Echo", width: 4, expressions: { width: "gone * 2" } }));

    expect(echoed.shape).toMatchObject({ name: "Echo", width: 4, expressions: { width: "gone * 2" } });
  });

  it("keeps a revolve binding when the summary's nested revolve settings are echoed", async () => {
    await project("revolve");
    value(await engine.addParameter("revolve", { name: "sweep", expression: "180deg", dimension: "angle" }));
    const [shape] = value(await engine.addShapes("revolve", [
      { kind: "revolve", profile: [[5, 0], [10, 0], [10, 8], [5, 8]], sides: 24, expressions: { "revolve.sweepAngle": "sweep" } },
    ])).shapes;
    expect(shape!.sketchRevolve?.sweepAngle).toBe(180);
    const halfVolume = value(await engine.properties("revolve", shape!.id)).volume;

    const echoed = value(await engine.changeShape("revolve", shape!.id, { name: "Echo", revolve: { ...shape!.sketchRevolve } }));
    expect(echoed.shape.expressions).toEqual({ "revolve.sweepAngle": "sweep" });

    value(await engine.updateParameter("revolve", "sweep", { expression: "360deg" }));
    const full = (await document("revolve")).shapes[0]!;
    expect(full.sketchRevolve?.sweepAngle).toBe(360);
    expect(value(await engine.properties("revolve", shape!.id)).volume).toBeCloseTo(halfVolume * 2, 0);
  }, CAD_TEST_TIMEOUT_MS);
});
