import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const guide = new URL("../../docs/guides/edit-and-export-model.md", import.meta.url);
const home = new URL("../../docs/index.md", import.meta.url);
const quickstart = new URL("../../docs/guides/editor-quickstart.md", import.meta.url);
const browserTest = new URL("../browser/editor-quickstart.test.mjs", import.meta.url);
const siteConfig = new URL("../../docs/.vitepress/config.mts", import.meta.url);
const faceDraftGuide = new URL("../../docs/guides/face-drafting.md", import.meta.url);
const faceDraftBrowserTest = new URL("../browser/face-drafting.test.mjs", import.meta.url);
const sketchConstraintsGuide = new URL("../../docs/guides/sketch-constraints.md", import.meta.url);
const sketchConstraintsBrowserTest = new URL("../browser/sketch-parallel-constraint.test.mjs", import.meta.url);
const stepAssemblyGuide = new URL("../../docs/guides/step-assemblies.md", import.meta.url);
const sketchSweepGuide = new URL("../../docs/guides/sketch-sweeps.md", import.meta.url);
const sketchSweepBrowserTest = new URL("../browser/sketch-sweep-ux.test.mjs", import.meta.url);

test("editor workflow guide covers create, edit, save, and export with supporting references", async () => {
  const [guideText, homeText, quickstartText, browserTestText, siteConfigText] = await Promise.all([
    readFile(guide, "utf8"),
    readFile(home, "utf8"),
    readFile(quickstart, "utf8"),
    readFile(browserTest, "utf8"),
    readFile(siteConfig, "utf8"),
  ]);

  for (const step of [
    "## 1. Create a project and the first solid",
    "## 2. Edit the sketch to add a circular feature",
    "## 3. Save and confirm the edit",
    "## 4. Export a portable editable project",
  ]) {
    assert.ok(guideText.includes(step), `guide should include the ${step.replace(/^## \d\. /, "").toLowerCase()} task`);
  }
  assert.match(guideText, /parametric-extrusion-rebuilt-solid\.png/);
  assert.match(guideText, /editor-quickstart-export\.png/);
  assert.match(guideText, /editor-quickstart\.md/);
  assert.match(guideText, /SKF_PROJECT_FORMAT\.md/);
  assert.match(homeText, /edit-and-export-model\.md/);
  assert.match(quickstartText, /edit-and-export-model\.md/);
  assert.match(siteConfigText, /\/docs\/guides\/edit-and-export-model/);
  assert.match(browserTestText, /getByRole\("menuitem", \{ name: "Circle" \}\)/);
  assert.match(browserTestText, /the added circle should remain after reloading/);
  assert.match(browserTestText, /Save SketchForge Project/);
});

test("editor quickstart documents discoverable keyboard shortcuts with screenshot evidence", async () => {
  const quickstartText = await readFile(quickstart, "utf8");
  assert.match(quickstartText, /## Keyboard shortcuts/);
  assert.match(quickstartText, /\*\*Shift\+L\*\*/);
  assert.match(quickstartText, /\*\*Shift\+H\*\*/);
  assert.match(quickstartText, /\*\*Alt\+Shift\+H\*\*/);
  assert.match(quickstartText, /editor-keyboard-shortcuts\.png/);
});

test("face drafting guide links a supported editor workflow to browser acceptance and screenshot evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(faceDraftGuide, "utf8"),
    readFile(faceDraftBrowserTest, "utf8"),
  ]);

  assert.match(guideText, /\*\*Faces\*\*/);
  assert.match(guideText, /Enable face editing/);
  assert.match(guideText, /face-draft-browser\.png/);
  assert.match(guideText, /face-tools\.png/);
  assert.match(guideText, /face-drafting\.test\.mjs/);
  assert.match(guideText, /face-tools\.test\.mjs/);
  assert.doesNotMatch(guideText, /CAD face index/);
  // Faces are picked in the view; the stepper is the keyboard fallback.
  assert.match(guideText, /click(?:ing)? (?:a|the|that) face in the view/i);
  assert.match(guideText, /keyboard/i);
  assert.match(guideText, /Face ID/);
  assert.match(guideText, /face-picking\.png/);
  assert.match(browserTestText, /getByRole\("region", \{ name: "Faces" \}\)/);
  assert.match(browserTestText, /Apply draft/);
  assert.match(browserTestText, /Face drafted\./);
  assert.match(browserTestText, /face-draft-browser\.png/);
  // The kept draft (#384) is documented with the browser flow that proves it.
  assert.match(guideText, /Face draft/);
  assert.match(guideText, /face-draft-retained\.png/);
  assert.match(browserTestText, /region", \{ name: "Face draft" \}/);
  assert.match(browserTestText, /Save SketchForge Project/);
  assert.match(browserTestText, /face-draft-retained\.png/);
});

test("the perpendicular constraint workflow has browser acceptance and screenshot evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(sketchConstraintsGuide, "utf8"),
    readFile(sketchConstraintsBrowserTest, "utf8"),
  ]);

  assert.match(guideText, /Perpendicular/);
  assert.match(guideText, /90(?:°| degrees?)/i);
  assert.match(guideText, /sketch-perpendicular-constraint\.png/);
  assert.match(browserTestText, /a user can constrain two selected sketch segments to be perpendicular/i);
  assert.match(browserTestText, /sketch-perpendicular-constraint\.png/);
});

test("the sketch sweep workflow has a guide, browser acceptance, and screenshot evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(sketchSweepGuide, "utf8"),
    readFile(sketchSweepBrowserTest, "utf8"),
  ]);

  assert.match(guideText, /\*\*Start\*\*/);
  assert.match(guideText, /\*\*3D preview\*\*/);
  assert.match(guideText, /\*\*Centre section\*\*/);
  assert.match(guideText, /sketch-sweep-ux\.png/);
  assert.match(browserTestText, /data-sweep-status/);
  assert.match(browserTestText, /Sweep 3D preview/);
  assert.match(browserTestText, /sketch-sweep-ux\.png/);
});

test("STEP assembly guide links the editor-to-local-MCP workflow to browser acceptance and screenshot evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(stepAssemblyGuide, "utf8"),
    readFile(browserTest, "utf8"),
  ]);

  assert.match(guideText, /step-assembly-editor-import\.png/);
  assert.match(guideText, /editor-quickstart\.test\.mjs/);
  assert.match(browserTestText, /a STEP assembly exported from the editor can be imported and exploded through local MCP/i);
  assert.match(browserTestText, /setInputFiles\(fixturePath\)/);
  assert.match(browserTestText, /download\.saveAs\(packagePath\)/);
  assert.match(browserTestText, /sketchforge_import_project/);
  assert.match(browserTestText, /sketchforge_explode_step_assembly/);
  assert.match(browserTestText, /step-assembly-editor-import\.png/);
});

test("STEP assembly guide documents exploding from the shape inspector with browser evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(stepAssemblyGuide, "utf8"),
    readFile(browserTest, "utf8"),
  ]);

  assert.match(guideText, /\*\*Explode Assembly\*\*/);
  assert.match(guideText, /one undo step/i);
  assert.match(guideText, /flat[\s\S]{0,80}solids[\s\S]{0,200}notice/i);
  assert.match(guideText, /step-assembly-editor-exploded\.png/);
  assert.match(browserTestText, /explodes into nested groups from the shape inspector/);
  assert.match(browserTestText, /step-assembly-editor-exploded\.png/);
});
