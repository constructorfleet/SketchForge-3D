import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

test("the locked Mermaid version satisfies the VitePress plugin peer range", async () => {
  const [manifest, lockfile] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  const mermaidVersion = lockfile.packages["node_modules/mermaid"].version;
  const peerRange = lockfile.packages["node_modules/vitepress-plugin-mermaid"].peerDependencies.mermaid;
  const allowedMajors = [...peerRange.matchAll(/(?:^|\s|\|)(\d+)(?=\s|\||$)/g)].map((match) => match[1]);

  assert.equal(manifest.devDependencies.mermaid.startsWith(`^${mermaidVersion.split(".")[0]}.`), true);
  assert.ok(
    allowedMajors.includes(mermaidVersion.split(".")[0]),
    `mermaid@${mermaidVersion} must satisfy vitepress-plugin-mermaid's mermaid peer range ${peerRange}`,
  );
});
