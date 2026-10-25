import { type OcctKernel } from "occt-wasm";
import type { SketchProfile } from "@/types/sketchforge";
import { draftPrismLoop } from "@constructorfleet/sketchforge-engine/sketchCadProfile";
import { meshShapeWithFaceGroups } from "@/lib/engine/cadFaceMesh";

export type DraftPrismBuildRequest = {
  profile: SketchProfile;
  height: number;
  angle: number;
};

export type DraftPrismBuildResult = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  brep: string;
  /** Triangle start, triangle count and B-rep face index triples, for face colours. */
  faceGroups: number[];
};

/** Builds an exact drafted solid from the editor's supported straight sketch profile, in any segment order. */
export function buildDraftPrism(cad: OcctKernel, request: DraftPrismBuildRequest): DraftPrismBuildResult {
  if (!Number.isFinite(request.height) || request.height <= 0
    || !Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45) {
    throw new Error("Draft prism requires a positive height and an angle between -45 and 45 degrees, excluding zero.");
  }
  // The same loop, and the same refusals, as the REST draft (#349).
  const loop = draftPrismLoop(request.profile);
  if (typeof loop === "string") throw new Error(loop);

  const { points } = request.profile;
  const minX = Math.min(...points.map(({ x }) => x));
  const maxX = Math.max(...points.map(({ x }) => x));
  const minZ = Math.min(...points.map(({ z }) => z));
  const maxZ = Math.max(...points.map(({ z }) => z));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const edges = loop.map((point, index) => {
    const next = loop[(index + 1) % loop.length];
    return cad.makeLineEdge(
      { x: point.x - centerX, y: 0, z: point.z - centerZ },
      { x: next.x - centerX, y: 0, z: next.z - centerZ },
    );
  });
  const face = cad.makeFace(cad.makeWire(edges));
  const solid = cad.draftPrism(face, 0, request.height, 0, request.angle);
  if (!cad.isValid(solid) || !cad.isSolid(solid)) throw new Error("The draft did not produce a valid solid.");
  const mesh = meshShapeWithFaceGroups(cad, solid, { linearDeflection: 0.035, angularDeflection: 0.16 });
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    faceGroups: mesh.faceGroups,
    brep: cad.toBREP(solid),
  };
}
