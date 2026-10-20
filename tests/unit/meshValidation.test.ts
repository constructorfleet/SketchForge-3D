import { describe, expect, it } from "vitest";
import { analyzeMeshTopology } from "@sketchforge/engine/meshValidation";

describe("analyzeMeshTopology", () => {
  it("recognizes a closed tetrahedron as watertight", () => {
    const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
    const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] as const;
    expect(analyzeMeshTopology(vertices, faces)).toMatchObject({ triangles: 4, boundaryEdges: 0, nonManifoldEdges: 0, degenerateTriangles: 0, watertight: true });
  });

  it("reports open boundaries, degenerate faces, and edges used by three faces", () => {
    const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, 0]] as const;
    const faces = [[0, 1, 2], [1, 0, 3], [0, 1, 4], [0, 1, 5]] as const;
    expect(analyzeMeshTopology(vertices, faces)).toMatchObject({ boundaryEdges: 6, nonManifoldEdges: 1, degenerateTriangles: 1, watertight: false });
  });
});
