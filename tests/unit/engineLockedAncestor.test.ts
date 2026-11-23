import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { shapeChangeApiError } from "@constructorfleet/sketchforge-engine/apiErrors";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import type { SketchProfile } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

/** A closed rectangle, `width` x 2, centred on the origin. */
function rectangle(width: number): SketchProfile {
  const half = width / 2;
  return {
    points: [
      { id: "a", x: -half, z: -1 }, { id: "b", x: half, z: -1 },
      { id: "c", x: half, z: 1 }, { id: "d", x: -half, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
}

describe("a locked group refuses edits to the sketch outputs it holds", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-locked-ancestor-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A sketch extrusion `sketch/x` cut by a hole box; returns the cut's id, locked when asked. */
  async function lockedCut(projectId: string, lock = true) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    const created = value(await engine.addShapes(projectId, [
      { kind: "box", width: 2, depth: 2, height: 3 },
      { kind: "box", width: 0.5, depth: 0.5, height: 1, elevation: 1, hole: true },
    ])).shapes;
    const current = (await store.read(projectId))!;
    await store.write(projectId, current, [{
      ...current.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: rectangle(2),
      sketchSourceId: "sketch/x",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }, current.shapes[1]!]);
    const cut = value(await engine.cut(projectId, { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
    if (lock) value(await engine.changeShape(projectId, cut.id, { locked: true }));
    return cut.id;
  }

  async function stored(projectId: string) {
    return JSON.stringify(await store.read(projectId));
  }

  it.each([
    ["a new sketch profile", { sketchProfile: rectangle(4) }],
    ["a new sketch profile with locked: false", { sketchProfile: rectangle(4), locked: false }],
    ["a prism draft", { draftPrismAngle: 5 }],
    ["a prism draft with locked: false", { draftPrismAngle: 5, locked: false }],
    ["a cleared face draft", { faceDraft: null }],
  ])("refuses %s sent to the output's source id, names the group, and writes nothing", async (_name, changes) => {
    const groupId = await lockedCut("locked");
    const before = await stored("locked");

    const changed = await engine.changeShape("locked", "sketch/x", changes);

    expect(changed).toEqual({ ok: false, failure: { reason: "shape_locked", ids: [groupId] } });
    expect(await stored("locked")).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("applies the same edit once the group is unlocked", async () => {
    const groupId = await lockedCut("unlocked");
    value(await engine.changeShape("unlocked", groupId, { locked: false }));

    const changed = await engine.changeShape("unlocked", "sketch/x", { draftPrismAngle: 5 });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("maps the refusal to a REST reply that names the group to unlock", async () => {
    const groupId = await lockedCut("rest");
    const changed = await engine.changeShape("rest", "sketch/x", { draftPrismAngle: 5 });
    if (changed.ok) throw new Error("expected a refusal");

    const reply = shapeChangeApiError(changed.failure, "sketch/x");

    expect(reply).toMatchObject({ status: 409, code: "shape_locked", detail: { shapeId: groupId } });
    expect(reply.message).toContain(groupId);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps the own-lock wording for a top-level shape", async () => {
    const groupId = await lockedCut("own");
    const changed = await engine.changeShape("own", groupId, { x: 4 });
    if (changed.ok) throw new Error("expected a refusal");

    expect(shapeChangeApiError(changed.failure, groupId)).toMatchObject({
      status: 409,
      code: "shape_locked",
      message: "That shape is locked. Send locked: false to change it.",
      detail: { shapeId: groupId },
    });
  }, CAD_TEST_TIMEOUT_MS);

  it("reaches only top-level shapes by id, so a locked group's child cannot be edited through any other operation", async () => {
    const groupId = await lockedCut("by-id");
    const childId = (await store.read("by-id"))!.shapes.find((shape) => shape.id === groupId)!.groupedShapes![0]!.id;
    const before = await stored("by-id");
    const missing = { ok: false, failure: { reason: "shapes_not_found", ids: [childId] } };

    expect(await engine.changeShape("by-id", childId, { x: 4 })).toMatchObject(missing);
    expect(await engine.treat("by-id", childId, { kind: "fillet", amount: 0.1 })).toMatchObject(missing);
    expect(await engine.draftPrism("by-id", childId, 5)).toMatchObject(missing);
    expect(await engine.shell("by-id", childId, { thickness: 0.2 })).toMatchObject(missing);
    expect(await engine.removeShape("by-id", childId)).toMatchObject(missing);
    expect(await engine.ungroup("by-id", childId)).toMatchObject(missing);
    expect(await engine.separate("by-id", childId)).toMatchObject(missing);
    expect(await engine.mirrorBaked("by-id", [childId], "x")).toMatchObject(missing);
    expect(await engine.align("by-id", { ids: [groupId, childId], axis: "x", target: "min" })).toMatchObject(missing);
    expect(await engine.distribute("by-id", { ids: [groupId, childId, "other"], axis: "x" })).toMatchObject({ ok: false, failure: { reason: "shapes_not_found" } });
    expect(await engine.pattern("by-id", { ids: [childId], kind: "linear", count: 2, stepX: 5 })).toMatchObject(missing);
    expect(await engine.explode("by-id", childId)).toMatchObject(missing);
    expect(await engine.bindShapeField("by-id", childId, "x", "1")).toEqual({ ok: false, failure: { reason: "shape_locked", ids: [groupId] } });
    expect(await stored("by-id")).toBe(before);
  }, CAD_TEST_TIMEOUT_MS);
});
