/**
 * A server-stored project as shapes (upstream issue #55).
 *
 * Node-only. The geometry lives in the project's `.skf` package, so changing a
 * shape means unpacking it, editing the list, and packing it again -- and
 * bumping the revision in the metadata sidecar, which is what tells an open
 * dashboard its copy is behind.
 */

import { appendEditorHistorySnapshot, editorHistoryEntry, type EditorHistoryEntry } from "@/lib/engine/editorHistory";
import {
  projectRecord,
  readProjectMetadata,
  readProjectPackage,
  writeProjectMetadata,
  writeProjectPackage,
  type ProjectMetadata,
} from "@/lib/engine/serverProjectFiles";
import { exportSkfProject, importSkfProject } from "@/lib/engine/skfProject";
import { serverSourceImporter } from "@/lib/engine/serverSourceImporter";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@/lib/engine/placementWorkplane";
import type { GridSize, ProjectAsset, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";
import type { PlacementWorkplane } from "@/lib/engine/placementWorkplane";

export type ProjectDocument = {
  metadata: ProjectMetadata;
  projectName: string;
  createdAt: number;
  shapes: WorkplaneShape[];
  // Carried through a write untouched. These belong to the project, not to the
  // shapes, and an API call that changes one shape must not reset the grid or
  // tip the workplane back to flat.
  history: EditorHistoryEntry[];
  historyIndex: number;
  // An imported mesh's source file lives here, not on the shape: writing the
  // package back without it would strip the import out of the project.
  assets: ProjectAsset[];
  workspace: WorkplaneWorkspaceSettings;
  snapGrid: GridSize;
  placementElevation: number;
  placementWorkplane: PlacementWorkplane;
  sketchPlacementWorkplane: PlacementWorkplane;
};

function metadataNumber(metadata: ProjectMetadata, key: string, fallback: number) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function metadataString(metadata: ProjectMetadata, key: string, fallback: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * The project's metadata and shapes, or null when it is not there.
 *
 * A project whose package has not been written yet reads as an empty one
 * rather than a missing one: the dashboard creates the sidecar first, and a
 * script adding the first shape should not have to care.
 */
export async function readProjectDocument(root: string, projectId: string): Promise<ProjectDocument | null> {
  const metadata = await readProjectMetadata(root, projectId);
  if (!metadata) return null;
  const projectName = metadataString(metadata, "name", "Untitled design");
  const createdAt = metadataNumber(metadata, "createdAt", Date.now());
  const packageBytes = await readProjectPackage(root, projectId);
  if (!packageBytes) {
    return {
      metadata,
      projectName,
      createdAt,
      shapes: [],
      history: [],
      historyIndex: 0,
      assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
      placementWorkplane: horizontalPlacementWorkplane(),
      sketchPlacementWorkplane: horizontalPlacementWorkplane(),
    };
  }
  // With the server's own source importer: the default one rebuilds a STEP
  // asset through the browser's kernel loader, so without this every project
  // holding one is unreadable here.
  const restored = await importSkfProject(packageBytes, { sourceImporter: serverSourceImporter });
  return {
    metadata,
    projectName: restored.projectName || projectName,
    createdAt: restored.createdAt || createdAt,
    shapes: restored.shapes,
    history: restored.history,
    historyIndex: restored.historyIndex,
    assets: restored.assets,
    workspace: restored.workspace,
    snapGrid: restored.snapGrid,
    placementElevation: restored.placementElevation,
    placementWorkplane: restored.placementWorkplane,
    sketchPlacementWorkplane: restored.sketchPlacementWorkplane,
  };
}

/**
 * Store a new shape list for a project.
 *
 * The revision is advanced past both the stored one and the clock, the way the
 * editor advances it, so a dashboard holding this project reloads it rather
 * than keeping a stale cache that outranks what was just written.
 */
export async function writeProjectDocument(root: string, projectId: string, document: ProjectDocument, shapes: WorkplaneShape[]) {
  const revision = Math.max(Date.now(), metadataNumber(document.metadata, "revision", 0) + 1);
  // An API change lands as one more undo step rather than wiping the stack, so
  // whoever opens the project next can undo back past it.
  const history = appendEditorHistorySnapshot(
    document.history,
    document.historyIndex,
    editorHistoryEntry(shapes, []),
  );
  const packageBytes = await exportSkfProject({
    projectId,
    projectName: document.projectName,
    createdAt: document.createdAt,
    modifiedAt: revision,
    shapes,
    history: history.entries,
    historyIndex: history.index,
    assets: document.assets,
    workspace: document.workspace,
    snapGrid: document.snapGrid,
    placementElevation: document.placementElevation,
    placementWorkplane: document.placementWorkplane,
    sketchPlacementWorkplane: document.sketchPlacementWorkplane,
    compressionLevel: 1,
  });
  await writeProjectPackage(root, projectId, packageBytes);
  const metadata: ProjectMetadata = {
    ...document.metadata,
    name: document.projectName,
    shapes: shapes.length,
    revision,
    updatedAt: revision,
  };
  await writeProjectMetadata(root, projectId, metadata);
  return { metadata, record: await projectRecord(root, projectId, metadata), revision };
}
