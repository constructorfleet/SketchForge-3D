import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";

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

/** Pixels in a PNG that read as the face highlight colour (#ffb400), whatever the lighting. */
async function highlightPixels(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
    if (r > 120 && g > 0.5 * r && g < 0.85 * r && b < 0.3 * r) count += 1;
  }
  return count;
}

test("a user can enable face editing on a plain box, then colour and draft a face", { timeout: 180_000 }, async () => {
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

    // The face tools are offered on a fresh primitive, not only after a fillet.
    const faces = page.getByRole("region", { name: "Faces" });
    await faces.waitFor({ state: "visible", timeout: 30_000 });
    const header = faces.getByRole("button", { name: "Faces" });
    if (await header.getAttribute("aria-expanded") === "false") await header.click();
    await faces.getByRole("button", { name: "Enable face editing" }).click();
    await page.getByRole("status").getByText("Face editing enabled.", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
    await faces.getByText("of 6", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    // Nothing in the inspector speaks API or kernel.
    const inspectorText = await faces.innerText();
    for (const jargon of ["GET /", "CAD", "B-rep", "kernel", "local frame"]) {
      assert.equal(inspectorText.includes(jargon), false, `the face tools must not show "${jargon}"`);
    }

    // While the pointer is over the card, the chosen face is highlighted in the view.
    const canvasBox = await page.locator("canvas").first().boundingBox();
    const cardBox = await faces.boundingBox();
    assert.ok(canvasBox && cardBox);
    const modelView = () => page.screenshot({
      clip: { x: canvasBox.x, y: canvasBox.y, width: cardBox.x - 20 - canvasBox.x, height: canvasBox.height },
    });
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40);
    await page.waitForTimeout(300);
    const unhighlighted = await highlightPixels(await modelView());
    const faceField = faces.getByRole("spinbutton", { name: "Face" });
    let shown = 0;
    // Step until a face that looks at the default camera is selected.
    for (let face = 1; face <= 6 && shown <= unhighlighted + 1_000; face += 1) {
      await faceField.fill(String(face));
      await faces.hover();
      await page.waitForTimeout(300);
      shown = await highlightPixels(await modelView());
    }
    assert.ok(shown > unhighlighted + 1_000, `the selected face must be highlighted (${unhighlighted} before, ${shown} after)`);
    const selectedFace = await faceField.inputValue();

    // Leaving the panel takes the highlight away again.
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40);
    await faceField.blur();
    await page.waitForTimeout(300);
    const cleared = await highlightPixels(await modelView());
    assert.ok(cleared < unhighlighted + 200, `the highlight must clear when the pointer leaves the panel (${cleared} left, ${unhighlighted} before)`);

    await faces.getByLabel(`Color for face ${selectedFace}`).fill("#3366ff");
    await faces.getByRole("list", { name: "Colored faces" }).getByText(`Face ${selectedFace}`, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await faces.hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "docs/screenshots/face-tools.png" });

    const draft = faces.getByRole("group", { name: "Draft" });
    await draft.getByLabel("Direction").selectOption("y");
    await draft.getByLabel("Draft angle").fill("5");
    await draft.getByRole("button", { name: "Apply draft" }).click();
    await page.getByRole("status").getByText("Face drafted.", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
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
