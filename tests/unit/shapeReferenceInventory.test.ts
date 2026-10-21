import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";


describe("shape reference inventory", () => {
  it("matches the engine's requestable kinds and supported parameters", () => {
    const result = spawnSync(process.execPath, ["scripts/generate-shape-reference.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
