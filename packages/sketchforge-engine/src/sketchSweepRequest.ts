import type { SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
import { createLocalId } from "./localIds.js";
import { withCadKernel } from "./serverCadKernel.js";
import { buildCadSketchSweep } from "./sketchCadSweep.js";
import { canonicalizeShape, cleanNearZero } from "./workplaneShapes.js";

export function invalidSketchSweepProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return "A sketch sweep profile must be an object.";
  const value = profile as Record<string, unknown>;
  if (!Array.isArray(value.points) || value.points.length < 5 || value.points.length > 5000) {
    return "A sketch sweep profile must contain between 5 and 5000 points.";
  }
  if (!Array.isArray(value.segments) || value.segments.length < 4 || value.segments.length > 10000) {
    return "A sketch sweep profile must contain between 4 and 10000 segments.";
  }
  const pointIds = new Set<string>();
  for (const point of value.points) {
    if (!point || typeof point !== "object" || Array.isArray(point)) return "Every sketch sweep point must be an object.";
    const entry = point as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id || pointIds.has(entry.id)) return "Sketch sweep point IDs must be unique non-empty strings.";
    pointIds.add(entry.id);
    if (![entry.x, entry.z, entry.sweepDepth ?? 0].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) <= 10000)) {
      return "Sketch sweep point coordinates must be finite and within 10000 mm.";
    }
  }
  const segmentIds = new Set<string>();
  for (const segment of value.segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) return "Every sketch sweep segment must be an object.";
    const entry = segment as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id || segmentIds.has(entry.id)) return "Sketch sweep segment IDs must be unique non-empty strings.";
    if (typeof entry.startId !== "string" || typeof entry.endId !== "string" || !pointIds.has(entry.startId) || !pointIds.has(entry.endId)) {
      return "Sketch sweep segments must reference existing point IDs.";
    }
    segmentIds.add(entry.id);
  }
  return null;
}

/** Build a retained sketch sweep from the public shape request's profile. */
export async function sketchSweepShapeFromRequest(request: Record<string, unknown>): Promise<WorkplaneShape> {
  const profile = request.profile as SketchProfile;
  return withCadKernel((cad) => {
    const solid = buildCadSketchSweep(cad, profile);
    if (!cad.isValid(solid)) throw new Error("The sketch sweep produced invalid geometry");
    const mesh = cad.tessellate(solid, { linearDeflection: 0.05, angularDeflection: 0.16 });
    const positions = mesh.positions;
    const normals = mesh.normals;
    const indices = mesh.indices;
    if (positions.length < 9 || indices.length < 3) throw new Error("The sketch sweep produced no solid geometry");

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]!); minY = Math.min(minY, positions[i + 1]!); minZ = Math.min(minZ, positions[i + 2]!);
      maxX = Math.max(maxX, positions[i]!); maxY = Math.max(maxY, positions[i + 1]!); maxZ = Math.max(maxZ, positions[i + 2]!);
    }
    if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) throw new Error("The sketch sweep produced invalid bounds");
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const width = Math.max(0.01, maxX - minX);
    const height = Math.max(0.01, maxY - minY);
    const depth = Math.max(0.01, maxZ - minZ);
    const flattenedPositions: number[] = [];
    const flattenedNormals: number[] = [];
    for (let i = 0; i < indices.length; i += 1) {
      const vertex = indices[i]! * 3;
      flattenedPositions.push(positions[vertex]! - centerX, positions[vertex + 1]! - minY, positions[vertex + 2]! - centerZ);
      if (normals.length >= vertex + 3) flattenedNormals.push(normals[vertex]!, normals[vertex + 1]!, normals[vertex + 2]!);
    }
    return canonicalizeShape({
      id: typeof request.id === "string" ? request.id : createLocalId("sketch-sweep"),
      name: typeof request.name === "string" && request.name.trim() ? request.name.trim() : "Sketch sweep",
      kind: "mesh",
      color: typeof request.color === "string" ? request.color : "#d41721",
      x: cleanNearZero(centerX, 0.0005) + (typeof request.x === "number" ? request.x : 0),
      z: cleanNearZero(centerZ, 0.0005) + (typeof request.z === "number" ? request.z : 0),
      elevation: cleanNearZero(minY, 0.0005) + (typeof request.elevation === "number" ? request.elevation : 0),
      width, depth, height, size: Math.max(width, depth),
      rotation: typeof request.rotation === "number" && Number.isFinite(request.rotation) ? request.rotation : 0,
      rotationX: typeof request.rotationX === "number" && Number.isFinite(request.rotationX) ? request.rotationX : 0,
      rotationZ: typeof request.rotationZ === "number" && Number.isFinite(request.rotationZ) ? request.rotationZ : 0,
      hole: request.hole === true,
      sketchProfile: structuredClone(profile),
      sketchOperation: "sweep",
      importedMesh: {
        positions: flattenedPositions,
        normals: flattenedNormals.length === flattenedPositions.length ? flattenedNormals : undefined,
        baseWidth: maxX - minX, baseDepth: maxZ - minZ, baseHeight: maxY - minY,
        triangleCount: Math.floor(indices.length / 3), sourceFormat: "json",
      },
      cadBrep: cad.toBREP(solid),
      cadBrepFrame: { x: centerX, z: centerZ, elevation: minY, width, depth, height },
    });
  });
}
