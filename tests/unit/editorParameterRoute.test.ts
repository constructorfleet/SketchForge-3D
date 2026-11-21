import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createEngine, exportProjectScene, shapeFromRequest, type ProjectDocument, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { activateConfiguration, addConfiguration, resolveProjectParameters } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { ProjectConfiguration, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { POST } from "@/app/api/editor/parameters/route";
import { editorParameterRequest } from "@/lib/editorCadRequests";
import type { ParameterEdit } from "@/lib/projectParameterEdits";
import type { EditorFieldBind } from "@/lib/expressionFields";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { measureMesh } from "./support/meshMeasure";

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

function boundBox(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const box = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 });
  if (!box) throw new Error("no box");
  return { ...box, id: "box-1", name: "Bound box", x: 5, expressions: { width: "w", x: "w / 2" }, ...overrides };
}

/** Builds a 10 mm-wide ring revolved a full turn, through the engine's own request path. */
async function revolveShape(): Promise<WorkplaneShape> {
  let document = { metadata: { revision: 0 }, projectName: "r", createdAt: 0, shapes: [] as WorkplaneShape[], history: [], historyIndex: 0, assets: [] } as unknown as ProjectDocument;
  const store: ProjectStore = {
    read: async () => document,
    write: async (_id, next, shapes) => {
      document = { ...next, shapes };
      return { revision: 1 };
    },
    withLock: async (_id, work) => ({ busy: false, result: await work() }),
    list: async () => [],
  };
  const added = await createEngine(store).addShapes("r", [{ kind: "revolve", profile: [[5, -4], [10, -4], [10, 4], [5, 4]], sides: 48 }]);
  if (!added.ok) throw new Error(JSON.stringify(added.failure));
  return document.shapes[0]!;
}

async function post(shapes: WorkplaneShape[], edit: ParameterEdit | EditorFieldBind) {
  const parameters = table([{ name: "w", expression: "10", dimension: "length" }]);
  const request = editorParameterRequest("project-1", shapes, parameters, edit);
  const response = await POST(new Request(`http://localhost${request.url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.body),
  }));
  return { status: response.status, body: await response.json() };
}

async function stlMeasure(shapes: WorkplaneShape[]) {
  const { data } = await exportProjectScene({ projectName: "bound", shapes } as Parameters<typeof exportProjectScene>[0], { format: "stl" });
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const positions: number[] = [];
  for (let triangle = 0; triangle < view.getUint32(80, true); triangle += 1) {
    for (let index = 0; index < 9; index += 1) positions.push(view.getFloat32(84 + triangle * 50 + 12 + index * 4, true));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return measureMesh(geometry);
}

describe("editor parameter route", () => {
  it("recomputes bound geometry through the engine and returns the new table", async () => {
    const before = await stlMeasure([boundBox()]);
    const { status, body } = await post([boundBox()], { kind: "update", name: "w", expression: "20" });

    expect(status).toBe(200);
    expect(body.parameters).toEqual([{ name: "w", expression: "20", dimension: "length", value: 20 }]);
    const [shape] = body.shapes as WorkplaneShape[];
    expect(shape!.expressions).toEqual({ width: "w", x: "w / 2" });
    // Volume doubles with the width, and the centre follows x = w / 2.
    const after = await stlMeasure(body.shapes);
    expect(after.volume).toBeCloseTo(before.volume * 2, 3);
    expect(after.centroid[0] - before.centroid[0]).toBeCloseTo(5, 3);
  });

  it("refuses a recompute the engine refuses, with the engine's failure", async () => {
    const locked = await post([boundBox({ locked: true })], { kind: "update", name: "w", expression: "20" });
    expect(locked.status).toBe(422);
    expect(locked.body.failure).toMatchObject({ reason: "binding_failed", shapeId: "box-1", failure: { reason: "shape_locked" } });

    const range = await post([boundBox()], { kind: "update", name: "w", expression: "-5" });
    expect(range.status).toBe(422);
    expect(range.body.failure).toMatchObject({ reason: "binding_invalid", error: { code: "outOfRange", field: "width" } });

    const invalid = await post([boundBox()], { kind: "update", name: "w", expression: "2 +" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.failure).toMatchObject({ reason: "parameter_invalid", error: { code: "invalidExpression" } });
  });

  it("stops reading a streamed body past the limit", async () => {
    const chunk = new Uint8Array(17 * 1024 * 1024).fill(32);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 4) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await POST(new Request("http://localhost/api/editor/parameters", { method: "POST", body, duplex: "half" } as RequestInit));
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(4);
  });

  it("resolves under the active configuration and returns the rows", async () => {
    const added = addConfiguration({ parameters: table([{ name: "w", expression: "10", dimension: "length" }]), configurations: [] as ProjectConfiguration[], activeConfiguration: null as string | null }, { name: "Large", overrides: { w: "30" } });
    if (!added.ok) throw new Error(added.error.message);
    const active = activateConfiguration(added.project, "Large");
    if (!active.ok) throw new Error(active.error.message);
    const { configurations } = active.project;
    const configuration = { configurations, activeConfiguration: "Large" };
    const request = editorParameterRequest("project-1", [boundBox({ width: 30, x: 15 })], active.project.parameters, { kind: "rename", name: "w", newName: "size" }, configuration);
    const response = await POST(new Request(`http://localhost${request.url}`, { method: "POST", body: JSON.stringify(request.body) }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.parameters).toEqual([{ name: "size", expression: "10", dimension: "length", value: 30 }]);
    expect(body.configurations).toEqual([{ name: "Large", overrides: { size: "30" } }]);
    expect(body.activeConfiguration).toBe("Large");
    expect(body.shapes[0]).toMatchObject({ width: 30, expressions: { width: "size", x: "size / 2" } });
  });

  it("binds a shape field through the engine, applying the resolved value", async () => {
    const free = boundBox({ expressions: undefined, x: 0 });
    const before = await stlMeasure([free]);
    const { status, body } = await post([free], { kind: "bindShape", shapeId: "box-1", field: "width", expression: "w * 2" });

    expect(status).toBe(200);
    const [shape] = body.shapes as WorkplaneShape[];
    expect(shape!.expressions).toEqual({ width: "w * 2" });
    expect(shape!.width).toBe(20);
    const after = await stlMeasure(body.shapes);
    expect(after.volume).toBeCloseTo(before.volume * 2, 3);
    // The box grows about its centre, so the whole centroid stays put.
    after.centroid.forEach((value, axis) => expect(value).toBeCloseTo(before.centroid[axis]!, 3));
  });

  it("binds a revolve feature field, which rebuilds through the kernel", async () => {
    const revolve = await revolveShape();
    const full = await stlMeasure([revolve]);
    const { status, body } = await post([revolve], { kind: "bindShape", shapeId: revolve.id, field: "revolve.sweepAngle", expression: "180" });

    expect(status, JSON.stringify(body)).toBe(200);
    const [shape] = body.shapes as WorkplaneShape[];
    expect(shape!.expressions).toEqual({ "revolve.sweepAngle": "180" });
    expect(shape!.sketchRevolve?.sweepAngle).toBe(180);
    const half = await stlMeasure(body.shapes);
    // Half the solid, within tessellation; the centre leaves the axis toward the kept half.
    expect(half.volume / full.volume).toBeCloseTo(0.5, 2);
    const shift = half.centroid.map((value, axis) => value - full.centroid[axis]!);
    expect(Math.hypot(...shift)).toBeGreaterThan(3);
  }, CAD_TEST_TIMEOUT_MS);

  it("binds under the active configuration", async () => {
    const added = addConfiguration({ parameters: table([{ name: "w", expression: "10", dimension: "length" }]), configurations: [] as ProjectConfiguration[], activeConfiguration: null as string | null }, { name: "Large", overrides: { w: "30" } });
    if (!added.ok) throw new Error(added.error.message);
    const active = activateConfiguration(added.project, "Large");
    if (!active.ok) throw new Error(active.error.message);
    const configuration = { configurations: active.project.configurations, activeConfiguration: "Large" };
    const free = boundBox({ expressions: undefined, x: 0 });
    const edit: EditorFieldBind = { kind: "bindShape", shapeId: "box-1", field: "width", expression: "w" };
    const request = editorParameterRequest("project-1", [free], active.project.parameters, edit, configuration);
    const response = await POST(new Request(`http://localhost${request.url}`, { method: "POST", body: JSON.stringify(request.body) }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.shapes[0]).toMatchObject({ width: 30, expressions: { width: "w" } });
    expect(body.activeConfiguration).toBe("Large");
  });

  it("removes a binding and keeps the number", async () => {
    const { status, body } = await post([boundBox()], { kind: "bindShape", shapeId: "box-1", field: "x", expression: null });
    expect(status).toBe(200);
    expect(body.shapes[0]).toMatchObject({ x: 5, expressions: { width: "w" } });
  });

  it("refuses a bind the engine refuses, leaving shapes unchanged", async () => {
    const invalid = await post([boundBox()], { kind: "bindShape", shapeId: "box-1", field: "width", expression: "nope" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.failure).toMatchObject({ reason: "binding_invalid", error: { code: "invalidExpression", field: "width" } });

    const missing = await post([boundBox()], { kind: "bindShape", shapeId: "other", field: "width", expression: "w" });
    expect(missing.status).toBe(422);
    expect(missing.body.failure).toMatchObject({ reason: "shapes_not_found" });
  it("activates a configuration and sets an override through the engine, recomputing bound geometry", async () => {
    const parameters = table([{ name: "w", expression: "10", dimension: "length" }]);
    const send = async (shapes: WorkplaneShape[], table: typeof parameters, configuration: { configurations: ProjectConfiguration[]; activeConfiguration: string | null }, edit: ParameterEdit) => {
      const request = editorParameterRequest("project-1", shapes, table, edit, configuration);
      const response = await POST(new Request(`http://localhost${request.url}`, { method: "POST", body: JSON.stringify(request.body) }));
      return { status: response.status, body: await response.json() };
    };
    const activated = await send([boundBox()], parameters, { configurations: [{ name: "Large", overrides: { w: "30" } }], activeConfiguration: null },
      { kind: "activateConfiguration", configuration: "Large" });
    expect(activated.status).toBe(200);
    expect(activated.body.activeConfiguration).toBe("Large");
    expect(activated.body.shapes[0]).toMatchObject({ width: 30, x: 15 });

    const overridden = await send(activated.body.shapes, activated.body.parameters, { configurations: activated.body.configurations, activeConfiguration: "Large" },
      { kind: "setOverride", configuration: "Large", name: "w", expression: "-4" });
    expect(overridden.status).toBe(422);
    expect(overridden.body.failure).toMatchObject({ reason: "binding_invalid", error: { code: "outOfRange", field: "width" } });

    const malformed = await send([], parameters, { configurations: [], activeConfiguration: null }, { kind: "activateConfiguration", configuration: 3 } as never);
    expect(malformed.status).toBe(400);
  });

  it("rejects malformed requests", async () => {
    const bind = await POST(new Request("http://localhost/api/editor/parameters", { method: "POST", body: JSON.stringify({ projectId: "p", shapes: [], parameters: [], edit: { kind: "bindShape", shapeId: "a", field: 3, expression: "w" } }) }));
    expect(bind.status).toBe(400);
    const response = await POST(new Request("http://localhost/api/editor/parameters", { method: "POST", body: JSON.stringify({ projectId: "p", shapes: [], parameters: [], edit: { kind: "drop" } }) }));
    expect(response.status).toBe(400);
  });
});
