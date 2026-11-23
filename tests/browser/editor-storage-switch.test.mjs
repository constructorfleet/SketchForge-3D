import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// Issue #657: the switch to server project storage re-rendered the editor in
// the 120 ms before a new shape's save published, and the editor reset to the
// host's older, empty scene. Timers are paused so the switch lands in that gap.

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

test("a shape added just before projects move to server storage stays in the scene", { timeout: 180_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-storage-switch-"));
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "storage-switch-token" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());

    // The first listing finds the new project in the browser and migrates it;
    // the second, after the upload, is what switches the editor to the server.
    const probe = gate();
    const adoption = gate();
    let listings = 0;
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "GET") {
        listings += 1;
        if (listings === 1) await probe.opened;
        if (listings === 2) await adoption.opened;
      }
      await route.continue();
    });

    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
    probe.open();
    await page.getByRole("button", { name: "Add shape" }).click();
    const boxItem = page.getByText("Box", { exact: true }).first();
    await boxItem.waitFor({ state: "visible" });

    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 50);
    await boxItem.click();
    adoption.open();
    const deadline = Date.now() + 30_000;
    while (await page.evaluate(() => window.localStorage.getItem("sketchForge.projects") !== null)) {
      assert.ok(Date.now() < deadline, "the editor never switched to server project storage");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // React renders on a message channel, not a timer, so the switch has re-rendered by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.clock.resume();

    await page.getByRole("region", { name: "Faces" }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.getByText("Nothing in the scene", { exact: true }).count(), 0, "the new box was dropped from the scene");

    // The held save still publishes, so the server records the box.
    const saved = Date.now() + 15_000;
    let shapes = 0;
    while (Date.now() < saved) {
      const listing = await (await fetch(`${baseURL}/api/projects`)).json();
      shapes = listing.projects?.[0]?.metadata?.shapes ?? 0;
      if (shapes === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(shapes, 1, "the server never received the new box");
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
