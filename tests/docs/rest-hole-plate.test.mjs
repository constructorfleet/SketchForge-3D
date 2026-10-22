import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

test("REST hole-plate walkthrough is sourced from the API integration example", () => {
  const restApi = read("docs/REST_API.md");
  const integrationTest = read("packages/sketchforge-client/tests/rest-hole-plate.integration.ts");
  const fixture = read("docs/examples/rest-hole-plate.mjs");
  const packageJson = JSON.parse(read("package.json"));
  const ciWorkflow = read(".github/workflows/ci.yml");
  const sectionStart = restApi.indexOf("## Example: a plate with a row of holes");
  const nextSection = restApi.indexOf("## Combining shapes: cut, group, separate", sectionStart);
  assert.notEqual(sectionStart, -1, "REST guide should retain the hole-plate walkthrough");
  assert.notEqual(nextSection, -1, "the following route-alternatives section should remain separate");
  const exampleSection = restApi.slice(sectionStart, nextSection);

  assert.match(exampleSection, /runnable-source: docs\/examples\/rest-hole-plate\.mjs; tested-by: packages\/sketchforge-client\/tests\/rest-hole-plate\.integration\.ts; ci: npm run test:integration/);
  assert.match(exampleSection, /```js\s*\n!!!include\(\.\/examples\/rest-hole-plate\.mjs\)!!!\s*\n```/);
  assert.doesNotMatch(exampleSection, /runnable-exempt:/);
  assert.match(integrationTest, /rest-hole-plate\.mjs/);
  assert.match(integrationTest, /expect\(result\.createdShapeCount\)\.toBe\(6\)/);
  assert.match(integrationTest, /expect\(result\.resultingShapeCount\)\.toBe\(1\)/);
  assert.match(integrationTest, /expect\(result\.cutVolume\)\.toBeLessThan\(result\.plateVolume\)/);
  assert.match(fixture, /SKETCHFORGE_API_TOKEN/);
  assert.match(fixture, /finally[\s\S]*DELETE/);
  const acceptanceCriteria = read("docs/DOCUMENTATION_SUITE_SPEC.md");
  assert.match(acceptanceCriteria, /7\. \*\*Partial:\*\*[\s\S]*?Changed-source diagnostics[\s\S]*?`docs\/examples\/rest-hole-plate\.mjs`/);
  assert.match(acceptanceCriteria, /10\. \*\*Partial:\*\*[\s\S]*?Changed-source diagnostics map file paths[\s\S]*?`docs\/examples\/rest-hole-plate\.mjs`/);
  assert.match(packageJson.scripts["docs:verify"], /tests\/docs\/rest-hole-plate\.test\.mjs/);
  assert.match(ciWorkflow, /run: npm run test:integration/);
});

test("REST hole-plate walkthrough deletes its project when a post-creation step fails", async () => {
  const { runHolePlateWalkthrough } = await import("../../docs/examples/rest-hole-plate.mjs");
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    requests.push({ path: `${parsedUrl.pathname}${parsedUrl.search}`, method: options.method });
    if (options.method === "DELETE") return response(200, { deleted: true });
    if (parsedUrl.pathname.endsWith("/projects")) {
      return response(201, { project: { id: "temporary-project" } });
    }
    return response(500, { error: "injected shape creation failure" });
  };

  await assert.rejects(
    runHolePlateWalkthrough({ baseUrl: "http://127.0.0.1:3000", token: "test-token", fetchImpl }),
    /POST \/shapes\?projectId=temporary-project returned 500/,
  );
  assert.deepEqual(requests, [
    { path: "/api/v1/projects", method: "POST" },
    { path: "/api/v1/shapes?projectId=temporary-project", method: "POST" },
    { path: "/api/v1/projects?projectId=temporary-project", method: "DELETE" },
  ]);
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("REST hole-plate walkthrough refuses non-local servers", async () => {
  const { runHolePlateWalkthrough } = await import("../../docs/examples/rest-hole-plate.mjs");
  await assert.rejects(
    runHolePlateWalkthrough({ baseUrl: "https://example.invalid", token: "test-token", fetchImpl: async () => { throw new Error("network should not be used"); } }),
    /localhost/i,
  );
});
