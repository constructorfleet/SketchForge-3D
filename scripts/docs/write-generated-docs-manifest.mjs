import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GENERATED_DOC_PATHS } from "./validate-generated-docs-artifact.mjs";

const [eventPath, outputDirectory] = process.argv.slice(2);
if (!eventPath || !outputDirectory) throw new Error("Usage: node write-generated-docs-manifest.mjs EVENT_PATH OUTPUT_DIRECTORY");
const event = JSON.parse(await readFile(eventPath, "utf8"));
if (event.repository?.full_name !== process.env.GITHUB_REPOSITORY || !event.pull_request?.number) {
  throw new Error("Expected a pull_request workflow event for the current repository");
}
await mkdir(outputDirectory, { recursive: true });
for (const relative of GENERATED_DOC_PATHS) {
  const target = path.join(outputDirectory, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.resolve(relative), target);
}
await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify({
  repo: event.repository.full_name,
  pullRequest: event.pull_request.number,
  headSha: event.pull_request.head.sha,
  baseSha: event.pull_request.base.sha,
  files: GENERATED_DOC_PATHS,
}, null, 2)}\n`);
