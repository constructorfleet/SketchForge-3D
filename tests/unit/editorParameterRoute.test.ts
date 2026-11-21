import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { exportProjectScene, shapeFromRequest } from "@constructorfleet/sketchforge-engine";
import { resolveProjectParameters } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { POST } from "@/app/api/editor/parameters/route";
import { editorParameterRequest } from "@/lib/editorCadRequests";
import type { ParameterEdit } from "@/lib/projectParameterEdits";
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

async function post(shapes: WorkplaneShape[], edit: ParameterEdit) {
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

  it("rejects malformed requests", async () => {
    const response = await POST(new Request("http://localhost/api/editor/parameters", { method: "POST", body: JSON.stringify({ projectId: "p", shapes: [], parameters: [], edit: { kind: "drop" } }) }));
    expect(response.status).toBe(400);
  });
});
