import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/engine/serverProjectDocument";
import { withProjectLock } from "@/lib/engine/serverProjectFiles";
import {
  isRevolveShape,
  outlineFromProfile,
  parseRevolveRequest,
  rebuiltRevolveShape,
  resolveThreadRequest,
  revolvedShapeFromRequest,
} from "@/lib/engine/revolveRequests";
import { serverManifoldRuntime } from "@/lib/engine/serverManifoldRuntime";
import { REQUESTABLE_SHAPE_KINDS, shapeFromRequest, shapeWithRequestedChanges } from "@/lib/engine/shapeRequests";
import { normalizeSketchRevolveSettings } from "@/lib/engine/sketchRevolve";
import type { SketchRevolveSettings, WorkplaneShape } from "@/types/sketchforge";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_SHAPES_PER_REQUEST = 200;

/**
 * `kind: "thread"` is `kind: "revolve"` with the outline filled in.
 *
 * A size from the catalog carries its own pitch, so "M8" is enough; an
 * explicit diameter and pitch still work for anything unlisted. `hole: true`
 * cuts the form wider by a clearance so a bolt of that size fits, and marks
 * the shape as a hole for the boolean to subtract.
 */
function resolvedThreadRequest(request: Record<string, unknown>): { request: Record<string, unknown>; error?: undefined } | { error: string; request?: undefined } {
  if (request.profile) return { request };
  const resolved = resolveThreadRequest(request);
  if ("error" in resolved) return { error: resolved.error };
  return {
    request: {
      ...request,
      profile: resolved.profile,
      pitch: resolved.pitch,
      turns: resolved.turns,
      coreRadius: resolved.coreRadius,
      hole: resolved.hole,
      name: typeof request.name === "string" ? request.name : (resolved.hole ? `${resolved.designation} hole` : resolved.designation),
    },
  };
}

/**
 * The settings a change names, over the ones a revolve already has.
 *
 * `sides` means the sweep's angular resolution here, not a facet count, which
 * is why a revolve's settings are read apart from the per-kind parameters: the
 * stored kind is `mesh`, and a mesh has no facets to count.
 */
const REVOLVE_SETTING_NAMES = ["startAngle", "sweepAngle", "sides", "quality", "pitch", "turns", "coreRadius"] as const;

/**
 * The change fields that can only mean a sweep.
 *
 * `sides` is left out because it is also a prism's facet count, and a cylinder
 * naming it is asking about facets, not about a helix it does not have.
 */
const REVOLVE_ONLY_FIELDS = ["startAngle", "sweepAngle", "quality", "pitch", "turns", "coreRadius", "revolve", "profile", "outline"] as const;

const REVOLVE_CHANGE_FIELDS = [...REVOLVE_SETTING_NAMES, "revolve", "profile", "outline"] as const;

function requestedRevolveSettings(existing: SketchRevolveSettings, body: Record<string, unknown>): SketchRevolveSettings {
  const nested = body.revolve && typeof body.revolve === "object" && !Array.isArray(body.revolve)
    ? (body.revolve as Record<string, unknown>)
    : {};
  const requested: Record<string, unknown> = { ...existing };
  for (const name of REVOLVE_SETTING_NAMES) {
    const value = nested[name] ?? body[name];
    if (value !== undefined) requested[name] = value;
  }
  return normalizeSketchRevolveSettings(requested as Partial<SketchRevolveSettings>);
}

export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiErrors.projectNotFound();
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
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const requested = Array.isArray(body.shapes) ? body.shapes : [body];
  if (requested.length === 0) return apiError("No shapes were given.", 400, "invalid_request");
  if (requested.length > MAX_SHAPES_PER_REQUEST) {
    return apiError(`A request can add at most ${MAX_SHAPES_PER_REQUEST} shapes.`, 413, "too_many_shapes");
  }

  const built: WorkplaneShape[] = [];
  for (const [index, entry] of requested.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return apiError(`Shape ${index} is not an object.`, 400, "invalid_request");
    }
    const request = entry as Record<string, unknown>;

    // A revolve is described by an outline and a pitch rather than by
    // dimensions, and it is built by manifold rather than from parameters --
    // which is what makes threads and springs possible here at all.
    if (request.kind === "revolve" || request.kind === "thread") {
      let revolveRequest = request;
      if (request.kind === "thread") {
        const resolved = resolvedThreadRequest(request);
        if (!resolved.request) return apiError(`Shape ${index}: ${resolved.error}`, 400, "invalid_request");
        revolveRequest = resolved.request;
      }
      const parsed = parseRevolveRequest(revolveRequest);
      if (!parsed.ok) return apiError(`Shape ${index}: ${parsed.error}`, 400, "invalid_request");
      try {
        const runtime = await serverManifoldRuntime();
        built.push(revolvedShapeFromRequest(runtime, parsed, {
          name: typeof revolveRequest.name === "string" ? revolveRequest.name : undefined,
          color: typeof request.color === "string" ? request.color : undefined,
          x: typeof request.x === "number" ? request.x : undefined,
          z: typeof request.z === "number" ? request.z : undefined,
          elevation: typeof request.elevation === "number" ? request.elevation : undefined,
          rotation: typeof request.rotation === "number" ? request.rotation : undefined,
          hole: revolveRequest.hole === true,
        }));
      } catch (error) {
        return apiError(
          `Shape ${index}: ${error instanceof Error ? error.message : "the revolve could not be built"}.`,
          422,
          "geometry_failed",
        );
      }
      continue;
    }

    const shape = shapeFromRequest(request);
    if (!shape) {
      return apiError(
        `Shape ${index} has an unsupported kind. The API can build: ${REQUESTABLE_SHAPE_KINDS.join(", ")}, revolve, thread.`,
        422,
        "unsupported_kind",
      );
    }
    built.push(shape);
  }

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const written = await writeProjectDocument(context.root, projectId, document, [...document.shapes, ...built]);
    return apiJson({ shapes: built.map(apiShapeSummary), revision: written.revision }, 201);
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}

/**
 * Change a shape.
 *
 * Everything the shape summary reports can be sent back, which is the whole
 * point of reporting it. For a revolve or a thread that means the sweep itself:
 * a pitch, a turn count or a new outline is geometry rather than a property, so
 * the mesh is swept again here -- manifold runs under Node, and refusing to
 * rebuild would leave a thread's pitch readable but not writable, which is the
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

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiErrors.shapeNotFound();
    if (existing.locked && body.locked !== false) {
      return apiErrors.shapeLocked("That shape is locked. Send locked: false to change it.");
    }

    const sweptShape = isRevolveShape(existing);
    const misplaced = REVOLVE_ONLY_FIELDS.filter((field) => body[field] !== undefined);
    if (!sweptShape && misplaced.length > 0) {
      return apiError(
        `A shape of kind "${existing.kind}" has no sweep to change: ${misplaced.join(", ")}.`,
        422,
        "unapplicable_fields",
        { fields: misplaced },
      );
    }

    const revolveChanges = sweptShape ? REVOLVE_CHANGE_FIELDS.filter((field) => body[field] !== undefined) : [];
    let swept = existing;
    if (revolveChanges.length > 0 && sweptShape) {
      const outline = body.profile ?? body.outline ?? outlineFromProfile(existing.sketchProfile!);
      if (!outline) {
        return apiError(
          "That revolve's outline was drawn rather than described, so the sweep cannot be rebuilt from it. Send a profile to replace it.",
          422,
          "unapplicable_fields",
          { fields: revolveChanges },
        );
      }
      const parsed = parseRevolveRequest({ profile: outline });
      if (!parsed.ok) return apiError(parsed.error, 400, "invalid_request");
      try {
        const runtime = await serverManifoldRuntime();
        swept = rebuiltRevolveShape(runtime, existing, {
          profile: parsed.profile,
          settings: requestedRevolveSettings(existing.sketchRevolve!, body),
        });
      } catch (error) {
        return apiError(
          `${error instanceof Error ? error.message : "The revolve could not be rebuilt"}.`,
          422,
          "geometry_failed",
        );
      }
    }

    const sweepFields: readonly string[] = sweptShape ? REVOLVE_CHANGE_FIELDS : REVOLVE_ONLY_FIELDS;
    const changed = shapeWithRequestedChanges(swept, Object.fromEntries(
      Object.entries(body).filter(([field]) => !sweepFields.includes(field)),
    ));
    if (!changed.ok) {
      return apiError(
        `A shape of kind "${existing.kind}" cannot take: ${changed.unapplicable.join(", ")}.`,
        422,
        "unapplicable_fields",
        { fields: changed.unapplicable },
      );
    }

    const shapes = document.shapes.map((shape) => (shape.id === shapeId ? changed.shape : shape));
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shape: apiShapeSummary(changed.shape), revision: written.revision });
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}

export async function DELETE(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiErrors.shapeNotFound();
    if (existing.locked) return apiErrors.shapeLocked();

    const shapes = document.shapes.filter((shape) => shape.id !== shapeId);
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ deleted: true, id: shapeId, revision: written.revision });
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}
