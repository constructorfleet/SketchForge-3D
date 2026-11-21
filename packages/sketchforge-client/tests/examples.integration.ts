/**
 * The worked examples, run against a real server.
 *
 * These are the integration tests: the examples are the thing most likely to
 * break when the API changes, and running them proves the client, the macro
 * runner and the geometry together. They are kept out of `npm test` because
 * they need a server with a token and a projects directory -- see
 * `npm run test:integration`.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFromEnvironment } from "../src/environment.js";
import { macroFromModule, runMacro } from "../src/macro.js";
import type { SketchForgeClient } from "../src/client.js";

import boltPlate from "../examples/bolt-plate.macro.mjs";
import boltCircle from "../examples/bolt-circle.macro.mjs";
import filletedBox from "../examples/filleted-box.macro.mjs";
import tapDrillPlate from "../examples/tap-drill-plate.macro.mjs";
import parametricBox from "../examples/parametric-box.macro.mjs";
import { SketchForgeApiError } from "../src/errors.js";
import { shapePatchFromSummary } from "../src/resources/shapes.js";

let client: SketchForgeClient;
const createdProjects: string[] = [];

async function run(module: unknown, params: Record<string, string> = {}) {
  const definition = macroFromModule({ default: module }, "example");
  const report = await runMacro(client, definition, { params });
  createdProjects.push(report.projectId);
  return report;
}

beforeAll(async () => {
  client = clientFromEnvironment();
  const health = await client.check();
  if (!health.ok) {
    throw new Error(
      `The integration tests need a live SketchForge server: ${health.reason}\n` +
        "Start one with SKETCHFORGE_PROJECTS_DIR, SKETCHFORGE_API_TOKEN and PORT set, then point SKETCHFORGE_URL at it.",
    );
  }
});

afterAll(async () => {
  for (const projectId of new Set(createdProjects)) {
    await client.projects.delete(projectId).catch(() => undefined);
  }
});

describe("bolt plate", () => {
  it("builds a plate sized around its row of tapped holes", async () => {
    const report = await run(boltPlate, { holes: "5", spacing: "25", size: "M8", thickness: "8" });
    const result = report.result as { plate: { width: number; depth: number }; holes: number };

    expect(result.holes).toBe(5);
    // Four 25mm gaps, plus the bolt's radius and the margin at each end.
    expect(result.plate.width).toBe(132);
    expect(result.plate.depth).toBe(32);
    expect(report.shapeCount).toBe(6);

    const shapes = await client.shapes.list(report.projectId);
    const holes = shapes.filter((shape) => shape.hole);
    expect(holes).toHaveLength(5);
    expect(holes.map((hole) => Math.round(hole.x))).toEqual([-50, -25, 0, 25, 50]);
    // A thread is built by manifold and stored as a mesh, whatever it was asked for.
    expect(new Set(holes.map((hole) => hole.kind))).toEqual(new Set(["mesh"]));
  });

  it("is idempotent: a second run leaves one plate, not two", async () => {
    const first = await run(boltPlate, { holes: "3", spacing: "20" });
    const second = await run(boltPlate, { holes: "3", spacing: "20" });

    expect(second.projectId).toBe(first.projectId);
    expect(second.shapesCleared).toBe(4);
    expect(second.shapeCount).toBe(4);
  });
});

describe("bolt circle", () => {
  it("puts N tapped holes on a ring of radius R", async () => {
    const report = await run(boltCircle, { holes: "6", radius: "30", size: "M6", bore: "20" });
    const result = report.result as { holes: number; angles: number[]; outerDiameter: number };

    expect(result.holes).toBe(6);
    expect(result.angles).toEqual([0, 60, 120, 180, -120, -60]);
    expect(result.outerDiameter).toBe(84);
    // The flange, six holes, and the bore.
    expect(report.shapeCount).toBe(8);

    const shapes = await client.shapes.list(report.projectId);
    const holes = shapes.filter((shape) => shape.hole && shape.name.startsWith("M6"));
    for (const hole of holes) {
      expect(Math.hypot(hole.x, hole.z)).toBeCloseTo(30, 3);
    }
  });

  it("creates a new project per run, so runs cannot overwrite each other", async () => {
    const first = await run(boltCircle, { holes: "3" });
    const second = await run(boltCircle, { holes: "4" });
    expect(second.projectId).not.toBe(first.projectId);
    expect(second.projectCreated).toBe(true);
  });
});

/** Enclosed volume and centroid of a binary STL, by signed tetrahedra from the origin. */
function stlSolid(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  let volume = 0;
  const moment = [0, 0, 0];
  for (let index = 0; index < triangles; index += 1) {
    const at = 84 + index * 50 + 12;
    const vertex = (n: number) => [0, 1, 2].map((axis) => view.getFloat32(at + n * 12 + axis * 4, true));
    const [a, b, c] = [vertex(0), vertex(1), vertex(2)] as [number[], number[], number[]];
    const signed = (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    volume += signed;
    for (let axis = 0; axis < 3; axis += 1) moment[axis]! += (signed * (a[axis]! + b[axis]! + c[axis]!)) / 4;
  }
  return { triangles, volume, centroid: moment.map((value) => value / volume) };
}

describe("tapped plate", () => {
  it("cuts an M8 thread into the plate and exports the part as a closed STL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sketchforge-tapped-plate-"));
    const out = path.join(directory, "tapped-plate.stl");
    try {
      const report = await run(tapDrillPlate, { size: "8", width: "60", depth: "40", thickness: "8", offset: "10", out });
      const result = report.result as { plateId: string; triangles: number; stl: { filename: string; bytes: number; shapeCount: number } };

      // The cut replaced both operands with one shape.
      const shapes = await client.shapes.list(report.projectId);
      expect(shapes.map((shape) => shape.id)).toEqual([result.plateId]);
      expect(result.triangles).toBeGreaterThan(0);

      // The M8 cutter's core and thread form were removed, and the off-centre
      // cut shifts the plate's centre of mass away from the tapped hole.
      const plateVolume = 60 * 40 * 8;
      const { volume, centerOfMass } = await client.properties.get(report.projectId, result.plateId);
      const removed = plateVolume - volume;
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThan(plateVolume);
      expect(centerOfMass.x).toBeLessThan(0);

      // The file on disk is that same solid, closed: its triangles enclose the
      // server's volume about the same centre. STL is Z-up, so X is unchanged.
      expect(result.stl).toMatchObject({ filename: "tapped-plate.stl", shapeCount: 1 });
      const bytes = new Uint8Array(await readFile(out));
      expect(bytes.byteLength).toBe(result.stl.bytes);
      const stl = stlSolid(bytes);
      expect(bytes.byteLength).toBe(84 + stl.triangles * 50);
      expect(stl.volume).toBeCloseTo(volume, 0);
      expect(stl.centroid[0]).toBeCloseTo(centerOfMass.x, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("filleted box", () => {
  it("rounds every roundable edge and keeps the box's size", async () => {
    const report = await run(filletedBox, { width: "60", depth: "40", height: "20", radius: "4" });
    const result = report.result as {
      edges: number;
      rounded: number;
      triangles: number;
      size: { width: number; depth: number; height: number };
    };

    expect(result.edges).toBe(12);
    expect(result.rounded).toBe(12);
    expect(result.triangles).toBeGreaterThan(0);
    expect(result.size).toEqual({ width: 60, depth: 40, height: 20 });
  });

  it("refuses a radius the geometry cannot take, and leaves the shape alone", async () => {
    const report = await run(filletedBox, { width: "30", depth: "30", height: "2", radius: "9" }).catch(
      (error: unknown) => error,
    );
    expect(report).toBeInstanceOf(Error);
    expect((report as Error).message).toMatch(/422/);
  });
});

describe("parametric box", () => {
  it("rebuilds the bound solid when its parameter changes", async () => {
    const report = await run(parametricBox, { wall: "2", resized: "3" });
    const result = report.result as {
      expressions: Record<string, string>;
      before: { width: number; x: number; volume: number; centerX: number };
      after: { width: number; x: number; volume: number; centerX: number };
      rebuilt: number;
    };

    expect(result.expressions).toEqual({ width: "wall * 5", x: "wall * 10" });
    expect(result.rebuilt).toBe(1);
    expect(result.before).toMatchObject({ width: 10, x: 20 });
    expect(result.after).toMatchObject({ width: 15, x: 30 });
    // 10 x 10 x (wall * 5), centred on wall * 10.
    expect(result.before.volume).toBeCloseTo(1000, 3);
    expect(result.before.centerX).toBeCloseTo(20, 3);
    expect(result.after.volume).toBeCloseTo(1500, 3);
    expect(result.after.centerX).toBeCloseTo(30, 3);
  });

  it("refuses to delete a bound parameter, renames through its bindings, and clears them", async () => {
    const report = await run(parametricBox);
    const project = client.project(report.projectId);
    const { shapeId } = report.result as { shapeId: string };

    const refused = await project.deleteParameter("wall").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SketchForgeApiError);
    expect((refused as SketchForgeApiError).isParameterInUse).toBe(true);
    expect((refused as SketchForgeApiError).shapeDependents.map(({ shapeId: id, fields }) => ({ id, fields: [...fields].sort() })))
      .toEqual([{ id: shapeId, fields: ["width", "x"] }]);

    const renamed = await project.renameParameter("wall", "shell");
    expect(renamed.shapes.find((shape) => shape.id === shapeId)?.expressions).toEqual({ width: "shell * 5", x: "shell * 10" });

    const invalid = await project.updateParameter("shell", { expression: "shell + 1" }).catch((error: unknown) => error);
    expect((invalid as SketchForgeApiError).isInvalidExpression).toBe(true);
    expect((invalid as SketchForgeApiError).expressionError?.code).toBeTruthy();

    const cleared = await project.bindExpressions(shapeId, { width: null, x: null });
    expect(cleared.shape.expressions).toBeUndefined();
    expect(cleared.shape.width).toBe(15);
    expect((await project.propertiesOf(shapeId)).volume).toBeCloseTo(1500, 3);

    await expect(project.deleteParameter("shell")).resolves.toMatchObject({ deleted: true, name: "shell" });
    await expect(project.parameters()).resolves.toMatchObject({ parameters: [], bindingIssues: [] });
  });

  it("guards a stale summary round trip with If-Match, and unbinds without it", async () => {
    const { id: projectId } = await client.projects.create("Stale parameter round trip");
    createdProjects.push(projectId);
    const project = client.project(projectId);
    await project.addParameter({ name: "wall", expression: "2 mm", dimension: "length" });
    const { shapes: [box], revision: readAt } = await project.addMany([
      { kind: "box", depth: 10, height: 10, expressions: { width: "wall * 5" } },
    ]);
    const stale = shapePatchFromSummary(box!);
    const changed = await project.updateParameter("wall", { expression: "3 mm" });
    expect(changed.revision).toBeGreaterThan(readAt);

    const guarded = clientFromEnvironment(process.env, { expectedRevision: readAt });
    for (const write of [
      () => guarded.shapes.update(projectId, box!.id, stale),
      () => guarded.parameters.update(projectId, "wall", { expression: "4 mm" }),
    ]) {
      const refused = await write().catch((error: unknown) => error);
      expect((refused as SketchForgeApiError).isRevisionMismatch).toBe(true);
      expect((refused as SketchForgeApiError).currentRevision).toBe(changed.revision);
    }
    expect((await project.propertiesOf(box!.id)).volume).toBeCloseTo(1500, 3);

    // The stale width counts as an edit, so the number replaces the binding.
    const unguarded = await project.update(box!.id, stale);
    expect(unguarded.shape.expressions).toBeUndefined();
    expect(unguarded.shape.width).toBe(10);
    expect((await project.propertiesOf(box!.id)).volume).toBeCloseTo(1000, 3);

    const current = clientFromEnvironment(process.env, { expectedRevision: unguarded.revision });
    await expect(current.parameters.update(projectId, "wall", { expression: "4 mm" })).resolves.toMatchObject({ parameter: { value: 4 } });
  });
});
