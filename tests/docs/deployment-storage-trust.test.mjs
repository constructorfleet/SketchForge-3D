import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guide = await readFile(path.join(root, "docs/guides/deployment.md"), "utf8");

test("deployment guide states the trust model for server-backed project routes", () => {
  assert.match(guide, /## Who can do what/);
  assert.match(guide, /GET \/api\/projects.*(?:unauthenticated|without authentication)/is);
  assert.match(guide, /They accept requests with no `Origin` header/i);
  assert.match(guide, /same-origin.*(?:not authentication|does not authenticate)/is);
  assert.match(guide, /`SKETCHFORGE_API_TOKEN`.*`\/api\/v1`.*(?:does not|doesn't).*(?:protect|gate|cover).*`\/api\/(?:projects|shared-projects)`/is);
  assert.match(guide, /GET `?\/api\/shared-projects`?.*(?:unauthenticated|without authentication)/is);
  assert.match(guide, /reverse proxy.*(?:authenticate|authentication)/is);
  assert.match(guide, /application port inaccessible.*bypass the proxy/is);
});
