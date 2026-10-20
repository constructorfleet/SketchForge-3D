import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_SHAPES_PER_REQUEST = 200;

/** A change refusing a locked shape says how to unlock it in the same call. */
const LOCKED_FOR_CHANGE = "That shape is locked. Send locked: false to change it.";

export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const project = await apiEngine(context.root).project(projectId);
  if (!project.ok) return apiEngineError(project.failure);
  return apiJson({ shapes: project.value.shapes.map(apiShapeSummary) });
}

/**
 * Add shapes to a project.
 *
 * Accepts one shape or a list of them, because the point of the API is
 * parameterised work: a script computing a row of holes should not need a
 * request per hole, and a batch is one write of the project package.
 *
 * What is left here is the request and the reply. Everything below -- the
 * per-kind parameter table, the thread catalog, sweeping a revolve with
 * manifold, the project lock and the revision bump -- is `Engine.addShapes`,
 * which is what lets a macro add the same batch with no server at all. The
 * checks that stay are the ones about the JSON rather than about the shapes:
 * the engine takes a list of requests and has no opinion on whether the body
 * that carried them was shaped like a list.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const requested = Array.isArray(body.shapes) ? body.shapes : [body];
  if (requested.length === 0) return apiError("No shapes were given.", 400, "invalid_request");
  if (requested.length > MAX_SHAPES_PER_REQUEST) {
    return apiError(`A request can add at most ${MAX_SHAPES_PER_REQUEST} shapes.`, 413, "too_many_shapes");
  }
  for (const [index, entry] of requested.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return apiError(`Shape ${index} is not an object.`, 400, "invalid_request");
    }
  }

  const added = await apiEngine(context.root).addShapes(projectId, requested as Record<string, unknown>[]);
  if (!added.ok) return apiEngineError(added.failure);
  return apiJson({ shapes: added.value.shapes.map(apiShapeSummary), revision: added.value.revision }, 201);
}

/**
 * Change a shape.
 *
 * Everything the shape summary reports can be sent back, which is the whole
 * point of reporting it. For a revolve or a thread that means the sweep itself:
 * a pitch, a turn count or a new outline is geometry rather than a property, so
 * the mesh is swept again -- manifold runs under Node, and refusing to rebuild
 * would leave a thread's pitch readable but not writable, which is the
 * asymmetry this endpoint had in the first place.
 */
export async function PATCH(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();

  const changed = await apiEngine(context.root).changeShape(projectId, shapeId, body);
  if (!changed.ok) {
    return apiEngineError(changed.failure, { oneShape: true, locked: () => LOCKED_FOR_CHANGE });
  }
  return apiJson({ shape: apiShapeSummary(changed.value.shape), revision: changed.value.revision });
}

export async function DELETE(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const removed = await apiEngine(context.root).removeShape(projectId, shapeId);
  if (!removed.ok) return apiEngineError(removed.failure, { oneShape: true });
  return apiJson({ deleted: true, id: removed.value.id, revision: removed.value.revision });
}
