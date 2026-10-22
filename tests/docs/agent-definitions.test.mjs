import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const agentsDir = path.join(root, ".claude/agents");
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;

const agents = () =>
  readdirSync(agentsDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => ({ file: entry, body: readFileSync(path.join(agentsDir, entry), "utf8") }));

const frontmatter = (body) => {
  const match = body.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "an agent definition needs YAML frontmatter");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => /^\w[\w-]*:/.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
};

test("the repository defines its own implementation and gate agents", () => {
  assert.ok(existsSync(agentsDir), ".claude/agents should hold the repository's agent definitions");
  const names = agents().map((agent) => frontmatter(agent.body).name);
  for (const required of ["implementer", "quality-gates", "change-reviewer"]) {
    assert.ok(names.includes(required), `missing agent definition: ${required}`);
  }
});

test("each agent definition is addressable and describes when to use it", () => {
  for (const { file, body } of agents()) {
    const meta = frontmatter(body);
    assert.equal(meta.name, path.basename(file, ".md"), `${file}: name must match the filename`);
    assert.ok((meta.description ?? "").length > 40, `${file}: description should say when to reach for this agent`);
  }
});

test("every npm script an agent names still exists", () => {
  for (const { file, body } of agents()) {
    for (const [, script] of body.matchAll(/npm run ([a-z][\w:]*)/g)) {
      assert.ok(scripts[script], `${file} names \`npm run ${script}\`, which package.json no longer defines`);
    }
  }
});

const trackedPaths = () => {
  // Tracked rather than merely present on disk: generated directories exist in a
  // working tree that has run the generators and are absent from a fresh clone,
  // so an existence check passes locally and fails in CI.
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  return (cited) => tracked.some((entry) => entry === cited || entry.startsWith(cited.endsWith("/") ? cited : `${cited}/`));
};

// `.claude/` is deliberately out of scope: `.claude/worktrees/` is a runtime
// directory that is never tracked, and quality-gates.md cites it as a hazard.
const citedPaths = (body) =>
  [...body.matchAll(/`((?:docs|apps|packages|tests|scripts|\.github)\/[\w./-]+)`/g)]
    .map(([, cited]) => cited)
    .filter((cited) => !cited.includes("*"));

test("every repository path an agent cites is tracked, not generated output", () => {
  const isTracked = trackedPaths();
  for (const { file, body } of agents()) {
    for (const cited of citedPaths(body)) {
      assert.ok(isTracked(cited), `${file} cites ${cited}, which is not tracked in git -- a generated path is absent from a fresh checkout`);
    }
  }
});

// Paths AGENTS.md names as conventions created on demand rather than as files
// that should already be there. `docs/agents/domain.md` states that the
// domain-modeling skill writes these lazily and that their absence is not a
// defect, so requiring them would contradict the instruction they appear in.
const lazilyCreated = new Set(["docs/adr/"]);

test("every repository path AGENTS.md cites is tracked, not generated output", () => {
  // AGENTS.md points agents at the skill documents it expects to exist. A
  // citation added alongside files that were never committed reads as a working
  // instruction and resolves to nothing in a fresh clone.
  const isTracked = trackedPaths();
  for (const cited of citedPaths(readFileSync(path.join(root, "AGENTS.md"), "utf8"))) {
    if (lazilyCreated.has(cited)) continue;
    assert.ok(isTracked(cited), `AGENTS.md cites ${cited}, which is not tracked in git -- it is absent from a fresh checkout`);
  }
});
