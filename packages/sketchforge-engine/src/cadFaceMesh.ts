import type { OcctKernel, ShapeHandle, TessellateOptions } from "occt-wasm";

/** The upper bound `meshShape` uses when it hashes a face into a face group. */
const FACE_HASH_UPPER_BOUND = 2_147_483_647;

export type CadFaceMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  /**
   * Triangle start, triangle count and B-rep face index triples, where the face
   * index is the position of the face in `getSubShapes(shape, "face")` -- the
   * numbering the inspector, `GET /faces` and `faceColors` use.
   */
  faceGroups: number[];
};

/**
 * Mesh an exact shape and say which triangles belong to which B-rep face.
 *
 * `tessellate` gives triangles only, so a face colour stored on the shape had
 * nothing to paint in the viewport. `meshShape` reports each face as a range of
 * index-buffer entries and a face hash; this converts the range to triangles
 * and the hash to the face's index. A hash that maps to no face, or
 * to more than one, is dropped rather than guessed, and that face simply
 * previews in the shape's base colour.
 */
export function meshShapeWithFaceGroups(cad: OcctKernel, shape: ShapeHandle, options?: TessellateOptions): CadFaceMesh {
  const mesh = cad.meshShape(shape, options);
  const faces = cad.getSubShapes(shape, "face");
  try {
    const indexByHash = new Map<number, number | null>();
    faces.forEach((face, index) => {
      const hash = cad.hashCode(face, FACE_HASH_UPPER_BOUND);
      indexByHash.set(hash, indexByHash.has(hash) ? null : index);
    });
    const faceGroups = triangleFaceGroups(mesh.faceGroups, indexByHash);
    return {
      positions: new Float32Array(mesh.positions),
      normals: new Float32Array(mesh.normals),
      indices: new Uint32Array(mesh.indices),
      triangleCount: mesh.triangleCount,
      faceGroups,
    };
  } finally {
    faces.forEach((face) => cad.release(face));
  }
}

/**
 * Convert the kernel's face groups -- index-buffer ranges, three entries per
 * triangle, each naming its face by hash -- to triangle ranges naming the face
 * by its index. A group whose hash is unknown or ambiguous (`null`) is dropped.
 */
export function triangleFaceGroups(raw: ArrayLike<number> | undefined, faceIndexByHash: ReadonlyMap<number, number | null>) {
  const faceGroups: number[] = [];
  for (let group = 0; raw && group + 2 < raw.length; group += 3) {
    const index = faceIndexByHash.get(raw[group + 2]!);
    if (index === undefined || index === null) continue;
    faceGroups.push(raw[group]! / 3, raw[group + 1]! / 3, index);
  }
  return faceGroups;
}
