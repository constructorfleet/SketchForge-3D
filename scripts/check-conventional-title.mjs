#!/usr/bin/env node
/**
 * Check a pull request title is a conventional commit.
 *
 * This is load-bearing rather than tidiness. The repository squash-merges with
 * the title as the commit subject, and release-please reads those subjects to
 * decide the next version: a `feat:` means a minor bump, a `fix:` a patch.
 * A title it cannot parse is not an error anywhere -- the commit simply does
 * not count, and a release quietly ships without it, or no release is offered
 * at all. That is a failure nobody notices until a version is missing.
 *
 * The allowed types come from release-please's own configuration, so this
 * cannot drift from what actually produces a release.
 */

import { readFileSync } from "node:fs";

/** Types release-please understands out of the box, beyond the configured sections. */
const BUILT_IN_TYPES = ["feat", "fix", "perf", "docs", "chore", "refactor", "test", "build", "ci", "style", "revert"];

function allowedTypes(configPath = "release-please-config.json") {
  const configured = [];
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const section of config["changelog-sections"] ?? []) {
      if (section.type) configured.push(section.type);
    }
  } catch {
    // No config, or an unreadable one: the built-in set is still right, and a
    // title check is not the place to fail a release-please misconfiguration.
  }
  return [...new Set([...configured, ...BUILT_IN_TYPES])].sort();
}

/**
 * A conventional commit subject.
 *
 * Deliberately not the full grammar: a scope is optional, `!` marks a breaking
 * change, and the description must be non-empty. Anything stricter -- a length
 * cap, a mood rule -- would reject titles that release-please is perfectly
 * happy with, and the point is to match what releases, not to have opinions.
 */
export function checkTitle(title, types = allowedTypes()) {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return { ok: false, reason: "The title is empty." };

  const match = /^(?<type>[a-zA-Z]+)(?<scope>\([^)]*\))?(?<breaking>!)?:\s*(?<description>.+)$/s.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      reason: "The title is not a conventional commit: it needs a type, a colon and a description, as in \"fix: stop the dashboard emptying itself\".",
    };
  }

  const { type, description } = match.groups;
  if (type !== type.toLowerCase()) {
    return { ok: false, reason: `The type must be lower case: "${type}" should be "${type.toLowerCase()}".` };
  }
  if (!types.includes(type)) {
    return { ok: false, reason: `"${type}" is not a type this project releases on. Use one of: ${types.join(", ")}.` };
  }
  if (!description.trim()) {
    return { ok: false, reason: "The title has a type but no description." };
  }
  return { ok: true, type, breaking: Boolean(match.groups.breaking) };
}

// `node scripts/check-conventional-title.mjs "<title>"`, or from PR_TITLE.
if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.argv[2] ?? process.env.PR_TITLE ?? "";
  const result = checkTitle(title);
  if (result.ok) {
    const note = result.breaking ? " (a breaking change, so the next release is a major)" : "";
    console.log(`"${title}" is a ${result.type}${note}.`);
    process.exit(0);
  }
  console.error(`::error title=Pull request title::${result.reason}`);
  console.error("");
  console.error(`Got: ${title}`);
  console.error("");
  console.error("The title becomes the commit subject when this is squash-merged, and release-please");
  console.error("reads it to work out the next version. A title it cannot parse does not fail anything:");
  console.error("the change simply does not count towards a release.");
  process.exit(1);
}
