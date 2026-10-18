import { apiContext, apiError, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { createLocalId } from "@/lib/localIds";
import { horizontalPlacementWorkplane } from "@/lib/placementWorkplane";
import { readProjectDocument } from "@/lib/serverProjectDocument";
import {
  deleteProjectFiles,
  listProjectRecords,
  readProjectMetadata,
  withProjectLock,
  writeProjectMetadata,
  type ProjectMetadata,
} from "@/lib/serverProjectFiles";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";

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
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);

  if (new URL(request.url).searchParams.has("projectId")) {
    if (!projectId) return apiError("Invalid project id.", 400);
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
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
  return apiJson({ projects: records.map((record) => projectSummary(record.projectId, record.metadata, record.updatedAt, record.packageBytes)) });
}

export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);
  const requestedName = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!requestedName) return apiError("A project name is required.", 400);

  // The dashboard's own id shape, so a project made here is indistinguishable
  // from one made in the browser.
  const projectId = createLocalId("project");
  const now = Date.now();
  const locked = await withProjectLock(context.root, projectId, async () => {
    if (await readProjectMetadata(context.root, projectId)) {
      return apiError("That project already exists.", 409);
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
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}

export async function DELETE(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const existed = await deleteProjectFiles(context.root, projectId);
    return existed ? apiJson({ deleted: true, id: projectId }) : apiError("That project is not on the server.", 404);
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
