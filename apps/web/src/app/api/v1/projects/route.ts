import { apiContext, apiError, apiErrors, apiExpectedRevision, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { createLocalId } from "@/lib/engine/localIds";
import { horizontalPlacementWorkplane } from "@/lib/engine/placementWorkplane";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import {
  deleteProjectFiles,
  listProjectRecords,
  readProjectMetadata,
  withProjectLock,
  writeProjectMetadata,
  type ProjectMetadata,
} from "@/lib/engine/serverProjectFiles";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/engine/workplaneSettings";
import { parseCreateProjectRequest, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { paginateApiV1 } from "@/lib/apiV1Pagination";

export const runtime = "nodejs";
export const revalidate = false;

function projectSummary(projectId: string, metadata: ProjectMetadata, updatedAt: number, packageBytes: number) {
  return {
    id: projectId,
    name: typeof metadata.name === "string" ? metadata.name : "Untitled design",
    shapes: typeof metadata.shapes === "number" ? metadata.shapes : 0,
    revision: typeof metadata.revision === "number" ? metadata.revision : 0,
    updatedAt,
    packageBytes,
  };
}

/** The project list, or one project with its shapes when given `projectId`. */
async function getHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);

  if (new URL(request.url).searchParams.has("projectId")) {
    if (!projectId) return apiErrors.invalidProjectId();
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    return apiJson({
      project: {
        id: projectId,
        name: document.projectName,
        createdAt: document.createdAt,
        snapGrid: document.snapGrid,
        workspace: document.workspace,
        shapes: document.shapes.map(apiShapeSummary),
      },
    });
  }

  const records = await listProjectRecords(context.root);
  const page = paginateApiV1(records, new URL(request.url).searchParams.get("limit") ?? undefined, new URL(request.url).searchParams.get("cursor") ?? undefined);
  if (!page) return apiError("The limit or cursor is invalid.", 400, "invalid_request");
  return apiJson({ projects: page.items.map((record) => projectSummary(record.projectId, record.metadata, record.updatedAt, record.packageBytes)), nextCursor: page.nextCursor });
}

async function postHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;

  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  const parsed = parseCreateProjectRequest(body);
  if (!parsed) return apiError("A project name is required.", 400, "invalid_request");
  const requestedName = parsed.name;

  // The dashboard's own id shape, so a project made here is indistinguishable
  // from one made in the browser.
  const projectId = createLocalId("project");
  const now = Date.now();
  const locked = await withProjectLock(context.root, projectId, async () => {
    if (await readProjectMetadata(context.root, projectId)) {
      return apiError("That project already exists.", 409, "project_exists");
    }
    const metadata: ProjectMetadata = {
      id: projectId,
      name: requestedName,
      createdAt: now,
      updatedAt: now,
      revision: now,
      shapes: 0,
      accent: "sky",
      thumbnailUrl: null,
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
      placementWorkplane: horizontalPlacementWorkplane(),
      sketchPlacementWorkplane: horizontalPlacementWorkplane(),
    };
    await writeProjectMetadata(context.root, projectId, metadata);
    return apiJson({ project: projectSummary(projectId, metadata, now, 0) }, 201);
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}

async function deleteHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const locked = await withProjectLock(context.root, projectId, async () => {
    const metadata = await readProjectMetadata(context.root, projectId);
    if (!metadata) return apiErrors.projectNotFound();
    const expectedRevision = apiExpectedRevision(request);
    const currentRevision = typeof metadata?.revision === "number" ? metadata.revision : 0;
    if (expectedRevision !== undefined && expectedRevision !== "*" && expectedRevision !== String(currentRevision)) {
      return apiErrors.revisionMismatch(currentRevision);
    }
    const existed = await deleteProjectFiles(context.root, projectId);
    return existed ? apiJson({ deleted: true, id: projectId }) : apiErrors.projectNotFound();
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}

export const GET = withApiV1Contract("GET /api/v1/projects", getHandler);

export const POST = withApiV1Contract("POST /api/v1/projects", postHandler);

export const DELETE = withApiV1Contract("DELETE /api/v1/projects", deleteHandler);
