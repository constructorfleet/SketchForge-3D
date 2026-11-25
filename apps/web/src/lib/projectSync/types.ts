import type { PlacementWorkplane } from "@/lib/engine/placementWorkplane";
import type { ProjectShapeCacheEntry, ProjectShapeSaveContext } from "@/lib/projectShapeCache";
import type { GridSize, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export type ProjectStorageMode = "browser" | "server";

/** One project as the dashboard lists it, in the browser list and in server metadata sidecars. */
export type DashboardProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  shapes: number;
  accent: "cyan" | "green" | "gold" | "red";
  thumbnailUrl?: string | null;
  thumbnailVersion?: number;
  revision?: number;
  workspace?: WorkplaneWorkspaceSettings;
  snapGrid?: GridSize;
  placementElevation?: number;
  placementWorkplane?: PlacementWorkplane;
  sketchPlacementWorkplane?: PlacementWorkplane;
  sharedProject?: { fileName: string; revision: string };
};

export type StoredDashboardProject = Partial<DashboardProject> & {
  designShapes?: unknown;
};

/** One queued autosave. `shapeCount` and `revision` are what the list shows once it lands. */
export type ProjectSaveJob = {
  entry: ProjectShapeCacheEntry;
  context: ProjectShapeSaveContext;
  revision: number;
  shapeCount: number;
};

/**
 * Whether this client may write a project, and why not.
 *
 * - `synced`: writes go ahead.
 * - `blocked`: held back after a failed Start over; a good load releases it.
 * - `unreadable`: the stored copy was read but could not be opened (#622, #648).
 * - `unavailable`: storage or the server could not be reached.
 * - `conflicted`: another client saved a newer copy (#650, #656).
 * - `deleted`: deleted here, or deleted elsewhere and refused by the server (#665, #672).
 */
export type ProjectSyncStatus = "synced" | "blocked" | "unreadable" | "unavailable" | "conflicted" | "deleted";
