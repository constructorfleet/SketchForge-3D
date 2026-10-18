import { apiContext, apiError, apiJson, apiJsonBody } from "@/lib/apiV1";
import { listProjectRecords, readProjectMetadata, withProjectLock, writeProjectMetadata } from "@/lib/serverProjectFiles";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";
import { horizontalPlacementWorkplane } from "@/lib/placementWorkplane";
import { createLocalId } from "@/lib/localIds";

export const runtime = "nodejs";
export const revalidate = false;

function projectSummary(record: Awaited<ReturnType<typeof listProjectRecords>>[number]) {
  const metadata = record.metadata as { name?: unknown; shapes?: unknown; revision?: unknown };
  return {
    id: record.projectId,
    name: typeof metadata.name === "string" ? metadata.name : "Untitled design",
    shapes: typeof metadata.shapes === "number" ? metadata.shapes : 0,
    revision: typeof metadata.revision === "number" ? metadata.revision : 0,
    updatedAt: record.updatedAt,
    packageBytes: record.packageBytes,
  };
}

export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  return apiJson({ projects: (await listProjectRecords(context.root)).map(projectSummary) });
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
    await writeProjectMetadata(context.root, projectId, {
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
    });
    return apiJson({ project: { id: projectId, name: requestedName, shapes: 0, revision: now, updatedAt: now, packageBytes: 0 } }, 201);
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
