import { describe, expect, expectTypeOf, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { SketchForgeApiError } from "../errors.js";
import { fakeServer, type FakeServer } from "../testing.js";
import type { SketchConstraintBindResult, SketchConstraintSummary } from "../types.js";

function client(server: FakeServer, expectedRevision?: number) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch, expectedRevision });
}

const width = { id: "width", kind: "distance", value: 3, expression: "w" } as const;
const bar = {
  id: "s1", name: "Bar", kind: "mesh", color: "#fff", hole: false, locked: false, hidden: false,
  x: 0, z: 0, elevation: 0, width: 3, depth: 2, height: 10, rotation: 0, rotationX: 0, rotationZ: 0,
  sketchConstraints: [width, { id: "depth", kind: "distance", value: 2 }],
};

describe("sketch constraints", () => {
  it("binds a constraint with PATCH, naming the shape and constraint in the query", async () => {
    const server = fakeServer({ body: { shape: bar, constraint: width, revision: 5 } });

    const result = await client(server, 4).sketchConstraints.bind("p1", "s1", "width", "w");

    expect(server.calls[0]).toMatchObject({
      method: "PATCH",
      url: "http://localhost:3100/api/v1/sketch-constraints?projectId=p1&shapeId=s1&constraintId=width",
      body: { expression: "w" },
    });
    expect(server.calls[0]?.headers["if-match"]).toBe('"4"');
    expect(result.constraint).toEqual(width);
    expect(result.shape.sketchConstraints?.[0]).toEqual(width);
    expect(result.revision).toBe(5);
    expectTypeOf(result).toEqualTypeOf<SketchConstraintBindResult>();
    expectTypeOf(result.constraint).toEqualTypeOf<SketchConstraintSummary>();
  });

  it("unbinds with null, which the body carries rather than drops", async () => {
    const server = fakeServer({ body: { shape: bar, constraint: { id: "width", kind: "distance", value: 3 }, revision: 6 } });

    const result = await client(server).sketchConstraints.unbind("p1", "sketch/s1", "width");

    expect(server.calls[0]).toMatchObject({
      method: "PATCH",
      url: "http://localhost:3100/api/v1/sketch-constraints?projectId=p1&shapeId=sketch%2Fs1&constraintId=width",
      body: { expression: null },
    });
    expect(result.constraint.expression).toBeUndefined();
  });

  it("refuses an empty expression before sending, and surfaces the server's constraint refusal", async () => {
    const empty = fakeServer({ body: {} });
    await expect(client(empty).sketchConstraints.bind("p1", "s1", "width", "  ")).rejects.toThrow(/expression/);
    expect(empty.calls).toHaveLength(0);

    const server = fakeServer({
      status: 422,
      body: { error: "width: a distance constraint cannot be -3.", code: "invalid_expression", shapeId: "s1", constraintId: "width", reason: "outOfRange" },
    });
    let refused: unknown;
    try {
      await client(server).sketchConstraints.bind("p1", "s1", "width", "-w");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SketchForgeApiError);
    expect(refused).toMatchObject({ status: 422, code: "invalid_expression" });
    expect((refused as SketchForgeApiError).body).toMatchObject({ constraintId: "width", reason: "outOfRange" });
  });

  it("is reachable from a project handle", async () => {
    const server = fakeServer({ body: { shape: bar, constraint: width, revision: 5 } });

    await client(server).project("p1").bindSketchConstraint("s1", "width", "w");

    expect(server.calls[0]).toMatchObject({ method: "PATCH", body: { expression: "w" } });
  });
});
