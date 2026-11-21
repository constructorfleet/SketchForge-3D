import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("published .skf format reference", () => {
  it("matches the engine contract and documented compatibility behavior", () => {
    execFileSync(process.execPath, ["scripts/generate-skf-format-reference.mjs", "--check"], { cwd: root });

    const reference = readFileSync(path.join(root, "docs", "SKF_FORMAT_REFERENCE.md"), "utf8");
    expect(reference).toMatch(/Newest format read and written\s*\|\s*4/);
    expect(reference).toMatch(/Format written when the project has configurations\s*\|\s*4/);
    expect(reference).toMatch(/Format written when the project has parameters\s*\|\s*3/);
    expect(reference).toMatch(/Format written for other projects\s*\|\s*2/);
    expect(reference).toContain("### `SkfParameterV3`");
    expect(reference).toContain("`parameters?` | `SkfParameterV3[]`");
    expect(reference).toContain("### `SkfConfigurationV4`");
    expect(reference).toContain("`configurations?` | `SkfConfigurationV4[]`");
    expect(reference).toContain("`activeConfiguration?` | `string`");
    expect(reference).toContain("`sceneStateId`");
    expect(reference).toContain("projectName: string");
    expect(reference).toContain("`cadDisplayEdgesAssetId?`");
    expect(reference).toContain("V1 packaged projects");
    expect(reference).toContain("V0 legacy JSON");
  });
});
