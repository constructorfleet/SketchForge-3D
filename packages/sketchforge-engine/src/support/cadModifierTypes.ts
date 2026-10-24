import type { LocalizedErrorPayload } from "./i18n/LocalizedError.js";
import type { WorkplaneShape } from "./../domain/sketchforge.js";
import type { SketchProfile } from "./../domain/sketchforge.js";
import type { ResolvedSketchFaceDraftSource, RetainedFaceDraftResolution } from "./../sketchFaceDraftKernel.js";
import type { InterferenceOperand, InterferenceResult, WallThicknessResult } from "./../cadAnalysis.js";

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
  /** Read-only analysis (#380): exact gaps and overlap volumes between the operands. */
  | { type: "interference"; requestId: number; operands: Array<InterferenceOperand & { part: CadModifierMeshPart }>; clearance: number }
  /** Read-only analysis (#380): the sampled thinnest wall of one solid. */
  | { type: "wall-thickness"; requestId: number; part: CadModifierMeshPart }
  | { type: "draft-prism"; requestId: number; profile: SketchProfile; height: number; angle: number }
  | { type: "draft-face"; requestId: number; brep: string; faceIds: string[]; faceId: string; angle: number; pullDirection: "x" | "y" | "z" | "-x" | "-y" | "-z"; brepTransform?: number[] }
  /**
   * Draft one face of an undrafted sketch extrusion and keep it as a feature:
   * the draft is made in the source's own B-rep frame, and the answer carries
   * what the retained record needs (#384).
   */
  | {
      type: "retained-face-draft";
      requestId: number;
      resolution: RetainedFaceDraftResolution;
    }
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
  | { type: "interference"; requestId: number; result: InterferenceResult }
  | { type: "wall-thickness"; requestId: number; result: WallThicknessOutcome }
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
      type: "retained-face-draft";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      faceGroups: number[];
      sourceFaceIds: string[];
      resultFaceIds: string[];
      resolved: Pick<ResolvedSketchFaceDraftSource, "faceId" | "normal" | "segmentMatch">;
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

/** A sampled wall thickness, or why the solid could not be sampled at all. */
export type WallThicknessOutcome =
  | { ok: true; value: WallThicknessResult }
  | { ok: false; refusal: { reason: "no_faces" | "too_many_faces"; limit?: number } };
