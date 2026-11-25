"use client";

import { Clock3, CopyPlus, Download, EllipsisVertical, FileUp, FolderKanban, Grid3X3, HomeIcon, List, Palette, Pencil, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SketchForgeEditor, importedShapeFromObj, importedShapeFromStl, importedShapeFromSvg } from "@/components/SketchForgeEditor";
import ChallengesDashboard from "@/components/official/ChallengesDashboard";
import {
  LANGUAGE_PREFERENCE_OPTIONS,
  LocalizedError,
  currentTranslator,
  errorFromPayload,
  errorFromResponse,
  errorText,
  formattingLocale,
  initLanguage,
  languagePreferenceLabel,
  normalizeLanguagePreference,
  notice,
  translate,
  useLanguagePreference,
  useLocale,
  useTranslations,
  type ErrorResponseFields,
  type Locale,
  type Notice,
  type Translator,
} from "@/i18n";
import { applyAppTheme, readStoredAppTheme, resolveAppTheme, storeAppTheme, type AppThemePreference, type ResolvedAppTheme } from "@/lib/appTheme";
import type { AppUpdateStatus } from "@/lib/appUpdates";
import { isChallengeTutorialId, type ChallengeTutorialId } from "@/lib/challenges";
import { NO_CONFIGURATIONS, type EditorHistoryEntry, type ProjectConfigurationState } from "@/lib/engine/editorHistory";
import { createAutosaveNoticeController, type AutosaveNotice } from "@/lib/autosaveNotice";
import { createLocalId } from "@/lib/engine/localIds";
import { publicAssetPath, withAppBasePath } from "@/lib/publicAssetPath";
import {
  horizontalPlacementWorkplane,
  normalizePlacementWorkplane,
  placementWorkplaneFingerprint,
  type PlacementWorkplane,
} from "@/lib/engine/placementWorkplane";
import { attachProjectAsset, dedupeProjectAssets, projectAssetFromBytes, sourceFormatForFileName } from "@/lib/engine/projectAssets";
import { reconcileLoadedProjectShapeCacheEntry } from "@/lib/projectShapePersistence";
import {
  PROJECT_ACCENTS,
  StoredProjectMissingError,
  cacheWithEditorChange,
  createProjectSync,
  projectLoadFailureCause,
  projectShapeSaveContext,
  withoutDeletedProjects,
  type DashboardProject,
  type ProjectLoadFailureKind,
  type ProjectStorageMode,
  type ProjectSyncEvent,
} from "@/lib/projectSync";
import { browserProjectSyncAdapters } from "@/lib/projectSync/browserAdapters";
import {
  projectShapeCacheEntry,
  projectShapeCacheEntryFromEditor,
  projectSkfPackage,
  type ProjectShapeCacheEntry,
  type ProjectShapeSaveContext,
} from "@/lib/projectShapeCache";
import { openableProjectIds, ServerPackageRequestError, ServerProjectConflictError } from "@/lib/serverProjectStore";
import { importSkfProject, SKF_CREATED_WITH_VERSION, SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";
import { importExtensionSupported } from "@/lib/importExtensions";
import { openDesktopProjectFile } from "@/lib/desktopProjectFile";
import { downloadBlob } from "@/lib/downloadFile";
import { projectExportFileName } from "@/lib/exportNames";
import { PROJECTS_BACKUP_MEDIA_TYPE, newerBackupSource, projectsBackupFileName, storedBackupRevision, writeProjectsBackup, type ProjectBackupEntry } from "@/lib/projectBackup";
import { browserStorageManager, readStorageStatus, requestPersistentStorageOnce, storageNearQuota, storageUsageFraction, type StorageStatus } from "@/lib/storageHealth";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE, normalizeSnapGrid, normalizeWorkspaceSettings, workplaneSettingsFingerprint } from "@/lib/engine/workplaneSettings";
import type { GridSize, ProjectAsset, ProjectParameter, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

type AppView = "dashboard" | "editor";
type ViewMode = "grid" | "list";
type DashboardSection = "home" | "shared" | "challenges" | "customization";
type DownloadMode = "browser" | "folder";

type SharedProject = {
  fileName: string;
  name: string;
  updatedAt: number;
  size: number;
  revision: string;
  thumbnailUrl?: string;
};

type ProjectLoadFailure = { kind: ProjectLoadFailureKind; message: string };

const LOAD_FAILURE_TEXT = {
  unreadable: { title: "dashboard.loadFailure.title", body: "dashboard.loadFailure.kept" },
  storageNewer: { title: "dashboard.loadFailure.title", body: "dashboard.loadFailure.storageNewerKept" },
  unavailable: { title: "dashboard.loadFailure.unavailableTitle", body: "dashboard.loadFailure.unavailableKept" },
  missing: { title: "dashboard.loadFailure.missingTitle", body: "dashboard.loadFailure.missingKept" },
  conflict: { title: "dashboard.loadFailure.conflictTitle", body: "dashboard.loadFailure.conflictKept" },
  deleted: { title: "dashboard.loadFailure.deletedTitle", body: "dashboard.loadFailure.deletedKept" },
} as const satisfies Record<ProjectLoadFailureKind, { title: string; body: string }>;

const DOWNLOAD_MODE_STORAGE_KEY = "sketchForge.downloadMode";
const DOWNLOAD_FOLDER_STORAGE_KEY = "sketchForge.downloadFolder";
const PROJECT_NAME_TOOLBAR_STORAGE_KEY = "sketchForge.showProjectNameInToolbar";
const ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY = "sketchForge.activeChallengeTutorial";
const DISMISSED_UPDATE_VERSION_STORAGE_KEY = "sketchForge.dismissedUpdateVersion";
const STATIC_EXPORT_BUILD = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";
// The corresponding source of *this* build, which is what the AGPL asks a
// network user be offered -- not the project this was forked from, whose code
// is not what is running. Overridable for anyone running their own fork.
const SOURCE_CODE_URL = process.env.NEXT_PUBLIC_SOURCE_CODE_URL?.trim() || "https://github.com/constructorfleet/SketchForge-3D";
const EDITOR_SKELETON_MIN_DURATION_MS = 320;
// Every storage and sync rule lives in the project sync module (#678); the page renders what it
// reports. Module scope keeps its state for the page's lifetime, as the module-level maps it replaced did.
const sync = createProjectSync(browserProjectSyncAdapters({ staticExport: STATIC_EXPORT_BUILD }));

function formatUpdated(t: Translator, locale: Locale, timestamp: number) {
  const age = Date.now() - timestamp;
  if (age < 60_000) return t("dashboard.time.justNow");
  if (age < 3_600_000) return t("dashboard.time.minutesAgo", { count: Math.max(1, Math.round(age / 60_000)) });
  if (age < 86_400_000) return t("dashboard.time.today");
  return new Intl.DateTimeFormat(formattingLocale(locale), { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function formatFileSize(t: Translator, locale: Locale, bytes: number) {
  const format = (value: number, fractionDigits: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits, useGrouping: false }).format(value);
  if (bytes < 1024) return t("dashboard.fileSize.bytes", { size: format(bytes, 0) });
  if (bytes < 1024 * 1024) return t("dashboard.fileSize.kilobytes", { size: format(bytes / 1024, bytes < 10 * 1024 ? 1 : 0) });
  return t("dashboard.fileSize.megabytes", { size: format(bytes / (1024 * 1024), bytes < 10 * 1024 * 1024 ? 1 : 0) });
}

/** Describes a failed read of one project's stored copy. */
function loadFailureDetail(t: Translator, error: unknown, fallbackKey: Parameters<typeof errorText>[2]) {
  const cause = projectLoadFailureCause(error);
  if (cause instanceof StoredProjectMissingError) return t("dashboard.loadFailure.packageMissing");
  if (!(cause instanceof ServerPackageRequestError)) return errorText(t, cause, fallbackKey);
  const params = { detail: cause.detail };
  if (cause.reason === "network") return t("dashboard.loadFailure.packageNetwork", params);
  if (cause.reason === "status") return t("dashboard.loadFailure.packageStatus", params);
  return t("dashboard.loadFailure.packageNotPackage", params);
}

function newProject(name: string, index: number, shapeCount = 0): DashboardProject {
  const now = Date.now();
  return {
    id: createLocalId("project"),
    name,
    createdAt: now,
    updatedAt: now,
    shapes: shapeCount,
    accent: PROJECT_ACCENTS[index % PROJECT_ACCENTS.length],
    revision: now,
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
}

function projectNameFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || "Imported design";
}

export default function Home() {
  const t = useTranslations();
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<AppView>("dashboard");
  const [editorStarted, setEditorStarted] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [dashboardSection, setDashboardSection] = useState<DashboardSection>("home");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState("recent");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<AppThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedAppTheme>("light");
  const [downloadMode, setDownloadMode] = useState<DownloadMode>("browser");
  const [localDownloadEnabled, setLocalDownloadEnabled] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState("");
  const [showProjectNameInToolbar, setShowProjectNameInToolbar] = useState(true);
  const [dashboardNotice, setDashboardNotice] = useState("");
  const [autosaveNotice, setAutosaveNotice] = useState<AutosaveNotice | null>(null);
  const autosaveNoticeControllerRef = useRef<ReturnType<typeof createAutosaveNoticeController> | null>(null);
  if (autosaveNoticeControllerRef.current === null) {
    autosaveNoticeControllerRef.current = createAutosaveNoticeController(setAutosaveNotice);
  }
  const [projectStorageMode, setProjectStorageMode] = useState<ProjectStorageMode>("browser");
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  // Whether the server-storage probe has answered. A static build has no
  // server to ask, so it starts settled in browser mode.
  const [storageProbeSettled, setStorageProbeSettled] = useState(STATIC_EXPORT_BUILD);
  const [editorHostNotice, setEditorHostNotice] = useState<{ id: number; notice: Notice } | null>(null);
  const [exportingAllProjects, setExportingAllProjects] = useState(false);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [sharedProjectsEnabled, setSharedProjectsEnabled] = useState(false);
  const [sharedProjectsLoading, setSharedProjectsLoading] = useState(false);
  const [activeChallengeTutorial, setActiveChallengeTutorial] = useState<ChallengeTutorialId | null>(null);
  const [projectShapesById, setProjectShapesById] = useState<Record<string, ProjectShapeCacheEntry>>({});
  // Project id to load error, for projects whose stored copy could not be read.
  const [projectLoadFailures, setProjectLoadFailures] = useState<Record<string, ProjectLoadFailure>>({});
  const dashboardImportInputRef = useRef<HTMLInputElement | null>(null);
  // Set every render, so a subscription made once still sees current state.
  const syncEventRef = useRef<((event: ProjectSyncEvent) => void) | null>(null);
  const editorLoadingStartedAtRef = useRef(0);

  const startEditorTransition = useCallback(() => {
    editorLoadingStartedAtRef.current = Date.now();
    setEditorLoading(true);
  }, []);

  const refreshSharedProjects = useCallback(async () => {
    if (STATIC_EXPORT_BUILD) return;
    setSharedProjectsLoading(true);
    try {
      const response = await fetch("/api/shared-projects", { cache: "no-store" });
      const payload = await response.json() as { enabled?: boolean; projects?: SharedProject[] } & Partial<ErrorResponseFields>;
      setSharedProjectsEnabled(Boolean(payload.enabled));
      setSharedProjects(Array.isArray(payload.projects) ? payload.projects : []);
      if (!response.ok && payload.enabled) setDashboardNotice(errorText(currentTranslator(), errorFromResponse(payload), "errors.shared.loadFailed"));
    } catch {
      setSharedProjectsEnabled(false);
      setSharedProjects([]);
    } finally {
      setSharedProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    initLanguage();
    const storedTheme = readStoredAppTheme(window.localStorage);
    setThemePreference(storedTheme);
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setResolvedTheme(resolveAppTheme(storedTheme, systemPrefersDark));
    applyAppTheme(storedTheme, systemPrefersDark);
    const { projects: storedProjects, legacyShapes } = sync.readBrowserList();
    setProjects(storedProjects);
    if (Object.keys(legacyShapes).length > 0) {
      setProjectShapesById(legacyShapes);
      Object.entries(legacyShapes).forEach(([projectId, entry]) => {
        const project = storedProjects.find((candidate) => candidate.id === projectId);
        if (!project) return;
        void sync.write(projectId, entry, projectShapeSaveContext(project)).catch(() => {
          setDashboardNotice(translate("dashboard.storage.migrateFailed"));
        });
      });
    }
    setDownloadMode(!STATIC_EXPORT_BUILD && window.localStorage.getItem(DOWNLOAD_MODE_STORAGE_KEY) === "folder" ? "folder" : "browser");
    setDownloadFolder(window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY) ?? "");
    if (!STATIC_EXPORT_BUILD) {
      void fetch("/api/local-download", { cache: "no-store" })
        .then((response) => response.json() as Promise<{ enabled?: boolean }>)
        .then(({ enabled }) => {
          setLocalDownloadEnabled(Boolean(enabled));
          if (!enabled) setDownloadMode("browser");
        })
        .catch(() => {
          setLocalDownloadEnabled(false);
          setDownloadMode("browser");
        });
    }
    setShowProjectNameInToolbar(window.localStorage.getItem(PROJECT_NAME_TOOLBAR_STORAGE_KEY) !== "false");

    const params = new URLSearchParams(window.location.search);
    if (params.has("codexBooleanCase") || params.get("editor") === "1") {
      const requestedProjectId = params.get("project");
      if (requestedProjectId && storedProjects.some((project) => project.id === requestedProjectId)) {
        setActiveProjectId(requestedProjectId);
        try {
          const storedChallenge = JSON.parse(window.localStorage.getItem(ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY) ?? "null") as { projectId?: string; tutorial?: ChallengeTutorialId } | null;
          if (storedChallenge?.projectId === requestedProjectId && isChallengeTutorialId(storedChallenge.tutorial)) {
            setActiveChallengeTutorial(storedChallenge.tutorial);
          }
        } catch {
          window.localStorage.removeItem(ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY);
        }
      }
      startEditorTransition();
      setEditorStarted(true);
      setView("editor");
    }
    setMounted(true);
  }, [startEditorTransition, sync]);

  useEffect(() => sync.subscribe((event) => syncEventRef.current?.(event)), [sync]);

  useEffect(() => {
    if (!mounted) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyCurrentTheme = () => {
      setResolvedTheme(resolveAppTheme(themePreference, media.matches));
      applyAppTheme(themePreference, media.matches);
    };
    storeAppTheme(window.localStorage, themePreference);
    applyCurrentTheme();
    if (themePreference !== "system") return;
    media.addEventListener("change", applyCurrentTheme);
    return () => media.removeEventListener("change", applyCurrentTheme);
  }, [mounted, themePreference]);

  useEffect(() => {
    if (!mounted) return;
    void refreshSharedProjects();
  }, [mounted, refreshSharedProjects]);

  // Server-side project storage (upstream #109). The module moves browser-held projects up
  // before switching, so enabling the directory adopts them instead of hiding them.
  useEffect(() => {
    if (!mounted || STATIC_EXPORT_BUILD) return;
    const controller = new AbortController();
    void sync.start({
      signal: controller.signal,
      onRestored: (restored) => {
        setProjects(restored);
        setDashboardNotice(translate("dashboard.serverStorage.restored", { count: restored.length }));
      },
      onSwitched: (serverProjects) => {
        setProjects(serverProjects);
        setProjectStorageMode("server");
      },
      onMigrated: (migratedCount, serverProjects) => {
        if (migratedCount > 0) {
          setDashboardNotice(translate("dashboard.serverStorage.migrated", { count: migratedCount }));
        }
        // A reload straight into the editor checked the browser list, which the
        // server has now replaced, so the requested project could not be found.
        const params = new URLSearchParams(window.location.search);
        const requestedProjectId = params.get("editor") === "1" ? params.get("project") : null;
        if (requestedProjectId && serverProjects.some((project) => project.id === requestedProjectId)) {
          setActiveProjectId((current) => current ?? requestedProjectId);
        }
      },
      onFailed: (error) => setDashboardNotice(errorText(currentTranslator(), error, "dashboard.serverStorage.migrateFailed")),
    }).finally(() => {
      if (!controller.signal.aborted) setStorageProbeSettled(true);
    });
    return () => controller.abort();
  }, [mounted, sync]);

  useEffect(() => {
    if (!mounted) return;
    const { rewrite, error } = sync.persistList(projects, projectStorageMode);
    if (error) {
      setDashboardNotice(errorText(currentTranslator(), error, "dashboard.storage.saveListFailed"));
      return;
    }
    if (rewrite) setProjects(rewrite);
  }, [mounted, projectStorageMode, projects, sync]);

  // A deleted project another client saved again is listed again; saves for it resume (#665).
  useEffect(() => {
    sync.listed(projects);
  }, [projects, sync]);

  // Server storage has no storage event across clients (#650). Coming back into view
  // re-reads the listing, so a newer copy another client saved is loaded before editing.
  useEffect(() => {
    if (!mounted || projectStorageMode !== "server") return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      sync.onVisible((update) => setProjects(update));
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [mounted, projectStorageMode, sync]);

  useEffect(() => {
    if (!mounted) return;
    return sync.watchOtherTabs({
      onDeleted: (deleted) => setProjects((current) => withoutDeletedProjects(current, deleted)),
      onList: (list) => setProjects(list),
    });
  }, [mounted, projectStorageMode, sync]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (projects.some((project) => project.id === activeProjectId)) return;
    setActiveProjectId(null);
    setView("dashboard");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  }, [activeProjectId, projects]);

  useEffect(() => {
    if (!mounted || !activeProjectId) return;
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (!activeProject) return;
    if (projectLoadFailures[activeProjectId]) return;
    const cached = projectShapesById[activeProjectId];
    if (cached && cached.revision >= (activeProject.revision ?? 0)) return;

    const controller = new AbortController();
    void sync.open(activeProject, cached, controller.signal).then((result) => {
      if (result.kind === "canceled") return;
      if (result.kind === "loaded") {
        setProjectShapesById((current) => {
          // IndexedDB reads are asynchronous. A local edit/import can update the live
          // cache while this older read is still in flight; never let that stale read
          // replace newer in-memory shapes. Bump the preserved entry to the requested
          // project revision so this effect does not immediately retry the same load.
          const existing = current[activeProjectId];
          const reconciled = reconcileLoadedProjectShapeCacheEntry(existing, result.entry, result.loadedRevision);
          if (reconciled === existing) return current;
          return {
            ...current,
            [activeProjectId]: reconciled,
          };
        });
        return;
      }
      const failure: ProjectLoadFailure = {
        kind: result.failureKind,
        message: loadFailureDetail(currentTranslator(), result.error, "dashboard.storage.loadFailed"),
      };
      // The module refuses writes now. The cached copy is stale, so the editor closes.
      if (cached) {
        setProjectShapesById((current) => {
          const next = { ...current };
          delete next[activeProjectId];
          return next;
        });
      }
      setProjectLoadFailures((current) => ({ ...current, [activeProjectId]: failure }));
      closeEditorForFailure();
    });
    return () => {
      controller.abort();
    };
  }, [activeProjectId, mounted, projectLoadFailures, projectShapesById, projects, sync]);

  useEffect(() => {
    if (!editorLoading || view !== "editor") return;
    if (activeProjectId) {
      const activeProject = projects.find((project) => project.id === activeProjectId);
      const activeEntry = projectShapesById[activeProjectId];
      if (!activeProject || !activeEntry) return;
    }

    const elapsed = Date.now() - editorLoadingStartedAtRef.current;
    const remaining = Math.max(0, EDITOR_SKELETON_MIN_DURATION_MS - elapsed);
    const timer = window.setTimeout(() => {
      window.requestAnimationFrame(() => setEditorLoading(false));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [activeProjectId, editorLoading, projectShapesById, projects, view]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(DOWNLOAD_MODE_STORAGE_KEY, downloadMode);
    window.localStorage.setItem(DOWNLOAD_FOLDER_STORAGE_KEY, downloadFolder);
    window.localStorage.setItem(PROJECT_NAME_TOOLBAR_STORAGE_KEY, String(showProjectNameInToolbar));
  }, [downloadFolder, downloadMode, mounted, showProjectNameInToolbar]);

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery ? projects.filter((project) => project.name.toLowerCase().includes(normalizedQuery)) : projects;
    return sortMode === "name" ? [...filtered].sort((a, b) => a.name.localeCompare(b.name)) : [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects, query, sortMode]);

  const visibleSharedProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery ? sharedProjects.filter((project) => project.name.toLowerCase().includes(normalizedQuery)) : sharedProjects;
    return sortMode === "name" ? [...filtered].sort((a, b) => a.name.localeCompare(b.name)) : [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [query, sharedProjects, sortMode]);

  // Returns to the dashboard, where the failure banner explains what happened.
  const closeEditorForFailure = () => {
    setDashboardNotice("");
    setDashboardSection("home");
    setEditorLoading(false);
    setView("dashboard");
    window.history.replaceState(null, "", withAppBasePath("/"));
  };

  const clearProjectLoadFailure = (projectId: string) => {
    setProjectLoadFailures((current) => {
      if (!(projectId in current)) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  };

  const openEditor = (projectId: string | null, options: { allowMissingFromStorage?: boolean; challengeTutorial?: ChallengeTutorialId | null } = {}) => {
    if (projectId && typeof window !== "undefined" && !options.allowMissingFromStorage) {
      // Opening checks the project still exists, in case another tab deleted
      // it. The check has to ask whichever store owns the list: in server mode
      // `localStorage` is empty by design, so reading it here declared every
      // project gone and emptied the dashboard on every click.
      const storedProjects = sync.readBrowserList().projects;
      const openable = openableProjectIds(projectStorageMode, { stored: storedProjects, live: projects });
      if (!openable.has(projectId)) {
        if (projectStorageMode !== "server") setProjects(storedProjects);
        setActiveProjectId(null);
        setView("dashboard");
        window.history.replaceState(null, "", "/");
        return;
      }
      const touch = (list: DashboardProject[]) =>
        list.map((project) => (project.id === projectId ? { ...project, updatedAt: Date.now() } : project));
      if (projectStorageMode === "server") setProjects((current) => touch(current));
      else setProjects(touch(storedProjects));
    } else if (projectId) {
      setProjects((current) => current.map((project) => (project.id === projectId ? { ...project, updatedAt: Date.now() } : project)));
    }
    // Opening again retries the read.
    if (projectId) clearProjectLoadFailure(projectId);
    startEditorTransition();
    let nextChallengeTutorial = options.challengeTutorial ?? null;
    if (typeof window !== "undefined" && projectId) {
      if (nextChallengeTutorial) {
        window.localStorage.setItem(
          ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY,
          JSON.stringify({ projectId, tutorial: nextChallengeTutorial }),
        );
      } else {
        try {
          const storedChallenge = JSON.parse(window.localStorage.getItem(ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY) ?? "null") as { projectId?: string; tutorial?: ChallengeTutorialId } | null;
          if (storedChallenge?.projectId === projectId && isChallengeTutorialId(storedChallenge.tutorial)) {
            nextChallengeTutorial = storedChallenge.tutorial;
          }
        } catch {
          window.localStorage.removeItem(ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY);
        }
      }
    }
    setActiveChallengeTutorial(nextChallengeTutorial);
    setActiveProjectId(projectId);
    // A desktop-opened file's earlier message must not replay in another
    // project. Its own result is shown after this call, so it still appears.
    setEditorHostNotice(null);
    setEditorStarted(true);
    setView("editor");
    if (typeof window !== "undefined") {
      const nextUrl = `${withAppBasePath("/")}?editor=1${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;
      window.history.replaceState(null, "", nextUrl);
    }
  };

  const updateProjectSnapshot = useCallback(async (snapshot: { image: string; projectId: string; shapes: number }, signal?: AbortSignal) => {
    const version = Date.now();
    if (signal?.aborted) throw new DOMException("Thumbnail upload aborted", "AbortError");
    if (STATIC_EXPORT_BUILD) {
      setProjects((current) =>
        current.map((project) =>
          project.id === snapshot.projectId
            ? { ...project, shapes: snapshot.shapes, thumbnailUrl: snapshot.image, thumbnailVersion: version, updatedAt: version }
            : project,
        ),
      );
      return;
    }

    setProjects((current) =>
      current.map((project) => (project.id === snapshot.projectId ? { ...project, shapes: snapshot.shapes, updatedAt: version } : project)),
    );
    try {
      const response = await fetch("/api/project-thumbnail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: snapshot.image, projectId: snapshot.projectId }),
        signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as Partial<ErrorResponseFields> | null;
        throw errorFromResponse(payload) ?? new LocalizedError("errors.thumbnail.saveFailed");
      }
      const payload = await response.json() as { version?: number };
      if (signal?.aborted) throw new DOMException("Thumbnail upload aborted", "AbortError");
      const nextVersion = payload?.version ?? Date.now();
      const thumbnailUrl = `/api/project-thumbnail?projectId=${encodeURIComponent(snapshot.projectId)}&v=${nextVersion}`;
      setProjects((current) =>
        current.map((project) =>
          project.id === snapshot.projectId
            ? { ...project, shapes: snapshot.shapes, thumbnailUrl, thumbnailVersion: nextVersion, updatedAt: nextVersion }
            : project,
        ),
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      setProjects((current) =>
        current.map((project) => (project.id === snapshot.projectId ? { ...project, shapes: snapshot.shapes, updatedAt: version } : project)),
      );
      throw error;
    }
  }, []);

  const updateProjectShapes = useCallback((snapshot: {
    projectId: string;
    shapes: WorkplaneShape[];
    history: EditorHistoryEntry[];
    historyIndex: number;
    assets: ProjectAsset[];
    parameters: ProjectParameter[];
    configuration: ProjectConfigurationState;
    projectName: string;
    projectCreatedAt: number;
    workspace: WorkplaneWorkspaceSettings;
    snapGrid: GridSize;
    placementElevation: number;
    placementWorkplane: PlacementWorkplane;
    sketchPlacementWorkplane: PlacementWorkplane;
  }) => {
    const saveContext: ProjectShapeSaveContext = {
      projectName: snapshot.projectName,
      createdAt: snapshot.projectCreatedAt,
      workspace: normalizeWorkspaceSettings(snapshot.workspace),
      snapGrid: normalizeSnapGrid(snapshot.snapGrid),
      placementElevation: Number.isFinite(snapshot.placementElevation) ? snapshot.placementElevation : 0,
      placementWorkplane: normalizePlacementWorkplane(snapshot.placementWorkplane, snapshot.placementElevation),
      sketchPlacementWorkplane: normalizePlacementWorkplane(snapshot.sketchPlacementWorkplane),
    };
    const { accepted, job } = sync.saveSnapshot(snapshot.projectId, (revision) => ({
      entry: projectShapeCacheEntryFromEditor(revision, snapshot.shapes, snapshot.history, snapshot.historyIndex, snapshot.assets, snapshot.parameters, snapshot.configuration),
      context: saveContext,
      shapeCount: snapshot.shapes.length,
    }));
    // The editor publishes after a delay, so a snapshot can arrive after its load failed.
    if (!accepted) return;
    setProjectShapesById((current) => cacheWithEditorChange(current, snapshot.projectId, job.entry, sync));
    autosaveNoticeControllerRef.current?.pending(snapshot.projectId, saveContext.projectName);
  }, [sync]);

  const updateProjectWorkspace = useCallback((snapshot: {
    projectId: string;
    workspace: WorkplaneWorkspaceSettings;
    snap: GridSize;
    placementElevation?: number;
    placementWorkplane?: PlacementWorkplane;
    sketchPlacementWorkplane?: PlacementWorkplane;
  }) => {
    const version = sync.nextRevision();
    const workspace = normalizeWorkspaceSettings(snapshot.workspace);
    const snapGrid = normalizeSnapGrid(snapshot.snap);
    const placementElevation = typeof snapshot.placementElevation === "number" && Number.isFinite(snapshot.placementElevation)
      ? snapshot.placementElevation
      : 0;
    const placementWorkplane = normalizePlacementWorkplane(snapshot.placementWorkplane, placementElevation);
    const sketchPlacementWorkplane = normalizePlacementWorkplane(snapshot.sketchPlacementWorkplane);
    const nextFingerprint = `${workplaneSettingsFingerprint(workspace, snapGrid)}:${placementElevation}:${placementWorkplaneFingerprint(placementWorkplane)}:${placementWorkplaneFingerprint(sketchPlacementWorkplane)}`;
    setProjects((current) => {
      let changed = false;
      const next = current.map((project) => {
        if (project.id !== snapshot.projectId) return project;
        const currentFingerprint = `${workplaneSettingsFingerprint(
          normalizeWorkspaceSettings(project.workspace),
          normalizeSnapGrid(project.snapGrid),
        )}:${project.placementElevation ?? 0}:${placementWorkplaneFingerprint(normalizePlacementWorkplane(project.placementWorkplane, project.placementElevation))}:${placementWorkplaneFingerprint(normalizePlacementWorkplane(project.sketchPlacementWorkplane))}`;
        if (currentFingerprint === nextFingerprint) return project;
        changed = true;
        // `revision` tracks the IndexedDB shape snapshot. Advancing it for a
        // workspace-only change can make the loader replace newer live shapes
        // with an older persisted snapshot while autosave is still pending.
        return {
          ...project,
          workspace,
          snapGrid,
          placementElevation,
          placementWorkplane,
          sketchPlacementWorkplane,
          updatedAt: version,
        };
      });
      if (!changed) return current;
      sync.writeBrowserListNow(next);
      return next;
    });
  }, [sync]);

  const createAndOpenProject = (name?: string, challengeTutorial: ChallengeTutorialId | null = null) => {
    const project = newProject(name ?? `Untitled design ${projects.length + 1}`, projects.length);
    setProjectShapesById((current) => ({
      ...current,
      [project.id]: projectShapeCacheEntry(project.revision ?? project.updatedAt, []),
    }));
    void sync.write(
      project.id,
      projectShapeCacheEntry(project.revision ?? project.updatedAt, []),
      projectShapeSaveContext(project),
    ).catch(() => {
      setDashboardNotice(t("dashboard.storage.prepareFailed"));
    });
    setProjects((current) => [project, ...current]);
    openEditor(project.id, { allowMissingFromStorage: true, challengeTutorial });
  };

  const openSkfProjectFromFile = useCallback(async (file: File, sharedProject?: SharedProject) => {
    setDashboardNotice(t("dashboard.open.validating", { fileName: file.name }));
    try {
      const restored = await importSkfProject(await file.arrayBuffer());
      const now = Date.now();
      const project: DashboardProject = {
        ...newProject(restored.projectName, projects.length, restored.shapes.length),
        createdAt: restored.createdAt,
        updatedAt: now,
        revision: now,
        workspace: restored.workspace,
        snapGrid: restored.snapGrid,
        placementElevation: restored.placementElevation,
        placementWorkplane: restored.placementWorkplane,
        sketchPlacementWorkplane: restored.sketchPlacementWorkplane,
        sharedProject: sharedProject ? { fileName: sharedProject.fileName, revision: sharedProject.revision } : undefined,
      };
      const entry = projectShapeCacheEntry(now, restored.shapes, restored.history, restored.historyIndex, restored.assets, restored.parameters, { configurations: restored.configurations, activeConfiguration: restored.activeConfiguration });
      await sync.write(project.id, entry, projectShapeSaveContext(project));
      setProjectShapesById((current) => ({ ...current, [project.id]: entry }));
      setProjects((current) => [project, ...current]);
      const openedMessage = t("dashboard.open.opened", { fileName: file.name });
      setDashboardNotice(sharedProject ? t("dashboard.shared.openedAutosave", { name: sharedProject.name }) : openedMessage);
      openEditor(project.id, { allowMissingFromStorage: true });
      return {
        ok: true,
        message: notice((t) => sharedProject ? t("dashboard.shared.opened", { name: sharedProject.name }) : t("dashboard.open.opened", { fileName: file.name })),
      };
    } catch (error) {
      setDashboardNotice(errorText(t, error, "dashboard.open.failed"));
      return { ok: false, message: notice((t) => errorText(t, error, "dashboard.open.failed")) };
    }
  }, [projects.length, t]);

  // The desktop shell hands over `.skf` files the OS opened with SketchForge
  // (double-click, Open With, a path on the command line). They take the same
  // path as a file chosen in the dashboard, and report progress and errors in
  // the dashboard and in the editor's status line, as the editor's own import
  // does. Subscribing releases any file that arrived while the app was
  // starting, so it waits until the storage probe has settled: in server mode
  // the probe's listing replaces the whole project list, and would drop a
  // project opened before it answered.
  const openSkfProjectFromFileRef = useRef(openSkfProjectFromFile);
  useEffect(() => {
    openSkfProjectFromFileRef.current = openSkfProjectFromFile;
  }, [openSkfProjectFromFile]);
  useEffect(() => {
    if (!storageProbeSettled) return;
    const subscribe = window.sketchforgeDesktop?.onOpenProjectFile;
    if (!subscribe) return;
    let opening = Promise.resolve();
    let noticeId = 0;
    const show = (value: Notice) => {
      setDashboardNotice(value.text(currentTranslator()));
      noticeId += 1;
      setEditorHostNotice({ id: noticeId, notice: value });
    };
    return subscribe((payload) => {
      opening = opening.then(() => openDesktopProjectFile(payload, { open: (file) => openSkfProjectFromFileRef.current(file), show }));
    });
  }, [storageProbeSettled]);

  const openSharedProject = useCallback(async (sharedProject: SharedProject) => {
    setDashboardNotice(t("dashboard.shared.opening", { name: sharedProject.name }));
    try {
      const response = await fetch(`/api/shared-projects?fileName=${encodeURIComponent(sharedProject.fileName)}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Partial<ErrorResponseFields>;
        throw errorFromResponse(payload) ?? new Error(t("dashboard.shared.downloadFailed"));
      }
      const revision = response.headers.get("etag")?.replace(/^W\//, "").replace(/^"|"$/g, "") || sharedProject.revision;
      const file = new File([await response.blob()], sharedProject.fileName, { type: "application/vnd.sketchforge.project+zip" });
      await openSkfProjectFromFile(file, { ...sharedProject, revision });
    } catch (error) {
      setDashboardNotice(errorText(t, error, "dashboard.shared.openFailed"));
    }
  }, [openSkfProjectFromFile, t]);

  const deleteSharedProject = useCallback(async (sharedProject: SharedProject) => {
    setDashboardNotice(t("dashboard.shared.deleting", { name: sharedProject.name }));
    try {
      const response = await fetch(`/api/shared-projects?fileName=${encodeURIComponent(sharedProject.fileName)}`, {
        method: "DELETE",
        headers: { "If-Match": `"${sharedProject.revision}"` },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Partial<ErrorResponseFields>;
        throw errorFromResponse(payload) ?? new LocalizedError("errors.shared.deleteFailed");
      }
      setSharedProjects((current) => current.filter((project) => project.fileName !== sharedProject.fileName));
      setDashboardNotice(t("dashboard.shared.deleted", { name: sharedProject.name }));
    } catch (error) {
      setDashboardNotice(errorText(t, error, "errors.shared.deleteFailed"));
      await refreshSharedProjects();
    }
  }, [refreshSharedProjects, t]);

  const saveActiveProjectToShared = useCallback(async ({ exportName, bytes, thumbnailDataUrl }: { exportName: string; bytes: Uint8Array; thumbnailDataUrl: string }) => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (!activeProject) throw new LocalizedError("errors.shared.saveNeedsLocalProject");
    const normalizedExportName = exportName.trim() || activeProject.name;
    const saveBackToSource = Boolean(activeProject.sharedProject && normalizedExportName === activeProject.name);
    const fileName = saveBackToSource && activeProject.sharedProject
      ? activeProject.sharedProject.fileName
      : `${normalizedExportName.replace(/\.skf$/i, "")}.skf`;
    const headers: Record<string, string> = {};
    if (saveBackToSource && activeProject.sharedProject) headers["If-Match"] = `"${activeProject.sharedProject.revision}"`;
    else headers["If-None-Match"] = "*";
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const thumbnailResponse = await fetch(thumbnailDataUrl);
    const thumbnail = await thumbnailResponse.blob();
    if (thumbnail.type !== "image/png" || thumbnail.size === 0) throw new LocalizedError("errors.shared.thumbnailPrepareFailed");
    const formData = new FormData();
    formData.append("project", new Blob([body], { type: "application/vnd.sketchforge.project+zip" }), fileName);
    formData.append("thumbnail", thumbnail, `${fileName}.png`);
    const response = await fetch(`/api/shared-projects?fileName=${encodeURIComponent(fileName)}`, { method: "POST", headers, body: formData });
    const payload = await response.json().catch(() => ({})) as { project?: SharedProject } & Partial<ErrorResponseFields>;
    if (!response.ok || !payload.project) throw errorFromResponse(payload) ?? new LocalizedError("errors.shared.saveFailed");
    const savedProject = payload.project;
    setProjects((current) => current.map((project) => project.id === activeProject.id
      ? { ...project, sharedProject: { fileName: savedProject.fileName, revision: savedProject.revision } }
      : project));
    await refreshSharedProjects();
    return notice((t) => t("dashboard.shared.saved", { name: savedProject.name }));
  }, [activeProjectId, projects, refreshSharedProjects]);

  const importFilesFromDashboard = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const projectFiles = files.filter((file) => /\.skf$/i.test(file.name));
      if (projectFiles.length) {
        if (files.length !== 1) {
          setDashboardNotice(t("dashboard.import.oneSkfAtATime"));
          return;
        }
        await openSkfProjectFromFile(projectFiles[0]);
        return;
      }
      const importedShapes: WorkplaneShape[] = [];
      const importedAssets: ProjectAsset[] = [];
      const importedFileNames: string[] = [];
      const failures: Array<{ fileName: string; reason: string }> = [];

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const sourceFormat = sourceFormatForFileName(file.name) ?? (file.type === "image/svg+xml" ? "svg" : null);
        const isObj = sourceFormat === "obj";
        const isSvg = sourceFormat === "svg";
        const isStep = sourceFormat === "step";
        if (!sourceFormat || (!isSvg && !isStep && !importExtensionSupported(file.name))) {
          failures.push({ fileName: file.name, reason: t("dashboard.import.unsupportedType") });
          continue;
        }

        setDashboardNotice(t("dashboard.import.progress", { index: index + 1, count: files.length, fileName: file.name }));
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          const parsedShape = isStep
            ? await import("@/lib/engine/stepImport").then(({ importedShapeFromStep }) => importedShapeFromStep(file.name, buffer))
            : isObj
              ? importedShapeFromObj(file.name, new TextDecoder().decode(bytes))
              : isSvg
                ? importedShapeFromSvg(file.name, new TextDecoder().decode(bytes))
                : importedShapeFromStl(file.name, buffer);
          const asset = await projectAssetFromBytes(file.name, sourceFormat, bytes, file.type);
          importedShapes.push(attachProjectAsset(parsedShape, asset.id));
          importedAssets.push(asset);
          importedFileNames.push(file.name);
        } catch (error) {
          failures.push({
            fileName: file.name,
            reason: errorText(t, error, "dashboard.import.readFailed"),
          });
        }
      }

      const failureDetails = failures
        .slice(0, 3)
        .map((failure) => `${failure.fileName}: ${failure.reason}`)
        .join("; ");
      const remainingFailureCount = Math.max(0, failures.length - 3);
      const failureSummary = failures.length
        ? t("dashboard.import.failures", {
          details: remainingFailureCount
            ? t("dashboard.import.failuresMore", { details: failureDetails, count: remainingFailureCount })
            : failureDetails,
        })
        : "";
      const withFailureSummary = (summary: string) => (failureSummary ? `${summary} ${failureSummary}` : summary);

      if (!importedShapes.length) {
        setDashboardNotice(files.length === 1 && failures[0] ? failures[0].reason : withFailureSummary(t("dashboard.import.noneImported", { count: files.length })));
        return;
      }

      try {
        const projectName = importedShapes.length === 1
          ? projectNameFromFileName(importedFileNames[0])
          : `Imported design (${importedShapes.length} files)`;
        const project = newProject(projectName, projects.length, importedShapes.length);
        const revision = project.revision ?? project.updatedAt;
        const entry = projectShapeCacheEntry(revision, importedShapes, undefined, undefined, dedupeProjectAssets(importedAssets));
        await sync.write(project.id, entry, projectShapeSaveContext(project));
        setProjectShapesById((current) => ({
          ...current,
          [project.id]: entry,
        }));
        const successSummary = importedShapes.length === 1 && files.length === 1
          ? t("dashboard.import.importedOne", { fileName: files[0].name })
          : t("dashboard.import.importedSome", { imported: importedShapes.length, count: files.length });
        setDashboardNotice(withFailureSummary(successSummary));
        setProjects((current) => [project, ...current]);
        openEditor(project.id, { allowMissingFromStorage: true });
      } catch (error) {
        setDashboardNotice(errorText(t, error, "dashboard.import.createProjectFailed"));
      }
    },
    [openSkfProjectFromFile, projects.length, t],
  );

  // Browser-held projects are best-effort storage that the browser may evict
  // (issue #333). Ask once per profile to keep them, and re-read the usage
  // estimate whenever the dashboard is shown so the quota warning is current.
  // The request waits for the server-storage probe, so a server-mode profile
  // is not asked, and does not spend its one request, for storage it never uses.
  useEffect(() => {
    if (!mounted || !storageProbeSettled || projectStorageMode !== "browser" || view !== "dashboard") return;
    let canceled = false;
    void (async () => {
      const storage = browserStorageManager();
      let preferences: Storage | null = null;
      try {
        preferences = window.localStorage;
      } catch {
        preferences = null;
      }
      await requestPersistentStorageOnce(storage, preferences);
      const status = await readStorageStatus(storage);
      if (!canceled) setStorageStatus(status);
    })();
    return () => {
      canceled = true;
    };
  }, [mounted, projectStorageMode, storageProbeSettled, view]);

  const exportAllProjects = useCallback(async () => {
    if (exportingAllProjects || projects.length === 0) return;
    setExportingAllProjects(true);
    setDashboardNotice(t("dashboard.backup.preparing", { count: projects.length }));
    try {
      const entries: ProjectBackupEntry[] = [];
      const skipped: string[] = [];
      for (const project of projects) {
        try {
          // The in-session copy may hold edits still queued for autosave, but
          // another tab or server client may have stored a newer one since.
          // Read the stored copy and back up whichever revision is higher.
          const inSession: ProjectShapeCacheEntry | null = projectShapesById[project.id] ?? null;
          let stored: ProjectShapeCacheEntry | null = null;
          try {
            const record = await sync.loadRecord(project.id);
            stored = record
              ? projectShapeCacheEntry(storedBackupRevision(record), record.shapes ?? [], record.history, record.historyIndex, record.assets, record.parameters, record.configuration)
              : null;
          } catch (error) {
            if (!inSession) throw error;
          }
          const entry = newerBackupSource(inSession, stored);
          if (!entry) {
            skipped.push(project.name);
            continue;
          }
          entries.push({
            projectName: project.name,
            modifiedAt: entry.revision,
            package: await projectSkfPackage(project.id, entry, projectShapeSaveContext(project)),
          });
        } catch {
          skipped.push(project.name);
        }
      }
      if (entries.length === 0) {
        setDashboardNotice(t("dashboard.backup.failed"));
        return;
      }
      const bytes = writeProjectsBackup(entries);
      const fileName = projectsBackupFileName(new Date());
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await downloadBlob(fileName, new Blob([body], { type: PROJECTS_BACKUP_MEDIA_TYPE }), {
        mode: downloadMode,
        folder: downloadFolder,
        localDownloadAvailable: !STATIC_EXPORT_BUILD && localDownloadEnabled,
      });
      const exported = t("dashboard.backup.exported", {
        count: entries.length,
        fileName: result.mode === "folder" ? result.path : fileName,
      });
      setDashboardNotice(skipped.length ? `${exported} ${t("dashboard.backup.skipped", { names: skipped.join(", ") })}` : exported);
    } catch (error) {
      setDashboardNotice(errorText(t, error, "dashboard.backup.failed"));
    } finally {
      setExportingAllProjects(false);
    }
  }, [downloadFolder, downloadMode, exportingAllProjects, localDownloadEnabled, projectShapesById, projects, t]);

  const openLatestProject = () => {
    const latest = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) {
      openEditor(latest.id);
      return;
    }
    createAndOpenProject();
  };

  const openDashboard = () => {
    if (activeProjectId) {
      setProjects((current) => current.map((project) => (project.id === activeProjectId ? { ...project, updatedAt: Date.now() } : project)));
    }
    setDashboardSection("home");
    setActiveChallengeTutorial(null);
    setEditorLoading(false);
    setEditorHostNotice(null);
    setView("dashboard");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  };

  const downloadStoredProject = async (project: DashboardProject) => {
    try {
      const stored = await sync.readStoredCopy(project.id);
      if (!stored) {
        setDashboardNotice(t("dashboard.loadFailure.nothingStored"));
        return;
      }
      const { bytes, format } = stored;
      const fileName = projectExportFileName(project.name, "skf").replace(/\.skf$/, `.${format}`);
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await downloadBlob(fileName, new Blob([body], { type: format === "skf" ? SKF_MEDIA_TYPE : "application/json" }), {
        mode: downloadMode,
        folder: downloadFolder,
        localDownloadAvailable: !STATIC_EXPORT_BUILD && localDownloadEnabled,
      });
      setDashboardNotice(t("dashboard.loadFailure.downloaded", { fileName: result.mode === "folder" ? result.path : fileName }));
    } catch (error) {
      setDashboardNotice(loadFailureDetail(t, error, "dashboard.loadFailure.downloadFailed"));
    }
  };

  // Replaces an unreadable stored copy with an empty project, only after the user confirms.
  const startProjectOver = async (project: DashboardProject) => {
    const result = await sync.startOver(project);
    if (!result.ok) {
      setDashboardNotice(result.error instanceof ServerProjectConflictError
        ? t("dashboard.loadFailure.startOverRefused", { name: project.name })
        : errorText(t, result.error, "dashboard.storage.saveFailed"));
      return;
    }
    const { entry, revision } = result;
    setProjectShapesById((current) => ({ ...current, [project.id]: entry }));
    setProjects((current) => current.map((candidate) => (
      candidate.id === project.id ? { ...candidate, shapes: 0, revision, updatedAt: revision } : candidate
    )));
    clearProjectLoadFailure(project.id);
    openEditor(project.id, { allowMissingFromStorage: true });
  };

  const downloadConflictedCopy = async (project: DashboardProject) => {
    const job = sync.keptCopy(project.id);
    if (!job) {
      setDashboardNotice(t("dashboard.loadFailure.nothingStored"));
      return;
    }
    try {
      const bytes = await projectSkfPackage(project.id, job.entry, job.context);
      const fileName = projectExportFileName(t("dashboard.loadFailure.myCopyName", { name: project.name }), "skf");
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await downloadBlob(fileName, new Blob([body], { type: SKF_MEDIA_TYPE }), {
        mode: downloadMode,
        folder: downloadFolder,
        localDownloadAvailable: !STATIC_EXPORT_BUILD && localDownloadEnabled,
      });
      setDashboardNotice(t("dashboard.loadFailure.downloaded", { fileName: result.mode === "folder" ? result.path : fileName }));
    } catch (error) {
      setDashboardNotice(errorText(t, error, "dashboard.loadFailure.downloadFailed"));
    }
  };

  // The module offers the cached copy when another client deletes the project.
  sync.readCachedCopiesWith((projectId) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    const cached = projectShapesById[projectId];
    return cached && project ? { entry: cached, context: projectShapeSaveContext(project), revision: cached.revision, shapeCount: cached.shapes.length } : undefined;
  });

  const dropCachedCopy = (projectId: string) => {
    setProjectShapesById((current) => {
      if (!(projectId in current)) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  };

  syncEventRef.current = (event) => {
    switch (event.type) {
      case "saved":
        setProjects((current) => current.map((project) => (
          project.id === event.projectId && (project.revision ?? 0) <= event.job.revision
            ? { ...project, shapes: event.job.shapeCount, updatedAt: event.job.revision, revision: event.job.revision }
            : project
        )));
        if (!event.waiting) autosaveNoticeControllerRef.current?.saved(event.projectId);
        return;
      case "saveFailed":
        autosaveNoticeControllerRef.current?.failed(
          event.projectId,
          event.job.context.projectName,
          errorText(currentTranslator(), event.error, "dashboard.storage.saveFailed"),
        );
        return;
      case "conflicted": {
        const savedAt = new Intl.DateTimeFormat(formattingLocale(locale), { dateStyle: "medium", timeStyle: "medium" }).format(new Date(event.error.storedRevision));
        setProjectLoadFailures((current) => ({
          ...current,
          [event.projectId]: { kind: "conflict", message: t("dashboard.loadFailure.conflictDetail", { time: savedAt }) },
        }));
        // The stale copy must not be edited further; opening again loads the newer one.
        dropCachedCopy(event.projectId);
        if (activeProjectId === event.projectId) closeEditorForFailure();
        return;
      }
      case "deletedElsewhere":
        // Another client deleted it; the server refuses every write to that id (#672).
        setProjectLoadFailures((current) => ({ ...current, [event.projectId]: { kind: "deleted", message: "" } }));
        dropCachedCopy(event.projectId);
        if (activeProjectId === event.projectId) closeEditorForFailure();
        return;
      case "metadataAdopted":
        setProjects((current) => current.map((project) => (project.id === event.projectId ? { ...event.project, accent: project.accent } : project)));
        return;
      case "metadataFailed":
        setDashboardNotice(errorText(currentTranslator(), event.error, "errors.projects.saveFailed"));
        return;
      case "status":
        return;
    }
  };

  // Drops a project deleted elsewhere from this list, without a delete request.
  const forgetDeletedProject = (projectId: string) => {
    sync.forgetDeleted(projectId);
    clearProjectLoadFailure(projectId);
    setProjects((current) => current.filter((project) => project.id !== projectId));
    if (activeProjectId === projectId) setActiveProjectId(null);
  };

  const saveDeletedCopyAsNewProject = async (project: DashboardProject) => {
    const job = sync.keptCopy(project.id);
    if (!job) {
      setDashboardNotice(t("dashboard.loadFailure.nothingStored"));
      return;
    }
    const now = sync.nextRevision();
    const copy: DashboardProject = {
      ...project,
      id: createLocalId("project"),
      updatedAt: now,
      revision: now,
      shapes: job.shapeCount,
      // The old thumbnail belongs to the deleted id.
      thumbnailUrl: null,
      sharedProject: undefined,
    };
    const entry = { ...job.entry, revision: now };
    try {
      // A new id has no base and no delete record, so the server creates it.
      await sync.write(copy.id, entry, job.context);
    } catch (error) {
      setDashboardNotice(errorText(t, error, "dashboard.storage.saveFailed"));
      return;
    }
    setProjectShapesById((current) => ({ ...current, [copy.id]: entry }));
    forgetDeletedProject(project.id);
    setProjects((current) => [copy, ...current]);
    setDashboardNotice(t("dashboard.loadFailure.savedAsNew", { name: project.name }));
  };

  const dismissProjectLoadFailure = (projectId: string) => {
    if (projectLoadFailures[projectId]?.kind === "deleted") {
      forgetDeletedProject(projectId);
      return;
    }
    clearProjectLoadFailure(projectId);
    // Leaving it active would retry the read straight away.
    if (activeProjectId === projectId) setActiveProjectId(null);
  };

  const deleteProject = (projectId: string) => {
    // Refuses its writes and records the delete for other tabs before any request starts.
    const deletion = sync.deleteProject(projectId);
    clearProjectLoadFailure(projectId);
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setProjectShapesById((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    if (activeProjectId === projectId) {
      setActiveProjectId(null);
    }
    if (!STATIC_EXPORT_BUILD) {
      void fetch(`/api/project-thumbnail?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    }
    void deletion.catch(() => {
      setDashboardNotice(t("dashboard.storage.deleteFailed"));
    });
  };

  const renameProject = (projectId: string, name: string) => {
    const nextName = name.trim().slice(0, 80);
    if (!nextName) return;
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, name: nextName, updatedAt: Date.now() } : project)),
    );
  };

  // React hoists <title> into <head>; it follows the language, unlike static metadata.
  const documentTitle = <title>{t("common.appTitle")}</title>;

  if (!mounted) {
    return documentTitle;
  }

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null;
  const activeProjectShapeEntry = activeProjectId ? projectShapesById[activeProjectId] : null;
  const canRenderEditor = !activeProjectId || (Boolean(activeProject) && Boolean(activeProjectShapeEntry));
  const projectDebugSummary = projects.map((project) => ({
    id: project.id,
    revision: project.revision,
    shapes: project.shapes,
    designShapes: projectShapesById[project.id]?.shapes.length ?? null,
    thumbnail: Boolean(project.thumbnailUrl),
    workspace: Boolean(project.workspace),
    snapGrid: project.snapGrid ?? null,
  }));

  return (
    <>
      {documentTitle}
      <pre data-codex-projects hidden>
        {JSON.stringify(projectDebugSummary)}
      </pre>
      <input
        ref={dashboardImportInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        accept=".skf,.stl,.obj,.step,.stp,.svg,image/svg+xml"
        onChange={(event) => {
          const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
          if (files.length) {
            void importFilesFromDashboard(files);
          }
          event.currentTarget.value = "";
        }}
      />
      {view === "dashboard" ? (
        <Dashboard
          dashboardSection={dashboardSection}
          dashboardNotice={dashboardNotice}
          exportingAllProjects={exportingAllProjects}
          projectCount={projects.length}
          storageWarningPercent={projectStorageMode === "browser" && storageStatus && storageNearQuota(storageStatus)
            ? storageUsageFraction(storageStatus)
            : null}
          onExportAllProjects={() => void exportAllProjects()}
          loadFailures={projects.flatMap((project) => (projectLoadFailures[project.id] ? [{ project, ...projectLoadFailures[project.id] }] : []))}
          onRetryLoad={(project) => openEditor(project.id)}
          onDownloadStoredProject={(project) => void downloadStoredProject(project)}
          onDownloadConflictedCopy={(project) => void downloadConflictedCopy(project)}
          onSaveDeletedCopyAsNew={(project) => void saveDeletedCopyAsNewProject(project)}
          onStartProjectOver={(project) => void startProjectOver(project)}
          onDismissLoadFailure={(project) => dismissProjectLoadFailure(project.id)}
          downloadFolder={downloadFolder}
          downloadMode={downloadMode}
          localDownloadEnabled={localDownloadEnabled}
          projects={visibleProjects}
          projectStorageMode={projectStorageMode}
          query={query}
          settingsOpen={settingsOpen}
          sharedProjects={visibleSharedProjects}
          sharedProjectsEnabled={sharedProjectsEnabled}
          sharedProjectsLoading={sharedProjectsLoading}
          staticExportBuild={STATIC_EXPORT_BUILD}
          sortMode={sortMode}
          viewMode={viewMode}
          onCloseSettings={() => setSettingsOpen(false)}
          onCreate={() => createAndOpenProject()}
          onStartChallenge={(challenge) => createAndOpenProject(challenge === "nameplate" ? "Personalized Nameplate" : "Key Tag", challenge)}
          onDeleteProject={deleteProject}
          onDeleteSharedProject={(project) => void deleteSharedProject(project)}
          onDownloadFolderChange={setDownloadFolder}
          onDownloadModeChange={setDownloadMode}
          onImportFile={() => dashboardImportInputRef.current?.click()}
          onChallenges={() => {
            setDashboardSection("challenges");
            setDashboardNotice("");
          }}
          onCustomization={() => {
            setDashboardSection("customization");
            setDashboardNotice("");
          }}
          onDashboardHome={() => setDashboardSection("home")}
          onOpenSharedProject={(project) => void openSharedProject(project)}
          onOpenProject={openEditor}
          onOpenSettings={() => setSettingsOpen(true)}
          onQueryChange={setQuery}
          onRenameProject={renameProject}
          onRefreshSharedProjects={() => void refreshSharedProjects()}
          onSharedProjects={() => {
            setDashboardSection("shared");
            setDashboardNotice("");
            void refreshSharedProjects();
          }}
          onSortModeChange={setSortMode}
          onViewModeChange={setViewMode}
          onWorkspace={openLatestProject}
        />
      ) : null}
      {editorStarted && canRenderEditor ? (
        <div className={view === "editor" ? "editor-stage active" : "editor-stage"} aria-hidden={view !== "editor"}>
          <SketchForgeEditor
            initialAssets={activeProjectShapeEntry?.assets ?? []}
            initialParameters={activeProjectShapeEntry?.parameters ?? []}
            initialConfiguration={activeProjectShapeEntry?.configuration ?? NO_CONFIGURATIONS}
            initialShapes={activeProjectShapeEntry?.shapes ?? []}
            initialHistory={activeProjectShapeEntry?.history}
            initialHistoryIndex={activeProjectShapeEntry?.historyIndex}
            initialSnap={activeProject?.snapGrid ?? DEFAULT_SNAP_GRID}
            initialWorkspace={activeProject?.workspace ?? DEFAULT_WORKPLANE_WORKSPACE}
            initialPlacementElevation={activeProject?.placementElevation ?? 0}
            initialPlacementWorkplane={activeProject?.placementWorkplane}
            onHome={openDashboard}
            projectsStoredOnServer={projectStorageMode === "server"}
            onOpenSkfProjectFile={openSkfProjectFromFile}
            onSaveSharedProject={saveActiveProjectToShared}
            onProjectShapesChange={updateProjectShapes}
            onProjectSnapshot={updateProjectSnapshot}
            onProjectWorkspaceChange={updateProjectWorkspace}
            onProjectNameChange={(name) => {
              if (activeProjectId) renameProject(activeProjectId, name);
            }}
            projectId={activeProjectId}
            projectName={activeProject?.name}
            autosaveNotice={autosaveNotice?.projectId === activeProjectId ? autosaveNotice : null}
            hostNotice={editorHostNotice}
            showProjectNameInToolbar={showProjectNameInToolbar}
            onShowProjectNameInToolbarChange={setShowProjectNameInToolbar}
            projectCreatedAt={activeProject?.createdAt}
            projectModifiedAt={activeProject?.updatedAt}
            projectRevision={activeProjectShapeEntry?.revision ?? activeProject?.revision ?? 0}
            sharedProjectsEnabled={sharedProjectsEnabled}
            challengeTutorial={activeChallengeTutorial}
            onChallengeTutorialFinish={() => {
              setActiveChallengeTutorial(null);
              window.localStorage.removeItem(ACTIVE_CHALLENGE_TUTORIAL_STORAGE_KEY);
            }}
            themePreference={themePreference}
            resolvedTheme={resolvedTheme}
            onThemePreferenceChange={setThemePreference}
          />
        </div>
      ) : null}
      {view === "editor" && (editorLoading || !canRenderEditor) ? <EditorLoadingSkeleton /> : null}
    </>
  );
}

function EditorLoadingSkeleton() {
  const t = useTranslations();
  const leftToolbarSections = [
    { className: "home", controls: 1 },
    { className: "clipboard", controls: 4 },
    { className: "history", controls: 2 },
    { className: "shapes", controls: 1 },
  ];
  const rightToolbarSections = [
    { className: "visibility", controls: 2 },
    { className: "combine", controls: 3 },
    { className: "modify", controls: 5 },
    { className: "arrange", controls: 2 },
  ];

  const renderToolbarSection = ({ className, controls }: { className: string; controls: number }) => (
    <div className={`editor-loading-tool-section ${className}`} key={className}>
      <span className="editor-loading-section-label editor-skeleton-shimmer" />
      <div className="editor-loading-section-controls">
        {Array.from({ length: controls }, (_, index) => (
          <span className="editor-loading-tool editor-skeleton-shimmer" key={index} />
        ))}
      </div>
    </div>
  );

  return (
    <div className="editor-loading-screen" role="status" aria-label={t("dashboard.loading.editor")} aria-live="polite">
      <div className="editor-loading-toolbar">
        <div className="editor-loading-tabs">
          <span className="editor-skeleton-shimmer" />
          <span className="editor-skeleton-shimmer" />
        </div>
        {/* Import, Export and workspace settings, which live in the title row. */}
        <div className="editor-loading-title-actions">
          {Array.from({ length: 3 }, (_, index) => (
            <span className="editor-loading-title-action editor-skeleton-shimmer" key={index} />
          ))}
        </div>
        <div className="editor-loading-tool-groups">
          <div className="editor-loading-tool-cluster">
            {leftToolbarSections.map(renderToolbarSection)}
          </div>
          <span className="editor-loading-toolbar-spacer" />
          <div className="editor-loading-tool-cluster">
            {rightToolbarSections.map(renderToolbarSection)}
          </div>
        </div>
      </div>

      <div className="editor-loading-body">
        <div className="editor-loading-viewport">
          <div className="editor-loading-view-cube">
            <span className="editor-loading-cube-top editor-skeleton-shimmer" />
            <span className="editor-loading-cube-left editor-skeleton-shimmer" />
            <span className="editor-loading-cube-right editor-skeleton-shimmer" />
          </div>
          <div className="editor-loading-model" aria-hidden="true">
            <span className="editor-loading-model-top editor-skeleton-shimmer" />
            <span className="editor-loading-model-front editor-skeleton-shimmer" />
            <span className="editor-loading-model-side editor-skeleton-shimmer" />
          </div>
          <div className="editor-loading-viewport-controls">
            {Array.from({ length: 5 }, (_, index) => (
              <span className="editor-skeleton-shimmer" key={index} />
            ))}
          </div>
          <span className="editor-loading-status editor-skeleton-shimmer" />
          <span className="editor-loading-snap editor-skeleton-shimmer" />
        </div>
      </div>
    </div>
  );
}

function Dashboard({
  dashboardSection,
  dashboardNotice,
  exportingAllProjects,
  projectCount,
  storageWarningPercent,
  onExportAllProjects,
  loadFailures,
  onRetryLoad,
  onDownloadStoredProject,
  onDownloadConflictedCopy,
  onSaveDeletedCopyAsNew,
  onStartProjectOver,
  onDismissLoadFailure,
  downloadFolder,
  downloadMode,
  localDownloadEnabled,
  projects,
  projectStorageMode,
  query,
  settingsOpen,
  sharedProjects,
  sharedProjectsEnabled,
  sharedProjectsLoading,
  staticExportBuild,
  sortMode,
  viewMode,
  onCloseSettings,
  onCreate,
  onStartChallenge,
  onDeleteProject,
  onDeleteSharedProject,
  onDownloadFolderChange,
  onDownloadModeChange,
  onImportFile,
  onChallenges,
  onCustomization,
  onDashboardHome,
  onOpenSharedProject,
  onOpenProject,
  onOpenSettings,
  onQueryChange,
  onRenameProject,
  onRefreshSharedProjects,
  onSharedProjects,
  onSortModeChange,
  onViewModeChange,
  onWorkspace,
}: {
  dashboardSection: DashboardSection;
  dashboardNotice: string;
  exportingAllProjects: boolean;
  /** Every project, not only those the search shows; "Export all projects" packs them all. */
  projectCount: number;
  /** Used share of the browser quota once it passes the warning threshold; null hides the warning. */
  storageWarningPercent: number | null;
  onExportAllProjects: () => void;
  loadFailures: Array<{ project: DashboardProject; kind: ProjectLoadFailureKind; message: string }>;
  onRetryLoad: (project: DashboardProject) => void;
  onDownloadStoredProject: (project: DashboardProject) => void;
  onDownloadConflictedCopy: (project: DashboardProject) => void;
  onSaveDeletedCopyAsNew: (project: DashboardProject) => void;
  onStartProjectOver: (project: DashboardProject) => void;
  onDismissLoadFailure: (project: DashboardProject) => void;
  downloadFolder: string;
  downloadMode: DownloadMode;
  localDownloadEnabled: boolean;
  projects: DashboardProject[];
  projectStorageMode: ProjectStorageMode;
  query: string;
  settingsOpen: boolean;
  sharedProjects: SharedProject[];
  sharedProjectsEnabled: boolean;
  sharedProjectsLoading: boolean;
  staticExportBuild: boolean;
  sortMode: string;
  viewMode: ViewMode;
  onCloseSettings: () => void;
  onCreate: () => void;
  onStartChallenge: (challenge: ChallengeTutorialId) => void;
  onDeleteProject: (projectId: string) => void;
  onDeleteSharedProject: (project: SharedProject) => void;
  onDownloadFolderChange: (value: string) => void;
  onDownloadModeChange: (value: DownloadMode) => void;
  onImportFile: () => void;
  onChallenges: () => void;
  onCustomization: () => void;
  onDashboardHome: () => void;
  onOpenSharedProject: (project: SharedProject) => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onQueryChange: (value: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onRefreshSharedProjects: () => void;
  onSharedProjects: () => void;
  onSortModeChange: (value: string) => void;
  onViewModeChange: (value: ViewMode) => void;
  onWorkspace: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [languagePreference, setLanguagePreference] = useLanguagePreference();
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [openSharedProjectMenuFileName, setOpenSharedProjectMenuFileName] = useState<string | null>(null);
  const [projectPendingDeleteId, setProjectPendingDeleteId] = useState<string | null>(null);
  const [projectPendingStartOverId, setProjectPendingStartOverId] = useState<string | null>(null);
  const startOverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeStartOver = () => {
    setProjectPendingStartOverId(null);
    startOverTriggerRef.current?.focus();
  };
  const [sharedProjectPendingDeleteFileName, setSharedProjectPendingDeleteFileName] = useState<string | null>(null);
  const [projectPendingRenameId, setProjectPendingRenameId] = useState<string | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [desktopAppVersion, setDesktopAppVersion] = useState<string | null>(null);
  const [desktopUpdaterConnected, setDesktopUpdaterConnected] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updateKey, setUpdateKey] = useState("");
  const [updateStarting, setUpdateStarting] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const updateCheckedRef = useRef(false);
  const projectPendingDelete = projects.find((project) => project.id === projectPendingDeleteId) ?? null;
  const projectPendingStartOver = loadFailures.find(({ project }) => project.id === projectPendingStartOverId)?.project ?? null;
  const sharedProjectPendingDelete = sharedProjects.find((project) => project.fileName === sharedProjectPendingDeleteFileName) ?? null;
  const projectPendingRename = projects.find((project) => project.id === projectPendingRenameId) ?? null;

  useEffect(() => {
    const desktop = window.sketchforgeDesktop;
    if (!desktop) return;
    setDesktopUpdaterConnected(true);
    void desktop.getVersion().then(setDesktopAppVersion).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!projectPendingDeleteId) return;
    if (projects.some((project) => project.id === projectPendingDeleteId)) return;
    setProjectPendingDeleteId(null);
  }, [projectPendingDeleteId, projects]);

  useEffect(() => {
    if (!sharedProjectPendingDeleteFileName) return;
    if (sharedProjects.some((project) => project.fileName === sharedProjectPendingDeleteFileName)) return;
    setSharedProjectPendingDeleteFileName(null);
  }, [sharedProjectPendingDeleteFileName, sharedProjects]);

  const confirmProjectDelete = () => {
    if (!projectPendingDelete) return;
    onDeleteProject(projectPendingDelete.id);
    setProjectPendingDeleteId(null);
  };

  const confirmSharedProjectDelete = () => {
    if (!sharedProjectPendingDelete) return;
    onDeleteSharedProject(sharedProjectPendingDelete);
    setSharedProjectPendingDeleteFileName(null);
  };

  const startProjectRename = (project: DashboardProject) => {
    setOpenProjectMenuId(null);
    setProjectPendingRenameId(project.id);
    setProjectNameDraft(project.name);
  };

  const closeProjectRename = () => {
    setProjectPendingRenameId(null);
    setProjectNameDraft("");
  };

  const confirmProjectRename = () => {
    if (!projectPendingRename || !projectNameDraft.trim()) return;
    onRenameProject(projectPendingRename.id, projectNameDraft);
    closeProjectRename();
  };

  const checkForUpdates = useCallback(async (force: boolean, alwaysPrompt: boolean) => {
    if (staticExportBuild) return;
    setUpdateChecking(true);
    setUpdateMessage("");
    try {
      const desktop = window.sketchforgeDesktop;
      if (desktop) {
        setDesktopUpdaterConnected(true);
        const result = await desktop.checkForUpdates();
        setDesktopAppVersion(result.currentVersion);
        if (result.error) throw new Error(result.error);
        const payload: AppUpdateStatus = {
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          updateAvailable: result.updateAvailable,
          checkedAt: result.checkedAt,
          updateUrl: "",
          installationReady: true,
          requiresUpdateKey: false,
          updateMode: "desktop",
        };
        setUpdateStatus(payload);
        if (result.updateAvailable && result.latestVersion) {
          setUpdateMessage(
            result.downloaded
              ? t("dashboard.updates.readyToInstall", { version: result.latestVersion })
              : t("dashboard.updates.availableDesktop", { version: result.latestVersion }),
          );
        } else if (alwaysPrompt) {
          setUpdateMessage(t("dashboard.updates.upToDate"));
        }
        return;
      }

      const response = await fetch(`/api/app-update${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as AppUpdateStatus & Partial<ErrorResponseFields>;
      if (!response.ok) throw errorFromResponse(payload) ?? new LocalizedError("errors.update.checkFailed");
      setUpdateStatus(payload);
      if (payload.updateAvailable && payload.latestVersion) {
        const dismissedVersion = window.localStorage.getItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY);
        if (alwaysPrompt || dismissedVersion !== payload.latestVersion) {
          onCloseSettings();
          setUpdatePromptOpen(true);
        }
      } else if (alwaysPrompt && !payload.checkError) {
        setUpdateMessage(t("dashboard.updates.upToDate"));
      }
    } catch (error) {
      setUpdateMessage(errorText(t, error, "errors.update.checkFailed"));
    } finally {
      setUpdateChecking(false);
    }
  }, [onCloseSettings, staticExportBuild, t]);

  useEffect(() => {
    if (staticExportBuild || updateCheckedRef.current) return;
    updateCheckedRef.current = true;
    void checkForUpdates(false, false);
  }, [checkForUpdates, staticExportBuild]);

  const dismissUpdate = () => {
    if (updateStatus?.latestVersion) {
      window.localStorage.setItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY, updateStatus.latestVersion);
    }
    setUpdatePromptOpen(false);
    setUpdateKey("");
    setUpdateMessage("");
  };

  const requestUpdate = async () => {
    if (!updateStatus?.updateAvailable) return;

    const desktop = window.sketchforgeDesktop;
    if (desktop) {
      setUpdateStarting(true);
      setUpdateMessage(
        updateStatus.latestVersion
          ? t("dashboard.updates.downloadingVersion", { version: updateStatus.latestVersion })
          : t("dashboard.updates.downloadingUpdate"),
      );
      try {
        const result = await desktop.installUpdate();
        if (result.error) throw new Error(result.error);
        if (!result.updateAvailable) {
          setUpdateStatus({
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
            updateAvailable: false,
            checkedAt: result.checkedAt,
            updateUrl: "",
            installationReady: true,
            requiresUpdateKey: false,
            updateMode: "desktop",
          });
          setUpdateMessage(t("dashboard.updates.alreadyUpToDate"));
        } else {
          setUpdateMessage(t("dashboard.updates.restartingToInstall"));
        }
      } catch (error) {
        setUpdateMessage(errorText(t, error, "dashboard.updates.installFailed"));
      } finally {
        setUpdateStarting(false);
      }
      return;
    }

    if (!updateStatus.installationReady) {
      window.open(updateStatus.updateUrl, "_blank", "noopener,noreferrer");
      dismissUpdate();
      return;
    }
    if (updateStatus.requiresUpdateKey && !updateKey.trim()) {
      setUpdateMessage(t("dashboard.updates.keyRequired"));
      return;
    }

    setUpdateStarting(true);
    setUpdateMessage("");
    try {
      const response = await fetch("/api/app-update", {
        method: "POST",
        headers: { "x-sketchforge-update-key": updateKey.trim() },
      });
      const payload = await response.json() as { accepted?: boolean; updateUrl?: string; updateMode?: "local" | "server"; restartRequired?: boolean } & Partial<ErrorResponseFields>;
      if (!response.ok || !payload.accepted) throw errorFromResponse(payload) ?? new LocalizedError("errors.update.startFailed");
      if (updateStatus.latestVersion) {
        window.localStorage.setItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY, updateStatus.latestVersion);
      }
      setUpdateKey("");
      if (payload.updateMode === "local" || updateStatus.updateMode === "local") {
        const expectedVersion = updateStatus.latestVersion;
        setUpdateMessage(t("dashboard.updates.localRestarting"));
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const statusResponse = await fetch("/api/app-update?force=1", { cache: "no-store" });
            if (statusResponse.ok) {
              const statusPayload = await statusResponse.json() as AppUpdateStatus;
              if (!expectedVersion || statusPayload.currentVersion === expectedVersion || !statusPayload.updateAvailable) {
                window.location.reload();
                return;
              }
            }
          } catch {
            // The local dev server is expected to be briefly unavailable while it restarts.
          }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        setUpdateMessage(t("dashboard.updates.localReload"));
      } else {
        setUpdateMessage(t("dashboard.updates.serverStarted"));
      }
    } catch (error) {
      setUpdateMessage(errorText(t, error, "errors.update.startFailed"));
    } finally {
      setUpdateStarting(false);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-topbar">
        <a className="dashboard-brand" href="./" aria-label={t("dashboard.topbar.homeLink")}>
          <img src={publicAssetPath("/assets/sketchforge/sketchforge-logo-white.png")} alt="" />
          <span>SketchForge</span>
        </a>
        <div className="dashboard-search">
          <Search size={18} strokeWidth={2.4} />
          <input value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} placeholder={t("dashboard.topbar.search")} aria-label={t("dashboard.topbar.search")} />
        </div>
        <button className="dashboard-primary" type="button" onClick={onCreate}>
          <Plus size={20} strokeWidth={2.6} />
          <span>{t("dashboard.topbar.create")}</span>
        </button>
      </header>

      <div className="dashboard-layout">
        <aside className="dashboard-sidebar">
          <div className="dashboard-nav-stack">
            <button className={`dashboard-nav-item ${dashboardSection === "home" ? "active" : ""}`} type="button" aria-label={t("dashboard.nav.home")} title={t("dashboard.nav.home")} onClick={onDashboardHome}>
              <HomeIcon size={20} />
              <span>{t("dashboard.nav.home")}</span>
            </button>
            {sharedProjectsEnabled ? (
              <button className={`dashboard-nav-item ${dashboardSection === "shared" ? "active" : ""}`} type="button" aria-label={t("dashboard.shared.title")} title={t("dashboard.shared.title")} onClick={onSharedProjects}>
                <FolderKanban size={20} />
                <span>{t("dashboard.nav.shared")}</span>
              </button>
            ) : null}
            <button className={`dashboard-nav-item ${dashboardSection === "challenges" ? "active" : ""}`} type="button" aria-label={t("dashboard.nav.challenges")} title={t("dashboard.nav.challenges")} onClick={onChallenges}>
              <SlidersHorizontal size={20} />
              <span>{t("dashboard.nav.challenges")}</span>
            </button>
            <button className={`dashboard-nav-item ${dashboardSection === "customization" ? "active" : ""}`} type="button" aria-label={t("dashboard.nav.customization")} title={t("dashboard.nav.customization")} onClick={onCustomization}>
              <Palette size={20} />
              <span>{t("dashboard.nav.customization")}</span>
            </button>
          </div>
          <div className="dashboard-sidebar-footer">
            <button className="dashboard-nav-item dashboard-settings-button" type="button" aria-label={t("dashboard.settings.title")} title={t("dashboard.settings.title")} onClick={onOpenSettings}>
              <Settings size={20} />
              <span>{t("dashboard.settings.title")}</span>
            </button>
          </div>
        </aside>

        <section
          className="dashboard-main"
          aria-label={t(
            dashboardSection === "challenges"
              ? "dashboard.nav.challenges"
              : dashboardSection === "shared"
                ? "dashboard.shared.title"
                : dashboardSection === "customization"
                  ? "dashboard.nav.customization"
                  : "dashboard.nav.dashboard",
          )}
        >
          {dashboardSection === "challenges" ? (
            <ChallengesDashboard onStartChallenge={onStartChallenge} />
          ) : dashboardSection === "customization" ? (
            <div className="dashboard-coming-soon" role="status">
              <strong>{t("dashboard.customization.comingSoon")}</strong>
            </div>
          ) : dashboardSection === "shared" ? (
            <>
              {dashboardNotice ? <div className="dashboard-import-notice" role="status">{dashboardNotice}</div> : null}
              <div className="dashboard-section-header shared-projects-header">
                <div>
                  <h1>{t("dashboard.shared.title")}</h1>
                  <span>{t("dashboard.shared.available", { count: sharedProjects.length })}</span>
                </div>
                <button className="shared-projects-refresh" type="button" onClick={onRefreshSharedProjects} disabled={sharedProjectsLoading}>
                  <RefreshCw size={16} className={sharedProjectsLoading ? "spinning" : undefined} />
                  <span>{t("dashboard.shared.refresh")}</span>
                </button>
              </div>
              {sharedProjects.length > 0 ? (
                <div className={viewMode === "grid" ? "project-grid" : "project-list"}>
                  {sharedProjects.map((project, index) => (
                    <article className="project-card shared-project-card" key={project.fileName}>
                      <button className="project-card-open" type="button" onClick={() => onOpenSharedProject(project)}>
                        <ProjectPreview accent={PROJECT_ACCENTS[index % PROJECT_ACCENTS.length]} thumbnailUrl={project.thumbnailUrl} />
                        <span className="project-card-title">{project.name}</span>
                        <span className="project-card-meta">{formatUpdated(t, locale, project.updatedAt)} - {formatFileSize(t, locale, project.size)}</span>
                      </button>
                      <span className="shared-project-badge">{t("dashboard.shared.badge")}</span>
                      <button
                        className="project-menu-trigger"
                        type="button"
                        aria-label={t("dashboard.shared.optionsFor", { name: project.name })}
                        aria-expanded={openSharedProjectMenuFileName === project.fileName}
                        title={t("dashboard.shared.options")}
                        onClick={() => {
                          setOpenProjectMenuId(null);
                          setOpenSharedProjectMenuFileName((current) => (current === project.fileName ? null : project.fileName));
                        }}
                      >
                        <EllipsisVertical size={19} strokeWidth={2.5} />
                      </button>
                      {openSharedProjectMenuFileName === project.fileName ? (
                        <div className="project-card-menu" role="menu" aria-label={t("dashboard.shared.menuFor", { name: project.name })}>
                          <button
                            className="delete"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setOpenSharedProjectMenuFileName(null);
                              setSharedProjectPendingDeleteFileName(project.fileName);
                            }}
                          >
                            <Trash2 size={16} />
                            <span>{t("dashboard.button.delete")}</span>
                          </button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="project-empty">
                  <strong>{sharedProjectsLoading ? t("dashboard.shared.loading") : t("dashboard.shared.empty")}</strong>
                  <span>{t("dashboard.shared.emptyHint")}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="dashboard-actions-band">
                <button className="dashboard-action-tile create" type="button" onClick={onCreate}>
                  <span className="dashboard-action-icon">
                    <Plus size={25} strokeWidth={2.8} />
                  </span>
                  <span>{t("dashboard.actions.create")}</span>
                </button>
                <button className="dashboard-action-tile" type="button" onClick={onImportFile}>
                  <span className="dashboard-action-icon">
                    <FileUp size={24} strokeWidth={2.4} />
                  </span>
                  <span>{t("dashboard.actions.import")}</span>
                </button>
                <button className="dashboard-action-tile" type="button" onClick={onWorkspace}>
                  <span className="dashboard-action-icon">
                    <Clock3 size={24} strokeWidth={2.4} />
                  </span>
                  <span>{t("dashboard.actions.continue")}</span>
                </button>
                <button className="dashboard-action-tile" type="button" onClick={onExportAllProjects} disabled={projectCount === 0 || exportingAllProjects}>
                  <span className="dashboard-action-icon">
                    <Download size={24} strokeWidth={2.4} />
                  </span>
                  <span>{t("dashboard.backup.exportAll")}</span>
                </button>
              </div>
              {storageWarningPercent !== null ? (
                <div className="dashboard-storage-warning" role="alert">
                  <span>
                    {t("dashboard.storageWarning.message", {
                      percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(storageWarningPercent),
                    })}
                  </span>
                  <button type="button" onClick={onExportAllProjects} disabled={projectCount === 0 || exportingAllProjects}>
                    {t("dashboard.backup.exportAll")}
                  </button>
                </div>
              ) : null}
              {loadFailures.map(({ project, kind, message }) => (
                <section className="dashboard-load-failure" role="alert" aria-labelledby={`load-failure-${project.id}`} key={project.id}>
                  <div className="dashboard-load-failure-text">
                    <strong id={`load-failure-${project.id}`}>{t(LOAD_FAILURE_TEXT[kind].title, { name: project.name })}</strong>
                    <p>{t(LOAD_FAILURE_TEXT[kind].body)}</p>
                    {message ? <p className="dashboard-load-failure-detail">{message}</p> : null}
                  </div>
                  <div className="dashboard-load-failure-actions">
                    {/* A database from a newer release opens the same way every time. */}
                    {kind === "conflict" ? (
                      <button type="button" aria-label={t("dashboard.loadFailure.reloadNewerFor", { name: project.name })} onClick={() => onRetryLoad(project)}>
                        <RefreshCw size={16} />
                        {t("dashboard.loadFailure.reloadNewer")}
                      </button>
                    ) : kind !== "storageNewer" && kind !== "deleted" ? (
                      <button type="button" aria-label={t("dashboard.loadFailure.retryFor", { name: project.name })} onClick={() => onRetryLoad(project)}>
                        <RefreshCw size={16} />
                        {t("dashboard.loadFailure.retry")}
                      </button>
                    ) : null}
                    {kind === "conflict" || kind === "deleted" ? (
                      <button type="button" aria-label={t("dashboard.loadFailure.downloadMineFor", { name: project.name })} onClick={() => onDownloadConflictedCopy(project)}>
                        <Download size={16} />
                        {t("dashboard.loadFailure.downloadMine")}
                      </button>
                    ) : null}
                    {kind === "deleted" ? (
                      <button type="button" aria-label={t("dashboard.loadFailure.saveAsNewFor", { name: project.name })} onClick={() => onSaveDeletedCopyAsNew(project)}>
                        <CopyPlus size={16} />
                        {t("dashboard.loadFailure.saveAsNew")}
                      </button>
                    ) : null}
                    {/* Only a copy that was read has bytes to download. */}
                    {kind === "unreadable" ? (
                      <button type="button" aria-label={t("dashboard.loadFailure.downloadFor", { name: project.name })} onClick={() => onDownloadStoredProject(project)}>
                        <Download size={16} />
                        {t("dashboard.loadFailure.download")}
                      </button>
                    ) : null}
                    {/* Unreachable, upgraded or newer copies are not this client's to replace. */}
                    {kind === "unreadable" || kind === "missing" ? (
                      <button
                        className="dashboard-load-failure-start-over"
                        type="button"
                        aria-label={t("dashboard.loadFailure.startOverFor", { name: project.name })}
                        onClick={(event) => {
                          startOverTriggerRef.current = event.currentTarget;
                          setProjectPendingStartOverId(project.id);
                        }}
                      >
                        {t("dashboard.loadFailure.startOver")}
                      </button>
                    ) : null}
                    {/* Dismissing would leave this client's unsaved copy with no way to download it. */}
                    {kind !== "conflict" ? (
                      <button
                        className="dashboard-load-failure-dismiss"
                        type="button"
                        aria-label={t(kind === "deleted" ? "dashboard.loadFailure.removeDeleted" : "dashboard.loadFailure.dismiss", { name: project.name })}
                        onClick={() => onDismissLoadFailure(project)}
                      >
                        <X size={16} />
                      </button>
                    ) : null}
                  </div>
                </section>
              ))}
              {dashboardNotice ? (
                <div className="dashboard-import-notice" role="status">
                  {dashboardNotice}
                </div>
              ) : null}

              <div className="dashboard-section-header">
                <div>
                  <h1>{t("dashboard.projects.title")}</h1>
                  <span>
                    {t("dashboard.projects.visible", { count: projects.length })}
                    {projectStorageMode === "server" ? ` - ${t("dashboard.serverStorage.badge")}` : null}
                  </span>
                </div>
                <div className="dashboard-controls">
                  <label className="dashboard-select">
                    <SlidersHorizontal size={17} />
                    <select value={sortMode} onChange={(event) => onSortModeChange(event.currentTarget.value)} aria-label={t("dashboard.projects.sort")}>
                      <option value="recent">{t("dashboard.projects.sortRecent")}</option>
                      <option value="name">{t("dashboard.projects.sortName")}</option>
                    </select>
                  </label>
                  <div className="dashboard-segmented" aria-label={t("dashboard.projects.view")}>
                    <button className={viewMode === "grid" ? "active" : ""} type="button" aria-label={t("dashboard.projects.gridView")} onClick={() => onViewModeChange("grid")}>
                      <Grid3X3 size={17} />
                    </button>
                    <button className={viewMode === "list" ? "active" : ""} type="button" aria-label={t("dashboard.projects.listView")} onClick={() => onViewModeChange("list")}>
                      <List size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {projects.length > 0 ? (
                <div className={viewMode === "grid" ? "project-grid" : "project-list"}>
                  {projects.map((project) => (
                    <article className="project-card" key={project.id}>
                      <button className="project-card-open" type="button" onClick={() => onOpenProject(project.id)}>
                        <ProjectPreview accent={project.accent} thumbnailUrl={project.thumbnailUrl} />
                        <span className="project-card-title">{project.name}</span>
                        <span className="project-card-meta">
                          {formatUpdated(t, locale, project.updatedAt)} - {t("dashboard.projects.shapeCount", { count: project.shapes })}
                        </span>
                      </button>
                      <button
                        className="project-menu-trigger"
                        type="button"
                        aria-label={t("dashboard.projects.optionsFor", { name: project.name })}
                        aria-expanded={openProjectMenuId === project.id}
                        title={t("dashboard.projects.options")}
                        onClick={() => {
                          setOpenSharedProjectMenuFileName(null);
                          setOpenProjectMenuId((current) => (current === project.id ? null : project.id));
                        }}
                      >
                        <EllipsisVertical size={19} strokeWidth={2.5} />
                      </button>
                      {openProjectMenuId === project.id ? (
                        <div className="project-card-menu" role="menu" aria-label={t("dashboard.projects.menuFor", { name: project.name })}>
                          <button type="button" role="menuitem" onClick={() => startProjectRename(project)}>
                            <Pencil size={16} />
                            <span>{t("dashboard.projects.rename")}</span>
                          </button>
                          <button
                            className="delete"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setOpenProjectMenuId(null);
                              setProjectPendingDeleteId(project.id);
                            }}
                          >
                            <Trash2 size={16} />
                            <span>{t("dashboard.button.delete")}</span>
                          </button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="project-empty">
                  <strong>{t("dashboard.projects.empty")}</strong>
                  <span>{t("dashboard.projects.emptyHint")}</span>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {projectPendingDelete ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="delete-project-title">{t("dashboard.projects.deleteTitle")}</strong>
              <button type="button" aria-label={t("dashboard.projects.deleteCancel")} onClick={() => setProjectPendingDeleteId(null)}>
                <X size={18} />
              </button>
            </header>
            <p>{t.rich("dashboard.projects.deleteConfirm", { name: projectPendingDelete.name, b: (chunks) => <span>{chunks}</span> })}</p>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={() => setProjectPendingDeleteId(null)}>
                {t("dashboard.button.cancel")}
              </button>
              <button className="dashboard-confirm-delete" type="button" onClick={confirmProjectDelete}>
                {t("dashboard.button.delete")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {projectPendingStartOver ? (
        <section
          className="dashboard-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-over-project-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeStartOver();
              return;
            }
            if (event.key !== "Tab") return;
            // Keeps Tab inside the modal dialog.
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="start-over-project-title">{t("dashboard.loadFailure.startOverTitle", { name: projectPendingStartOver.name })}</strong>
              <button type="button" aria-label={t("dashboard.loadFailure.startOverClose")} onClick={closeStartOver}>
                <X size={18} />
              </button>
            </header>
            <p>{t.rich("dashboard.loadFailure.startOverConfirm", { name: projectPendingStartOver.name, b: (chunks) => <span>{chunks}</span> })}</p>
            <div className="dashboard-confirm-actions">
              {/* Focus starts on the safe choice. */}
              <button className="dashboard-confirm-cancel" type="button" autoFocus onClick={closeStartOver}>
                {t("dashboard.button.cancel")}
              </button>
              <button
                className="dashboard-confirm-delete"
                type="button"
                onClick={() => {
                  setProjectPendingStartOverId(null);
                  onStartProjectOver(projectPendingStartOver);
                }}
              >
                {t("dashboard.loadFailure.startOverAction")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {sharedProjectPendingDelete ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-shared-project-title">
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="delete-shared-project-title">{t("dashboard.shared.deleteTitle")}</strong>
              <button type="button" aria-label={t("dashboard.shared.deleteCancel")} onClick={() => setSharedProjectPendingDeleteFileName(null)}>
                <X size={18} />
              </button>
            </header>
            <p>{t.rich("dashboard.shared.deleteConfirm", { name: sharedProjectPendingDelete.name, b: (chunks) => <span>{chunks}</span> })}</p>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={() => setSharedProjectPendingDeleteFileName(null)}>
                {t("dashboard.button.cancel")}
              </button>
              <button className="dashboard-confirm-delete" type="button" onClick={confirmSharedProjectDelete}>
                {t("dashboard.button.delete")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {projectPendingRename ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
          <form
            className="dashboard-confirm-dialog dashboard-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              confirmProjectRename();
            }}
          >
            <header>
              <strong id="rename-project-title">{t("dashboard.projects.renameTitle")}</strong>
              <button type="button" aria-label={t("dashboard.projects.renameCancel")} onClick={closeProjectRename}>
                <X size={18} />
              </button>
            </header>
            <label>
              <span>{t("dashboard.projects.nameLabel")}</span>
              <input
                autoFocus
                maxLength={80}
                value={projectNameDraft}
                onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
                aria-label={t("dashboard.projects.nameLabel")}
              />
            </label>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={closeProjectRename}>
                {t("dashboard.button.cancel")}
              </button>
              <button className="dashboard-confirm-save" type="submit" disabled={!projectNameDraft.trim()}>
                {t("dashboard.button.save")}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {updatePromptOpen && updateStatus?.updateAvailable && updateStatus.latestVersion ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="app-update-title">
          <div className="dashboard-confirm-dialog dashboard-update-dialog">
            <header>
              <strong id="app-update-title">{t("dashboard.updates.promptTitle", { version: updateStatus.latestVersion })}</strong>
              <button type="button" aria-label={t("dashboard.updates.dismiss")} onClick={dismissUpdate} disabled={updateStarting}>
                <X size={18} />
              </button>
            </header>
            <div className="dashboard-update-copy">
              <p>{t("dashboard.updates.promptQuestion", { version: updateStatus.currentVersion })}</p>
              <div className="dashboard-update-safety">
                {updateStatus.updateMode === "local"
                  ? t("dashboard.updates.safetyLocal")
                  : t.rich("dashboard.updates.safetyServer", { code: (chunks) => <code>{chunks}</code> })}
              </div>
              {!updateStatus.installationReady ? (
                <div className="dashboard-update-note">{t("dashboard.updates.notConfigured")}</div>
              ) : null}
              {updateStatus.requiresUpdateKey ? (
                <label className="dashboard-update-key">
                  <span>{t("dashboard.updates.keyLabel")}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={updateKey}
                    onChange={(event) => setUpdateKey(event.currentTarget.value)}
                    disabled={updateStarting}
                  />
                </label>
              ) : null}
              {updateMessage ? <div className="dashboard-update-message" role="status">{updateMessage}</div> : null}
            </div>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={dismissUpdate} disabled={updateStarting}>
                {t("dashboard.updates.notNow")}
              </button>
              <button className="dashboard-confirm-save" type="button" onClick={() => void requestUpdate()} disabled={updateStarting}>
                {updateStarting
                  ? t("dashboard.updates.starting")
                  : updateStatus.installationReady
                    ? t("dashboard.updates.update")
                    : t("dashboard.updates.openGuide")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {settingsOpen ? (
        <section className="dashboard-settings-panel" role="dialog" aria-modal="true" aria-label={t("dashboard.settings.title")}>
          <header>
            <strong>{t("dashboard.settings.title")}</strong>
            <button type="button" aria-label={t("dashboard.settings.close")} onClick={onCloseSettings}>
              <X size={18} />
            </button>
          </header>
          <label className="dashboard-setting-row">
            <span>{t("common.language.label")}</span>
            <select
              value={languagePreference}
              onChange={(event) => setLanguagePreference(normalizeLanguagePreference(event.currentTarget.value))}
            >
              {LANGUAGE_PREFERENCE_OPTIONS.map((preference) => (
                <option key={preference} value={preference}>
                  {languagePreferenceLabel(t, preference)}
                </option>
              ))}
            </select>
          </label>
          {localDownloadEnabled ? <>
          <label className="dashboard-setting-row">
            <span>{t("dashboard.settings.saveMethod")}</span>
            <select
              value={downloadMode}
              onChange={(event) => onDownloadModeChange(!staticExportBuild && localDownloadEnabled && event.currentTarget.value === "folder" ? "folder" : "browser")}
            >
              <option value="browser">{t("dashboard.settings.browserDownloads")}</option>
              <option value="folder">{t("dashboard.settings.saveToFolder")}</option>
            </select>
          </label>
          <label className="dashboard-setting-row">
            <span>{t("dashboard.settings.folderPath")}</span>
            <input
              disabled={staticExportBuild || downloadMode !== "folder"}
              value={downloadFolder}
              onChange={(event) => onDownloadFolderChange(event.currentTarget.value)}
              placeholder="C:\\Users\\username\\Downloads"
            />
          </label>
          </> : null}
          <div className="dashboard-version-row">
            <span>{t("dashboard.settings.version")}</span>
            <strong>{desktopAppVersion ?? updateStatus?.currentVersion ?? SKF_CREATED_WITH_VERSION}</strong>
          </div>
          <section className="dashboard-update-settings" aria-label={t("dashboard.updates.sectionTitle")}>
            <div>
              <strong>{t("dashboard.updates.sectionTitle")}</strong>
              <span>{t("dashboard.updates.sectionNote")}</span>
            </div>
            {staticExportBuild ? (
              <span className="dashboard-update-status">{t("dashboard.updates.managed")}</span>
            ) : updateStatus?.checkError ? (
              <span className="dashboard-update-status error">
                {errorText(t, errorFromPayload({ message: updateStatus.checkError, errorKey: updateStatus.checkErrorKey, errorParams: updateStatus.checkErrorParams }), "errors.update.checkFailed")}
              </span>
            ) : desktopUpdaterConnected && updateStatus?.updateAvailable && updateStatus.latestVersion ? (
              <button
                className="dashboard-update-available"
                type="button"
                onClick={() => void requestUpdate()}
                disabled={updateStarting}
              >
                {updateStarting ? t("dashboard.updates.downloading") : t("dashboard.updates.updateTo", { version: updateStatus.latestVersion })}
              </button>
            ) : updateStatus?.updateAvailable && updateStatus.latestVersion ? (
              <button
                className="dashboard-update-available"
                type="button"
                onClick={() => {
                  onCloseSettings();
                  setUpdateMessage("");
                  setUpdatePromptOpen(true);
                }}
              >
                {t("dashboard.updates.updateTo", { version: updateStatus.latestVersion })}
              </button>
            ) : updateStatus ? (
              <span className="dashboard-update-status ready">{t("dashboard.updates.upToDateStatus")}</span>
            ) : null}
            {!staticExportBuild ? (
              <button className="dashboard-check-update" type="button" onClick={() => void checkForUpdates(true, true)} disabled={updateChecking}>
                <RefreshCw size={15} className={updateChecking ? "spin" : ""} />
                <span>{updateChecking ? t("dashboard.updates.checking") : t("dashboard.updates.check")}</span>
              </button>
            ) : null}
            {updateMessage && settingsOpen ? <span className="dashboard-update-status" role="status">{updateMessage}</span> : null}
          </section>
          <div className="dashboard-version-row">
            <span>{t("dashboard.settings.license")}</span>
            <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPLv3</a>
          </div>
          <div className="dashboard-version-row">
            <span>{t("dashboard.settings.source")}</span>
            <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">{t("dashboard.settings.viewSource")}</a>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ProjectPreview({ accent, thumbnailUrl }: { accent: DashboardProject["accent"]; thumbnailUrl?: string | null }) {
  const t = useTranslations();
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null);
  const showThumbnail = Boolean(thumbnailUrl && thumbnailUrl !== failedThumbnailUrl);

  useEffect(() => {
    setFailedThumbnailUrl(null);
  }, [thumbnailUrl]);

  return (
    <span className={`project-preview accent-${accent}`} aria-hidden="true">
      {showThumbnail ? (
        <img className="project-thumbnail-image" src={thumbnailUrl ?? ""} alt="" onError={() => setFailedThumbnailUrl(thumbnailUrl ?? null)} />
      ) : (
        <>
          <span className="preview-grid" />
          <span className="preview-empty-mark">{t("dashboard.projects.noSnapshot")}</span>
        </>
      )}
    </span>
  );
}
