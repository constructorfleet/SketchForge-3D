import { describe, expect, it } from "vitest";
import { resolveProjectParameters, type ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";
import {
  applyBindingsLocally,
  hostProjectSync,
  mergeRecomputedShapes,
  parameterRecomputeResponseMessage,
  recomputeScope,
} from "@/lib/projectParameterEdits";
import type { WorkplaneShape } from "@/types/sketchforge";

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

function box(id: string, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const shape = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 });
  if (!shape) throw new Error("no box");
  return { ...shape, id, name: id, ...overrides };
}

const before = table([{ name: "w", expression: "10", dimension: "length" }, { name: "h", expression: "w", dimension: "length" }, { name: "free", expression: "1", dimension: "length" }]);
const after = table([{ name: "w", expression: "20", dimension: "length" }, { name: "h", expression: "w", dimension: "length" }, { name: "free", expression: "1", dimension: "length" }]);

describe("recomputeScope", () => {
  it("posts only top-level trees whose bindings read a changed value, plus trees sharing their sketch source", () => {
    const mesh = box("mesh", { importedMesh: { positions: new Array(9_000).fill(0) } as never });
    const direct = box("direct", { expressions: { width: "w" } });
    const nested = box("group", { groupedShapes: [box("child", { sketchSourceId: "sketch-1", expressions: { "revolve.sweepAngle": "h" } as never })] });
    const sibling = box("sibling", { sketchSourceId: "sketch-1" });
    const unrelated = box("unrelated", { expressions: { width: "free" } });
    const scope = recomputeScope([mesh, direct, nested, sibling, unrelated], before, after);
    expect(scope.map((shape) => shape.id)).toEqual(["direct", "group", "sibling"]);
  });
});

describe("mergeRecomputedShapes", () => {
  it("replaces the posted trees by id and keeps the rest by reference", () => {
    const keep = box("keep");
    const posted = box("posted", { expressions: { width: "w" } });
    const merged = mergeRecomputedShapes([keep, posted], [posted], [{ ...posted, width: 20 }]);
    expect(merged?.[0]).toBe(keep);
    expect(merged?.[1]?.width).toBe(20);
  });

  it("refuses a response that adds or loses a tree", () => {
    const posted = box("posted");
    expect(mergeRecomputedShapes([posted], [posted], [])).toBeNull();
    expect(mergeRecomputedShapes([posted], [posted], [posted, box("extra")])).toBeNull();
  });
});

describe("parameterRecomputeResponseMessage", () => {
  it("tells a too-large, rejected, or failing request apart from an unreachable server", () => {
    const shapes = [box("a")];
    expect(parameterRecomputeResponseMessage(413, null, shapes).key).toBe("editor.parameters.error.requestTooLarge");
    expect(parameterRecomputeResponseMessage(400, { error: "x" }, shapes).key).toBe("editor.parameters.error.requestRejected");
    expect(parameterRecomputeResponseMessage(500, null, shapes).key).toBe("editor.parameters.error.serverError");
    expect(parameterRecomputeResponseMessage(200, null, shapes).key).toBe("editor.parameters.error.serverError");
    expect(parameterRecomputeResponseMessage(422, { error: "kernel" }, shapes).key).toBe("editor.parameters.error.recomputeFailedGeneric");
    expect(parameterRecomputeResponseMessage(422, { failure: { reason: "binding_failed", shapeId: "a", fields: ["width"], failure: { reason: "shape_locked" } } }, shapes))
      .toEqual({ key: "editor.parameters.error.shapeLocked", values: { shape: "a" } });
  });
});

describe("applyBindingsLocally", () => {
  it("applies plain primitive fields without the kernel", () => {
    const result = applyBindingsLocally([box("a", { x: 5, expressions: { width: "w", x: "h / 2" } }), box("b")], before, after);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.shapes[0]).toMatchObject({ width: 20, x: 10, expressions: { width: "w", x: "h / 2" } });
    expect(result.shapes[1]!.width).toBe(10);
  });

  it("refuses as the engine does: out of range, or a locked shape", () => {
    const negative = table([{ name: "w", expression: "-1", dimension: "length" }, { name: "h", expression: "w", dimension: "length" }, { name: "free", expression: "1", dimension: "length" }]);
    expect(applyBindingsLocally([box("a", { expressions: { width: "w" } })], before, negative))
      .toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "outOfRange", field: "width" } } });
    expect(applyBindingsLocally([box("a", { locked: true, expressions: { width: "w" } })], before, after))
      .toMatchObject({ ok: false, failure: { reason: "binding_failed", shapeId: "a", failure: { reason: "shape_locked" } } });
  });

  it("returns null when any dependent needs kernel work", () => {
    expect(applyBindingsLocally([box("a", { expressions: { width: "w" }, edgeTreatments: [{} as never] })], before, after)).toBeNull();
    expect(applyBindingsLocally([box("a", { sketchSourceId: "s", expressions: { width: "w" } })], before, after)).toBeNull();
    expect(applyBindingsLocally([box("g", { groupedShapes: [box("c", { sketchSourceId: "s", expressions: { "revolve.sweepAngle": "h" } as never })] })], before, after)).toBeNull();
  });
});

describe("hostProjectSync", () => {
  const base = { projectChanged: false, hostTableKey: "t1", knownTableKey: "t1", incomingShapesKey: "s1", echoShapesKey: "s1", currentShapesKey: "s1" };

  it("ignores the echo of the editor's own save", () => {
    expect(hostProjectSync(base)).toEqual({ adoptTable: false, action: "echo" });
  });

  it("adopts a remote table change and rehydrates history even when the shapes are unchanged", () => {
    expect(hostProjectSync({ ...base, hostTableKey: "t2" })).toEqual({ adoptTable: true, action: "hydrate" });
    expect(hostProjectSync({ ...base, hostTableKey: "t2", echoShapesKey: null })).toEqual({ adoptTable: true, action: "hydrate" });
  });

  it("skips unchanged shapes and hydrates changed ones or a new project", () => {
    expect(hostProjectSync({ ...base, echoShapesKey: null })).toEqual({ adoptTable: false, action: "unchanged" });
    expect(hostProjectSync({ ...base, echoShapesKey: null, incomingShapesKey: "s2" })).toEqual({ adoptTable: false, action: "hydrate" });
    expect(hostProjectSync({ ...base, projectChanged: true })).toEqual({ adoptTable: true, action: "hydrate" });
  });
});
