import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no type declarations, checked here rather than duplicated.
import { checkTitle } from "../../scripts/check-conventional-title.mjs";

const check = checkTitle as (title: string, types?: string[]) => { ok: boolean; reason?: string; type?: string; breaking?: boolean };

describe("pull request titles", () => {
  it("accepts the shapes this project actually uses", () => {
    for (const title of [
      "feat: a catalog of standard screw threads",
      "fix: make a release actually publish anything",
      "chore: clear every critical and high security advisory",
      "refactor: share the project directory helpers",
      "test: give the CAD suites a budget the kernel can meet",
      "feat(api): boolean cut over REST",
      "fix!: drop the legacy project format",
    ]) {
      expect(check(title), title).toMatchObject({ ok: true });
    }
  });

  it("reads a breaking change, which is what makes a release major", () => {
    expect(check("feat!: rename every endpoint")).toMatchObject({ ok: true, breaking: true });
    expect(check("feat: rename every endpoint")).toMatchObject({ ok: true, breaking: false });
  });

  it("refuses a title that would silently not count", () => {
    // Each of these parses as prose and releases nothing.
    for (const title of [
      "Repeat a selection in a row or around a ring",
      "Fixed the dashboard emptying itself",
      "updates",
      "",
      "   ",
    ]) {
      expect(check(title).ok, title).toBe(false);
    }
  });

  it("refuses a type nothing releases on", () => {
    // Upstream writes "release:" subjects; release-please ignores them, so a
    // pull request titled that way would contribute nothing.
    const result = check("release: SketchForge 1.2.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a type this project releases on");
  });

  it("insists on a lower-case type and a description", () => {
    expect(check("Feat: a catalog").reason).toContain("lower case");
    expect(check("feat:").ok).toBe(false);
    expect(check("feat:    ").ok).toBe(false);
  });

  it("takes its allowed types from the caller, so it cannot drift from the release config", () => {
    expect(check("spike: try something", ["spike"])).toMatchObject({ ok: true });
    expect(check("feat: a thing", ["spike"]).ok).toBe(false);
  });
});
