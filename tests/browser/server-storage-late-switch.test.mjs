import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// Issue #662: the page uploads browser projects, then waits for a second
// listing before it switches to server storage. These tests hold that listing
// and act inside the wait: edits, another client's save, a new project, a delete.

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(url, server, getLogs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${getLogs()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready:\n${getLogs()}`);
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The revision of the project's package in the browser store, or 0. */
function browserRevision(page, projectId) {
  return page.evaluate((id) => new Promise((resolve) => {
    const request = indexedDB.open("sketchForge.projectShapes");
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("projectShapes", "readonly").objectStore("projectShapes").get(id);
      read.onsuccess = () => { database.close(); resolve(read.result?.revision ?? 0); };
      read.onerror = () => { database.close(); resolve(0); };
    };
  }), projectId);
}

/** Holds a page's first listing until `probe.open()` and its second until `adoption.open()`. */
async function holdListings(page, { holdUploads = false } = {}) {
  const held = { probe: gate(), adoption: gate(), uploadsAllowed: gate(), listings: 0, answered: 0, uploads: 0 };
  if (!holdUploads) held.uploadsAllowed.open();
  await page.route("**/api/projects?*", async (route) => {
    if (route.request().method() === "POST") await held.uploadsAllowed.opened;
    await route.continue();
  });
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") {
      held.listings += 1;
      if (held.listings === 1) await held.probe.opened;
      if (held.listings === 2) await held.adoption.opened;
    }
    await route.continue();
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/api/projects") return;
    if (response.request().method() === "POST") held.uploads += 1;
    if (response.request().method() === "GET" && !new URL(response.url()).search) held.answered += 1;
  });
  return held;
}

/**
 * Opens a new design, lets the page upload it, and holds the listing that would
 * switch the page to server storage until `switchToServer` is called.
 * `beforeUpload` runs with the browser context before the page's first listing is answered.
 */
async function migratingSession(t, { beforeUpload } = {}) {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const token = "late-switch-token";
  const projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-late-switch-"));
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: token },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.pid) {
      try {
        if (process.platform === "win32") server.kill("SIGTERM");
        else process.kill(-server.pid, "SIGTERM");
      } catch {
        // The server already exited.
      }
    }
    rmSync(projectsDir, { recursive: true, force: true });
  });

  await waitForServer(baseURL, server, () => logs);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/api/app-update**", (route) => route.abort());
  const page = await context.newPage();
  const held = await holdListings(page);

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  const projectId = new URL(page.url()).searchParams.get("project");
  assert.ok(projectId, "the editor URL names the new project");
  await beforeUpload?.({ context, baseURL });
  held.probe.open();
  await until(() => held.uploads >= 2 && held.listings >= 2, "the page never uploaded the new project");

  const api = async (route) => {
    const response = await fetch(`${baseURL}/api/v1${route}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, `GET ${route} must succeed`);
    return response.json();
  };
  const listing = async () => (await (await fetch(`${baseURL}/api/projects`)).json()).projects ?? [];
  const storedRevision = async (id = projectId) => Number((await fetch(`${baseURL}/api/projects?projectId=${id}`)).headers.get("X-SketchForge-Revision"));
  /** Saves the stored package again as another client would, at a later revision. */
  const saveAsAnotherClient = async () => {
    const served = await fetch(`${baseURL}/api/projects?projectId=${projectId}`);
    assert.equal(served.status, 200, "the uploaded package can be read");
    const base = Number(served.headers.get("X-SketchForge-Revision"));
    // Just past the uploaded copy, so this client's later edits carry a higher revision.
    const revision = base + 1;
    const form = new FormData();
    form.append("project", new Blob([new Uint8Array(await served.arrayBuffer())], { type: "application/vnd.sketchforge.project+zip" }));
    form.append("revision", String(revision));
    form.append("baseRevision", String(base));
    const saved = await fetch(`${baseURL}/api/projects?projectId=${projectId}`, { method: "POST", body: form });
    assert.equal(saved.status, 200, `the other client's save is stored (${saved.status})`);
    return revision;
  };
  const savedAfter = (revision, what) => until(async () => {
    const current = await browserRevision(page, projectId);
    return current > revision ? current : 0;
  }, `${what} was never saved in the browser`);
  const addBox = async () => {
    await page.getByRole("button", { name: "Add shape" }).click();
    await page.getByText("Box", { exact: true }).first().click();
  };
  const switchToServer = async () => {
    held.adoption.open();
    await until(() => page.evaluate(() => window.localStorage.getItem("sketchForge.projects") === null), "the page never switched to server project storage");
  };
  return { page, baseURL, projectsDir, projectId, api, listing, storedRevision, saveAsAnotherClient, savedAfter, addBox, switchToServer };
}

const conflictBanner = (page) => page.getByRole("alert").filter({ hasText: "was changed elsewhere" });

test("edits made while the page is still switching to server storage reach the server", { timeout: 180_000 }, async (t) => {
  const { page, projectId, api, listing, savedAfter, addBox, switchToServer } = await migratingSession(t);
  const revisionAtUpload = await browserRevision(page, projectId);

  // Still in browser storage: these saves land in IndexedDB only.
  await addBox();
  const faces = page.getByRole("region", { name: "Faces" });
  await faces.waitFor({ state: "visible", timeout: 30_000 });
  const boxRevision = await savedAfter(revisionAtUpload, "the new box");
  await faces.getByRole("button", { name: "Enable face editing" }).click();
  await page.getByRole("status").getByText("Face editing enabled.", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
  const shownId = (await faces.getByText(/^Face ID: \S+$/).innerText()).replace(/^Face ID: /, "");
  await savedAfter(boxRevision, "the face-editing edit");

  await switchToServer();

  // No further edit: the switch itself must bring the server up to date.
  await until(async () => {
    const { shapes } = await api(`/shapes?projectId=${projectId}`);
    if (shapes?.length !== 1) return false;
    const { faces: listed } = await api(`/faces?projectId=${projectId}&shapeId=${shapes[0].id}`);
    return listed?.[0]?.id === shownId;
  }, "the server must hold the face IDs the editor shows", 20_000);

  // The dashboard entry catches up too, instead of the count taken at upload.
  await until(async () => (await listing()).find((record) => record.projectId === projectId)?.metadata?.shapes === 1, "the server's project entry must count the box", 15_000);
  assert.equal(await page.getByRole("status").getByText(/could not|being saved/i).count(), 0, "the switch must not report a failed save");
});

test("an edit made while projects move does not overwrite a newer copy another client saved", { timeout: 180_000 }, async (t) => {
  const { page, projectId, storedRevision, saveAsAnotherClient, savedAfter, addBox, switchToServer } = await migratingSession(t);
  const revisionAtUpload = await browserRevision(page, projectId);
  await addBox();
  await savedAfter(revisionAtUpload, "the new box");
  const theirs = await saveAsAnotherClient();

  await switchToServer();
  await conflictBanner(page).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await storedRevision(), theirs, "the other client's copy is kept");
  assert.equal(await conflictBanner(page).getByRole("button", { name: /^Download my copy/ }).count(), 1, "the late edit can still be downloaded");
});

test("after projects move, an edit does not overwrite a newer copy another client saved", { timeout: 180_000 }, async (t) => {
  const { page, storedRevision, saveAsAnotherClient, addBox, switchToServer } = await migratingSession(t);
  await switchToServer();
  const theirs = await saveAsAnotherClient();

  await addBox();
  await conflictBanner(page).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await storedRevision(), theirs, "the other client's copy is kept");
});

test("a project created while projects move is kept on the server", { timeout: 180_000 }, async (t) => {
  const { page, projectId, listing, addBox, switchToServer } = await migratingSession(t);
  await page.getByRole("button", { name: "Home dashboard" }).click();
  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  const lateId = new URL(page.url()).searchParams.get("project");
  assert.ok(lateId && lateId !== projectId, "a second project opened");
  await addBox();

  await switchToServer();
  await until(async () => (await listing()).some((record) => record.projectId === lateId), "the new project must reach the server", 20_000);
  await until(async () => (await listing()).find((record) => record.projectId === lateId)?.metadata?.shapes === 1, "the new project's box must reach the server", 20_000);
  assert.equal(await page.getByRole("button", { name: "Add shape" }).count(), 1, "the new project stays open");
});

test("a project deleted while projects move does not come back", { timeout: 180_000 }, async (t) => {
  const { page, projectsDir, projectId, listing, switchToServer } = await migratingSession(t);
  await page.getByRole("button", { name: "Home dashboard" }).click();
  await page.getByRole("button", { name: "Options for Untitled design 1" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await until(async () => (await page.getByText("Untitled design 1", { exact: true }).count()) === 0, "the project leaves the dashboard");

  await switchToServer();
  await until(async () => !(await listing()).some((record) => record.projectId === projectId), "the deleted project must not stay on the server", 15_000);
  await page.waitForTimeout(1_000);
  assert.equal(await page.getByText("Untitled design 1", { exact: true }).count(), 0, "the deleted project does not reappear");
  assert.deepEqual(readdirSync(projectsDir).filter((name) => name.startsWith(projectId)), [], "no file of the deleted project is left");
});

test("a project moved by two tabs at once stays on the server", { timeout: 180_000 }, async (t) => {
  let other;
  const { page, projectsDir, projectId, api, listing, savedAfter, addBox, switchToServer } = await migratingSession(t, {
    // A second tab reads the same browser list and moves the same project.
    // Its uploads wait until the first tab has moved it too, so both see an empty server.
    beforeUpload: async ({ context, baseURL }) => {
      const page = await context.newPage();
      other = { page, held: await holdListings(page, { holdUploads: true }) };
      await page.goto(baseURL);
      other.held.probe.open();
      await until(() => other.held.answered >= 1, "the second tab never read the server's list");
    },
  });
  other.held.uploadsAllowed.open();
  await until(() => other.held.uploads >= 2 && other.held.listings >= 2, "the second tab never moved the project");

  // A late edit both tabs find in the shared IndexedDB.
  const revisionAtUpload = await browserRevision(page, projectId);
  await addBox();
  await savedAfter(revisionAtUpload, "the new box");

  // The first tab switches and removes the browser list the second tab still reads.
  await switchToServer();
  other.held.adoption.open();
  await until(() => other.held.answered >= 2, "the second tab never read the server's list");
  await other.page.waitForTimeout(2_000);

  assert.ok((await listing()).some((record) => record.projectId === projectId), "the project stays on the server");
  assert.ok(readdirSync(projectsDir).includes(`${projectId}.skf`), "the project's package stays on disk");
  await until(async () => (await api(`/shapes?projectId=${projectId}`)).shapes?.length === 1, "the late box must reach the server", 20_000);
  await other.page.getByText("Untitled design 1", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  for (const tab of [page, other.page]) {
    assert.equal(await tab.getByRole("alert").filter({ hasText: "was changed elsewhere" }).count(), 0, "one tab's catch-up is not a conflict for the other");
  }
});

test("a missing browser project list during the move keeps every project", { timeout: 180_000 }, async (t) => {
  const { page, projectsDir, projectId, api, listing, savedAfter, addBox, switchToServer } = await migratingSession(t);
  const revisionAtUpload = await browserRevision(page, projectId);
  await addBox();
  await savedAfter(revisionAtUpload, "the new box");
  // After the box's list update, so nothing writes the list again.
  await page.waitForTimeout(1_000);
  await page.evaluate(() => window.localStorage.removeItem("sketchForge.projects"));
  await switchToServer();
  await until(async () => (await api(`/shapes?projectId=${projectId}`)).shapes?.length === 1, "the late box must reach the server", 20_000);

  assert.ok((await listing()).some((record) => record.projectId === projectId), "the project stays on the server");
  assert.ok(readdirSync(projectsDir).includes(`${projectId}.skf`), "the project's package stays on disk");
  assert.equal(await page.getByRole("button", { name: "Add shape" }).count(), 1, "the open project stays open");
});

test("edits made while the page catches up still reach the server", { timeout: 180_000 }, async (t) => {
  const { page, projectId, api, savedAfter, addBox, switchToServer } = await migratingSession(t);
  const revisionAtUpload = await browserRevision(page, projectId);
  await addBox();
  await savedAfter(revisionAtUpload, "the first box");

  // The second box is added while the catch-up is uploading the first.
  const switched = switchToServer();
  await addBox();
  await switched;
  await until(async () => (await api(`/shapes?projectId=${projectId}`)).shapes?.length === 2, "both boxes must reach the server", 20_000);
  assert.equal(await page.getByRole("alert").filter({ hasText: "was changed elsewhere" }).count(), 0, "the client's own saves do not conflict");
});

// Issue #670: a delete in one tab is shared with a second tab that is moving the same project.
test("a project one tab deletes while two tabs move it does not come back", { timeout: 180_000 }, async (t) => {
  let other;
  const { page, projectId, listing, switchToServer } = await migratingSession(t, {
    beforeUpload: async ({ context, baseURL }) => {
      const tab = await context.newPage();
      other = { page: tab, held: await holdListings(tab, { holdUploads: true }) };
      await tab.goto(baseURL);
      other.held.probe.open();
      await until(() => other.held.answered >= 1, "the second tab never read the server's list");
    },
  });
  other.held.uploadsAllowed.open();
  await until(() => other.held.uploads >= 2 && other.held.listings >= 2, "the second tab never moved the project");

  await page.getByRole("button", { name: "Home dashboard" }).click();
  await page.getByRole("button", { name: "Options for Untitled design 1" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await switchToServer();
  await until(async () => !(await listing()).some((record) => record.projectId === projectId), "the first tab removes its upload", 15_000);

  other.held.adoption.open();
  await until(() => other.held.answered >= 2, "the second tab never read the server's list");
  await other.page.waitForTimeout(3_000);
  assert.equal((await listing()).some((record) => record.projectId === projectId), false, "the second tab put the deleted project back on the server");
  assert.equal(await other.page.getByText("Untitled design 1", { exact: true }).count(), 0, "the second tab lists the deleted project");
});
