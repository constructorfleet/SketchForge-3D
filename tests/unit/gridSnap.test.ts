import { describe, expect, it } from "vitest";
import { snapShapeFootprintToVisibleGrid, visibleGridStep } from "@/lib/gridSnap";
import { DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";
import type { WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

function groupedShape(): WorkplaneShape {
  return {
    id: "group",
    name: "Group",
    kind: "mesh",
    color: "#d41721",
    x: 3.2,
    z: -1.7,
    elevation: 2.4,
    size: 43.5,
    width: 43.5,
    depth: 19.8,
    height: 31.25,
    rotation: 0,
    groupedBaseWidth: 43.5,
    groupedBaseDepth: 19.8,
    groupedBaseHeight: 31.25,
    groupedShapes: [
      {
        id: "child-a",
        name: "Child A",
        kind: "box",
        color: "#d41721",
        x: -10.75,
        z: 1.2,
        elevation: 0,
        size: 20,
        width: 20,
        depth: 12,
        height: 20,
        rotation: 0,
      },
      {
        id: "child-b",
        name: "Child B",
        kind: "box",
        color: "#0098c7",
        x: 14.5,
        z: -2.8,
        elevation: 0,
        size: 10,
        width: 8,
        depth: 10,
        height: 31.25,
        rotation: 0,
      },
    ],
  };
}

function box(id: string, x: number, z: number, width: number, depth: number): WorkplaneShape {
  return {
    id,
    name: id,
    kind: "box",
    color: "#d41721",
    x,
    z,
    elevation: 0,
    size: Math.max(width, depth),
    width,
    depth,
    height: 10,
    rotation: 0,
  };
}

/** World-space footprint of an unrotated box, the way the editor measures it. */
function footprint(shape: WorkplaneShape) {
  return {
    minX: shape.x - (shape.width ?? 0) / 2,
    maxX: shape.x + (shape.width ?? 0) / 2,
    minZ: shape.z - (shape.depth ?? 0) / 2,
    maxZ: shape.z + (shape.depth ?? 0) / 2,
  };
}

// Shape coordinates are stored to six decimal places, so "on the lattice" is
// only ever exact to that. A shape on the wrong lattice is out by a fraction of
// a whole block, orders of magnitude more than this.
const COORDINATE_RESOLUTION = 1e-6;

function onLattice(value: number, step: number) {
  return Math.abs(value - Math.round(value / step) * step) < COORDINATE_RESOLUTION;
}

describe("Snap to Grid", () => {
  it("snaps the near footprint corner onto the world grid without resizing or changing child offsets", () => {
    const group = groupedShape();
    const snapped = snapShapeFootprintToVisibleGrid(
      group,
      { minX: -17.3, maxX: 26.2, minZ: -11.4, maxZ: 8.4 },
      { ...DEFAULT_WORKPLANE_WORKSPACE, gridBlockSize: 5 },
    );

    // The near corner lands on the lattice; the far corner follows the shape.
    expect(-17.3 + snapped.x - group.x).toBeCloseTo(-15, 6);
    expect(-11.4 + snapped.z - group.z).toBeCloseTo(-10, 6);
    expect(snapped.x).toBeCloseTo(5.5, 6);
    expect(snapped.z).toBeCloseTo(-0.3, 6);
    expect(snapped).toMatchObject({
      elevation: 2.4,
      width: 43.5,
      depth: 19.8,
      height: 31.25,
      size: 43.5,
    });
    expect(snapped.groupedShapes).toBe(group.groupedShapes);
  });

  // Upstream issue #117. The lattice used to be anchored on the workplane edge
  // (-width/2), so a plate whose span was not a whole number of grid blocks
  // snapped to a lattice that ran through neither the world origin nor the lines
  // the drag and keyboard snap use, and the two axes disagreed with each other.
  it("anchors the lattice on the world origin, not on the workplane edge", () => {
    const workspace: WorkplaneWorkspaceSettings = {
      ...DEFAULT_WORKPLANE_WORKSPACE,
      width: 203,
      depth: 187,
      gridBlockSize: 10,
    };
    const snapped = snapShapeFootprintToVisibleGrid(
      groupedShape(),
      { minX: -18, maxX: 25.5, minZ: -13, maxZ: 6.8 },
      workspace,
    );

    expect(snapped.x).toBeCloseTo(1.2, 6);
    expect(snapped.z).toBeCloseTo(1.3, 6);
  });

  // The reported symptom: "snapped" meant something different for every shape,
  // because whichever of the two footprint edges happened to be nearest a line
  // was the one that got placed on it. Two differently sized shapes therefore
  // came to rest on two different lattices and would not line up with each other.
  it("lands shapes of different sizes on the same world lattice", () => {
    const workspace = { ...DEFAULT_WORKPLANE_WORKSPACE, gridBlockSize: 5 };
    const step = visibleGridStep(workspace);

    const wide = box("wide", 1, 1, 10, 10);
    const narrow = box("narrow", 1, 1, 7, 7);

    const snappedWide = snapShapeFootprintToVisibleGrid(wide, footprint(wide), workspace);
    const snappedNarrow = snapShapeFootprintToVisibleGrid(narrow, footprint(narrow), workspace);

    const wideBounds = footprint(snappedWide);
    const narrowBounds = footprint(snappedNarrow);

    expect(onLattice(wideBounds.minX, step)).toBe(true);
    expect(onLattice(wideBounds.minZ, step)).toBe(true);
    expect(onLattice(narrowBounds.minX, step)).toBe(true);
    expect(onLattice(narrowBounds.minZ, step)).toBe(true);
    // Same lattice means the two near edges are a whole number of blocks apart.
    expect(onLattice(narrowBounds.minX - wideBounds.minX, step)).toBe(true);
    expect(onLattice(narrowBounds.minZ - wideBounds.minZ, step)).toBe(true);
  });

  it("puts every size on the lattice, however the footprint sits on its origin", () => {
    const workspace = { ...DEFAULT_WORKPLANE_WORKSPACE, gridBlockSize: 5 };
    const step = visibleGridStep(workspace);
    for (const width of [1, 3, 7, 10, 12.5, 43.5]) {
      for (const x of [-37.4, -3.1, 0, 2.2, 18.75]) {
        // An off-centre footprint: the origin sits a third of the way across it.
        const shape = box("probe", x, x, width, width);
        const bounds = {
          minX: x - width / 3,
          maxX: x + (2 * width) / 3,
          minZ: x - width / 3,
          maxZ: x + (2 * width) / 3,
        };
        const snapped = snapShapeFootprintToVisibleGrid(shape, bounds, workspace);
        const landedX = bounds.minX + (snapped.x - shape.x);
        const landedZ = bounds.minZ + (snapped.z - shape.z);
        expect(onLattice(landedX, step), `width=${width} x=${x}`).toBe(true);
        expect(onLattice(landedZ, step), `width=${width} x=${x}`).toBe(true);
      }
    }
  });

  it("never moves a shape further than half a grid block", () => {
    const workspace = { ...DEFAULT_WORKPLANE_WORKSPACE, gridBlockSize: 5 };
    for (const minX of [-11.3, -2.4, 0, 1.1, 7.6, 24.9]) {
      const shape = box("probe", minX + 5, 0, 10, 10);
      const snapped = snapShapeFootprintToVisibleGrid(
        shape,
        { minX, maxX: minX + 10, minZ: minX, maxZ: minX + 10 },
        workspace,
      );
      expect(Math.abs(snapped.x - shape.x)).toBeLessThanOrEqual(2.5 + 1e-9);
    }
  });

  it("leaves a shape alone when its footprint cannot be measured", () => {
    const shape = box("probe", 3.2, -1.7, 10, 10);
    const snapped = snapShapeFootprintToVisibleGrid(
      shape,
      { minX: Number.NaN, maxX: 10, minZ: -5, maxZ: 5 },
      DEFAULT_WORKPLANE_WORKSPACE,
    );

    expect(snapped.x).toBe(3.2);
    expect(snapped.z).toBe(-1.7);
  });
});
