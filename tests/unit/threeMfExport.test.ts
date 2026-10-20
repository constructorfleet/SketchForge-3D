import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sketchForgeToZUp } from "@/lib/meshCoordinates";
import { meshVolumeCentroid, meshVolumeMm3 } from "@/lib/materialPresets";
import {
  THREE_MF_CONTENT_TYPES_PATH,
  THREE_MF_CORE_NAMESPACE,
  THREE_MF_MODEL_CONTENT_TYPE,
  THREE_MF_MODEL_PATH,
  THREE_MF_MODEL_RELATIONSHIP,
  THREE_MF_RELS_PATH,
  displayColorFor,
  exportMeshesTo3mf,
  threeMfModelXml,
  type ThreeMfExportMesh,
} from "@/lib/threeMfExport";

/**
 * Axis-aligned box as 12 triangles with outward winding.
 *
 * Coordinates are SketchForge's Y-up scene convention, which is what the
 * editor hands the exporters.
 */
function boxMesh(
  name: string,
  { x, y, z }: { x: number; y: number; z: number },
  { width, height, depth }: { width: number; height: number; depth: number },
  color?: string,
): ThreeMfExportMesh {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const vertices: [number, number, number][] = [
    [x - hw, y - hh, z - hd],
    [x + hw, y - hh, z - hd],
    [x + hw, y - hh, z + hd],
    [x - hw, y - hh, z + hd],
    [x - hw, y + hh, z - hd],
    [x + hw, y + hh, z - hd],
    [x + hw, y + hh, z + hd],
    [x - hw, y + hh, z + hd],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  return { name, vertices, faces, ...(color ? { color } : {}) };
}

type ParsedObject = {
  id: string;
  name: string;
  pid: string;
  pindex: string;
  vertices: [number, number, number][];
  triangles: [number, number, number][];
};

function parseObjects(model: string): ParsedObject[] {
  return [...model.matchAll(/<object id="([^"]+)" type="model" pid="([^"]+)" pindex="([^"]+)" name="([^"]*)">([\s\S]*?)<\/object>/g)]
    .map((match) => ({
      id: match[1],
      pid: match[2],
      pindex: match[3],
      name: match[4],
      vertices: [...match[5].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
        .map((vertex) => [Number(vertex[1]), Number(vertex[2]), Number(vertex[3])] as [number, number, number]),
      triangles: [...match[5].matchAll(/<triangle v1="([^"]+)" v2="([^"]+)" v3="([^"]+)"\/>/g)]
        .map((triangle) => [Number(triangle[1]), Number(triangle[2]), Number(triangle[3])] as [number, number, number]),
    }));
}

function parseItems(model: string) {
  return [...model.matchAll(/<item objectid="([^"]+)" transform="([^"]+)"\/>/g)].map((match) => ({
    objectId: match[1],
    transform: match[2].split(" ").map(Number),
  }));
}

/** Applies a 3MF row-major 3x4 item transform to a point. */
function applyTransform(transform: number[], [x, y, z]: [number, number, number]): [number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22, m30, m31, m32] = transform;
  return [
    x * m00 + y * m10 + z * m20 + m30,
    x * m01 + y * m11 + z * m21 + m31,
    x * m02 + y * m12 + z * m22 + m32,
  ];
}

describe("3MF archive structure", () => {
  it("writes the three OPC parts a 3MF needs, in package order", async () => {
    const archive = unzipSync(await exportMeshesTo3mf([boxMesh("cube", { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 })]));
    expect(Object.keys(archive)).toEqual([THREE_MF_CONTENT_TYPES_PATH, THREE_MF_RELS_PATH, THREE_MF_MODEL_PATH]);
  });

  it("declares the model content type and the package relationship", async () => {
    const archive = unzipSync(await exportMeshesTo3mf([boxMesh("cube", { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 })]));
    const contentTypes = new TextDecoder().decode(archive[THREE_MF_CONTENT_TYPES_PATH]);
    const rels = new TextDecoder().decode(archive[THREE_MF_RELS_PATH]);

    expect(contentTypes).toContain('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>');
    expect(contentTypes).toContain(`<Default Extension="model" ContentType="${THREE_MF_MODEL_CONTENT_TYPE}"/>`);
    expect(rels).toContain(`Target="/${THREE_MF_MODEL_PATH}"`);
    expect(rels).toContain(`Type="${THREE_MF_MODEL_RELATIONSHIP}"`);
  });

  it("is byte-identical between runs so the same design exports reproducibly", async () => {
    const meshes = [boxMesh("cube", { x: 3, y: 10, z: -4 }, { width: 20, height: 20, depth: 20 }, "#ff0000")];
    const first = await exportMeshesTo3mf(meshes);
    const second = await exportMeshesTo3mf(meshes);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));

    // Reproducibility rests on the pinned ZIP timestamp, so check the DOS
    // date in the first local file header rather than only comparing two runs
    // made in the same second.
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(10, true)).toBe(0); // midnight
    expect(view.getUint16(12, true)).toBe((1980 - 1980) << 9 | 1 << 5 | 1); // 1980-01-01
  });
});

describe("3MF model XML", () => {
  it("declares the core namespace and millimeter units", () => {
    const model = threeMfModelXml([boxMesh("cube", { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 })]);
    expect(model.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(model).toContain(`<model unit="millimeter" xml:lang="en-US" xmlns="${THREE_MF_CORE_NAMESPACE}">`);
  });

  it("writes one object and one build item per shape, with distinct resource ids", () => {
    const model = threeMfModelXml([
      boxMesh("first", { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 }),
      boxMesh("second", { x: 40, y: 5, z: 0 }, { width: 10, height: 10, depth: 10 }),
    ]);
    const objects = parseObjects(model);
    const items = parseItems(model);

    expect(objects.map((object) => object.name)).toEqual(["first", "second"]);
    expect(objects.map((object) => object.id)).toEqual(["2", "3"]);
    // Resource ids share one namespace with the base-materials group at id 1.
    expect(model).toContain('<basematerials id="1">');
    expect(objects.every((object) => object.pid === "1")).toBe(true);
    expect(objects.map((object) => object.pindex)).toEqual(["0", "1"]);
    expect(items.map((item) => item.objectId)).toEqual(["2", "3"]);
  });

  it("carries each shape's color as a core displaycolor rather than an extension", () => {
    const model = threeMfModelXml([
      boxMesh("red", { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 }, "#ff0000"),
      boxMesh("plain", { x: 40, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 }),
    ]);
    expect(model).toContain('<base name="red" displaycolor="#FF0000FF"/>');
    expect(model).toContain(`<base name="plain" displaycolor="${displayColorFor(undefined)}"/>`);
    // No extension namespace is declared, so no requiredextensions is needed
    // and a reader that ignores color still gets the geometry.
    expect(model).not.toContain("requiredextensions");
    expect(model).not.toContain("3dmanufacturing/material");
  });

  it("escapes XML metacharacters in shape names", () => {
    const model = threeMfModelXml([boxMesh('bracket <A> & "B"', { x: 0, y: 10, z: 0 }, { width: 20, height: 20, depth: 20 })]);
    expect(model).toContain('name="bracket &lt;A&gt; &amp; &quot;B&quot;"');
    expect(model).not.toContain("<A>");
  });

  it("writes plain decimals rather than exponent notation for tiny coordinates", () => {
    const model = threeMfModelXml([boxMesh("tiny", { x: 0, y: 5e-7, z: 0 }, { width: 1e-6, height: 1e-6, depth: 1e-6 })]);
    expect(model).not.toMatch(/<vertex[^>]*[0-9]e-/);
    expect(model).toMatch(/<vertex x="0\.0*5?[0-9]*"/);
  });
});

describe("3MF mesh round-trip", () => {
  // Raised off the plate as well as offset in X/Y, so "centred on its own
  // origin and resting on z = 0" is a real claim and not true by accident.
  const source = boxMesh("cube", { x: 7, y: 30, z: -13 }, { width: 20, height: 20, depth: 20 });

  it("keeps every triangle", () => {
    const [object] = parseObjects(threeMfModelXml([source]));
    expect(object.triangles.length).toBe(source.faces.length);
    expect(object.triangles.length).toBe(12);
    expect(object.triangles).toEqual(source.faces);
    expect(object.vertices.length).toBe(source.vertices.length);
  });

  it("reproduces the source vertex coordinates once the item transform is applied", () => {
    const model = threeMfModelXml([source]);
    const [object] = parseObjects(model);
    const [item] = parseItems(model);

    expect(item.transform.length).toBe(12);
    // Rotation block is the identity; the placement is the translation.
    expect(item.transform.slice(0, 9)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const placed = object.vertices.map((vertex) => applyTransform(item.transform, vertex));
    const expected = source.vertices.map((vertex) => sketchForgeToZUp(vertex));
    placed.forEach((vertex, index) => {
      vertex.forEach((value, axis) => expect(value).toBeCloseTo(expected[index][axis], 9));
    });
  });

  it("stores the object centred on its own origin and resting on z = 0", () => {
    const [object] = parseObjects(threeMfModelXml([source]));
    const xs = object.vertices.map((vertex) => vertex[0]);
    const ys = object.vertices.map((vertex) => vertex[1]);
    const zs = object.vertices.map((vertex) => vertex[2]);

    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0, 9);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(0, 9);
    expect(Math.min(...zs)).toBeCloseTo(0, 9);
  });

  it("preserves the volume and the centre of the solid, not just its extents", () => {
    const model = threeMfModelXml([source]);
    const [object] = parseObjects(model);
    const [item] = parseItems(model);
    const placed = { vertices: object.vertices.map((vertex) => applyTransform(item.transform, vertex)), faces: object.triangles };
    const expectedVertices = source.vertices.map((vertex) => sketchForgeToZUp(vertex));

    // A 20 mm cube is 8000 mm3, whatever frame it is written in.
    expect(meshVolumeMm3(placed)).toBeCloseTo(8000, 6);
    expect(meshVolumeMm3({ vertices: object.vertices, faces: object.triangles })).toBeCloseTo(8000, 6);

    const centre = meshVolumeCentroid(placed);
    const expectedCentre = meshVolumeCentroid({ vertices: expectedVertices, faces: source.faces });
    centre.forEach((value, axis) => expect(value).toBeCloseTo(expectedCentre[axis], 9));
    // The source cube is centred at scene (7, 30, -13), which is Z-up (7, 13, 30).
    expect(centre[0]).toBeCloseTo(7, 9);
    expect(centre[1]).toBeCloseTo(13, 9);
    expect(centre[2]).toBeCloseTo(30, 9);
  });

  it("converts the Y-up scene into the Z-up convention slicers expect", () => {
    const [object] = parseObjects(threeMfModelXml([boxMesh("tall", { x: 0, y: 15, z: 0 }, { width: 10, height: 30, depth: 20 })]));
    const zs = object.vertices.map((vertex) => vertex[2]);
    const ys = object.vertices.map((vertex) => vertex[1]);
    // Height (30) lands on Z and depth (20) on Y.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(30, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 9);
  });
});

describe("3MF display colors", () => {
  it("expands shorthand hex and appends full opacity", () => {
    expect(displayColorFor("#f00")).toBe("#FF0000FF");
    expect(displayColorFor("#1fb66d")).toBe("#1FB66DFF");
    expect(displayColorFor("#1fb66d80")).toBe("#1FB66D80");
  });

  it("falls back to a neutral color for anything that is not hex", () => {
    expect(displayColorFor("rebeccapurple")).toBe("#CFD8DFFF");
    expect(displayColorFor(undefined)).toBe("#CFD8DFFF");
  });
});

describe("3MF empty design", () => {
  it("writes a valid empty package rather than an empty basematerials group", async () => {
    const model = threeMfModelXml([]);
    expect(model).not.toContain("basematerials");
    expect(model).toContain("<build>");
    const archive = unzipSync(await exportMeshesTo3mf([]));
    expect(Object.keys(archive)).toContain(THREE_MF_MODEL_PATH);
  });
});
