import * as THREE from "three";

type FaceGroupedMesh = {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  /** Triangle start, count, and GET /faces index triples. */
  faceGroups: readonly number[];
  /** Stable ID for each GET /faces index, when the imported shape has them. */
  faceIds?: readonly string[];
};

/** Build a viewport mesh with persisted face colors applied to tessellated triangles. */
export function createFaceColorPreviewGeometry(mesh: FaceGroupedMesh, faceColors: Record<string, string>, baseColor: string) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(mesh.positions), 3));
  if (mesh.normals?.length === mesh.positions.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(Array.from(mesh.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }

  const triangleCount = Math.floor(mesh.positions.length / 9);
  const colors = new Float32Array(triangleCount * 9);
  const base = new THREE.Color(baseColor);
  for (let index = 0; index < colors.length; index += 3) {
    colors[index] = base.r;
    colors[index + 1] = base.g;
    colors[index + 2] = base.b;
  }

  for (let group = 0; group + 2 < mesh.faceGroups.length; group += 3) {
    const start = mesh.faceGroups[group]!;
    const count = mesh.faceGroups[group + 1]!;
    const faceIndex = mesh.faceGroups[group + 2]!;
    const faceId = mesh.faceIds?.[faceIndex];
    const color = (faceId ? faceColors[faceId] : undefined) ?? faceColors[faceIndex];
    if (!color || !Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0) continue;
    const value = new THREE.Color(color);
    const end = Math.min(triangleCount, start + count);
    for (let triangle = start; triangle < end; triangle += 1) {
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const offset = (triangle * 3 + vertex) * 3;
        colors[offset] = value.r;
        colors[offset + 1] = value.g;
        colors[offset + 2] = value.b;
      }
    }
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}
