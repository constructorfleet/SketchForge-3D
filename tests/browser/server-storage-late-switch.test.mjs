import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// Issue #662: edits saved in the browser after a project was uploaded, but
// before the page switched to server storage, never reached the server. The
// adoption listing is held so face editing is enabled inside that window.

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

test("edits made while the page is still switching to server storage reach the server", { timeout: 180_000 }, async () => {
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
  const api = async (route) => {
    const response = await fetch(`${baseURL}/api/v1${route}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, `GET ${route} must succeed`);
    return response.json();
  };

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());

    // The first listing makes the page upload the new project; the second,
    // after the upload, is what switches it to the server.
    const probe = gate();
    const adoption = gate();
    let listings = 0;
    let uploads = 0;
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "GET") {
        listings += 1;
        if (listings === 1) await probe.opened;
        if (listings === 2) await adoption.opened;
      }
      await route.continue();
    });
    page.on("response", (response) => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects") uploads += 1;
    });

    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
    const projectId = new URL(page.url()).searchParams.get("project");
    assert.ok(projectId, "the editor URL names the new project");
    probe.open();
    const uploaded = Date.now() + 30_000;
    while (uploads < 2 || listings < 2) {
      assert.ok(Date.now() < uploaded, "the page never uploaded the new project");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const savedAfter = async (revision, what) => {
      const deadline = Date.now() + 30_000;
      let current;
      while ((current = await browserRevision(page, projectId)) <= revision) {
        assert.ok(Date.now() < deadline, `${what} was never saved in the browser`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return current;
    };
    const revisionAtUpload = await browserRevision(page, projectId);

    // Still in browser storage: these saves land in IndexedDB only.
    await page.getByRole("button", { name: "Add shape" }).click();
    await page.getByText("Box", { exact: true }).first().click();
    const faces = page.getByRole("region", { name: "Faces" });
    await faces.waitFor({ state: "visible", timeout: 30_000 });
    const boxRevision = await savedAfter(revisionAtUpload, "the new box");
    await faces.getByRole("button", { name: "Enable face editing" }).click();
    await page.getByRole("status").getByText("Face editing enabled.", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
    const shownId = (await faces.getByText(/^Face ID: \S+$/).innerText()).replace(/^Face ID: /, "");
    await savedAfter(boxRevision, "the face-editing edit");

    adoption.open();
    const switched = Date.now() + 30_000;
    while (await page.evaluate(() => window.localStorage.getItem("sketchForge.projects") !== null)) {
      assert.ok(Date.now() < switched, "the page never switched to server project storage");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // No further edit: the switch itself must bring the server up to date.
    let listedId = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && listedId !== shownId) {
      const { shapes } = await api(`/shapes?projectId=${projectId}`);
      if (shapes?.length === 1) {
        const { faces: listed } = await api(`/faces?projectId=${projectId}&shapeId=${shapes[0].id}`);
        listedId = listed?.[0]?.id ?? null;
      }
      if (listedId !== shownId) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(listedId, shownId, "the server must hold the face IDs the editor shows");
  } finally {
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
  }
});
