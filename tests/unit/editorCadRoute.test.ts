import { beforeEach, describe, expect, it, vi } from "vitest";

const { exportProjectScene } = vi.hoisted(() => ({ exportProjectScene: vi.fn() }));

vi.mock("@constructorfleet/sketchforge-engine/sceneExport", () => ({ exportProjectScene }));
vi.mock("@constructorfleet/sketchforge-engine/serverCadProperties", () => ({ shapeProperties: vi.fn() }));
vi.mock("@constructorfleet/sketchforge-engine/serverCadMeasure", () => ({ measureBetween: vi.fn() }));

import { POST } from "@/app/api/editor/cad/route";

describe("editor CAD export route", () => {
  beforeEach(() => {
    exportProjectScene.mockReset();
    exportProjectScene.mockResolvedValue({
      format: "step",
      filename: "Revolve.step",
      mimeType: "model/step",
      data: new Uint8Array([1, 2, 3]),
      shapeCount: 1,
      exportedCount: 1,
      skipped: [],
    });
  });

  it("allows editor STEP export of the current in-memory shapes", async () => {
    const response = await POST(new Request("http://localhost/api/editor/cad", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "export", projectId: "project-1", format: "step", name: "Revolve", shapes: [{ id: "revolve-1", name: "Revolve", kind: "mesh" }] }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/step");
    expect(response.headers.get("X-SketchForge-Exported-Count")).toBe("1");
    expect(response.headers.get("X-SketchForge-Skipped-Count")).toBe("0");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(exportProjectScene).toHaveBeenCalledWith(
      expect.objectContaining({ shapes: [{ id: "revolve-1", name: "Revolve", kind: "mesh" }] }),
      expect.objectContaining({ format: "step" }),
    );
  });
});
