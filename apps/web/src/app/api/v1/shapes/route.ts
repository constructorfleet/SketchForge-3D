import { apiContext, apiError, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { metricThreadOutline, parseRevolveRequest, revolvedShapeFromRequest } from "@/lib/revolveRequests";
import { serverManifoldRuntime } from "@/lib/serverManifoldRuntime";
import { REQUESTABLE_SHAPE_KINDS, shapeFromRequest, shapeWithRequestedChanges } from "@/lib/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_SHAPES_PER_REQUEST = 200;

/**
 * `kind: "thread"` is `kind: "revolve"` with the outline filled in.
 *
 * An ISO metric thread's profile follows from its diameter and pitch, so
 * asking for an M8 should not mean working out a 60-degree V by hand. The
 * pitch doubles as the revolve's pitch, which is what makes it a thread.
 */
function withMetricThreadOutline(request: Record<string, unknown>) {
  const diameter = typeof request.diameter === "number" ? request.diameter : 8;
  const pitch = typeof request.pitch === "number" && request.pitch !== 0 ? request.pitch : 1.25;
  return {
    ...request,
    profile: request.profile ?? metricThreadOutline(diameter, Math.abs(pitch)),
    pitch,
    turns: request.turns ?? 8,
  };
}

export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiError("That project is not on the server.", 404);
  return apiJson({ shapes: document.shapes.map(apiShapeSummary) });
}

/**
 * Add shapes to a project.
 *
 * Accepts one shape or a list of them, because the point of the API is
 * parameterised work: a script computing a row of holes should not need a
 * request per hole, and a batch is one write of the project package.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);
  const requested = Array.isArray(body.shapes) ? body.shapes : [body];
  if (requested.length === 0) return apiError("No shapes were given.", 400);
  if (requested.length > MAX_SHAPES_PER_REQUEST) {
    return apiError(`A request can add at most ${MAX_SHAPES_PER_REQUEST} shapes.`, 413);
  }

  const built: WorkplaneShape[] = [];
  for (const [index, entry] of requested.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return apiError(`Shape ${index} is not an object.`, 400);
    }
    const request = entry as Record<string, unknown>;

    // A revolve is described by an outline and a pitch rather than by
    // dimensions, and it is built by manifold rather than from parameters --
    // which is what makes threads and springs possible here at all.
    if (request.kind === "revolve" || request.kind === "thread") {
      const parsed = parseRevolveRequest(
        request.kind === "thread" ? withMetricThreadOutline(request) : request,
      );
      if (!parsed.ok) return apiError(`Shape ${index}: ${parsed.error}`, 400);
      try {
        const runtime = await serverManifoldRuntime();
        built.push(revolvedShapeFromRequest(runtime, parsed, {
          name: typeof request.name === "string" ? request.name : undefined,
          color: typeof request.color === "string" ? request.color : undefined,
          x: typeof request.x === "number" ? request.x : undefined,
          z: typeof request.z === "number" ? request.z : undefined,
          elevation: typeof request.elevation === "number" ? request.elevation : undefined,
          rotation: typeof request.rotation === "number" ? request.rotation : undefined,
          hole: request.hole === true,
        }));
      } catch (error) {
        return apiError(
          `Shape ${index}: ${error instanceof Error ? error.message : "the revolve could not be built"}.`,
          422,
        );
      }
      continue;
    }

    const shape = shapeFromRequest(request);
    if (!shape) {
      return apiError(
        `Shape ${index} has an unsupported kind. The API can build: ${REQUESTABLE_SHAPE_KINDS.join(", ")}, revolve, thread.`,
        422,
      );
    }
    built.push(shape);
  }

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const written = await writeProjectDocument(context.root, projectId, document, [...document.shapes, ...built]);
    return apiJson({ shapes: built.map(apiShapeSummary), revision: written.revision }, 201);
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}

export async function PATCH(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);
  if (!shapeId) return apiError("A shapeId is required.", 400);

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiError("That shape is not in the project.", 404);
    if (existing.locked && body.locked !== false) {
      return apiError("That shape is locked. Send locked: false to change it.", 409);
    }

    const updated = shapeWithRequestedChanges(existing, body);
    const shapes = document.shapes.map((shape) => (shape.id === shapeId ? updated : shape));
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shape: apiShapeSummary(updated), revision: written.revision });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}

export async function DELETE(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);
  if (!shapeId) return apiError("A shapeId is required.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiError("That shape is not in the project.", 404);
    if (existing.locked) return apiError("That shape is locked.", 409);

    const shapes = document.shapes.filter((shape) => shape.id !== shapeId);
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ deleted: true, id: shapeId, revision: written.revision });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
