import { describe, expect, it } from "vitest";
import { interiorWorkplaneGridCoordinates, workplaneGridPalette, workplaneThemePalette, WORKPLANE_LINE_ELEVATION, WORKPLANE_MAJOR_GRID_INTERVAL } from "@/lib/workplaneGrid";

describe("workplane grid geometry", () => {
  it("excludes both perimeter coordinates when spacing divides the workplane", () => {
    const coordinates = interiorWorkplaneGridCoordinates(200, 5).map(({ coordinate }) => coordinate);

    expect(coordinates).not.toContain(-100);
    expect(coordinates).not.toContain(100);
    expect(coordinates).toContain(0);
    expect(coordinates.at(0)).toBe(-95);
    expect(coordinates.at(-1)).toBe(95);
  });

  // Upstream issue #117: the lattice used to start at the near plate edge, so a
  // plate that is not a whole number of blocks across drew no line through the
  // origin at all and disagreed with where a snap put a shape.
  it("anchors custom spacing on the world origin rather than the plate edge", () => {
    const coordinates = interiorWorkplaneGridCoordinates(200, 30).map(({ coordinate }) => coordinate);

    expect(coordinates).toEqual([-90, -60, -30, 0, 30, 60, 90]);
  });

  it("draws every line a whole number of blocks from the origin, whatever the plate measures", () => {
    for (const span of [200, 203, 187, 97.5, 2000]) {
      for (const step of [1, 5, 8, 10, 30]) {
        for (const { coordinate } of interiorWorkplaneGridCoordinates(span, step)) {
          expect(coordinate / step, `span=${span} step=${step} at=${coordinate}`)
            .toBeCloseTo(Math.round(coordinate / step), 9);
          expect(Math.abs(coordinate)).toBeLessThan(span / 2);
        }
      }
    }
  });

  it("keeps the origin as an axis line on an odd plate", () => {
    const coordinates = interiorWorkplaneGridCoordinates(203, 10).map(({ coordinate }) => coordinate);

    expect(coordinates).toContain(0);
    expect(coordinates.at(0)).toBe(-100);
    expect(coordinates.at(-1)).toBe(100);
  });

  it("numbers lines by their distance from the origin, so major lines do not slide when the plate is resized", () => {
    const narrow = interiorWorkplaneGridCoordinates(100, 5);
    const wide = interiorWorkplaneGridCoordinates(200, 5);
    const majorOf = (entries: typeof narrow) =>
      entries.filter(({ index }) => index % WORKPLANE_MAJOR_GRID_INTERVAL === 0).map(({ coordinate }) => coordinate);

    expect(majorOf(narrow).every((coordinate) => majorOf(wide).includes(coordinate))).toBe(true);
    expect(majorOf(narrow)).toContain(0);
    expect(majorOf(narrow)).toContain(25);

    // A step that does not divide the half span is where counting from the first
    // drawn line and counting from the origin come apart: counted from the edge
    // the major lines would land on -48, -8 and 32 instead.
    const brick = interiorWorkplaneGridCoordinates(100, 8);
    expect(majorOf(brick)).toEqual([-40, 0, 40]);
  });

  it("uses one elevation for grid and border lines", () => {
    expect(WORKPLANE_LINE_ELEVATION).toBe(0);
  });

  it("groups minor grid blocks into five-by-five major sections", () => {
    expect(WORKPLANE_MAJOR_GRID_INTERVAL).toBe(5);
  });

  it("preserves the minor, major, and axis line hierarchy", () => {
    const palette = workplaneGridPalette();

    expect(palette.minor.opacity).toBeLessThan(palette.major.opacity);
    expect(palette.major.opacity).toBeLessThan(palette.axis.opacity);
    expect(palette.minor.color).not.toBe(palette.major.color);
  });

  it("uses a complete dark viewport palette without changing the configured project background", () => {
    const configuredBackground = "#f8fbfc";
    const dark = workplaneThemePalette("dark", configuredBackground);
    const light = workplaneThemePalette("light", configuredBackground);

    expect(dark.sceneBackground).not.toBe(configuredBackground);
    expect(dark.surface.color).not.toBe(light.surface.color);
    expect(dark.grid.minor.color).not.toBe(light.grid.minor.color);
    expect(light.sceneBackground).toBe(configuredBackground);
  });

  it("applies a custom project grid color while retaining line hierarchy", () => {
    const customColor = "#c23b72";
    const palette = workplaneGridPalette("light", customColor);

    expect(palette.minor.color).toBe(customColor);
    expect(palette.major.color).toBe(customColor);
    expect(palette.axis.color).toBe(customColor);
    expect(palette.minor.opacity).toBeLessThan(palette.major.opacity);
    expect(palette.major.opacity).toBeLessThan(palette.axis.opacity);
  });
});
