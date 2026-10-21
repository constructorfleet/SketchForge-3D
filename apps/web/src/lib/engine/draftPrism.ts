import { type OcctKernel } from "occt-wasm";
import type { SketchProfile } from "@/types/sketchforge";

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
};

/** Builds an exact drafted solid from the editor's supported straight sketch profile. */
export function buildDraftPrism(cad: OcctKernel, request: DraftPrismBuildRequest): DraftPrismBuildResult {
  const { points, segments } = request.profile;
  if (!Number.isFinite(request.height) || request.height <= 0
    || !Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45
    || points.length < 3 || segments.length !== points.length
    || segments.some((segment, index) => (segment.kind && segment.kind !== "line")
      || segment.startId !== points[index]?.id
      || segment.endId !== points[(index + 1) % points.length]?.id)
    || points.some((point) => point.handleIn || point.handleOut || !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
    throw new Error("Draft prism requires one straight closed sketch profile and an angle between -45 and 45 degrees, excluding zero.");
  }

  const minX = Math.min(...points.map(({ x }) => x));
  const maxX = Math.max(...points.map(({ x }) => x));
  const minZ = Math.min(...points.map(({ z }) => z));
  const maxZ = Math.max(...points.map(({ z }) => z));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return cad.makeLineEdge(
      { x: point.x - centerX, y: 0, z: point.z - centerZ },
      { x: next.x - centerX, y: 0, z: next.z - centerZ },
    );
  });
  const face = cad.makeFace(cad.makeWire(edges));
  const solid = cad.draftPrism(face, 0, request.height, 0, request.angle);
  if (!cad.isValid(solid) || !cad.isSolid(solid)) throw new Error("The draft did not produce a valid solid.");
  const mesh = cad.tessellate(solid, { linearDeflection: 0.035, angularDeflection: 0.16 });
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    brep: cad.toBREP(solid),
  };
}
