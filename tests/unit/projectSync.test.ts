import { describe, expect, it } from "vitest";
import { importSkfProject } from "@/lib/engine/skfProject";
import { createMemoryBrowser, createMemoryServer, memoryProjectSyncAdapters } from "@/lib/projectSync/memoryAdapters";
import { PROJECTS_STORAGE_KEY, createProjectSync, projectShapeSaveContext, type DashboardProject, type ProjectSync, type ProjectSyncEvent } from "@/lib/projectSync";
import { projectShapeCacheEntry, projectSkfPackage } from "@/lib/projectShapeCache";
import { ProjectWriteRefusedError } from "@/lib/projectWriteGuard";
import { ServerPackageRequestError, serverProjectRevision } from "@/lib/serverProjectStore";
import type { WorkplaneShape } from "@/types/sketchforge";

// Issue #678: the storage and sync scenarios of #622 to #672, run against the project sync
// module's interface with in-memory adapters. The browser suites pin the same behaviour end to end.

function box(id: string): WorkplaneShape {
  return { id, name: "Box", kind: "box", color: "#12a4cc", x: 0, z: 0, elevation: 0, size: 10, width: 10, depth: 10, height: 10, rotation: 0 };
}

function project(id: string, revision: number, name = "Bracket"): DashboardProject {
  return { id, name, createdAt: 1, updatedAt: revision, shapes: 0, accent: "cyan", revision };
}

function snapshot(of: DashboardProject, shapeIds: string[]) {
  return (revision: number) => ({
    entry: projectShapeCacheEntry(revision, shapeIds.map(box)),
    context: projectShapeSaveContext(of),
    shapeCount: shapeIds.length,
  });
}

async function packageFor(of: DashboardProject, revision: number, shapeIds: string[]) {
  return projectSkfPackage(of.id, projectShapeCacheEntry(revision, shapeIds.map(box)), projectShapeSaveContext(of));
}

async function shapeIdsIn(bytes: Uint8Array | null | undefined) {
  if (!bytes) return null;
  return (await importSkfProject(bytes)).shapes.map((shape) => shape.id);
}

function recordEvents(sync: ProjectSync) {
  const events: ProjectSyncEvent[] = [];
  sync.subscribe((event) => events.push(event));
  return events;
}

async function switchToServer(sync: ProjectSync) {
  const switched: DashboardProject[][] = [];
  await sync.start({
    signal: new AbortController().signal,
    onRestored: () => undefined,
    onSwitched: (projects) => switched.push(projects),
    onMigrated: () => undefined,
    onFailed: (error) => {
      throw error;
    },
  });
  expect(sync.mode()).toBe("server");
  return switched[0];
}

/** A server holding one project, saved at `revision` with one shape. */
async function serverWith(of: DashboardProject, options: { now?: () => number } = {}) {
  const server = createMemoryServer(options);
  await server.api.savePackage(of.id, await packageFor(of, of.revision!, ["original"]), of.revision!);
  await server.api.saveMetadata(of.id, of);
  return server;
}

function client(server: ReturnType<typeof createMemoryServer> | null, browser = createMemoryBrowser(), now?: () => number) {
  const sync = createProjectSync(memoryProjectSyncAdapters({ browser: browser.store, preferences: browser.tab(), server: server?.api ?? null, now }));
  return { sync, browser };
}

describe("a project whose stored copy cannot be read (#622, #648)", () => {
  it("refuses every write to it, so the stored bytes stay as they were, until Start over replaces them", async () => {
    const browser = createMemoryBrowser();
    const broken = project("p", 10);
    const corrupt = new Uint8Array([1, 2, 3, 4]);
    browser.records.set("p", { id: "p", revision: 10, updatedAt: 10, skfPackage: corrupt });
    const { sync } = client(null, browser);

    const opened = await sync.open(broken, undefined);
    expect(opened).toMatchObject({ kind: "failed", failureKind: "unreadable" });
    expect(sync.status("p")).toBe("unreadable");

    expect(sync.saveSnapshot("p", snapshot(broken, ["edit"])).accepted).toBe(false);
    await expect(sync.write("p", projectShapeCacheEntry(99, []), projectShapeSaveContext(broken))).rejects.toBeInstanceOf(ProjectWriteRefusedError);
    await sync.idle();
    expect(browser.records.get("p")?.skfPackage).toBe(corrupt);

    const replaced = await sync.startOver(broken);
    expect(replaced.ok).toBe(true);
    expect(sync.status("p")).toBe("synced");
    expect(await shapeIdsIn(browser.records.get("p")?.skfPackage)).toEqual([]);
  });

  it("calls a database a newer release upgraded unreadable, with storageNewer as the reason", async () => {
    const browser = createMemoryBrowser();
    browser.failReads(Object.assign(new Error("The requested version (3) is less than the existing version (99)."), { name: "VersionError" }));
    const { sync } = client(null, browser);

    expect(await sync.open(project("p", 10), undefined)).toMatchObject({ kind: "failed", failureKind: "storageNewer" });
    expect(sync.status("p")).toBe("unreadable");
  });

  it("calls a server it cannot reach unavailable, and saves again after a good retry", async () => {
    const original = project("p", 10);
    const server = await serverWith(original);
    const { sync } = client(server);
    await switchToServer(sync);

    server.failFetches(new ServerPackageRequestError("status", "503"));
    expect(await sync.open(original, undefined)).toMatchObject({ kind: "failed", failureKind: "unavailable" });
    expect(sync.status("p")).toBe("unavailable");

    server.failFetches(null);
    expect((await sync.open(original, undefined)).kind).toBe("loaded");
    expect(sync.status("p")).toBe("synced");
    sync.saveSnapshot("p", snapshot(original, ["original", "edit"]));
    await sync.idle();
    expect(await shapeIdsIn(server.projects.get("p")?.packageBytes)).toEqual(["original", "edit"]);
  });

  it("does not open a listed server project whose package is missing as an empty one (#650)", async () => {
    const listedOnly = project("p", 10);
    const server = createMemoryServer();
    await server.api.saveMetadata("p", listedOnly);
    const { sync } = client(server);
    await switchToServer(sync);

    expect(await sync.open(listedOnly, undefined)).toMatchObject({ kind: "failed", failureKind: "missing" });
    expect(sync.saveSnapshot("p", snapshot(listedOnly, ["edit"])).accepted).toBe(false);
  });
});

describe("two clients sharing server storage (#650, #656)", () => {
  it("refuses a save based on an older copy, keeps the newer one, and offers this client's copy", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server);
    await switchToServer(a.sync);
    await switchToServer(b.sync);
    await a.sync.open(shared, undefined);
    await b.sync.open(shared, undefined);
    const aEvents = recordEvents(a.sync);

    b.sync.saveSnapshot("p", snapshot(shared, ["original", "from-b"]));
    await b.sync.idle();
    const { job } = a.sync.saveSnapshot("p", snapshot(shared, ["original", "from-a"]));
    await a.sync.idle();

    expect(await shapeIdsIn(server.projects.get("p")?.packageBytes)).toEqual(["original", "from-b"]);
    expect(a.sync.status("p")).toBe("conflicted");
    expect(aEvents.some((event) => event.type === "conflicted")).toBe(true);
    expect(a.sync.keptCopy("p")).toBe(job);

    // Opening the newer copy bases later saves on it.
    expect((await a.sync.open(shared, undefined)).kind).toBe("loaded");
    expect(a.sync.status("p")).toBe("synced");
    a.sync.saveSnapshot("p", snapshot(shared, ["original", "from-b", "from-a"]));
    await a.sync.idle();
    expect(await shapeIdsIn(server.projects.get("p")?.packageBytes)).toEqual(["original", "from-b", "from-a"]);
  });

  it("keeps the newest edit, including one queued behind the refused save", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server);
    await switchToServer(a.sync);
    await switchToServer(b.sync);
    await a.sync.open(shared, undefined);
    await b.sync.open(shared, undefined);
    b.sync.saveSnapshot("p", snapshot(shared, ["from-b"]));
    await b.sync.idle();

    a.sync.saveSnapshot("p", snapshot(shared, ["first"]));
    const second = a.sync.saveSnapshot("p", snapshot(shared, ["first", "second"])).job;
    await a.sync.idle();

    expect(a.sync.keptCopy("p")).toBe(second);
  });

  it("saves on top of a copy written by a client whose clock is an hour ahead", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server, createMemoryBrowser(), () => Date.now() + 3_600_000);
    await switchToServer(a.sync);
    await switchToServer(b.sync);
    await b.sync.open(shared, undefined);
    b.sync.saveSnapshot("p", snapshot(shared, ["from-b"]));
    await b.sync.idle();

    await a.sync.open(shared, undefined);
    a.sync.saveSnapshot("p", snapshot(shared, ["from-b", "from-a"]));
    await a.sync.idle();

    expect(a.sync.status("p")).toBe("synced");
    expect(await shapeIdsIn(server.projects.get("p")?.packageBytes)).toEqual(["from-b", "from-a"]);
  });

  it("merges a stale list write into another client's rename instead of reverting it", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server);
    const listed = await switchToServer(a.sync);
    await switchToServer(b.sync);
    const aEvents = recordEvents(a.sync);

    b.sync.persistList([{ ...listed[0], name: "Renamed by B" }]);
    await b.sync.idle();
    a.sync.persistList([{ ...listed[0], thumbnailVersion: 4 }]);
    await a.sync.idle();

    expect(server.projects.get("p")?.metadata).toMatchObject({ name: "Renamed by B", thumbnailVersion: 4 });
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "metadataAdopted", project: expect.objectContaining({ name: "Renamed by B" }) }));
  });

  it("picks up another client's rename when the page comes back into view", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server);
    const listed = await switchToServer(a.sync);
    await switchToServer(b.sync);
    b.sync.persistList([{ ...listed[0], name: "Renamed by B" }]);
    await b.sync.idle();

    const updated = await new Promise<DashboardProject[]>((resolve) => a.sync.onVisible((update) => resolve(update(listed))));

    expect(updated[0].name).toBe("Renamed by B");
  });
});

describe("the move to server storage (#662)", () => {
  it("uploads a browser save still in flight when the listing was read, before switching", async () => {
    const browser = createMemoryBrowser();
    const moving = project("p", 10);
    browser.records.set("p", { id: "p", revision: 10, updatedAt: 10, skfPackage: await packageFor(moving, 10, ["original"]) });
    browser.storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([moving]));
    const server = createMemoryServer();
    const { sync } = client(server, browser);

    // The save lands only after the first pass uploaded the older copy.
    const write = browser.store.write.bind(browser.store);
    let releaseWrite = () => {};
    browser.store.write = (...args) => new Promise((resolve) => {
      releaseWrite = () => void write(...args).then(resolve);
    });
    const probe = server.api.probe.bind(server.api);
    let probes = 0;
    server.api.probe = async () => {
      probes += 1;
      if (probes === 2) {
        void sync.write("p", projectShapeCacheEntry(20, [box("original"), box("late")]), projectShapeSaveContext(moving));
        setTimeout(() => releaseWrite(), 20);
      }
      return probe();
    };

    await switchToServer(sync);

    expect(await shapeIdsIn(server.projects.get("p")?.packageBytes)).toEqual(["original", "late"]);
    expect(serverProjectRevision(server.projects.get("p")?.metadata)).toBe(20);
  });
});

describe("deleted projects (#665, #667, #670, #672)", () => {
  it("refuses a save published after a delete, until the project is listed again", async () => {
    const browser = createMemoryBrowser();
    const deleted = project("p", 10);
    browser.records.set("p", { id: "p", revision: 10, updatedAt: 10, skfPackage: await packageFor(deleted, 10, ["original"]) });
    const { sync } = client(null, browser);

    await sync.deleteProject("p");
    expect(sync.status("p")).toBe("deleted");
    expect(sync.saveSnapshot("p", snapshot(deleted, ["late"])).accepted).toBe(false);
    await sync.idle();
    expect(browser.records.has("p")).toBe(false);

    sync.listed([deleted]);
    expect(sync.status("p")).toBe("synced");
  });

  it("keeps a delete across tabs: another tab's stale list and late save cannot bring it back", async () => {
    const browser = createMemoryBrowser();
    const deleted = project("p", 10);
    const kept = project("q", 10, "Kept");
    browser.storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([deleted, kept]));
    const tab1 = createProjectSync(memoryProjectSyncAdapters({ browser: browser.store, preferences: browser.tab(), server: null }));
    const tab2 = createProjectSync(memoryProjectSyncAdapters({ browser: browser.store, preferences: browser.tab(), server: null }));
    const seenByTab2: Array<Set<string>> = [];
    tab2.watchOtherTabs({ onDeleted: (ids) => seenByTab2.push(ids), onList: () => undefined });

    await tab1.deleteProject("p");
    expect(seenByTab2.at(-1)?.has("p")).toBe(true);
    expect(tab2.status("p")).toBe("deleted");

    // Tab 2's list still holds the project.
    tab2.persistList([deleted, kept]);
    expect(tab1.readBrowserList().projects.map((candidate) => candidate.id)).toEqual(["q"]);
    await expect(tab2.write("p", projectShapeCacheEntry(20, []), projectShapeSaveContext(deleted))).rejects.toBeInstanceOf(ProjectWriteRefusedError);
    // A tab whose storage event has not arrived yet still reads the shared delete record.
    const tab3 = createProjectSync(memoryProjectSyncAdapters({ browser: browser.store, preferences: browser.tab(), server: null }));
    expect(tab3.status("p")).toBe("synced");
    await expect(tab3.write("p", projectShapeCacheEntry(20, []), projectShapeSaveContext(deleted))).rejects.toBeInstanceOf(ProjectWriteRefusedError);
    expect(browser.records.has("p")).toBe(false);
  });

  it("stops saving a project another client deleted, and keeps this client's copy", async () => {
    const shared = project("p", 10);
    const server = await serverWith(shared);
    const a = client(server);
    const b = client(server);
    const listed = await switchToServer(a.sync);
    await switchToServer(b.sync);
    await a.sync.open(shared, undefined);
    const aEvents = recordEvents(a.sync);

    await b.sync.deleteProject("p");
    const { job } = a.sync.saveSnapshot("p", snapshot(shared, ["late"]));
    await a.sync.idle();

    expect(server.projects.has("p")).toBe(false);
    expect(a.sync.status("p")).toBe("deleted");
    expect(aEvents.some((event) => event.type === "deletedElsewhere")).toBe(true);
    expect(a.sync.keptCopy("p")).toBe(job);

    // A list write for it does not recreate it either (#672).
    a.sync.persistList([{ ...listed[0], name: "Renamed late" }]);
    await a.sync.idle();
    expect(server.projects.has("p")).toBe(false);
  });
});

describe("opening a project", () => {
  it("changes nothing when the page abandons the read", async () => {
    const browser = createMemoryBrowser();
    const broken = project("p", 10);
    browser.records.set("p", { id: "p", revision: 10, updatedAt: 10, skfPackage: new Uint8Array([1]) });
    const { sync } = client(null, browser);
    const abandoned = new AbortController();

    const opening = sync.open(broken, undefined, abandoned.signal);
    abandoned.abort();

    expect(await opening).toEqual({ kind: "canceled" });
    expect(sync.status("p")).toBe("synced");
  });
});

describe("snapshot sequence numbers", () => {
  it("count each project's snapshots from 1 and never repeat", async () => {
    const { sync } = client(null);
    const a = project("a", 1);
    const b = project("b", 1);

    expect(sync.saveSnapshot("a", snapshot(a, [])).sequence).toBe(1);
    expect(sync.saveSnapshot("a", snapshot(a, [])).sequence).toBe(2);
    expect(sync.saveSnapshot("b", snapshot(b, [])).sequence).toBe(1);
    await sync.deleteProject("a");
    expect(sync.saveSnapshot("a", snapshot(a, [])).sequence).toBe(3);
    expect(sync.localSequence("a")).toBe(3);
    await sync.idle();
  });
});
