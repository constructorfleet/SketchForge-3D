import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// The screenshot is evidence for review, not documentation, so it goes to the
// automation output rather than docs/screenshots.
const SCREENSHOT_DIR = "output/playwright";

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

test("a face colour chosen in the inspector is kept on the shape", { timeout: 180_000 }, async () => {
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
    await page.getByRole("button", { name: "Add shape" }).click();
    await page.getByText("Box", { exact: true }).first().click();

    // An exact edge treatment gives the box B-rep faces to colour.
    await page.getByRole("button", { name: "Fillet" }).first().click();
    await page.getByRole("button", { name: "All sharp edges" }).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("status").getByText(/Filleted 12 edges/).waitFor({ state: "visible", timeout: 60_000 });

    const card = page.getByRole("region", { name: "Face colors" });
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.getByLabel("CAD face index").fill("1");
    await card.locator('input[type="color"]').fill("#ff0000");

    await card.getByText("#FF0000", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await card.getByText("No face colors assigned.").count(), 0, "the chosen colour must be stored on the shape");
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/face-colors.png` });

    await card.getByRole("button", { name: /Remove/ }).first().click();
    await card.getByText("No face colors assigned.").waitFor({ state: "visible", timeout: 10_000 });
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
