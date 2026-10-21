import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

const SPACINGS = ["gaps", "centers"] as const;

/**
 * Spread three or more shapes evenly along an axis.
 *
 * The outermost two never move: they define the span, which is the one thing
 * the caller has already decided. Two spacings are useful and they are not the
 * same thing -- `gaps` leaves equal clear space between neighbours, which is
 * what parts of different sizes along a rail want; `centers` puts the centres
 * at equal intervals, which is what a bolt pitch is.
 *
 * `axis` may be left out, and then it is whichever axis the shapes are already
 * most spread along: a row along X is a row whoever made it meant to be a row.
 */
const postDistribute = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const ids = apiShapeIds(body.ids);
  if (!ids?.length) return apiError("Send ids: a list of distinct shape ids to distribute.", 400, "invalid_request");

  if (body.axis !== undefined && body.axis !== "x" && body.axis !== "z") {
    return apiError("axis must be x or z, or left out to use whichever axis the shapes are already most spread along.", 400, "invalid_request");
  }
  if (body.spacing !== undefined && !SPACINGS.includes(body.spacing as (typeof SPACINGS)[number])) {
    return apiError(`spacing must be one of ${SPACINGS.join(", ")}.`, 400, "invalid_request");
  }
  if (!validateApiV1RequestBody("POST /api/v1/distribute", { ...body, ids })) {
    return apiError("The distribution request does not match its contract.", 400, "invalid_request");
  }

  const distributed = await apiEngine(context.root).distribute(projectId, {
    ids,
    axis: body.axis as "x" | "z" | undefined,
    spacing: body.spacing as (typeof SPACINGS)[number] | undefined,
  });
  if (!distributed.ok) {
    return apiEngineError(distributed.failure, {
      tooFewShapes: (needed, given) => `Distributing needs at least ${needed} shapes -- two to hold the span and one to space -- and ${given} were given.`,
    });
  }
  // A selection whose middle shapes are locked cannot be spaced without moving
  // something that must not move, and reports zero moved rather than refusing:
  // the project is as the caller asked for it to be, give or take what it
  // locked itself.
  return apiJson({
    moved: distributed.value.moved,
    axis: distributed.value.axis,
    spacing: distributed.value.spacing,
    shapes: distributed.value.shapes.map(apiShapeSummary),
    revision: distributed.value.revision,
  });
};

export const POST = withApiV1Contract("POST /api/v1/distribute", postDistribute);
