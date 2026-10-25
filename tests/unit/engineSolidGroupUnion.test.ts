/**
 * A group of solids is measured, exported and drawn as the union of its
 * children (issue #500).
 *
 * The group itself stays a record -- the editor stores a solid-only group that
 * way too, and ungrouping depends on it -- so the union is evaluated when a
 * solid is asked for. Before this, the record reached the CAD kernel as a
 * `mesh` with no triangles and was refused with "cannot build exact geometry
 * for a mesh", which also named the wrong problem.
 *
 * Volume and centre of mass, not bounds: a union that double-counts the
 * overlap, or a group whose turn is dropped, keeps the same box.
 */
import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { meshProjectShapes } from "@constructorfleet/sketchforge-engine/projectMeshes";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";

const CAD_TIMEOUT_MS = 60_000;

function projectWith(shapes: WorkplaneShape[]) {
  let document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Union test",
    createdAt: 0,
    shapes,
    history: [],
    historyIndex: -1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let revision = 0;
  const store = {
    read: async (projectId: string) => projectId === "union" ? document : null,
    write: async (_projectId: string, next: ProjectDocument, nextShapes: WorkplaneShape[]) => {
      revision += 1;
      document = { ...next, shapes: nextShapes, metadata: { ...next.metadata, revision } };
      return { revision };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { engine: createEngine(store), shapes: () => document.shapes };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function cylinder(id: string, diameter: number, height: number, placement: Partial<WorkplaneShape> = {}) {
  return sceneShape({ id, name: id, kind: "cylinder", color: "#336699", width: diameter, depth: diameter, height, ...placement });
}

function box(id: string, width: number, depth: number, height: number, placement: Partial<WorkplaneShape> = {}) {
  return sceneShape({ id, name: id, kind: "box", color: "#336699", width, depth, height, ...placement });
}

/** Signed volume of a closed triangle soup, by the divergence theorem. */
function meshVolume(vertices: [number, number, number][], faces: [number, number, number][]) {
  let total = 0;
  for (const [a, b, c] of faces) {
    const [ax, ay, az] = vertices[a];
    const [bx, by, bz] = vertices[b];
    const [cx, cy, cz] = vertices[c];
    total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return total / 6;
}

/** The overlap of two circles of radius r1 and r2 with centres d apart. */
function lensArea(r1: number, r2: number, d: number) {
  return r1 ** 2 * Math.acos((d ** 2 + r1 ** 2 - r2 ** 2) / (2 * d * r1))
    + r2 ** 2 * Math.acos((d ** 2 + r2 ** 2 - r1 ** 2) / (2 * d * r2))
    - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
}

describe("a group of solids evaluates as their union (#500)", () => {
  it("measures the issue's two overlapping cylinders without counting the overlap twice", async () => {
    const { engine, shapes } = projectWith([
      cylinder("large", 20, 10),
      cylinder("small", 10, 10, { x: 10, elevation: 5 }),
    ]);
    const group = value(await engine.group("union", ["large", "small"])).shape;
    // Still a record, as the editor stores a solid-only group.
    expect(group.importedMesh).toBeUndefined();
    expect(shapes()).toHaveLength(1);

    const properties = value(await engine.properties("union", group.id));
    const overlap = lensArea(10, 5, 10) * 5;
    expect(properties.volume).toBeCloseTo(Math.PI * 100 * 10 + Math.PI * 25 * 10 - overlap, 3);
    expect(properties.isValid).toBe(true);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("puts the union's centre of mass where the stacked cylinders put it", async () => {
    const { engine } = projectWith([
      cylinder("base", 20, 10, { x: 3, z: -2 }),
      cylinder("boss", 10, 10, { x: 3, z: -2, elevation: 5 }),
    ]);
    const group = value(await engine.group("union", ["base", "boss"])).shape;

    const properties = value(await engine.properties("union", group.id));
    // The boss's lower half sits inside the base, so only its upper 5mm adds.
    const baseVolume = Math.PI * 100 * 10;
    const bossVolume = Math.PI * 25 * 5;
    expect(properties.volume).toBeCloseTo(baseVolume + bossVolume, 3);
    expect(properties.centerOfMass.x).toBeCloseTo(3, 4);
    expect(properties.centerOfMass.z).toBeCloseTo(-2, 4);
    expect(properties.centerOfMass.y).toBeCloseTo((baseVolume * 5 + bossVolume * 12.5) / (baseVolume + bossVolume), 4);
  }, CAD_TIMEOUT_MS);

  it("applies the group's own turn and position to the union", async () => {
    const { engine, shapes } = projectWith([
      box("small", 10, 10, 10),
      box("long", 20, 10, 10, { x: 25 }),
    ]);
    const group = value(await engine.group("union", ["small", "long"])).shape;
    // Spans x -5..35, so its centre is 15. Turn it a quarter about Y and lift it.
    value(await engine.changeShape("union", group.id, { rotation: 90, elevation: 7 }));
    const turned = shapes()[0];
    expect(turned.rotation).toBe(90);

    const properties = value(await engine.properties("union", group.id));
    expect(properties.volume).toBeCloseTo(3000, 4);
    // Unturned, the centre of mass is 5/3 to +x of the group's centre. A
    // quarter turn about +Y carries +x to -z.
    expect(properties.centerOfMass.x).toBeCloseTo(15, 4);
    expect(properties.centerOfMass.z).toBeCloseTo(-5 / 3, 4);
    expect(properties.centerOfMass.y).toBeCloseTo(12, 4);
  }, CAD_TIMEOUT_MS);

  it("fuses a meshed revolve with the cylinder that fills its bore, and says it is tessellated", async () => {
    const { engine } = projectWith([]);
    const added = value(await engine.addShapes("union", [
      { kind: "revolve", name: "Ring", profile: [[5, -4], [10, -4], [10, 4], [5, 4]], sides: 96 },
      { kind: "cylinder", name: "Core", width: 10, depth: 10, height: 8 },
    ]));
    const [ring, core] = added.shapes;
    expect(ring.importedMesh).toBeDefined();
    const ringAlone = value(await engine.properties("union", ring.id));
    const group = value(await engine.group("union", [ring.id, core.id])).shape;

    const properties = value(await engine.properties("union", group.id));
    // The core fills the ring's bore, so together they are one solid disc.
    expect(properties.volume).toBeCloseTo(ringAlone.volume + Math.PI * 25 * 8, -1);
    expect(properties.volume).toBeGreaterThan(Math.PI * 100 * 8 * 0.99);
    expect(properties.centerOfMass.x).toBeCloseTo(core.x, 3);
    expect(properties.centerOfMass.z).toBeCloseTo(core.z, 3);
    expect(properties.centerOfMass.y).toBeCloseTo((core.elevation ?? 0) + 4, 3);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  }, CAD_TIMEOUT_MS);

  it("exports the group as one closed solid with the union's volume", async () => {
    const { engine, shapes } = projectWith([
      box("left", 10, 10, 10),
      box("right", 10, 10, 10, { x: 5 }),
    ]);
    value(await engine.group("union", ["left", "right"]));

    const meshes = await meshProjectShapes(shapes());
    expect(meshes).toHaveLength(1);
    // Overlapping by half, so 1500 rather than the 2000 two separate boxes make.
    expect(meshVolume(meshes[0].vertices, meshes[0].faces)).toBeCloseTo(1500, 3);
  }, CAD_TIMEOUT_MS);

  it("names the real problem for a mesh shape that carries no triangles", async () => {
    const { engine } = projectWith([
      sceneShape({ id: "empty", name: "Empty", kind: "mesh", color: "#336699", width: 1, depth: 1, height: 1 }),
    ]);
    const result = await engine.properties("union", "empty");
    expect(result.ok).toBe(false);
    const message = JSON.stringify(!result.ok && result.failure);
    expect(message).not.toContain("cannot build exact geometry for a mesh");
    expect(message).toContain("no triangles");
  }, CAD_TIMEOUT_MS);
});
