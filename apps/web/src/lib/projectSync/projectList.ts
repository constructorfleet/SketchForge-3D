/** The project list as the browser stores it, and the normalising both stores share. */
import { normalizePlacementWorkplane } from "@/lib/engine/placementWorkplane";
import { normalizeSnapGrid, normalizeWorkspaceSettings } from "@/lib/engine/workplaneSettings";
import { projectShapeCacheEntry, type ProjectShapeCacheEntry, type ProjectShapeSaveContext } from "@/lib/projectShapeCache";
import { readProjectTombstones } from "@/lib/projectTombstones";
import { writeServerSyncedRevisions } from "@/lib/serverSyncedRevisions";
import type { WorkplaneShape } from "@/types/sketchforge";
import type { KeyValueStore } from "./adapters";
import type { DashboardProject, StoredDashboardProject } from "./types";

export const PROJECTS_STORAGE_KEY = "sketchForge.projects";
// The browser list as it stood when server storage adopted it. Kept so that
// unsetting SKETCHFORGE_PROJECTS_DIR gives the projects back: IndexedDB still
// holds their geometry, but without a list nothing would show it.
export const MIGRATED_PROJECTS_STORAGE_KEY = "sketchForge.projects.beforeServerStorage";
export const PROJECT_ACCENTS: DashboardProject["accent"][] = ["cyan", "green", "gold", "red"];

export function projectShapeSaveContext(project: Pick<DashboardProject, "name" | "createdAt" | "workspace" | "snapGrid" | "placementElevation" | "placementWorkplane" | "sketchPlacementWorkplane">): ProjectShapeSaveContext {
  const placementElevation = Number.isFinite(project.placementElevation) ? project.placementElevation ?? 0 : 0;
  return {
    projectName: project.name,
    createdAt: project.createdAt,
    workspace: normalizeWorkspaceSettings(project.workspace),
    snapGrid: normalizeSnapGrid(project.snapGrid),
    placementElevation,
    placementWorkplane: normalizePlacementWorkplane(project.placementWorkplane, placementElevation),
    sketchPlacementWorkplane: normalizePlacementWorkplane(project.sketchPlacementWorkplane),
  };
}

/**
 * One stored project as the dashboard holds it.
 *
 * Shared by the `localStorage` list and the server store (upstream #109),
 * whose metadata sidecars hold this same serialized shape.
 */
export function normalizeStoredProject(
  project: StoredDashboardProject,
  index: number,
  legacyShapes?: Record<string, ProjectShapeCacheEntry>,
): DashboardProject {
  const id = project.id as string;
  const updatedAt = typeof project.updatedAt === "number" ? project.updatedAt : Date.now();
  const revision = typeof project.revision === "number" ? project.revision : updatedAt;
  const designShapes = Array.isArray(project.designShapes) ? (project.designShapes as WorkplaneShape[]) : null;
  if (designShapes && legacyShapes) {
    legacyShapes[id] = projectShapeCacheEntry(revision, designShapes);
  }
  return {
    id,
    name: project.name as string,
    createdAt: typeof project.createdAt === "number" ? project.createdAt : Date.now(),
    updatedAt,
    shapes: typeof project.shapes === "number" ? project.shapes : (designShapes?.length ?? 0),
    accent: PROJECT_ACCENTS.includes(project.accent as DashboardProject["accent"]) ? (project.accent as DashboardProject["accent"]) : PROJECT_ACCENTS[index % PROJECT_ACCENTS.length],
    thumbnailUrl: typeof project.thumbnailUrl === "string" ? project.thumbnailUrl : null,
    thumbnailVersion: typeof project.thumbnailVersion === "number" ? project.thumbnailVersion : undefined,
    revision,
    workspace: normalizeWorkspaceSettings(project.workspace),
    snapGrid: normalizeSnapGrid(project.snapGrid),
    placementElevation: typeof project.placementElevation === "number" && Number.isFinite(project.placementElevation) ? project.placementElevation : 0,
    placementWorkplane: normalizePlacementWorkplane(project.placementWorkplane, project.placementElevation),
    sketchPlacementWorkplane: normalizePlacementWorkplane(project.sketchPlacementWorkplane),
    sharedProject: typeof project.sharedProject?.fileName === "string" && typeof project.sharedProject.revision === "string"
      ? { fileName: project.sharedProject.fileName, revision: project.sharedProject.revision }
      : undefined,
  };
}

export function storedProjectIsUsable(project: StoredDashboardProject) {
  return typeof project.id === "string" && typeof project.name === "string";
}

/** Reads the browser list, without projects deleted in any tab of this browser (#670). */
export function readStoredProjects(storage: KeyValueStore) {
  const legacyShapes: Record<string, ProjectShapeCacheEntry> = {};
  try {
    const parsed = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY) ?? "[]") as StoredDashboardProject[];
    // Another tab may write back a list that still holds a project deleted here.
    const tombstones = readProjectTombstones(storage);
    const projects = parsed
      .filter(storedProjectIsUsable)
      .filter((project) => !tombstones.has(project.id as string))
      .map((project, index) => normalizeStoredProject(project, index, legacyShapes));
    return { projects, legacyShapes };
  } catch {
    return { projects: [], legacyShapes };
  }
}

export function readProjects(storage: KeyValueStore) {
  return readStoredProjects(storage).projects;
}

/**
 * Put the browser list back after server storage has been turned off again.
 *
 * Adopting projects onto the server empties the browser list, so a server that
 * stops answering would otherwise leave a dashboard with nothing on it even
 * though IndexedDB still holds every project's geometry. Restoring only when
 * the live list is empty means this can never fight with projects made since.
 */
export function restoreProjectsFromBeforeServerStorage(storage: KeyValueStore) {
  try {
    const backup = storage.getItem(MIGRATED_PROJECTS_STORAGE_KEY);
    if (!backup) return null;
    const current = storage.getItem(PROJECTS_STORAGE_KEY);
    if (current && current !== "[]") {
      storage.removeItem(MIGRATED_PROJECTS_STORAGE_KEY);
      return null;
    }
    storage.setItem(PROJECTS_STORAGE_KEY, backup);
    storage.removeItem(MIGRATED_PROJECTS_STORAGE_KEY);
    const restored = readStoredProjects(storage).projects;
    // Edits past these revisions never reached the server, so a later move must not drop them.
    writeServerSyncedRevisions(storage, restored);
    return restored;
  } catch {
    return null;
  }
}

function mergeProjectForStorage(project: DashboardProject, storedProject?: DashboardProject) {
  if (!storedProject) {
    return project;
  }
  const projectRevision = project.revision ?? 0;
  const storedRevision = storedProject.revision ?? 0;
  if (storedRevision <= projectRevision) {
    return project;
  }
  return {
    ...project,
    revision: storedProject.revision,
    shapes: storedProject.shapes || project.shapes,
    thumbnailUrl: project.thumbnailUrl ?? storedProject.thumbnailUrl,
    thumbnailVersion: project.thumbnailVersion ?? storedProject.thumbnailVersion,
    updatedAt: Math.max(project.updatedAt, storedProject.updatedAt),
    workspace: storedProject.workspace ?? project.workspace,
    snapGrid: storedProject.snapGrid ?? project.snapGrid,
    placementElevation: storedProject.placementElevation ?? project.placementElevation,
    placementWorkplane: storedProject.placementWorkplane ?? project.placementWorkplane,
    sketchPlacementWorkplane: storedProject.sketchPlacementWorkplane ?? project.sketchPlacementWorkplane,
    sharedProject: project.sharedProject ?? storedProject.sharedProject,
  };
}

export function projectForStorage(project: DashboardProject): DashboardProject {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    shapes: project.shapes,
    accent: project.accent,
    thumbnailUrl: project.thumbnailUrl ?? null,
    thumbnailVersion: project.thumbnailVersion,
    revision: project.revision,
    workspace: normalizeWorkspaceSettings(project.workspace),
    snapGrid: normalizeSnapGrid(project.snapGrid),
    placementElevation: typeof project.placementElevation === "number" && Number.isFinite(project.placementElevation) ? project.placementElevation : 0,
    placementWorkplane: normalizePlacementWorkplane(project.placementWorkplane, project.placementElevation),
    sketchPlacementWorkplane: normalizePlacementWorkplane(project.sketchPlacementWorkplane),
    sharedProject: project.sharedProject,
  };
}

/** Normalises the list, keeping fields the stored list holds at a newer revision. */
export function mergeProjectsForStorage(projects: DashboardProject[], storage: KeyValueStore) {
  const storedProjects = readProjects(storage);
  const storedById = new Map(storedProjects.map((project) => [project.id, project]));
  return projects.map((project) => projectForStorage(mergeProjectForStorage(project, storedById.get(project.id))));
}
