import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("the published engine README explains installation, supported usage, scope, and links", async () => {
  const readme = await readFile(new URL("packages/sketchforge-engine/README.md", root), "utf8");
  for (const section of ["Installation", "Quick start", "Public API", "Limitations", "License"]) {
    assert.match(readme, new RegExp(`^## ${section}$`, "m"), `README should include ${section}`);
  }
  assert.match(readme, /npm install @constructorfleet\/sketchforge-engine/);
  assert.match(readme, /Node\.js 20 or newer/i);
  assert.match(readme, /typescript-engine/);
  assert.match(readme, /AGPL-3\.0-only/);
  assert.match(readme, /meshForShape/);
  assert.match(readme, /meshForShape.*dispatcher/i);

  const example = readme.match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, "README should include a runnable JavaScript example");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `${example}\nconsole.log(JSON.stringify({ kind: shape.kind, width: shape.width, depth: shape.depth, height: shape.height }));`], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").at(-1), JSON.stringify({ kind: "box", width: 20, depth: 10, height: 5 }));
});

test("the published engine package includes the declared AGPL license text", async () => {
  const [packageLicense, repositoryLicense] = await Promise.all([
    readFile(new URL("packages/sketchforge-engine/LICENSE", root), "utf8"),
    readFile(new URL("LICENSE", root), "utf8"),
  ]);
  assert.equal(packageLicense, repositoryLicense);
});

test("the generated engine API leads with the package guide and links API areas", async () => {
  const reference = await readFile(new URL("docs/reference/typescript-engine.md", root), "utf8");
  assert.match(reference, /^# Engine API/m);
  assert.ok(reference.indexOf("## Installation") < reference.indexOf("## Exported API"));
  assert.match(reference, /\.\.\/packages\/engine\.md/);
  assert.match(reference, /## Exported API/);
  assert.match(reference, /### Projects and engine operations/);
  assert.match(reference, /\[`createEngine`\]\(#createengine\)/);
});
