import * as THREE from "three";

type FaceGroupedMesh = {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  /** Triangle start, count, and GET /faces index triples. */
  faceGroups: readonly number[];
  /** Stable ID for each GET /faces index, when the imported shape has them. */
  faceIds?: readonly string[];
};

const FACE_HIGHLIGHT_OFFSET_MM = 0.1;

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
      const ab = vertices[1]!.map((coordinate, axis) => coordinate - vertices[0]![axis]!);
      const ac = vertices[2]!.map((coordinate, axis) => coordinate - vertices[0]![axis]!);
      const cross = [
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      ];
      const crossLength = Math.hypot(...cross) || 1;
      const faceNormal = cross.map((coordinate) => coordinate / crossLength);
      const liftedVertices = vertices.map((point, vertex) => {
        const normalOffset = triangle * 9 + vertex * 3;
        const normal = mesh.normals && mesh.normals.length >= normalOffset + 3
          ? [mesh.normals[normalOffset]!, mesh.normals[normalOffset + 1]!, mesh.normals[normalOffset + 2]!]
          : faceNormal;
        const length = Math.hypot(...normal) || 1;
        return point.map((coordinate, axis) => coordinate + (normal[axis]! / length) * FACE_HIGHLIGHT_OFFSET_MM);
      });
      for (let edge = 0; edge < 3; edge += 1) {
        const a = vertices[edge]!;
        const b = vertices[(edge + 1) % 3]!;
        const liftedA = liftedVertices[edge]!;
        const liftedB = liftedVertices[(edge + 1) % 3]!;
        const keyFor = (point: number[]) => point.map((coordinate) => Math.round(coordinate * 1e5)).join(",");
        const aKey = keyFor(a);
        const bKey = keyFor(b);
        const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
        const existing = edges.get(key);
        if (existing) existing.count += 1;
        else edges.set(key, { count: 1, points: [...liftedA, ...liftedB] });
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

/**
 * The exact face a mesh triangle belongs to, read from the mesh's face groups
 * (start, count, face index), or null when no group covers it. Used to turn a
 * viewport hit into the face the inspector's face tools act on.
 */
export function faceAtTriangle(faceGroups: readonly number[], triangleCount: number, triangle: number): number | null {
  if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) return null;
  const unit = faceGroupUnit(faceGroups, triangleCount);
  for (let group = 0; group + 2 < faceGroups.length; group += 3) {
    const start = faceGroups[group]! / unit;
    const count = faceGroups[group + 1]! / unit;
    if (triangle >= start && triangle < start + count) return faceGroups[group + 2]!;
  }
  return null;
}

/**
 * The positions of one face's triangles, copied from an unindexed mesh in its
 * face groups' order, for drawing that face on its own (the viewport's hover
 * highlight). Empty when no group names the face.
 */
export function faceTrianglePositions(positions: ArrayLike<number>, faceGroups: readonly number[], faceIndex: number): Float32Array {
  const triangleCount = Math.floor(positions.length / 9);
  const unit = faceGroupUnit(faceGroups, triangleCount);
  const ranges: Array<[number, number]> = [];
  let total = 0;
  for (let group = 0; group + 2 < faceGroups.length; group += 3) {
    if (faceGroups[group + 2] !== faceIndex) continue;
    const start = faceGroups[group]! / unit;
    const end = Math.min(triangleCount, start + faceGroups[group + 1]! / unit);
    if (!Number.isInteger(start) || start < 0 || end <= start) continue;
    ranges.push([start, end]);
    total += end - start;
  }
  const out = new Float32Array(total * 9);
  let offset = 0;
  for (const [start, end] of ranges) {
    for (let index = start * 9; index < end * 9; index += 1) out[offset++] = positions[index]!;
  }
  return out;
}
