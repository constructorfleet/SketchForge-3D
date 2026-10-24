import type { LocalizedErrorPayload } from "./i18n/LocalizedError.js";
import type { WorkplaneShape } from "./../domain/sketchforge.js";
import type { SketchProfile } from "./../domain/sketchforge.js";

export type CadModifierKind = "chamfer" | "fillet";

export type CadModifierEdge = {
  id: number;
  owner?: number;
  points: number[];
  display: boolean;
  selectable: boolean;
  angle: number;
  boundary: boolean;
  manifold: boolean;
};

export type CadModifierQuality = "draft" | "standard" | "fine";

export type CadModifierDisplayEdge = {
  points: number[];
};

export type CadModifierPrimitivePart = {
  kind: "box";
  width: number;
  depth: number;
  height: number;
  transform?: number[];
};

/**
 * An operand the kernel builds from the shape's own parameters.
 *
 * The exact boolean path sends these instead of triangles, which is what keeps
 * a cylinder round and a taper sloped (upstream #118, #111). `transform` is the
 * rigid move onto the workplane as three row-major rows of (basis, offset); the
 * shape's rotation is baked in as the solid is built.
 */
export type CadModifierExactPart = {
  shape: WorkplaneShape;
  transform?: number[];
};

export type CadModifierMeshPart = {
  positions?: Float32Array;
  indices?: Uint32Array;
  brep?: string;
  brepTransform?: number[];
  primitive?: CadModifierPrimitivePart;
  exact?: CadModifierExactPart;
  hole: boolean;
};

export type CadModifierComponentMesh = {
  owner: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  brep: string;
  displayEdges: CadModifierDisplayEdge[];
  /** Triangle start, triangle count and B-rep face index triples, for face colours. */
  faceGroups?: number[];
};

export type CadModifierWorkerRequest =
  | { type: "prepare"; requestId: number; parts: CadModifierMeshPart[]; sharpAngle: number; suppressTreatmentDetailEdges?: boolean }
  | {
      type: "preview";
      requestId: number;
      kind: CadModifierKind;
      edgeIds: number[];
      amount: number;
      quality: CadModifierQuality;
      chamferAngle: number;
    }
  | { type: "boolean"; requestId: number; parts: CadModifierMeshPart[] }
  | { type: "draft-prism"; requestId: number; profile: SketchProfile; height: number; angle: number }
  | { type: "draft-face"; requestId: number; brep: string; faceIds: string[]; faceId: string; angle: number; pullDirection: "x" | "y" | "z" | "-x" | "-y" | "-z"; brepTransform?: number[] }
  /** Build the parts as one exact solid, so a primitive gains B-rep faces to colour and draft. */
  | { type: "exact"; requestId: number; parts: CadModifierMeshPart[] }
  | { type: "dispose"; requestId: number };

export type CadModifierWorkerResponse =
  | { type: "ready"; requestId: number; edges: CadModifierEdge[]; selectableEdgeIds: number[]; sourceType: string }
  | {
      type: "preview";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      displayEdges: CadModifierDisplayEdge[];
      components?: CadModifierComponentMesh[];
    /** Triangle start, triangle count and B-rep face index triples, for face colours. */
      faceGroups?: number[];
    }
  | {
      type: "boolean";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      triangleCount: number;
      brep: string;
      /** Volume before and after the holes, so the caller can tell a cut that did nothing. */
      fusedVolume: number;
      cutVolume: number;
    }
  | {
      type: "draft-prism";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      faceGroups?: number[];
    }
  | {
      type: "draft-face";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      faceCount: number;
      volume: number;
      brep: string;
      faceGroups?: number[];
    }
  | {
      type: "exact";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      faceCount: number;
      faceGroups: number[];
    }
  | { type: "disposed"; requestId: number }
  | ({ type: "error"; requestId: number; resetSession?: boolean } & LocalizedErrorPayload);
