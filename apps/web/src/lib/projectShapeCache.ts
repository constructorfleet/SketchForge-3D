import { editorHistoryForAutosave, hydrateEditorHistoryState, type EditorHistoryEntry } from "@/lib/engine/editorHistory";
import type { PlacementWorkplane } from "@/lib/engine/placementWorkplane";
import { dedupeProjectAssets } from "@/lib/engine/projectAssets";
import { exportSkfProject } from "@/lib/engine/skfProject";
import type { GridSize, ProjectAsset, ProjectParameter, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export type ProjectShapeCacheEntry = {
  revision: number;
  shapes: WorkplaneShape[];
  history: EditorHistoryEntry[];
  historyIndex: number;
  assets: ProjectAsset[];
  parameters: ProjectParameter[];
};

export type ProjectShapeSaveContext = {
  projectName: string;
  createdAt: number;
  workspace: WorkplaneWorkspaceSettings;
  snapGrid: GridSize;
  placementElevation: number;
  placementWorkplane: PlacementWorkplane;
  sketchPlacementWorkplane: PlacementWorkplane;
};

export function projectShapeCacheEntry(
  revision: number,
  shapes: WorkplaneShape[],
  history?: EditorHistoryEntry[],
  historyIndex?: number,
  assets: ProjectAsset[] = [],
  parameters: ProjectParameter[] = [],
): ProjectShapeCacheEntry {
  const hydrated = hydrateEditorHistoryState(shapes, history, historyIndex);
  return {
    revision,
    shapes: hydrated.entries[hydrated.index]?.shapes ?? shapes,
    history: hydrated.entries,
    historyIndex: hydrated.index,
    assets: dedupeProjectAssets(assets),
    parameters,
  };
}

export function projectShapeCacheEntryFromEditor(
  revision: number,
  shapes: WorkplaneShape[],
  history: EditorHistoryEntry[],
  historyIndex: number,
  assets: ProjectAsset[],
  parameters: ProjectParameter[],
): ProjectShapeCacheEntry {
  if (history.length === 0) {
    return projectShapeCacheEntry(revision, shapes, history, historyIndex, assets, parameters);
  }
  return {
    revision,
    shapes,
    history,
    historyIndex: Math.min(Math.max(0, historyIndex), history.length - 1),
    assets: dedupeProjectAssets(assets),
    parameters,
  };
}

/** The `.skf` package autosave stores for a project; "Export all projects" packs the same bytes. */
export function projectSkfPackage(projectId: string, entry: ProjectShapeCacheEntry, context: ProjectShapeSaveContext) {
  const autosaveHistory = editorHistoryForAutosave(entry.history, entry.historyIndex);
  return exportSkfProject({
    projectId,
    projectName: context.projectName,
    createdAt: context.createdAt,
    modifiedAt: entry.revision,
    shapes: entry.shapes,
    history: autosaveHistory.entries,
    historyIndex: autosaveHistory.index,
    assets: entry.assets,
    workspace: context.workspace,
    snapGrid: context.snapGrid,
    placementElevation: context.placementElevation,
    placementWorkplane: context.placementWorkplane,
    sketchPlacementWorkplane: context.sketchPlacementWorkplane,
    parameters: entry.parameters,
    compressionLevel: 1,
  });
}
