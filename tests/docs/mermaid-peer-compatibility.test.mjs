import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

test("the Mermaid 12 peer-range exception is explicit and covered by renderer tests", async () => {
  const [manifest, lockfile, npmConfig, rendererTests, siteBuildTests, dockerfile] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, ".npmrc"), "utf8"),
    readFile(path.join(root, "tests/docs/mermaid-rendering.test.mjs"), "utf8"),
    readFile(path.join(root, "tests/docs/site-build.test.mjs"), "utf8"),
    readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8"),
  ]);
  const mermaidVersion = lockfile.packages["node_modules/mermaid"].version;
  const peerRange = lockfile.packages["node_modules/vitepress-plugin-mermaid"].peerDependencies.mermaid;
  const allowedMajors = [...peerRange.matchAll(/(?:^|\s|\|)(\d+)(?=\s|\||$)/g)].map((match) => match[1]);

  assert.equal(manifest.devDependencies.mermaid.startsWith(`^${mermaidVersion.split(".")[0]}.`), true);
  assert.equal(mermaidVersion, "12.2.0");
  assert.deepEqual(allowedMajors, ["10", "11"]);
  assert.match(npmConfig, /^legacy-peer-deps=true$/m);
  assert.match(rendererTests, /mermaid fence becomes a rendered diagram/);
  assert.match(siteBuildTests, /mermaid diagram on a built page renders/);
  assert.match(dockerfile, /COPY \.npmrc package\.json package-lock\.json \.\//);
});
