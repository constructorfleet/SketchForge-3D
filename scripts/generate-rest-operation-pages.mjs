import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output-dir");
const outputDirArg = outputIndex === -1 ? ".docs-site/docs/rest-api" : process.argv[outputIndex + 1];
if (!outputDirArg || outputDirArg.startsWith("--")) throw new Error("--output-dir requires a directory path");
const outputDir = path.resolve(root, outputDirArg);
const spec = JSON.parse(await readFile(path.join(root, "docs/openapi-v1.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const repositoryUrl = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
const repository = repositoryUrl.match(/(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
if (!repository) throw new Error("Cannot derive GitHub repository for REST source links");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const operations = Object.entries(spec.paths).flatMap(([route, methods]) => Object.entries(methods)
  .filter(([method]) => method !== "options")
  .map(([method, operation]) => ({ method: method.toUpperCase(), route, ...operation })))
  .sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));

if (operations.some(({ operationId }) => !operationId)) throw new Error("Every documented REST operation must have an operationId");
if (new Set(operations.map(({ operationId }) => operationId)).size !== operations.length) throw new Error("REST operation IDs must be unique");

function jsonBlock(value) {
  return ["```json", JSON.stringify(value, null, 2), "```"];
}

function routeSource(route) {
  const routePath = route.replace(/^\/api\/v1\/?/, "");
  return `apps/web/src/app/api/v1/${routePath ? `${routePath}/` : ""}route.ts`;
}

function parameterTable(parameters = []) {
  if (!parameters.length) return ["No parameters."];
  return [
    "| Name | In | Required | Schema | Description |",
    "| --- | --- | --- | --- | --- |",
    ...parameters.map(({ name, in: location, required, schema, description }) => [
      `| \`${name}\``, `\`${location}\``, required ? "Yes" : "No", `\`${escapeCell(JSON.stringify(schema ?? {}))}\``, escapeCell(description ?? "—") + " |",
    ].join(" | ")),
  ];
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function authentication(operation) {
  const schemes = [...new Set((operation.security ?? spec.security ?? []).flatMap((requirement) => Object.keys(requirement)))];
  if (!schemes.length) return ["No authentication required."];
  const descriptions = schemes.map((name) => {
    const scheme = spec.components?.securitySchemes?.[name];
    if (!scheme) return `- \`${name}\``;
    if (scheme.type === "http" && scheme.scheme === "bearer") return "- Bearer token (`Authorization: Bearer <token>`).";
    if (scheme.type === "apiKey") return `- API token in the \`${scheme.name}\` ${scheme.in}.`;
    return `- \`${name}\` (${scheme.type}).`;
  });
  return schemes.length > 1 ? ["Provide either authentication method:", "", ...descriptions] : descriptions;
}

function requestBodyBlock(requestBody) {
  if (!requestBody) return ["No request body."];
  const lines = [`${requestBody.required ? "Required" : "Optional"}.`];
  for (const [contentType, media] of Object.entries(requestBody.content ?? {})) {
    lines.push("", `### \`${contentType}\``, "", ...(media.schema ? jsonBlock(media.schema) : ["Schema not declared."]));
  }
  return lines;
}

function responseBlocks(responses = {}) {
  const lines = [];
  for (const [status, response] of Object.entries(responses)) {
    lines.push(`### ${status} — ${response.description ?? "Response"}`, "");
    if (response.headers && Object.keys(response.headers).length) {
      lines.push("Headers:", "", ...jsonBlock(response.headers), "");
    }
    for (const [contentType, media] of Object.entries(response.content ?? {})) {
      lines.push(`Content type: \`${contentType}\``, "");
      if (media.schema) lines.push(...jsonBlock(media.schema), "");
    }
  }
  return lines;
}

function operationMarkdown(operation) {
  const source = routeSource(operation.route);
  const sourceUrl = `https://github.com/${repository}/blob/${revision}/${source}`;
  const lines = [
    "---",
    `slug: /docs/rest-api/${operation.operationId}`,
    `title: ${operation.operationId} — ${operation.method} ${operation.route}`,
    "audience: API users",
    "owner: API",
    "---",
    "",
    `# \`${operation.method} ${operation.route}\``,
    "",
    `**operationId:** \`${operation.operationId}\``,
    "",
    operation.description ?? "This operation is described by the generated OpenAPI contract.",
    "",
    "## Authentication",
    "",
    ...authentication(operation),
    "",
    "## Parameters",
    "",
    ...parameterTable(operation.parameters),
    "",
    "## Request body",
    "",
    ...requestBodyBlock(operation.requestBody),
    "",
    "## Responses",
    "",
    ...responseBlocks(operation.responses),
    "",
    "## Source",
    "",
    `[Route handler source](${sourceUrl}) · [OpenAPI JSON](/openapi-v1.json) · [REST API guide](../REST_API.md)`,
    "",
    "---",
    "",
    `Documentation version: \`${packageMetadata.version}\` · Repository revision: [\`${revision}\`](https://github.com/${repository}/tree/${revision}) · [View source](${sourceUrl})`,
    "",
  ];
  return lines.join("\n");
}

const indexLines = [
  "---",
  "slug: /docs/rest-api/",
  "title: REST API operations",
  "audience: API users",
  "owner: API",
  "---",
  "",
  "# REST API operations",
  "",
  `Generated from [the OpenAPI contract](/openapi-v1.json) at revision [\`${revision}\`](https://github.com/${repository}/tree/${revision}). Browse all ${operations.length} contracted operations below.`,
  "",
  "For request concepts and endpoint workflows, see the [REST API guide](../REST_API.md).",
  "",
  "| Method | Path | Operation |",
  "| --- | --- | --- |",
  ...operations.map((operation) => `| \`${operation.method}\` | \`${operation.route}\` | [\`${operation.operationId}\`](./${operation.operationId}.md) |`),
  "",
  "---",
  "",
  `Documentation version: \`${packageMetadata.version}\` · Repository revision: [\`${revision}\`](https://github.com/${repository}/tree/${revision}) · [View source](https://github.com/${repository}/blob/${revision}/scripts/generate-rest-operation-pages.mjs)`,
  "",
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "index.md"), indexLines.join("\n"));
for (const operation of operations) {
  await writeFile(path.join(outputDir, `${operation.operationId}.md`), operationMarkdown(operation));
}
console.log(`Generated ${operations.length} REST operation pages in ${path.relative(root, outputDir)}`);
