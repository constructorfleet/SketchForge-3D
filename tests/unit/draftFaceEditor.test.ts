import { describe, expect, it, vi } from "vitest";
import { DRAFT_FACE_PULL_AXES, applyDraftFaceSelection, draftFaceRequestForShape, draftFaceResultMetadata, faceDraftSourceIsCurrent } from "@/lib/draftFaceEditor";
import { projectShapesFingerprint } from "@/lib/engine/editorHistory";
import type { WorkplaneShape } from "@/types/sketchforge";

const base = {
  id: "part-1",
  kind: "mesh",
  x: 0,
  z: 0,
  height: 10,
  width: 20,
  depth: 20,
  rotation: 0,
  elevation: 0,
  cadBrep: "CASCADE Topology",
  cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 20, depth: 20, height: 10 },
  faceIds: ["stable-a", "stable-b", "stable-c"],
} as WorkplaneShape;

describe("face draft editor request", () => {
  it("offers all kernel pull axes to the inspector", () => {
    expect(DRAFT_FACE_PULL_AXES).toEqual(["x", "y", "z"]);
  });

  it("sends the selected stable face ID with the chosen local CAD axis", () => {
    expect(draftFaceRequestForShape(base, 1, -5, "z")).toMatchObject({
      brep: "CASCADE Topology",
      faceIds: ["stable-a", "stable-b", "stable-c"], faceId: "stable-b", angle: -5, pullDirection: "z",
    });
  });

  it("preserves a user-selected X or Y pull axis in the kernel request", () => {
    expect(draftFaceRequestForShape(base, 1, 5, "x")).toMatchObject({ faceId: "stable-b", pullDirection: "x" });
    expect(draftFaceRequestForShape(base, 1, 5, "y")).toMatchObject({ faceId: "stable-b", pullDirection: "y" });
  });

  it("passes the selected axis through the editor apply operation", async () => {
    const apply = vi.fn();
    await expect(applyDraftFaceSelection(base, 1, -5, "x", apply)).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith(1, -5, "x");
  });

  it("rejects missing exact B-rep, invalid face indices, and invalid angles", () => {
    expect(draftFaceRequestForShape({ ...base, cadBrep: undefined }, 0, 5, "z")).toBeNull();
    expect(draftFaceRequestForShape(base, -1, 5, "z")).toBeNull();
    expect(draftFaceRequestForShape(base, 3, 5, "z")).toBeNull();
    expect(draftFaceRequestForShape(base, 0, 0, "z")).toBeNull();
  });

  it("assigns new face IDs and clears stale colors and edge metadata on the baked result", () => {
    const metadata = draftFaceResultMetadata(base.id, 6);
    expect(metadata?.faceIds).toHaveLength(6);
    expect(new Set(metadata?.faceIds).size).toBe(6);
    expect(metadata).toMatchObject({
      faceColors: undefined,
      edgeTreatments: undefined,
      edgeTreatmentHistory: undefined,
      cadDisplayEdges: undefined,
      cadDisplayEdgesVersion: undefined,
    });
    expect(draftFaceResultMetadata(base.id, 0)).toBeNull();
  });

  it("discards a worker result after the source changes or the project changes", () => {
    const fingerprint = projectShapesFingerprint([base]);
    expect(faceDraftSourceIsCurrent(base, base, "project-a", "project-a", fingerprint)).toBe(true);
    expect(faceDraftSourceIsCurrent(base, { ...base, height: 11 }, "project-a", "project-a", fingerprint)).toBe(false);
    expect(faceDraftSourceIsCurrent(base, base, "project-a", "project-b", fingerprint)).toBe(false);
    expect(faceDraftSourceIsCurrent(base, undefined, "project-a", "project-a", fingerprint)).toBe(false);
  });
});
