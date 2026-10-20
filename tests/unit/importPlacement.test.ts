import { describe, expect, it } from "vitest";
import { importedShapeFromObj } from "@/lib/engine/objImport";
import { importedShapeFromStl } from "@/lib/engine/stlImport";

function boxStl(width: number, ySize: number, zSize: number, name = "box") {
  const vertices = [
    [0, 0, 0], [width, 0, 0], [width, ySize, 0], [0, ySize, 0],
    [0, 0, zSize], [width, 0, zSize], [width, ySize, zSize], [0, ySize, zSize],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const facets = faces.map(([a, b, c]) => `facet normal 0 0 0
  outer loop
    vertex ${vertices[a].join(" ")}
    vertex ${vertices[b].join(" ")}
    vertex ${vertices[c].join(" ")}
  endloop
endfacet`).join("\n");
  return new TextEncoder().encode(`solid ${name}\n${facets}\nendsolid ${name}`).buffer;
}

// The importers already centre the geometry on its own bounding box in X and Z
// and seat it on the plane in Y, so any non-zero placement offset moves the
// model away from the centre it was just brought to.
//
// importedShapeFromSvg carries the same placement, but reaching it needs a
// DOMParser, which this node-environment suite does not provide -- the same
// reason svgImport.test.ts exercises the pieces below that entry point.
describe("imported models land on the workplane centre", () => {
  it("places an imported STL at the origin", () => {
    const shape = importedShapeFromStl("box.stl", boxStl(80, 60, 20));
    expect(shape.x).toBe(0);
    expect(shape.z).toBe(0);
  });

  it("places an imported OBJ at the origin", () => {
    const shape = importedShapeFromObj("panel.obj", [
      "v 0 0 0", "v 2 0 0", "v 2 3 0", "v 0 3 0", "f 1 2 3 4",
    ].join("\n"));
    expect(shape.x).toBe(0);
    expect(shape.z).toBe(0);
  });

});
