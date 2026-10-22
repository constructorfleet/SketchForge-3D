import { describe, expect, it } from "vitest";
import { runHolePlateWalkthrough } from "../../../docs/examples/rest-hole-plate.mjs";

describe("REST API hole-plate walkthrough", () => {
  it("creates six operands and returns one boolean-cut shape with less volume", async () => {
    const result = await runHolePlateWalkthrough();

    expect(result.createdShapeCount).toBe(6);
    expect(result.holeCount).toBe(5);
    expect(result.resultingShapeCount).toBe(1);
    expect(result.groupedShapeCount).toBe(6);
    expect(result.cutVolume).toBeGreaterThan(0);
    expect(result.cutVolume).toBeLessThan(result.plateVolume);
  });
});
