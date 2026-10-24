import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// The screenshot illustrates docs/guides/scene-analysis.md.
const SCREENSHOT = "docs/screenshots/scene-analysis.png";

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

test("interference on two overlapping boxes reports one pair, selects it on click, and leaves history alone", { timeout: 240_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
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
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    // Two boxes added in a row land on the same spot, so they overlap whole.
    for (let added = 0; added < 2; added += 1) {
      await page.getByRole("button", { name: "Add shape" }).click();
      await page.getByText("Box", { exact: true }).first().click();
    }
    const sceneList = page.locator(".scene-inspector-list");
    await sceneList.getByRole("button", { name: /^Box/ }).nth(1).waitFor({ state: "visible", timeout: 10_000 });

    const analysis = page.getByRole("region", { name: "Analysis" });
    await analysis.waitFor({ state: "visible", timeout: 10_000 });
    // Nothing selected, so the check covers every visible shape.
    await page.keyboard.press("Escape");
    await analysis.getByRole("button", { name: "Check interference" }).click();
    const pairs = analysis.getByRole("list", { name: "Colliding pairs" });
    await pairs.waitFor({ state: "visible", timeout: 90_000 });
    assert.equal(await pairs.getByRole("listitem").count(), 1, "two overlapping boxes are exactly one colliding pair");
    await analysis.getByRole("status").getByText("1 colliding pair among 2 shapes.").waitFor({ state: "visible" });
    await analysis.getByText(/^overlap .* mm³$/).waitFor({ state: "visible" });
    await analysis.getByText(/Exact OCCT surface distance and common volume/).waitFor({ state: "visible" });

    // Clicking the pair highlights it by selecting both of its shapes.
    const pair = pairs.getByRole("button");
    await pair.click();
    await page.waitForFunction(() => document.querySelectorAll(".scene-row.selected").length === 2, null, { timeout: 10_000 });
    assert.equal(await pair.getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: SCREENSHOT });

    // Wall thickness of one box: the sampled minimum, with its method stated.
    await sceneList.getByRole("button", { name: /^Box/ }).first().click();
    await analysis.getByRole("button", { name: "Wall thickness" }).click();
    await analysis.getByRole("status").getByText(/^Thinnest wall of .+: \d/).waitFor({ state: "visible", timeout: 90_000 });
    await analysis.getByText(/Sampled estimate: 25 points per face across 6 faces/).waitFor({ state: "visible" });

    // Analysis is read-only. Had it pushed a history entry, one undo would take
    // that back and leave both boxes; instead it takes back the second box.
    await page.getByRole("button", { name: "Undo" }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".scene-row").length === 1, null, { timeout: 10_000 });
  } finally {
    await browser?.close();
    if (server.pid) {
      if (process.platform === "win32") server.kill("SIGTERM");
      else {
        try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
      }
      if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
});
