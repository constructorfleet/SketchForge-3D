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
});
