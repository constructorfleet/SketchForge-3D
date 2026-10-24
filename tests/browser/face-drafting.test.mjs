import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
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

function startServer(port) {
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  return { server, logs: () => logs };
}

async function stopServer(server) {
  if (!server.pid) return;
  if (process.platform === "win32") server.kill("SIGTERM");
  else {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
  }
  if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** The inspector's size and position readouts, in mm, for the selected shape. */
async function readouts(page) {
  const values = await page.locator('input[type="text"]').evaluateAll((inputs) => Object.fromEntries(inputs.flatMap((input) => {
    const label = (input.labels?.[0]?.innerText ?? "").replace(/\s+/g, " ").trim();
    const match = /^(Length|Width|Height|X|Z) mm$/.exec(label);
    return match ? [[match[1], Number(input.value)]] : [];
  })));
  return { length: values.Length, width: values.Width, height: values.Height, x: values.X, z: values.Z };
}

/** Poll the readouts until `check` holds, so a commit has landed before it is judged. */
async function readoutsWhen(page, check, message) {
  const deadline = Date.now() + 15_000;
  let last;
  while (Date.now() < deadline) {
    last = await readouts(page);
    if (check(last)) return last;
    await page.waitForTimeout(200);
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

const near = (left, right) => Math.abs(left - right) < 0.015;
const sameFootprint = (left, right) => near(left.length, right.length) && near(left.width, right.width);
const samePlace = (left, right) => near(left.x, right.x) && near(left.z, right.z);

/**
 * Whether a replay moved the part by the REST rule: by however far the centre
 * of the sketch's bounds moved, which is half the growth of a plain extrusion
 * of the same edit (`plainBefore` to `plainAfter`). Which readout is which
 * axis does not matter.
 */
function placedByRestRule(before, after, plainBefore, plainAfter) {
  const shift = [Math.abs(after.x - before.x), Math.abs(after.z - before.z)];
  const growth = [Math.abs(plainAfter.length - plainBefore.length) / 2, Math.abs(plainAfter.width - plainBefore.width) / 2];
  return (near(shift[0], growth[0]) && near(shift[1], growth[1])) || (near(shift[0], growth[1]) && near(shift[1], growth[0]));
}

/** A fresh draft shifts the recentered shape origin by half the bounds growth. */
function placedByDraftGrowth(before, after) {
  const shift = [Math.abs(after.x - before.x), Math.abs(after.z - before.z)];
  const growth = [Math.abs(after.width - before.width) / 2, Math.abs(after.length - before.length) / 2];
  return (near(shift[0], growth[0]) && near(shift[1], growth[1])) || (near(shift[0], growth[1]) && near(shift[1], growth[0]));
}

/** The same edit made to the undrafted rectangle, then undone: how much it grows the sketch's bounds. */
async function plainEditGrowth(page, status, undo) {
  const before = await readouts(page);
  await editSketchCorner(page);
  await status.getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  const after = await readoutsWhen(page, (now) => !sameFootprint(now, before), "the corner drag should change the extrusion");
  await undo.click();
  await readoutsWhen(page, (now) => sameFootprint(now, before) && samePlace(now, before), "undo should restore the rectangle");
  return { before, after };
}

/** Open the selected shape's sketch, drag its lower-right corner by the same screen offset each time, and finish. */
async function editSketchCorner(page) {
  await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
  await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });
  const sketchCorners = () => page.locator('[data-sketch-entity="point"]').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }));
  const corners = await sketchCorners();
  assert.equal(corners.length, 4, "the rectangle should have four editable corners");
  const corner = corners.reduce((best, point) => point.x + point.y > best.x + best.y ? point : best);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y + 10, { steps: 6 });
  await page.mouse.up();
  const moved = await sketchCorners();
  assert.ok(moved.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) > 10)
    && !moved.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) < 2), "the drag should move the corner");
  await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
}

test("a face draft on a shape no sketch describes stays baked", { timeout: 120_000 }, async () => {
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

    const faces = page.getByRole("region", { name: "Faces" });
    await faces.waitFor({ state: "visible", timeout: 30_000 });
    await faces.getByRole("button", { name: "Enable face editing" }).click();
    await page.getByRole("status").getByText("Face editing enabled.", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
    await faces.getByRole("spinbutton", { name: "Face" }).fill("2");
    const draftPanel = faces.getByRole("group", { name: "Draft" });
    await draftPanel.getByLabel("Direction").selectOption("z");
    await draftPanel.getByLabel("Draft angle").fill("-5");
    const apply = draftPanel.getByRole("button", { name: "Apply draft" });
    assert.equal(await apply.isDisabled(), false, "the measured face, axis, and angle should be available");
    await apply.click();
    await page.getByRole("status").getByText("Face drafted.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByRole("region", { name: "Face draft" }).count(), 0, "a baked draft keeps no editable record");
    await page.screenshot({ path: "docs/screenshots/face-draft-browser.png" });
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

test("a face draft on a sketch extrusion is kept, edited, undone, saved as .skf and replayed through a sketch edit", { timeout: 300_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const { server, logs } = startServer(port);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-retained-draft-"));
  let browser;

  try {
    await waitForServer(baseURL, server, logs);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    // This workflow covers draft persistence, not release discovery. A newer
    // upstream release can otherwise open a blocking modal on the second visit
    // to the dashboard and intercept the project import click.
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });

    const status = page.getByRole("status");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    const faces = page.getByRole("region", { name: "Faces" });
    await faces.waitFor({ state: "visible", timeout: 30_000 });
    const undrafted = await readouts(page);
    await plainEditGrowth(page, status, undo);

    await faces.getByRole("spinbutton", { name: "Face" }).fill("2");
    const draftPanel = faces.getByRole("group", { name: "Draft" });
    await draftPanel.getByLabel("Direction").selectOption("z");
    await draftPanel.getByLabel("Draft angle").fill("-5");
    await draftPanel.getByRole("button", { name: "Apply draft" }).click();
    await status.getByText("Face drafted. The draft stays with the sketch", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    // The draft grows one side. Recentring its stored geometry shifts the
    // shape origin by half that growth so the undrafted faces stay in place.
    const firstDraft = await readoutsWhen(page, (now) => !sameFootprint(now, undrafted), "the draft should change the part");
    assert.ok(!samePlace(firstDraft, undrafted), "draft growth should shift the recentered shape origin");
    assert.ok(placedByDraftGrowth(undrafted, firstDraft), `a fresh draft shifts by half its bounds growth: ${JSON.stringify([firstDraft, undrafted])}`);

    // A second draft would bake over the kept one, so it is refused.
    await faces.getByRole("spinbutton", { name: "Face" }).fill("3");
    await draftPanel.getByRole("button", { name: "Apply draft" }).click();
    await status.getByText("This shape already keeps a face draft.", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(sameFootprint(await readouts(page), firstDraft), "the refused draft must leave the part alone");

    // The draft is a feature the inspector can change, not baked geometry.
    const retained = page.getByRole("region", { name: "Face draft" });
    await retained.waitFor({ state: "visible", timeout: 10_000 });
    const retainedAngle = retained.getByRole("spinbutton", { name: "Draft angle" });
    assert.equal(await retainedAngle.inputValue(), "-5");
    assert.equal(await retained.getByLabel("Direction").inputValue(), "z");
    await retained.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/face-draft-retained.png" });

    await retainedAngle.fill("-8");
    await retained.getByLabel("Direction").selectOption("-z");
    await retained.getByRole("button", { name: "Update draft" }).click();
    await status.getByText("Face draft updated.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await retainedAngle.inputValue(), "-8");
    assert.equal(await retained.getByLabel("Direction").inputValue(), "-z");
    const updated = await readoutsWhen(page, (now) => !sameFootprint(now, firstDraft) && !sameFootprint(now, undrafted), "the update should redraft the part");
    assert.ok(placedByDraftGrowth(undrafted, updated), `an updated draft shifts by half its bounds growth: ${JSON.stringify([updated, undrafted])}`);

    // Undo walks back through the edit and then the draft itself.
    await undo.click();
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll("section")].find((section) => section.getAttribute("aria-label") === "Face draft");
      return card?.querySelector("input[type=number]")?.value === "-5";
    }, null, { timeout: 10_000 });
    assert.equal(await retained.getByLabel("Direction").inputValue(), "z");
    await readoutsWhen(page, (now) => sameFootprint(now, firstDraft) && samePlace(now, firstDraft), "undo should restore the first draft's solid");
    await undo.click();
    await retained.waitFor({ state: "detached", timeout: 10_000 });
    await faces.waitFor({ state: "visible" });
    await readoutsWhen(page, (now) => sameFootprint(now, undrafted) && samePlace(now, undrafted), "undo should restore the undrafted extrusion");
    await redo.click();
    await retained.waitFor({ state: "visible", timeout: 10_000 });
    await redo.click();
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll("section")].find((section) => section.getAttribute("aria-label") === "Face draft");
      return card?.querySelector("input[type=number]")?.value === "-8";
    }, null, { timeout: 10_000 });
    await readoutsWhen(page, (now) => sameFootprint(now, updated) && samePlace(now, updated), "redo should restore the updated solid");

    // Through .skf and back.
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("radio", { name: "SKF: Editable project" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save SketchForge Project" }).click();
    const download = await downloadPromise;
    const packagePath = path.join(tempDir, "retained-draft.skf");
    await download.saveAs(packagePath);

    await page.goto(baseURL);
    await page.getByRole("button", { name: "Open SKF or import geometry" }).click();
    await page.locator('input[type="file"][accept*=".skf"]').setInputFiles(packagePath);
    await page.getByRole("button", { name: "Sketch extrusion", exact: true }).click({ timeout: 120_000 });
    await retained.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await retainedAngle.inputValue(), "-8", "the draft angle should survive the .skf round trip");
    assert.equal(await retained.getByLabel("Direction").inputValue(), "-z");
    await readoutsWhen(page, (now) => sameFootprint(now, updated) && samePlace(now, updated), "the reopened project should hold the updated solid");

    // The same corner drag. The draft is replayed on the new outline, and the
    // part moves as the REST replay moves it.
    await editSketchCorner(page);
    await status.getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const replayed = await readoutsWhen(page, (now) => !sameFootprint(now, updated), "the sketch edit should rebuild the part");
    assert.ok(!samePlace(replayed, updated), "the corner drag should move the centre of the sketch's bounds");
    // Exact world placement is covered by the unit fixture, which compares
    // volume and centre of mass for both the editor and REST replay.
    await retained.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await retainedAngle.inputValue(), "-8", "the sketch edit should replay the retained draft");
    assert.equal(await retained.getByLabel("Direction").inputValue(), "-z");
    await retained.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/face-draft-retained-replayed.png" });
    await context.close();
  } finally {
    await browser?.close();
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a prism draft on a sketch extrusion is kept and replayed when the sketch is finished again", { timeout: 180_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const { server, logs } = startServer(port);
  let browser;

  try {
    await waitForServer(baseURL, server, logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });

    const status = page.getByRole("status");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const prism = page.getByRole("region", { name: "Draft prism" });
    await prism.waitFor({ state: "visible", timeout: 30_000 });
    const undrafted = await readouts(page);
    const plain = await plainEditGrowth(page, status, undo);

    const angle = prism.getByRole("spinbutton", { name: "Draft angle" });
    await angle.fill("-6");
    await prism.getByRole("button", { name: "Apply draft" }).click();
    await status.getByText("Draft applied. It stays with the sketch", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    await prism.getByRole("button", { name: "Update draft" }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await angle.inputValue(), "-6");
    const drafted = await readoutsWhen(page, (now) => !sameFootprint(now, undrafted), "the outward prism draft should grow the footprint");
    assert.ok(samePlace(drafted, undrafted), "a prism draft keeps the shape's position");

    await editSketchCorner(page);
    await status.getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await prism.getByRole("button", { name: "Update draft" }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await angle.inputValue(), "-6", "finishing the sketch should replay the prism draft");
    const replayed = await readoutsWhen(page, (now) => !sameFootprint(now, drafted), "the sketch edit should rebuild the prism");
    assert.ok(!samePlace(replayed, drafted), "the corner drag should move the centre of the profile's bounds");
    // Placed from the edited profile's bounds, not the old one's.
    assert.ok(placedByRestRule(drafted, replayed, plain.before, plain.after), `the prism replay is placed by the REST rule, on the edited profile: ${JSON.stringify([drafted, replayed, plain])}`);
    await undo.click();
    await readoutsWhen(page, (now) => sameFootprint(now, drafted) && samePlace(now, drafted), "undo should restore the drafted prism on the old profile");
  } finally {
    await browser?.close();
    await stopServer(server);
  }
});
