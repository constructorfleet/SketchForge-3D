import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";

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

/** Pixels in a PNG that read as the magenta used for the coloured faces, whatever the lighting. */
async function magentaPixels(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
    if (r > 90 && b > 90 && g < 0.45 * Math.min(r, b) && Math.abs(r - b) < 0.35 * Math.max(r, b)) count += 1;
  }
  return count;
}

test("a face colour chosen in the inspector is kept on the shape and painted in the viewport", { timeout: 180_000 }, async () => {
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

    const card = page.getByRole("region", { name: "Faces" });
    await card.waitFor({ state: "visible", timeout: 30_000 });
    // The inspector floats over the canvas, and its colour swatch is magenta too,
    // so only the part of the view left of the inspector is counted.
    const canvasBox = await page.locator("canvas").first().boundingBox();
    const cardBox = await card.boundingBox();
    assert.ok(canvasBox && cardBox);
    const modelView = () => page.screenshot({
      clip: { x: canvasBox.x, y: canvasBox.y, width: cardBox.x - 20 - canvasBox.x, height: canvasBox.height },
    });
    // Keep the pointer off the card, whose face highlight would also paint the view.
    const parkPointer = () => page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40);
    await parkPointer();
    const before = await magentaPixels(await modelView());

    const faceField = card.getByRole("spinbutton", { name: "Face" });
    const colored = card.getByRole("list", { name: "Colored faces" });
    await faceField.fill("2");
    await card.getByLabel("Color for face 2").fill("#ff00ff");
    await colored.getByText("Face 2", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await card.getByText("No faces colored yet.").count(), 0, "the chosen colour must be stored on the shape");

    // Colour the first six faces so at least one faces the default camera.
    for (const face of ["1", "3", "4", "5", "6"]) {
      await faceField.fill(face);
      await card.getByLabel(`Color for face ${face}`).fill("#ff00ff");
    }
    await colored.getByRole("listitem").nth(5).waitFor({ state: "visible", timeout: 10_000 });
    await parkPointer();
    await page.waitForTimeout(500);
    const after = await magentaPixels(await modelView());
    assert.ok(after > before + 2_000, `coloured faces must show in the viewport (magenta pixels ${before} before, ${after} after)`);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/face-colors.png` });

    for (let remaining = 6; remaining > 0; remaining -= 1) {
      await card.getByRole("button", { name: /^Remove color from face/ }).first().click();
      await colored.getByRole("listitem").nth(remaining - 1).waitFor({ state: "detached", timeout: 10_000 });
    }
    await card.getByText("No faces colored yet.").waitFor({ state: "visible", timeout: 10_000 });
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
