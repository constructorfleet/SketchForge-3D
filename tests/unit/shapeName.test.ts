import { describe, expect, it } from "vitest";
import { normalizeRenamedShapeName } from "@/lib/shapeName";

describe("normalizeRenamedShapeName", () => {
  it("trims a submitted name before it is saved", () => {
    expect(normalizeRenamedShapeName("Box", "  Base plate  ")).toBe("Base plate");
  });

  it("rejects blank names and unchanged names", () => {
    expect(normalizeRenamedShapeName("Box", "   ")).toBeNull();
    expect(normalizeRenamedShapeName("Base plate", " Base plate ")).toBeNull();
  });
});
