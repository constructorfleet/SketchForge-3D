import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { MAX_PATTERN_COUNT, MIN_PATTERN_COUNT } from "@/lib/engine/patternShapes";
import type { PatternKind } from "@/lib/engine/engine";

export const runtime = "nodejs";
export const revalidate = false;

const KINDS = ["linear", "circular"] as const;

/** A number the body named, or undefined, so the engine's own default stands. */
function optionalNumber(value: unknown, field: string): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a finite number.`;
  return value;
}

/**
 * Repeat shapes in a row or around a ring.
 *
 * Distribute re-spaces shapes that already exist; this makes the copies. It is
 * the difference between placing eight bolt holes by hand and asking for eight,
 * and once a thread is a catalog pick -- `POST /shapes` with `kind: "thread"`,
 * `size: "M8"` -- a ring of them is the next thing anyone wants.
 *
 * The step is centre to centre rather than a gap, because that is what a hole
 * pitch is: "eight at 20mm" is unambiguous where "eight with 20mm between
 * them" depends on how wide they are. A full turn divides by the count, so
 * eight land every 45 degrees and the last does not sit on the first; a partial
 * sweep divides by the gaps instead, so three across 90 degrees puts one at
 * each end and one in the middle.
 */
async function postPatterns(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  const ids = apiShapeIds(body.ids);
  if (!ids?.length) return apiError("Send ids: a list of distinct shape ids to repeat.", 400, "invalid_request");

  const kind = body.kind === undefined ? "linear" : KINDS.find((candidate) => candidate === body.kind);
  if (!kind) return apiError(`kind must be one of ${KINDS.join(", ")}.`, 400, "invalid_request");

  const count = body.count ?? 4;
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count)) {
    return apiError("count must be a number: the total copies including the original.", 400, "invalid_request");
  }
  if (count > MAX_PATTERN_COUNT) {
    return apiErrors.limitExceeded(`count must not exceed ${MAX_PATTERN_COUNT}.`, MAX_PATTERN_COUNT, count);
  }
  if (count < MIN_PATTERN_COUNT) {
    return apiError(`count must be between ${MIN_PATTERN_COUNT} and ${MAX_PATTERN_COUNT}.`, 400, "invalid_request");
  }

  const numbers = {
    stepX: optionalNumber(body.stepX, "stepX"),
    stepZ: optionalNumber(body.stepZ, "stepZ"),
    centerX: optionalNumber(body.centerX, "centerX"),
    centerZ: optionalNumber(body.centerZ, "centerZ"),
    sweepAngle: optionalNumber(body.sweepAngle, "sweepAngle"),
  };
  for (const value of Object.values(numbers)) {
    if (typeof value === "string") return apiError(value, 400, "invalid_request");
  }
  const contractBody = {
    ids,
    kind,
    count,
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
    ...(body.rotateCopies === undefined ? {} : { rotateCopies: body.rotateCopies }),
  };
  if (!validateApiV1RequestBody("POST /api/v1/patterns", contractBody)) {
    return apiError("The pattern request does not match its contract.", 400, "invalid_request");
  }

  const patterned = await apiEngine(context.root).pattern(projectId, {
    ids,
    kind: kind as PatternKind,
    count,
    ...(numbers as Record<keyof typeof numbers, number | undefined>),
    ...(body.rotateCopies === undefined ? {} : { rotateCopies: body.rotateCopies === true }),
  });
  if (!patterned.ok) {
    return apiEngineError(patterned.failure, {
      tooFewShapes: () => "Send at least one shape id to repeat.",
    });
  }
  return apiJson({
    created: patterned.value.shapes.length,
    kind,
    shapes: patterned.value.shapes.map(apiShapeSummary),
    revision: patterned.value.revision,
  }, 201);
}

export const POST = withApiV1Contract("POST /api/v1/patterns", postPatterns);
