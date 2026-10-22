import type { SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
import type { OcctKernel } from "occt-wasm";
import { createLocalId } from "./localIds.js";
import { withCadKernel } from "./serverCadKernel.js";
import { cadSketchRegions, type OrderedCadSketchPath } from "./sketchCadProfile.js";
import { canonicalizeShape, cleanNearZero } from "./workplaneShapes.js";

function pathWire(cad: OcctKernel, path: OrderedCadSketchPath) {
  return cad.makeWire(path.steps.map(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && first && second) {
      return cad.makeBezierEdge([
        { x: from.x, y: 0, z: from.z }, { x: first.x, y: 0, z: first.z },
        { x: second.x, y: 0, z: second.z }, { x: to.x, y: 0, z: to.z },
      ]);
    }
    return cad.makeLineEdge({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z });
  }));
}

/** Rebuild a retained sketch extrusion as exact OCCT geometry. */
export async function sketchExtrusionShapeFromRequest(request: Record<string, unknown>): Promise<WorkplaneShape> {
  const profile = request.profile as SketchProfile;
  const height = request.height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > 10000) {
    throw new Error("A sketch extrusion height must be finite and greater than zero.");
  }
  return withCadKernel((cad) => {
    const regions = cadSketchRegions(profile);
    if (regions.length === 0) throw new Error("A sketch extrusion requires a closed profile.");
    const solids = regions.map((region) => {
      let face = cad.makeFace(pathWire(cad, region.outer));
      if (region.holes.length) face = cad.addHolesInFace(face, region.holes.map((hole) => pathWire(cad, hole)));
      return cad.extrude(face, 0, height, 0);
    });
    const solid = solids.length === 1 ? solids[0]! : cad.makeCompound(solids);
    if (!cad.isValid(solid)) throw new Error("The sketch extrusion produced invalid geometry.");
    const mesh = cad.tessellate(solid, { linearDeflection: 0.05, angularDeflection: 0.16 });
    if (mesh.positions.length < 9 || mesh.indices.length < 3) throw new Error("The sketch extrusion produced no solid geometry.");
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]!); maxX = Math.max(maxX, mesh.positions[i]!);
      minY = Math.min(minY, mesh.positions[i + 1]!); maxY = Math.max(maxY, mesh.positions[i + 1]!);
      minZ = Math.min(minZ, mesh.positions[i + 2]!); maxZ = Math.max(maxZ, mesh.positions[i + 2]!);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const positions: number[] = [];
    const normals: number[] = [];
    for (const index of mesh.indices) {
      const vertex = index * 3;
      positions.push(mesh.positions[vertex]! - centerX, mesh.positions[vertex + 1]! - minY, mesh.positions[vertex + 2]! - centerZ);
      if (mesh.normals.length >= vertex + 3) normals.push(mesh.normals[vertex]!, mesh.normals[vertex + 1]!, mesh.normals[vertex + 2]!);
    }
    const width = Math.max(0.01, maxX - minX);
    const depth = Math.max(0.01, maxZ - minZ);
    const builtHeight = Math.max(0.01, maxY - minY);
    const id = typeof request.id === "string" ? request.id : createLocalId("sketch-extrusion");
    return canonicalizeShape({
      id,
      name: typeof request.name === "string" && request.name.trim() ? request.name.trim() : "Sketch extrusion",
      kind: "mesh",
      color: typeof request.color === "string" ? request.color : "#d41721",
      x: cleanNearZero(centerX, 0.0005) + (typeof request.x === "number" ? request.x : 0),
      z: cleanNearZero(centerZ, 0.0005) + (typeof request.z === "number" ? request.z : 0),
      elevation: cleanNearZero(minY, 0.0005) + (typeof request.elevation === "number" ? request.elevation : 0),
      width, depth, height: builtHeight, size: Math.max(width, depth),
      rotation: typeof request.rotation === "number" ? request.rotation : 0,
      rotationX: typeof request.rotationX === "number" ? request.rotationX : 0,
      rotationZ: typeof request.rotationZ === "number" ? request.rotationZ : 0,
      hole: request.hole === true,
      sketchProfile: structuredClone(profile), sketchOperation: "extrude",
      sketchSourceId: typeof request.sketchSourceId === "string" ? request.sketchSourceId : `sketch/${id}`,
      importedMesh: {
        positions, normals: normals.length === positions.length ? normals : undefined,
        baseWidth: width, baseDepth: depth, baseHeight: builtHeight,
        triangleCount: Math.floor(mesh.indices.length / 3), sourceFormat: "json",
      },
      cadBrep: cad.toBREP(solid),
      faceIds: cad.getSubShapes(solid, "face").map((_, index) => `face_${createLocalId(`${id}-face-${index}`)}`),
      cadBrepFrame: { x: centerX, z: centerZ, elevation: minY, width, depth, height: builtHeight },
    });
  });
}
