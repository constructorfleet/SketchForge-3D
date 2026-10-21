import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";
import type { AlignAxis, AlignTarget } from "@/lib/engine/alignShapes";

export const runtime = "nodejs";
export const revalidate = false;

const AXES = ["x", "y", "z"] as const;
const TARGETS = ["min", "center", "max"] as const;

/**
 * Bring shapes onto one line.
 *
 * The editor has had an Alignment button since before there was an API, and
 * the arithmetic behind it lived inside the editor component -- so a script
 * could place a row of bosses to four decimal places but could not ask for
 * their tops to be flush. `axis` and `target` are the two halves of the
 * editor's own nine handles: `x`+`min` is its Left, `y`+`max` its Top.
 *
 * `ids` is required rather than defaulting to a selection, because there is no
 * selection on a server -- that is the one thing the editor has and this does
 * not.
 */
const postAlign = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const ids = apiShapeIds(body.ids);
  if (!ids?.length) return apiError("Send ids: a list of distinct shape ids to align.", 400, "invalid_request");

  const axis = AXES.find((candidate) => candidate === body.axis);
  if (!axis) {
    return apiError(`Send axis as one of ${AXES.join(", ")}: x is left/right, z front/back, y bottom/top.`, 400, "invalid_request");
  }
  const target = TARGETS.find((candidate) => candidate === body.target);
  if (!target) {
    return apiError(`Send target as one of ${TARGETS.join(", ")}: which edge or centre to line up.`, 400, "invalid_request");
  }
  const anchorId = typeof body.anchorId === "string" ? body.anchorId.trim() || null : null;
  const contractBody = { ids, axis, target, ...(anchorId ? { anchorId } : {}) };
  if (!validateApiV1RequestBody("POST /api/v1/align", contractBody)) {
    return apiError("The alignment request does not match its contract.", 400, "invalid_request");
  }

  const aligned = await apiEngine(context.root).align(projectId, {
    ids,
    axis: axis as AlignAxis,
    target: target as AlignTarget,
    anchorId,
  });
  if (!aligned.ok) {
    return apiEngineError(aligned.failure, {
      tooFewShapes: (needed, given) => `Aligning needs at least ${needed} shapes; ${given} were given.`,
    });
  }
  // `moved` is the answer to "did anything happen": a selection already flush
  // writes nothing and reports zero, which a caller cannot otherwise tell from
  // an alignment that moved everything by a hair.
  return apiJson({
    moved: aligned.value.moved,
    axis,
    target,
    anchorId: aligned.value.anchorId,
    shapes: aligned.value.shapes.map(apiShapeSummary),
    revision: aligned.value.revision,
  });
};

export const POST = withApiV1Contract("POST /api/v1/align", postAlign);
