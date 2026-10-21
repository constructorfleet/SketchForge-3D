import { describe, expect, it } from "vitest";
import { apiShapeSummary } from "@/lib/apiShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

describe("API shape summaries", () => {
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
