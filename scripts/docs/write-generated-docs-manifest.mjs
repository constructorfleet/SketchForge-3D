import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GENERATED_DOC_PATHS } from "./validate-generated-docs-artifact.mjs";

const [eventPath, outputDirectory] = process.argv.slice(2);
if (!eventPath || !outputDirectory) throw new Error("Usage: node write-generated-docs-manifest.mjs EVENT_PATH OUTPUT_DIRECTORY");
const event = JSON.parse(await readFile(eventPath, "utf8"));
if (event.repository?.full_name !== process.env.GITHUB_REPOSITORY) throw new Error("Event repository does not match the current repository");
const pullRequestEvent = process.env.GITHUB_EVENT_NAME === "pull_request" && event.pull_request?.number;
const mainPushEvent = process.env.GITHUB_EVENT_NAME === "push"
  && event.ref === `refs/heads/${process.env.GITHUB_DEFAULT_BRANCH}`
  && /^[a-f0-9]{40}$/.test(event.after ?? "");
if (!pullRequestEvent && !mainPushEvent) throw new Error("Expected a pull_request or default-branch push event");
await mkdir(outputDirectory, { recursive: true });
for (const relative of GENERATED_DOC_PATHS) {
  const target = path.join(outputDirectory, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.resolve(relative), target);
}
await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify({
  repo: event.repository.full_name,
  ...(pullRequestEvent ? {
    event: "pull_request",
    pullRequest: event.pull_request.number,
    headSha: event.pull_request.head.sha,
    baseSha: event.pull_request.base.sha,
  } : {
    event: "push",
    ref: event.ref,
    headSha: event.after,
  }),
  files: GENERATED_DOC_PATHS,
}, null, 2)}\n`);
