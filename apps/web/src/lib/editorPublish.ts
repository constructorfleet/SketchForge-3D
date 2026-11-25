import { canonicalizeShape } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import { projectShapesFingerprint, type ProjectConfigurationState } from "@/lib/engine/editorHistory";
import { parameterStateKey } from "@/lib/projectParameterEdits";
import type { ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

/**
 * The editor publish module: when the editor sends its project to the host, and how it takes
 * the host's props back. The component forwards events; this owns the pending publish, its
 * timers, the echo and synced keys, and the flush rules.
 */

/** Delay between a local edit and its publish, so a burst of edits sends once. */
export const PUBLISH_DELAY_MS = 120;
/** Delay after a pointer interaction ends before the held scene publishes. */
export const INTERACTION_RESUME_MS = 180;

export type PublishScheduler = {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const windowScheduler: PublishScheduler = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

type Table = { parameters: readonly ProjectParameter[]; configuration: ProjectConfigurationState };

export type EditorPublishHost = {
  /** False while the host takes no snapshots. */
  enabled(): boolean;
  /** The editor's own table, read when a publish goes out. */
  table(): Table;
  /** The scene on screen, read when a held interaction resumes. */
  currentShapes(): WorkplaneShape[];
  /** Sends the editor's project, with these shapes, to the host under `projectId`. */
  send(projectId: string, shapes: WorkplaneShape[]): void;
};

export type HostProps = Table & {
  projectId: string | null;
  shapes: readonly WorkplaneShape[];
  /** The rendered scene, compared as it is, not canonicalised. */
  currentShapes: WorkplaneShape[];
};

/**
 * How the component takes host props. `adoptTable`: the host's table is a remote change.
 * Only `hydrate` replaces the editor's scene and history, with `shapes`.
 */
export type HostPropsDecision =
  | { action: "ignored" }
  | { action: "echo" | "unchanged"; adoptTable: boolean; projectChanged: boolean }
  | { action: "hydrate"; adoptTable: boolean; projectChanged: boolean; shapes: WorkplaneShape[] };

type SyncAction = "echo" | "unchanged" | "hydrate";

/**
 * Classifies a host update. A table the editor neither received nor sent is remote: a hydrate,
 * so a later local undo cannot revert it. Host shapes equal to the last ones synced are an older
 * copy, not a change: an unpublished local edit is newer (#657).
 */
export function classifyHostProps(keys: {
  projectChanged: boolean;
  hostTable: string;
  knownTable: string;
  incoming: string;
  echo: string | null;
  synced: string;
  current: string;
}): { adoptTable: boolean; action: SyncAction } {
  const adoptTable = keys.projectChanged || keys.hostTable !== keys.knownTable;
  if (adoptTable) return { adoptTable, action: "hydrate" };
  if (keys.echo !== null && keys.incoming === keys.echo) return { adoptTable, action: "echo" };
  if (keys.incoming === keys.current) return { adoptTable, action: "unchanged" };
  return { adoptTable, action: keys.incoming === keys.synced ? "echo" : "hydrate" };
}

type Pending = { projectId: string; shapes: WorkplaneShape[]; key: string; handle: unknown };

export function createEditorPublisher({ host, scheduler = windowScheduler, initialTable }: {
  host: EditorPublishHost;
  scheduler?: PublishScheduler;
  initialTable: Table;
}) {
  let projectId: string | null = null;
  /** The project the last host props were for; a different one is a new project. */
  let hostProjectId: string | null = null;
  let pending: Pending | null = null;
  /** Shapes last published to or taken from the host. */
  let syncedKey = "";
  /** Shapes last published; the host passing them back is this editor's own echo. */
  let echoKey: string | null = null;
  /** The table last received from or sent to the host. An equal host table is not a change. */
  let knownTable = parameterStateKey(initialTable.parameters, initialTable.configuration);
  /** Set by a hydrate, so its own render is not published back. */
  let hydrating = false;
  let interacting = false;
  /** The scene held while an interaction runs, published once it ends. */
  let held: WorkplaneShape[] | null = null;
  let resume: unknown = null;

  function cancelPending() {
    if (!pending) return;
    scheduler.clear(pending.handle);
    pending = null;
  }

  function cancelResume() {
    if (resume === null) return;
    scheduler.clear(resume);
    resume = null;
  }

  function send(target: string, shapes: WorkplaneShape[], key: string) {
    syncedKey = key;
    echoKey = key;
    const table = host.table();
    knownTable = parameterStateKey(table.parameters, table.configuration);
    host.send(target, shapes);
  }

  function flushPending() {
    if (!pending) return;
    const { projectId: target, shapes, key } = pending;
    cancelPending();
    send(target, shapes, key);
  }

  /**
   * A local edit. `force` publishes even when the shapes match the last publish, since a
   * table-only step leaves them unchanged. `immediate` skips the delay.
   */
  function localEdit(shapes: WorkplaneShape[], { force = false, immediate = false } = {}) {
    if (!projectId || !host.enabled()) return;
    if (interacting) {
      held = shapes;
      cancelPending();
      return;
    }
    const canonical = shapes.map(canonicalizeShape);
    const key = projectShapesFingerprint(canonical);
    if (!force && syncedKey === key) return;
    cancelPending();
    if (immediate) {
      send(projectId, canonical, key);
      return;
    }
    const target = projectId;
    const handle = scheduler.set(() => {
      pending = null;
      send(target, canonical, key);
    }, PUBLISH_DELAY_MS);
    pending = { projectId: target, shapes: canonical, key, handle };
  }

  /** The scene a render committed; skipped once after a hydrate, which it came from. */
  function shapesRendered(shapes: WorkplaneShape[]) {
    if (!projectId || !host.enabled()) return;
    if (hydrating) {
      hydrating = false;
      return;
    }
    localEdit(shapes);
  }

  /**
   * The editor's project changed. Call before the next project's data loads: the pending
   * publish goes out under its own project, which the host refuses if deleted or blocked (#668).
   * No project drops it: it named a project that closed, perhaps deleted (#665).
   */
  function projectChanged(next: string | null) {
    projectId = next;
    // It would read the next project's scene.
    cancelResume();
    if (next === null) {
      cancelPending();
      held = null;
      hostProjectId = null;
      syncedKey = "";
      echoKey = null;
      return;
    }
    if (pending && pending.projectId !== next) flushPending();
  }

  function hostProps(props: HostProps): HostPropsDecision {
    if (!props.projectId || interacting) return { action: "ignored" };
    const projectChanged = hostProjectId !== props.projectId;
    if (projectChanged) {
      hostProjectId = props.projectId;
      syncedKey = "";
      echoKey = null;
    }
    const incoming = props.shapes.map(canonicalizeShape);
    const incomingKey = projectShapesFingerprint(incoming);
    const hostTable = parameterStateKey(props.parameters, props.configuration);
    const { adoptTable, action } = classifyHostProps({
      projectChanged,
      hostTable,
      knownTable,
      incoming: incomingKey,
      echo: echoKey,
      synced: syncedKey,
      current: projectShapesFingerprint(props.currentShapes),
    });
    if (adoptTable) knownTable = hostTable;
    syncedKey = incomingKey;
    // Only a real change replaces a pending publish; it may hold a table-only undo (#663).
    if (action !== "hydrate") return { action, adoptTable, projectChanged };
    cancelPending();
    hydrating = true;
    return { action, adoptTable, projectChanged, shapes: incoming };
  }

  function interactionStarted() {
    cancelResume();
    if (pending) {
      cancelPending();
      held = host.currentShapes();
    }
    interacting = true;
  }

  /** A pointer interaction ended: the held scene publishes after a short settle. */
  function interactionEnded() {
    interacting = false;
    if (!held) return;
    held = null;
    cancelResume();
    resume = scheduler.set(() => {
      resume = null;
      localEdit(host.currentShapes());
    }, INTERACTION_RESUME_MS);
  }

  /** Publishes the scene at once, for a keyboard move that just ended. */
  function publishInteraction() {
    cancelResume();
    held = null;
    localEdit(host.currentShapes(), { immediate: true });
  }

  /** The host may unmount the editor to load a project; the pending publish still goes out (#668). */
  function unmount() {
    cancelResume();
    flushPending();
  }

  return {
    localEdit,
    shapesRendered,
    projectChanged,
    hostProps,
    interactionStarted,
    interactionEnded,
    publishInteraction,
    unmount,
    isHydrating: () => hydrating,
  };
}

export type EditorPublisher = ReturnType<typeof createEditorPublisher>;
