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

test("face drafting guide links a supported editor workflow to browser acceptance and screenshot evidence", async () => {
  const [guideText, browserTestText] = await Promise.all([
    readFile(faceDraftGuide, "utf8"),
    readFile(faceDraftBrowserTest, "utf8"),
  ]);

  assert.match(guideText, /Draft face/);
  assert.match(guideText, /face-draft-browser\.png/);
  assert.match(guideText, /face-drafting\.test\.mjs/);
  assert.match(browserTestText, /getByRole\("region", \{ name: "Draft face" \}\)/);
  assert.match(browserTestText, /Apply face draft/);
  assert.match(browserTestText, /Face draft applied/);
  assert.match(browserTestText, /face-draft-browser\.png/);
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
