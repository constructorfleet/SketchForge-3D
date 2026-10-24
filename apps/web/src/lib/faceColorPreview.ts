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

  const unit = faceGroupUnit(mesh.faceGroups, triangleCount);
  for (let group = 0; group + 2 < mesh.faceGroups.length; group += 3) {
    const start = mesh.faceGroups[group]! / unit;
    const count = mesh.faceGroups[group + 1]! / unit;
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

/** Build only the selected B-rep face's outer wire for a viewport edit cue. */
export function createFaceHighlightGeometry(mesh: FaceGroupedMesh, selectedFaceIndex: number) {
  const triangleCount = Math.floor(mesh.positions.length / 9);
  const unit = faceGroupUnit(mesh.faceGroups, triangleCount);
  const edges = new Map<string, { count: number; points: number[] }>();
  for (let group = 0; group + 2 < mesh.faceGroups.length; group += 3) {
    if (mesh.faceGroups[group + 2] !== selectedFaceIndex) continue;
    const start = mesh.faceGroups[group]! / unit;
    const count = mesh.faceGroups[group + 1]! / unit;
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0) continue;
    const end = Math.min(triangleCount, start + count);
    for (let triangle = start; triangle < end; triangle += 1) {
      const vertices = Array.from({ length: 3 }, (_, vertex) => {
        const offset = triangle * 9 + vertex * 3;
        return [mesh.positions[offset]!, mesh.positions[offset + 1]!, mesh.positions[offset + 2]!];
      });
      for (let edge = 0; edge < 3; edge += 1) {
        const a = vertices[edge]!;
        const b = vertices[(edge + 1) % 3]!;
        const keyFor = (point: number[]) => point.map((coordinate) => Math.round(coordinate * 1e5)).join(",");
        const aKey = keyFor(a);
        const bKey = keyFor(b);
        const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
        const existing = edges.get(key);
        if (existing) existing.count += 1;
        else edges.set(key, { count: 1, points: [...a, ...b] });
      }
    }
  }
  const positions: number[] = [];
  edges.forEach(({ count, points }) => { if (count === 1) positions.push(...points); });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Server CAD results stored by earlier versions kept the kernel's ranges as-is, in
 * index-buffer entries (three per triangle), so their groups cover three times
 * the triangles the mesh has. Ranges in triangles never can, which tells the
 * two apart without a format flag.
 */
function faceGroupUnit(faceGroups: readonly number[], triangleCount: number) {
  let total = 0;
  for (let group = 0; group + 2 < faceGroups.length; group += 3) {
    const start = faceGroups[group]!;
    const count = faceGroups[group + 1]!;
    if (start % 3 !== 0 || count % 3 !== 0) return 1;
    total += count;
  }
  return triangleCount > 0 && total === triangleCount * 3 ? 3 : 1;
}
