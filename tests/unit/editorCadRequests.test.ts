import { describe, expect, it } from "vitest";
import { editorExportRequest, editorMeasureRequest } from "@/lib/editorCadRequests";

describe("editor CAD requests", () => {
  it("builds a kernel distance request for two selected shapes", () => {
    expect(editorMeasureRequest("project-1", { id: "left" }, { id: "right" })).toEqual({
      url: "/api/editor/cad",
      body: { operation: "measure", projectId: "project-1", from: { shape: { id: "left" }, entity: "shape" }, to: { shape: { id: "right" }, entity: "shape" } },
    });
  });

  it("keeps section drawing options in the export request", () => {
    expect(editorExportRequest("project 1", "dxf", "Plate", { plane: "xy", offset: 4 }, [{ id: "a" }])).toEqual({
      url: "/api/editor/cad",
      body: { operation: "export", projectId: "project 1", format: "dxf", name: "Plate", section: { plane: "xy", offset: 4 }, shapes: [{ id: "a" }] },
    });
  });
});
