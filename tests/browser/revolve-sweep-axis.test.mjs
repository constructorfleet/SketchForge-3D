import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/**
 * Issue #503 in the editor: changing a sketch revolve's Sweep in the inspector
 * rebuilt it centred on the old box, which slid a partial sweep round its own
 * axis. The axis is where the sketch's x = 0 was put, so a full turn's box
 * centre is the axis, and a quarter turn lies to one side of it: its box centre
 * moves out to +X and -Z (the sweep starts on +X and turns towards -Z).
 */
test("changing a sketch revolve's sweep keeps it about its axis", { timeout: 240_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  let browser;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(baseURL)).ok) break; } catch { /* server starting */ }
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Revolve sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish revolve" }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await page.getByRole("button", { name: "Finish revolve", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });

    const field = (label) => page.locator("label").filter({ hasText: new RegExp(`^\\s*${label}(mm)?\\s*$`) }).locator("input").first();
    const position = async () => ({ x: Number(await field("X").inputValue()), z: Number(await field("Z").inputValue()) });
    const axis = await position();
    const width = Number(await field("Width").inputValue());
    assert.ok(width > 1, `the full turn has a footprint (width ${width})`);
    fs.mkdirSync("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/revolve-sweep-full-turn.png" });

    const sweep = field("Sweep");
    assert.equal(Number(await sweep.inputValue()), 360);
    await sweep.fill("90");
    await sweep.press("Enter");
    await page.getByRole("status").getByText("Revolve updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(
      (fullWidth) => {
        const input = [...document.querySelectorAll("label")].find((label) => /^\s*Width(mm)?\s*$/.test(label.textContent ?? ""))?.querySelector("input");
        return input && Number(input.value) < fullWidth * 0.75;
      },
      width,
      { timeout: 30_000 },
    );
    const quarter = await position();
    await page.screenshot({ path: "docs/screenshots/revolve-sweep-quarter-turn.png" });

    // Kept about the axis, the quarter's box centre moves out the same distance
    // along +X and -Z. Kept about the old box (the bug), it would not move.
    const dx = quarter.x - axis.x;
    const dz = quarter.z - axis.z;
    assert.ok(dx > width * 0.1, `the quarter lies on +X of the axis (moved ${dx} mm from ${axis.x})`);
    assert.ok(dz < -width * 0.1, `the quarter lies on -Z of the axis (moved ${dz} mm from ${axis.z})`);
    assert.ok(Math.abs(dx + dz) < 0.5, `the quarter is symmetric about the axis diagonal (dx ${dx}, dz ${dz})`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
    }
  }
});
