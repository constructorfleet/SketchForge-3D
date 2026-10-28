import { expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

const sketch: WorkplaneShape = {
  id: "profile", name: "profile", kind: "box", color: "#12a4cc", x: 0, z: 0,
  size: 10, width: 10, depth: 10, height: 10, rotation: 0,
  sketchProfile: {
    points: [
      { id: "a", x: 0, z: 0 },
      { id: "b", x: 10, z: 0, handleOut: { x: 12, z: 0 } },
      { id: "c", x: 10, z: 5, handleIn: { x: 10, z: 3 } },
    ],
    segments: [
      { id: "line", startId: "a", endId: "b" },
      { id: "other", startId: "b", endId: "a" },
      { id: "curve", startId: "b", endId: "c", kind: "bezier" },
    ],
    constraints: [
      { id: "c", kind: "coincident", pointIds: ["a", "b"] },
      { id: "h", kind: "horizontal", segmentId: "line" },
      { id: "v", kind: "vertical", segmentId: "line" },
      { id: "parallel", kind: "parallel", segmentIds: ["line", "other"] },
      { id: "p", kind: "perpendicular", segmentIds: ["line", "other"] },
      { id: "t", kind: "tangent", segmentIds: ["line", "curve"] },
      { id: "equal", kind: "equalLength", segmentIds: ["line", "other"] },
      { id: "angle", kind: "angle", segmentIds: ["line", "other"], valueDeg: 45 },
      { id: "symmetry", kind: "symmetry", pointIds: ["a", "c"], segmentId: "line" },
      { id: "radius", kind: "radius", pointIds: ["a", "b"], valueMm: 5 },
      { id: "diameter", kind: "diameter", pointIds: ["a", "b"], valueMm: 10 },
      { id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10 },
      { id: "fixed-a", kind: "fixed", pointId: "a", xMm: 0, zMm: 0 },
    ],
  },
};

it("round-trips sketch constraints in the native project format", async () => {
  const bytes = await exportSkfProject({
    projectName: "Constraints", createdAt: 1, modifiedAt: 1, shapes: [sketch],
    history: [editorHistoryEntry([sketch], [])], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
  const restored = await importSkfProject(bytes);
  expect(restored.shapes[0]?.sketchProfile?.constraints).toEqual(sketch.sketchProfile?.constraints);
});

it("rejects fixed-point constraints with invalid coordinates or missing points", async () => {
  for (const fixed of [
    { id: "fixed-a", kind: "fixed", pointId: "missing", xMm: 0, zMm: 0 },
    { id: "fixed-a", kind: "fixed", pointId: "a", xMm: Number.NaN, zMm: 0 },
  ]) {
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [fixed as never] } };
    const bytes = await exportSkfProject({
      projectName: "Invalid fixed constraint", createdAt: 1, modifiedAt: 1, shapes: [invalid],
      history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    await expect(importSkfProject(bytes)).rejects.toThrow();
  }
});

it("rejects parallel constraints that reference a missing segment", async () => {
  const invalid = {
    ...sketch,
    sketchProfile: {
      ...sketch.sketchProfile!,
      constraints: [{ id: "parallel", kind: "parallel" as const, segmentIds: ["line", "missing"] as [string, string] }],
    },
  };
  const bytes = await exportSkfProject({
    projectName: "Invalid parallel constraint", createdAt: 1, modifiedAt: 1, shapes: [invalid],
    history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
  await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentIds/);
});

it("rejects tangent constraints without a shared line and Bezier endpoint", async () => {
  const invalid = {
    ...sketch,
    sketchProfile: {
      ...sketch.sketchProfile!,
      constraints: [{ id: "t", kind: "tangent" as const, segmentIds: ["line", "other"] as [string, string] }],
    },
  };
  const bytes = await exportSkfProject({
    projectName: "Invalid tangent constraint", createdAt: 1, modifiedAt: 1, shapes: [invalid],
    history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
  await expect(importSkfProject(bytes)).rejects.toThrow();
});

it("rejects equal-length constraints that reference curved segments", async () => {
  const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [{ id: "equal", kind: "equalLength" as const, segmentIds: ["line", "curve"] as [string, string] }] } };
  const bytes = await exportSkfProject({ projectName: "Invalid equal length", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
  await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentIds/);
});

it("rejects equal-length constraints on a degenerate line", async () => {
  const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, points: sketch.sketchProfile!.points.map((point) => point.id === "b" ? { ...point, x: 0, z: 0 } : point), constraints: [{ id: "equal", kind: "equalLength" as const, segmentIds: ["line", "other"] as [string, string] }] } };
  const bytes = await exportSkfProject({ projectName: "Invalid degenerate equal length", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
  await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentIds/);
});

it("rejects angle constraints outside 0 to 180 degrees", async () => {
  for (const valueDeg of [-1, 181, Number.NaN]) {
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [{ id: "angle", kind: "angle" as const, segmentIds: ["line", "other"] as [string, string], valueDeg }] } };
    const bytes = await exportSkfProject({ projectName: "Invalid angle", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
    await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.valueDeg/);
  }
});

it("rejects angle constraints that reference a missing or degenerate segment", async () => {
  for (const constraints of [
    [{ id: "angle", kind: "angle" as const, segmentIds: ["line", "missing"] as [string, string], valueDeg: 45 }],
    [{ id: "angle", kind: "angle" as const, segmentIds: ["line", "flat"] as [string, string], valueDeg: 45 }],
  ]) {
    const points = sketch.sketchProfile!.points.map((point) => point.id === "b" ? { ...point, x: 0, z: 0 } : point);
    const segments = [...sketch.sketchProfile!.segments, { id: "flat", startId: "a", endId: "b" }];
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, points, segments, constraints } };
    const bytes = await exportSkfProject({ projectName: "Invalid angle segment", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
    await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentIds/);
  }
});

it("rejects symmetry constraints with missing or coincident points or a degenerate axis", async () => {
  const invalidConstraints = [
    { id: "symmetry", kind: "symmetry" as const, pointIds: ["a", "missing"] as [string, string], segmentId: "line" },
    { id: "symmetry", kind: "symmetry" as const, pointIds: ["a", "a"] as [string, string], segmentId: "line" },
    { id: "symmetry", kind: "symmetry" as const, pointIds: ["a", "c"] as [string, string], segmentId: "missing" },
  ];
  for (const constraint of invalidConstraints) {
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [constraint] } };
    const bytes = await exportSkfProject({ projectName: "Invalid symmetry", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
    await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.(pointIds|segmentId)/);
  }

  const degenerate = {
    ...sketch,
    sketchProfile: {
      ...sketch.sketchProfile!,
      points: sketch.sketchProfile!.points.map((point) => point.id === "b" ? { ...point, x: 0, z: 0 } : point),
      constraints: [{ id: "symmetry", kind: "symmetry" as const, pointIds: ["a", "c"] as [string, string], segmentId: "line" }],
    },
  };
  const bytes = await exportSkfProject({ projectName: "Degenerate symmetry axis", createdAt: 1, modifiedAt: 1, shapes: [degenerate], history: [editorHistoryEntry([degenerate], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
  await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentId/);
});

it("rejects radius and diameter constraints with non-positive values or identical points", async () => {
  for (const constraint of [
    { id: "radius", kind: "radius" as const, pointIds: ["a", "b"] as [string, string], valueMm: 0 },
    { id: "diameter", kind: "diameter" as const, pointIds: ["a", "b"] as [string, string], valueMm: -1 },
    { id: "radius", kind: "radius" as const, pointIds: ["a", "a"] as [string, string], valueMm: 5 },
  ]) {
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [constraint] } };
    const bytes = await exportSkfProject({ projectName: "Invalid radius", createdAt: 1, modifiedAt: 1, shapes: [invalid], history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0 });
    await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.(valueMm|pointIds)/);
  }
});
