import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import type { MeasurementEndRef } from "@/lib/engine/serverCadMeasure";

export const runtime = "nodejs";
export const revalidate = false;

const CAD_FAILED = "The CAD kernel could not measure that shape.";

/** A shape's edges and faces, measured from its exact geometry. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const measured = await apiEngine(context.root).measurements(projectId, shapeId);
  if (!measured.ok) {
    return apiEngineError(measured.failure, { oneShape: true, cadFailed: CAD_FAILED });
  }
  return apiJson({ measurements: measured.value });
}

const ENTITY_KINDS = ["edge", "face", "shape"] as const;

/**
 * One end of a between-entities request.
 *
 * `shapeId` is required on each end rather than shared, because the two ends may
 * be different shapes -- "how far apart are these two parts" is the measurement
 * the route exists for. An `entity` of `shape` measures the whole solid and
 * takes no index. A string is returned instead when the end cannot be read, so
 * the handler can say which of the two was wrong.
 */
function parseEnd(value: unknown): MeasurementEndRef | string {
  if (!value || typeof value !== "object") return "must be an object with a shapeId.";
  const candidate = value as Record<string, unknown>;
  const shapeId = typeof candidate.shapeId === "string" ? candidate.shapeId.trim() : "";
  if (!shapeId) return "needs a shapeId.";

  const requested = candidate.entity === undefined ? "shape" : candidate.entity;
  const entity = ENTITY_KINDS.find((kind) => kind === requested);
  if (!entity) {
    return `has an entity of ${JSON.stringify(requested)}; it must be one of ${ENTITY_KINDS.join(", ")}.`;
  }
  if (entity === "shape") {
    return { shapeId, entity };
  }

  const { index } = candidate;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return `needs a whole, non-negative index to name which ${entity} to measure.`;
  }
  return { shapeId, entity, index };
}

/** The distance between two entities, and the angle between them if both are flat faces. */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();

  const parsed = { from: parseEnd(body.from), to: parseEnd(body.to) };
  for (const [side, end] of Object.entries(parsed)) {
    if (typeof end === "string") {
      return apiError(`"${side}" ${end}`, 400, "invalid_request");
    }
  }
  const ends = parsed as { from: MeasurementEndRef; to: MeasurementEndRef };

  const measured = await apiEngine(context.root).measureBetween(projectId, ends.from, ends.to);
  if (!measured.ok) {
    return apiEngineError(measured.failure, { cadFailed: CAD_FAILED });
  }
  return apiJson(measured.value);
}
