import { describe, expect, it } from "vitest";
import { runImportInspectExportWalkthrough } from "../../../docs/examples/rest-import-inspect-export.mjs";

describe("REST API import-inspect-export walkthrough", () => {
  it("imports a supported STL, inspects its shape, and exports an STL artifact", async () => {
    const result = await runImportInspectExportWalkthrough();

    expect(result.importFormat).toBe("stl");
    expect(result.triangles).toBeGreaterThan(0);
    expect(result.inspectedVolume).toBeGreaterThan(0);
    expect(result.exportFormat).toBe("stl");
    expect(result.exportedShapeCount).toBe(1);
    expect(result.exportedBytes).toBeGreaterThan(0);
  });
});
