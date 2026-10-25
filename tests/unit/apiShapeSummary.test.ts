import { describe, expect, it } from "vitest";
import { apiShapeSummary } from "@/lib/apiShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

describe("API shape summaries", () => {
  it("returns STEP occurrence identity and ancestry for an exploded component", () => {
    const stepComponent = {
      id: "step-occurrence:12/solid-1",
      occurrenceId: "step-occurrence:12",
      path: [
        { id: "step-node:0", name: "MainAssembly" },
        { id: "step-occurrence:12", name: "SensorLeft" },
      ],
    };
    const shape = {
      id: "sensor-left",
      name: "SensorLeft",
      kind: "mesh",
      color: "#0098c7",
      x: 0,
      z: 0,
      size: 4,
      width: 2,
      depth: 2,
      height: 4,
      rotation: 0,
      stepComponent,
    } as WorkplaneShape;

    expect(apiShapeSummary(shape).stepComponent).toEqual(stepComponent);
  });

  it("returns nested STEP product names and direct children from stored shape metadata", () => {
    const stepAssembly = [{
      name: "MainAssembly",
      children: [{
        name: "Sensors",
        children: [{ name: "SensorLeft", children: [] }],
      }],
    }];
    const shape = {
      id: "step-model",
      name: "nested-assembly",
      kind: "mesh",
      color: "#0098c7",
      x: 0,
      z: 0,
      size: 12,
      width: 12,
      depth: 8,
      height: 4,
      rotation: 0,
      stepAssembly,
    } as WorkplaneShape;

    expect(apiShapeSummary(shape).stepAssembly).toEqual(stepAssembly);
  });

  it("returns the persisted draft-prism angle for source-driven edits", () => {
    const shape = {
      id: "drafted-extrusion",
      name: "Drafted extrusion",
      kind: "mesh",
      color: "#0098c7",
      x: 0,
      z: 0,
      size: 4,
      width: 2,
      depth: 2,
      height: 4,
      rotation: 0,
      sketchOperation: "extrude",
      sketchSourceId: "sketch/source-extrusion",
      draftPrismAngle: 12,
    } as WorkplaneShape;

    expect(apiShapeSummary(shape)).toMatchObject({
      sketchSourceId: "sketch/source-extrusion",
      draftPrismAngle: 12,
    });
  });

  it("reports where a partial revolve's axis is, beside its box centre (#503)", () => {
    const shape = {
      id: "quarter-ring",
      name: "Revolve",
      kind: "mesh",
      color: "#78b96b",
      x: 37.5,
      z: -37.5,
      size: 75,
      width: 75,
      depth: 75,
      height: 10,
      rotation: 0,
      importedMesh: { positions: [], baseWidth: 75, baseDepth: 75, baseHeight: 10, triangleCount: 0, sourceFormat: "json" },
      sketchProfile: { points: [], segments: [], images: [] },
      sketchOperation: "revolve",
      sketchRevolve: { startAngle: 0, sweepAngle: 90, sides: 64, quality: 6, pitch: 0, turns: 1, coreRadius: 0 },
      revolveAxisOffset: { x: 37.5, z: -37.5 },
    } as WorkplaneShape;

    expect(apiShapeSummary(shape).revolve).toMatchObject({ sweepAngle: 90, axis: { x: 0, z: 0 } });
    // A revolve saved before the axis was recorded says nothing rather than guessing.
    expect(apiShapeSummary({ ...shape, revolveAxisOffset: undefined }).revolve).not.toHaveProperty("axis");
    // Tilted, the axis is no longer vertical, so no single workplane point is
    // where it stands. Turned upside down it is vertical again, and the quarter
    // flipped over the X axis lies on +Z of it.
    expect(apiShapeSummary({ ...shape, rotationX: 30 }).revolve).not.toHaveProperty("axis");
    expect(apiShapeSummary({ ...shape, rotationZ: 90 }).revolve).not.toHaveProperty("axis");
    expect(apiShapeSummary({ ...shape, z: 37.5, rotationX: 180 }).revolve).toMatchObject({ axis: { x: expect.closeTo(0, 6), z: expect.closeTo(0, 6) } });
  });
});
