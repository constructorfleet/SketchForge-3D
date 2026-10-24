import type { LocalizedErrorPayload } from "@/i18n/LocalizedError";
import type { SketchProfile } from "@/types/sketchforge";

export type SketchCadBuildRequest = {
  type: "build";
  requestId: number;
  profile: SketchProfile;
  height: number;
};

export type SketchCadSweepRequest = {
  type: "sweep";
  requestId: number;
  profile: SketchProfile;
};

export type SketchCadWorkerRequest = SketchCadBuildRequest | SketchCadSweepRequest;

export type SketchCadBuildResponse =
  | {
      type: "built";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      /** Triangle start, triangle count and B-rep face index triples, for face colours. */
      faceGroups?: number[];
    }
  | ({ type: "error"; requestId: number } & LocalizedErrorPayload);
