import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** The pixels in a PNG that read as the face highlight colour (#ffb400), whatever the lighting, and their centre. */
async function highlightRegion(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
    if (r > 120 && g > 0.5 * r && g < 0.85 * r && b < 0.3 * r) {
      const pixel = offset / info.channels;
      count += 1;
      sumX += pixel % info.width;
      sumY += Math.floor(pixel / info.width);
    }
  }
  return { count, x: count ? sumX / count : 0, y: count ? sumY / count : 0 };
}

async function waitForValue(field, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && await field.inputValue() !== expected) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Whether most pixels around (x, y) in a PNG read as the highlight colour. */
async function highlightAt(png, x, y) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let hits = 0;
  let total = 0;
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= info.width || py >= info.height) continue;
      const offset = (py * info.width + px) * info.channels;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      total += 1;
      if (r > 120 && g > 0.5 * r && g < 0.85 * r && b < 0.3 * r) hits += 1;
    }
  }
  return total > 0 && hits / total > 0.6;
}

async function highlightPixels(png) {
  return (await highlightRegion(png)).count;
}

test("a user can enable face editing on a plain box, then colour and draft a face", { timeout: 180_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  // Projects are kept on the server so the API can list the faces the editor saved.
  const projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-face-tools-"));
  const token = "face-tools-browser-token";
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

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/projects", async (route) => { if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, Number(process.env.PROBE_DELAY))); await route.continue(); });
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

    // The chosen face stays outlined while the panel is open, and viewport hover
    // adds a transient face highlight that can be clicked to change the choice.
    const canvasBox = await page.locator("canvas").first().boundingBox();
    const cardBox = await faces.boundingBox();
    assert.ok(canvasBox && cardBox);
    const modelView = () => page.screenshot({
      clip: { x: canvasBox.x, y: canvasBox.y, width: cardBox.x - 20 - canvasBox.x, height: canvasBox.height },
    });
    await header.click();
    await page.waitForTimeout(300);
    const unhighlighted = await highlightPixels(await modelView());
    await header.click();
    await page.waitForTimeout(300);
    const faceField = faces.getByRole("spinbutton", { name: "Face" });
    let shown = 0;
    let region = { count: 0, x: 0, y: 0 };
    // Step until a face that looks at the default camera is selected.
    for (let face = 1; face <= 6 && shown <= unhighlighted + 40; face += 1) {
      await faceField.fill(String(face));
      await faces.hover();
      await page.waitForTimeout(300);
      region = await highlightRegion(await modelView());
      shown = region.count;
    }
    assert.ok(shown > unhighlighted + 40, `the selected face must be outlined (${unhighlighted} before, ${shown} after)`);
    const selectedFace = await faceField.inputValue();

    // The outline remains when the pointer leaves the panel and moves to the model.
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40);
    await faceField.blur();
    await page.waitForTimeout(300);
    const persistent = await highlightPixels(await modelView());
    assert.ok(persistent > unhighlighted + 40, `the selected face stays outlined after leaving the panel (${persistent} pixels)`);

    // Hovering that face in the view highlights it, and clicking it chooses it,
    // even after the panel was stepped to a different face.
    let facePoint = { x: canvasBox.x + region.x, y: canvasBox.y + region.y };
    const otherFace = String((Number(selectedFace) % 6) + 1);
    await faceField.fill(otherFace);
    await faceField.blur();
    await page.mouse.move(facePoint.x, facePoint.y, { steps: 4 });
    await page.waitForTimeout(300);
    const hovered = await highlightPixels(await modelView());
    assert.ok(hovered > unhighlighted + 1_000, `hovering a face of the selected shape must highlight it (${unhighlighted} before, ${hovered} hovering)`);
    const placement = () => page.locator('[id^="placement-"] input').evaluateAll((inputs) => inputs.map((input) => input.value));
    const placementBefore = await placement();
    assert.ok(placementBefore.length > 0, "the placement fields must be readable");
    await page.mouse.click(facePoint.x, facePoint.y);
    await waitForValue(faceField, selectedFace);
    assert.equal(await faceField.inputValue(), selectedFace, "clicking a face in the view must choose it in the Faces panel");
    assert.equal(await faces.isVisible(), true, "clicking a face must keep the shape selected");
    assert.deepEqual(await placement(), placementBefore, "clicking a face must not move the shape");
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40, { steps: 4 });
    await page.waitForTimeout(300);
    const unhovered = await highlightPixels(await modelView());
    assert.ok(unhovered > unhighlighted + 40, `the selected face outline remains after the hover cue clears (${unhovered} pixels)`);

    await faces.getByLabel(`Color for face ${selectedFace}`).fill("#3366ff");
    await faces.getByRole("list", { name: "Colored faces" }).getByText(`Face ${selectedFace}`, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await faces.hover();
    await page.waitForTimeout(300);
    const coloredFaceHighlight = await highlightPixels(await modelView());
    assert.ok(coloredFaceHighlight > unhighlighted + 40, `a colored face keeps the yellow edit outline (${coloredFaceHighlight} pixels)`);
    await page.screenshot({ path: "docs/screenshots/face-tools.png" });

    const draft = faces.getByRole("group", { name: "Draft" });
    await draft.getByLabel("Direction").selectOption("y");
    await draft.getByLabel("Draft angle").fill("5");
    await draft.getByRole("button", { name: "Apply draft" }).click();
    await page.getByRole("status").getByText("Face drafted.", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    // Find, with the panel's own highlight, which drafted face lies under that point.
    const draftedCount = Number((await faces.getByText(/^of \d+$/).innerText()).replace("of ", ""));
    let draftedFace = null;
    for (let face = 1; face <= draftedCount && !draftedFace; face += 1) {
      await faceField.fill(String(face));
      await faces.hover();
      await page.waitForTimeout(300);
      const outline = await highlightRegion(await modelView());
      const candidate = { x: canvasBox.x + outline.x, y: canvasBox.y + outline.y };
      const differentFace = face === 1 ? "2" : "1";
      await faceField.fill(differentFace);
      await faceField.blur();
      await page.mouse.move(candidate.x, candidate.y, { steps: 3 });
      await page.waitForTimeout(300);
      await page.mouse.click(candidate.x, candidate.y);
      await waitForValue(faceField, String(face));
      if (await faceField.inputValue() === String(face)) {
        draftedFace = String(face);
        facePoint = candidate;
      }
    }
    assert.ok(draftedFace, "clicking an outlined drafted face must choose it in the viewport");

    // The picked face's stable ID is shown in the inspector.
    assert.equal(await faceField.inputValue(), draftedFace);
    const elsewhere = draftedFace === "1" ? "2" : "1";
    const shownId = (await faces.getByText(/^Face ID: \S+$/).innerText()).replace(/^Face ID: /, "");

    // That is the ID GET /faces returns for the face, once the editor has saved the project.
    const api = async (route) => {
      const response = await fetch(`${baseURL}/api/v1${route}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200, `GET ${route} must succeed`);
      return response.json();
    };
    let listedId = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && listedId !== shownId) {
      const projectId = readdirSync(projectsDir).find((name) => name.endsWith(".skf"))?.replace(/\.skf$/, "");
      if (projectId) {
        const { shapes } = await api(`/shapes?projectId=${projectId}`);
        if (shapes?.length === 1) {
          const { faces: listed } = await api(`/faces?projectId=${projectId}&shapeId=${shapes[0].id}`);
          listedId = listed?.find((face) => face.index === Number(draftedFace) - 1)?.id ?? null;
        }
      }
      if (listedId !== shownId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(listedId, shownId, "the face ID shown must be the one GET /faces lists for that face");

    // The hover highlight goes when the camera moves under a still pointer.
    await page.mouse.move(facePoint.x + 1, facePoint.y + 1);
    await page.waitForTimeout(300);
    assert.ok(await highlightAt(await modelView(), region.x, region.y), "the hovered face must be highlighted");
    const highlightedBeforeCameraMove = await highlightPixels(await modelView());
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(600);
    const afterCameraMove = await highlightPixels(await modelView());
    assert.ok(afterCameraMove < highlightedBeforeCameraMove, "the hover cue must clear when the camera moves");
    assert.ok(afterCameraMove > unhighlighted + 40, "the selected face outline must remain after the hover cue clears");
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(600);

    await faces.hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "docs/screenshots/face-picking.png" });

    // Picking still works after the shape is deselected and selected again,
    // when the panel mounts before the view has seen the new selection.
    await page.mouse.click(canvasBox.x + 300, canvasBox.y + canvasBox.height - 150);
    await faces.waitFor({ state: "detached", timeout: 10_000 });
    await page.mouse.click(facePoint.x, facePoint.y);
    await faces.waitFor({ state: "visible", timeout: 10_000 });
    await faceField.fill(elsewhere);
    await faceField.blur();
    await page.mouse.move(facePoint.x + 2, facePoint.y + 2, { steps: 4 });
    await page.mouse.click(facePoint.x + 2, facePoint.y + 2);
    await waitForValue(faceField, draftedFace);
    assert.equal(await faceField.inputValue(), draftedFace, "a face must still be pickable after selecting the shape again");
  } finally {
    await browser?.close();
    if (server.pid) {
      if (process.platform === "win32") server.kill("SIGTERM");
      else {
        try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
      }
      if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    rmSync(projectsDir, { recursive: true, force: true });
  }
});
