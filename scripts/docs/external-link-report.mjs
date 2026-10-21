import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 20;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_LINKS = 2_000;

export async function generateExternalLinkReport({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  reportPath,
  fetchImpl = fetch,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxLinks = DEFAULT_MAX_LINKS,
} = {}) {
  const markdownFiles = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const links = new Set();

  for (const relativePath of markdownFiles) {
    const contents = await readFile(path.join(root, relativePath), "utf8");
    for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      addExternalUrl(links, match[1]);
    }
    for (const match of contents.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
      addExternalUrl(links, match[1]);
    }
  }

  const allUrls = [...links].sort();
  const urls = allUrls.slice(0, boundedInteger(maxLinks, DEFAULT_MAX_LINKS, 1, 10_000));
  const results = new Array(urls.length);
  const workerCount = Math.min(urls.length, boundedInteger(concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY));
  let next = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < urls.length) {
      const index = next++;
      results[index] = await checkUrl(urls[index], fetchImpl, boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 100, 60_000));
    }
  }));

  const report = {
    schemaVersion: 1,
    discovered: allUrls.length,
    checked: urls.length,
    truncated: allUrls.length > urls.length,
    failures: results.filter((result) => result.failure).map(({ url, status, error }) => ({ url, status, error })),
  };

  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const markdownPath = reportPath.toLowerCase().endsWith(".json") ? reportPath.replace(/\.json$/i, ".md") : `${reportPath}.md`;
    await writeFile(markdownPath, renderMarkdownReport(report));
  }
  return report;
}

function addExternalUrl(links, rawHref) {
  const href = rawHref.replace(/^<|>$/g, "").replace(/[.,;:!?]+$/g, "");
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") links.add(url.href);
  } catch {
    // Non-URL Markdown destinations are handled by the required local-link check.
  }
}

async function checkUrl(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => {});
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
    }
    return response.ok
      ? { url, status: response.status, failure: false }
      : { url, status: response.status, failure: true, error: `HTTP ${response.status}` };
  } catch (error) {
    return { url, status: null, failure: true, error: error?.name === "AbortError" ? `Timed out after ${timeoutMs} ms` : String(error?.message ?? error) };
  } finally {
    clearTimeout(timeout);
  }
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function renderMarkdownReport(report) {
  const lines = [
    "# External documentation link report",
    "",
    `Checked ${report.checked} of ${report.discovered} unique external links.`,
    report.truncated ? `The report was capped; ${report.discovered - report.checked} links were not checked.` : "The report includes every discovered link.",
    "",
  ];
  if (!report.failures.length) {
    lines.push("No external link failures were observed.");
  } else {
    lines.push(`Found ${report.failures.length} external link failure(s):`, "");
    for (const failure of report.failures) lines.push(`- [${failure.url}](${failure.url}) — ${failure.error}`);
  }
  lines.push("", "External failures are advisory; required local link checks remain blocking.", "");
  return lines.join("\n");
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--root" || name === "--report") {
      const value = args[++index];
      if (!value) throw new Error(`${name} requires a value`);
      options[name === "--root" ? "root" : "reportPath"] = value;
    } else {
      throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await generateExternalLinkReport(parseArguments(process.argv.slice(2)));
    console.log(`External links: checked ${report.checked}/${report.discovered}; failures: ${report.failures.length}${report.truncated ? " (capped)" : ""}.`);
  } catch (error) {
    console.error(`Unable to produce external-link report: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
