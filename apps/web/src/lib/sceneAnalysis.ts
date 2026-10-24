/**
 * What the editor's analysis panel checks, and how each shape travels to the
 * CAD worker (#380).
 *
 * Interference and wall thickness are read-only: nothing here or in the worker
 * changes a shape, and the panel never commits history. A shape is sent the way
 * an exact cut sends an operand -- its stored B-rep, or its parameters for the
 * worker to build exactly -- and only falls back to its tessellation when
 * neither exists, which the report then marks `tessellated`.
 */

import { cadBrepTransformForShape } from "@/lib/engine/cadBakeMetadata";
import { exactBooleanPlacement, shapeHasExactBooleanSolid } from "@/lib/engine/exactBooleanParts";
import {
  interferenceRequestRefusal,
  WALL_THICKNESS_MAX_FACES,
  type InterferenceOperand,
  type InterferenceRefusal,
  type InterferenceReport,
  type WallThicknessResult,
} from "@/lib/engine/cadAnalysis";
import type { CadModifierMeshPart, CadModifierWorkerRequest, CadModifierWorkerResponse } from "@/lib/cadModifierTypes";
import type { Translator } from "@/i18n/translator";
import type { WorkplaneShape } from "@/types/sketchforge";

export type SceneAnalysisOperand = InterferenceOperand & { part: CadModifierMeshPart };

/** World-space triangles for a shape, as the editor draws it. */
export type SceneAnalysisMesh = (shape: WorkplaneShape) => { positions: Float32Array; indices: Uint32Array } | null;

function analysable(shape: WorkplaneShape) {
  return !shape.hidden && !shape.hole;
}

/**
 * The shapes an interference check covers: the selection when it names two or
 * more solids, otherwise every visible solid in the scene. Hidden shapes and
 * cutters are never checked -- the same rule the REST API applies.
 */
export function interferenceTargets(shapes: readonly WorkplaneShape[], selectedIds: readonly string[]): WorkplaneShape[] {
  const selected = new Set(selectedIds);
  const picked = shapes.filter((shape) => selected.has(shape.id) && analysable(shape));
  return picked.length >= 2 ? picked : shapes.filter(analysable);
}

/** The one selected solid whose walls can be sampled, or null. */
export function wallThicknessTarget(shapes: readonly WorkplaneShape[], selectedIds: readonly string[]): WorkplaneShape | null {
  if (selectedIds.length !== 1) return null;
  const shape = shapes.find((candidate) => candidate.id === selectedIds[0]);
  return shape && analysable(shape) ? shape : null;
}

/**
 * One shape as a worker operand, or null when it has no geometry to send.
 *
 * A stored B-rep (a filleted, cut or STEP-imported shape) is exact. An imported
 * mesh without one is sewn from its triangles, and a mirrored or nested shape
 * the exact builders cannot place goes as the triangles the viewport draws;
 * both are marked `tessellated`.
 */
export function sceneAnalysisOperand(shape: WorkplaneShape, meshFor: SceneAnalysisMesh): SceneAnalysisOperand | null {
  const identity = { id: shape.id, name: shape.name };
  const importedMesh = (shape.importedMesh?.positions?.length ?? 0) >= 9;
  if (shape.cadBrep && shape.cadBrepFrame) {
    return { ...identity, tessellated: false, part: { brep: shape.cadBrep, brepTransform: cadBrepTransformForShape(shape), hole: false } };
  }
  if (!importedMesh && shapeHasExactBooleanSolid(shape)) {
    return { ...identity, tessellated: false, part: { exact: { shape, transform: exactBooleanPlacement(shape) }, hole: false } };
  }
  const mesh = meshFor(shape);
  if (!mesh || mesh.indices.length < 3) return null;
  return { ...identity, tessellated: true, part: { positions: mesh.positions, indices: mesh.indices, hole: false } };
}

/** Buffers in a request that can be handed to the worker rather than copied. */
export function sceneAnalysisTransfer(operands: readonly SceneAnalysisOperand[]): Transferable[] {
  return operands.flatMap(({ part }) => (part.positions && part.indices ? [part.positions.buffer, part.indices.buffer] : []));
}

/** Why an analysis produced no report, in a form the panel can translate. */
export type SceneAnalysisRefusal =
  | InterferenceRefusal
  | { reason: "no_faces" }
  | { reason: "too_many_faces"; limit?: number }
  | { reason: "no_geometry"; name: string };

export type SceneInterferenceOutcome = { ok: true; value: InterferenceReport } | { ok: false; refusal: SceneAnalysisRefusal };
export type SceneWallThicknessOutcome = { ok: true; value: WallThicknessResult } | { ok: false; refusal: SceneAnalysisRefusal };

/** Runs the panel's analyses. Neither call changes a shape. */
export type SceneAnalysisRunner = {
  interference: (shapes: readonly WorkplaneShape[]) => Promise<SceneInterferenceOutcome>;
  wallThickness: (shape: WorkplaneShape) => Promise<SceneWallThicknessOutcome>;
};

/** Generous, because the first analysis of a session also loads the 22 MB kernel. */
export const SCENE_ANALYSIS_TIMEOUT_MS = 60_000;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AnalysisRequest = Extract<CadModifierWorkerRequest, { type: "interference" | "wall-thickness" }>;
export type SceneAnalysisPost = (
  request: DistributiveOmit<AnalysisRequest, "requestId">,
  transfer: Transferable[],
  timeoutMs: number,
) => Promise<CadModifierWorkerResponse>;

function operandsFor(shapes: readonly WorkplaneShape[], meshFor: SceneAnalysisMesh): SceneAnalysisOperand[] | SceneAnalysisRefusal {
  const operands: SceneAnalysisOperand[] = [];
  for (const shape of shapes) {
    const operand = sceneAnalysisOperand(shape, meshFor);
    if (!operand) return { reason: "no_geometry", name: shape.name };
    operands.push(operand);
  }
  return operands;
}

/**
 * The panel's runner over the editor's CAD worker. An oversized interference
 * request is refused here, before any shape is tessellated, with the same
 * refusal the worker -- and the REST API -- would give.
 */
export function createSceneAnalysisRunner(post: SceneAnalysisPost, meshFor: SceneAnalysisMesh): SceneAnalysisRunner {
  return {
    async interference(shapes) {
      const refusal = interferenceRequestRefusal(shapes.length, 0);
      if (refusal) return { ok: false, refusal };
      const operands = operandsFor(shapes, meshFor);
      if (!Array.isArray(operands)) return { ok: false, refusal: operands };
      const response = await post({ type: "interference", operands, clearance: 0 }, sceneAnalysisTransfer(operands), SCENE_ANALYSIS_TIMEOUT_MS);
      if (response.type !== "interference") throw new Error("The CAD worker did not return an interference report");
      return response.result;
    },
    async wallThickness(shape) {
      const operands = operandsFor([shape], meshFor);
      if (!Array.isArray(operands)) return { ok: false, refusal: operands };
      const response = await post({ type: "wall-thickness", part: operands[0]!.part }, sceneAnalysisTransfer(operands), SCENE_ANALYSIS_TIMEOUT_MS);
      if (response.type !== "wall-thickness") throw new Error("The CAD worker did not return a wall thickness");
      return response.result;
    },
  };
}

/** The refusal as the user reads it, in their language. */
export function sceneAnalysisRefusalText(t: Translator, refusal: SceneAnalysisRefusal): string {
  switch (refusal.reason) {
    case "too_many_shapes":
      return t("panels.analysis.refusal.tooManyShapes", { limit: refusal.limit, given: refusal.given });
    case "too_many_candidates":
      return t("panels.analysis.refusal.tooManyCandidates", { limit: refusal.limit, given: refusal.given });
    case "invalid_clearance":
      return t("panels.analysis.refusal.invalidClearance");
    case "too_many_faces":
      return t("panels.analysis.refusal.tooManyFaces", { limit: refusal.limit ?? WALL_THICKNESS_MAX_FACES });
    case "no_faces":
      return t("panels.analysis.refusal.noFaces");
    case "no_geometry":
      return t("panels.analysis.refusal.noGeometry", { name: refusal.name });
  }
}
