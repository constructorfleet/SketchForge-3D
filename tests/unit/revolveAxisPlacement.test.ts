import { beforeAll, describe, expect, it } from "vitest";
import manifoldModule, { type ManifoldToplevel } from "manifold-3d";
import {
  bakedRevolveAxisOffset,
  parseRevolveRequest,
  rebuiltRevolveShape,
  revolveAxisPosition,
  revolvedShapeFromRequest,
  requestedRevolveSettings,
} from "@constructorfleet/sketchforge-engine/revolveRequests";
import { meshShapeFromWorldPositions, worldMeshForShape } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

/**
 * Issue #503: a partial-sweep revolve was re-centred on its own bounding box,
 * so `x`/`z` placed the box rather than the axis it turns about.
 *
 * Checked by volume and centre of mass in world space. A bounding box would
 * pass a solid mirrored onto the wrong side of the axis.
 */
function worldMassProperties(shape: WorkplaneShape) {
  const mesh = worldMeshForShape(shape);
  if (!mesh) throw new Error("expected a world mesh");
  let volume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const [ia, ib, ic] of mesh.faces) {
    const [ax, ay, az] = mesh.vertices[ia];
    const [bx, by, bz] = mesh.vertices[ib];
    const [qx, qy, qz] = mesh.vertices[ic];
    const tetra = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    volume += tetra;
    cx += tetra * (ax + bx + qx) / 4;
    cy += tetra * (ay + by + qy) / 4;
    cz += tetra * (az + bz + qz) / 4;
  }
  return { volume: Math.abs(volume), centroid: { x: cx / volume, y: cy / volume, z: cz / volume } };
}

/** The radial centroid of an annular sector of inner radius r, outer R and total angle theta. */
function sectorCentroidRadius(r: number, R: number, theta: number) {
  const half = theta / 2;
  return (2 * Math.sin(half) / (3 * half)) * (R ** 3 - r ** 3) / (R ** 2 - r ** 2);
}

const QUARTER_RING = [[50, 0], [75, 0], [75, 10], [50, 10]];
const QUARTER_VOLUME = (Math.PI / 4) * (75 ** 2 - 50 ** 2) * 10;
const QUARTER_RADIUS = sectorCentroidRadius(50, 75, Math.PI / 2);

function quarterRing(runtime: ManifoldToplevel, base: Parameters<typeof revolvedShapeFromRequest>[2], extra: Record<string, unknown> = {}) {
  const parsed = parseRevolveRequest({ profile: QUARTER_RING, sweepAngle: 90, sides: 256, ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return revolvedShapeFromRequest(runtime, parsed, base);
}

describe("a partial revolve stays about its axis (#503)", () => {
  let runtime: ManifoldToplevel;

  beforeAll(async () => {
    runtime = await manifoldModule();
    runtime.setup();
  });

  it("turns about the axis at the requested x and z, not about its bounding box", () => {
    const shape = quarterRing(runtime, { x: 100, z: -20 });
    const { volume, centroid } = worldMassProperties(shape);

    expect(volume).toBeGreaterThan(QUARTER_VOLUME * 0.995);
    expect(volume).toBeLessThan(QUARTER_VOLUME * 1.001);
    // Manifold sweeps from +X towards the editor's -Z.
    const offset = QUARTER_RADIUS * Math.SQRT1_2;
    expect(centroid.x).toBeCloseTo(100 + offset, 1);
    expect(centroid.z).toBeCloseTo(-20 - offset, 1);
    expect(revolveAxisPosition(shape)).toEqual({ x: expect.closeTo(100, 6), z: expect.closeTo(-20, 6) });
  });

  it("keeps the axis when the sweep is rotated about it by the start angle", () => {
    const shape = quarterRing(runtime, { x: 0, z: 0 }, { startAngle: 90 });
    const { centroid } = worldMassProperties(shape);
    const offset = QUARTER_RADIUS * Math.SQRT1_2;

    // The quarter from 90 to 180 degrees: -X, -Z in the editor.
    expect(centroid.x).toBeCloseTo(-offset, 1);
    expect(centroid.z).toBeCloseTo(-offset, 1);
  });

  it("places the axis, not the box, when the shape is also turned", () => {
    const shape = quarterRing(runtime, { x: 10, z: 5, rotation: 90 });
    const { centroid } = worldMassProperties(shape);
    const axis = revolveAxisPosition(shape)!;

    expect(axis.x).toBeCloseTo(10, 6);
    expect(axis.z).toBeCloseTo(5, 6);
    // Turning the shape keeps the solid at the same distance from its axis.
    expect(Math.hypot(centroid.x - 10, centroid.z - 5)).toBeCloseTo(QUARTER_RADIUS, 1);
    // And in the direction the viewport turns it: a yaw of +90 takes the
    // unturned quarter (+X, -Z) to (-X, -Z). A yaw or mirror applied with the
    // wrong sign keeps the distance but not the side.
    const offset = QUARTER_RADIUS * Math.SQRT1_2;
    expect(centroid.x).toBeCloseTo(10 - offset, 1);
    expect(centroid.z).toBeCloseTo(5 - offset, 1);
  });

  it("keeps the axis when the sweep angle is changed afterwards", () => {
    const shape = quarterRing(runtime, { x: 30, z: 40 });
    const settings = requestedRevolveSettings(shape.sketchRevolve!, { sweepAngle: 180 });
    const rebuilt = rebuiltRevolveShape(runtime, shape, { profile: shape.sketchProfile!, settings });
    const { volume, centroid } = worldMassProperties(rebuilt);
    const half = (Math.PI / 2) * (75 ** 2 - 50 ** 2) * 10;

    expect(volume).toBeGreaterThan(half * 0.995);
    // The half ring from 0 to 180 degrees is centred on the axis in X and lies
    // on the editor's -Z side of it.
    expect(centroid.x).toBeCloseTo(30, 1);
    expect(centroid.z).toBeCloseTo(40 - sectorCentroidRadius(50, 75, Math.PI), 1);
    expect(revolveAxisPosition(rebuilt)).toEqual({ x: expect.closeTo(30, 6), z: expect.closeTo(40, 6) });
  });

  it("keeps a resized revolve about its axis when its sweep is changed", () => {
    const shape = quarterRing(runtime, { x: 0, z: 0 });
    const doubled = { ...shape, width: shape.width * 2, depth: shape.depth * 2, x: shape.x * 2, z: shape.z * 2 };
    expect(revolveAxisPosition(doubled)).toEqual({ x: expect.closeTo(0, 6), z: expect.closeTo(0, 6) });

    const settings = requestedRevolveSettings(shape.sketchRevolve!, { sweepAngle: 180 });
    const rebuilt = rebuiltRevolveShape(runtime, doubled, { profile: shape.sketchProfile!, settings });
    const { centroid } = worldMassProperties(rebuilt);

    // The half ring keeps the doubled scale and the axis at the origin: centred
    // on it in X, and twice the unscaled radius out on the -Z side.
    expect(centroid.x).toBeCloseTo(0, 1);
    expect(centroid.z).toBeCloseTo(-2 * sectorCentroidRadius(50, 75, Math.PI), 1);
  });

  it("keeps the axis and the solid in place when a turned, resized revolve's transform is baked", () => {
    // The editor bakes a rotation into the mesh and drops it, re-centring the
    // mesh on its new box. The recorded offset is measured again in that frame,
    // so the axis stays where it was and a later sweep edit does not jump.
    const quarter = quarterRing(runtime, { x: 10, z: 5, rotation: 90 });
    const shape = { ...quarter, width: quarter.width * 1.5, depth: quarter.depth * 1.5 };
    const axis = revolveAxisPosition(shape)!;
    const before = worldMassProperties(shape);
    const offset = 1.5 * QUARTER_RADIUS * Math.SQRT1_2;
    expect(before.centroid.x).toBeCloseTo(axis.x - offset, 1);
    expect(before.centroid.z).toBeCloseTo(axis.z - offset, 1);

    const world = worldMeshForShape(shape)!;
    const positions = world.faces.flatMap((face) => face.flatMap((index) => world.vertices[index]));
    const { id, name, color, sketchProfile, sketchOperation, sketchRevolve, sketchSourceId } = shape;
    const moved = meshShapeFromWorldPositions(positions, { id, name, color, sketchProfile, sketchOperation, sketchRevolve, sketchSourceId })!;
    const baked = { ...moved, revolveAxisOffset: bakedRevolveAxisOffset(shape, moved) };

    expect(revolveAxisPosition(baked)).toEqual({ x: expect.closeTo(axis.x, 6), z: expect.closeTo(axis.z, 6) });
    const after = worldMassProperties(baked);
    expect(after.volume).toBeCloseTo(before.volume, 0);
    expect(after.centroid.x).toBeCloseTo(before.centroid.x, 3);
    expect(after.centroid.z).toBeCloseTo(before.centroid.z, 3);

    const settings = requestedRevolveSettings(baked.sketchRevolve!, { sweepAngle: 180 });
    const rebuilt = rebuiltRevolveShape(runtime, baked, { profile: baked.sketchProfile!, settings });
    expect(revolveAxisPosition(rebuilt)).toEqual({ x: expect.closeTo(axis.x, 6), z: expect.closeTo(axis.z, 6) });
  });

  it("does not move a revolve saved before the axis was recorded", () => {
    // A stored project's partial revolve sits wherever its box was placed and
    // carries no record of its axis. Rebuilding it recovers the axis from its
    // own sweep, so the first edit does not throw it across the workplane.
    const current = quarterRing(runtime, { x: 0, z: 0 });
    const { revolveAxisOffset: _dropped, ...legacy } = { ...current, x: 12, z: 7 };
    expect(revolveAxisPosition(legacy)).toBeNull();
    const before = worldMassProperties(legacy).centroid;

    const rebuilt = rebuiltRevolveShape(runtime, legacy, { profile: legacy.sketchProfile!, settings: legacy.sketchRevolve! });
    const after = worldMassProperties(rebuilt).centroid;

    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.z).toBeCloseTo(before.z, 4);
    expect(rebuilt.revolveAxisOffset).toBeDefined();
  });

  // A regression guard rather than a test of #503: a full turn is symmetric,
  // so its box centre was its axis before the fix too.
  it("leaves a full turn where it was", () => {
    const parsed = parseRevolveRequest({ profile: QUARTER_RING, sides: 64 });
    if (!parsed.ok) throw new Error(parsed.error);
    const shape = revolvedShapeFromRequest(runtime, parsed, { x: 5, z: 6 });

    expect(shape.x).toBeCloseTo(5, 6);
    expect(shape.z).toBeCloseTo(6, 6);
  });
});
