import { describe, expect, it } from "vitest";
import { apiProjectId } from "@constructorfleet/sketchforge-engine/apiErrors";
import { safeServerProjectId } from "@/lib/serverProjectStore";
import { HOSTED_PROJECT_ID } from "../../packages/sketchforge-client/mcp/hosted.mjs";

const samples = ["case", "a", "A1_b-2", "x".repeat(120), "x".repeat(121), "", "-a", "_a", "a.b", "a/b", "..", "a b", "ä", "project-0242cab3-c07e"];

describe("project id rule", () => {
  it("is one rule for REST, the server store and MCP local mode", () => {
    for (const id of [...samples, " case ", "\tcase"]) {
      expect(safeServerProjectId(id), JSON.stringify(id)).toBe(apiProjectId(id) ?? null);
    }
  });

  // hosted.mjs loads before the engine, so it keeps its own pattern; it does not trim.
  it("matches the /mcp endpoint's own pattern on untrimmed ids", () => {
    for (const id of samples) {
      expect(HOSTED_PROJECT_ID.test(id), JSON.stringify(id)).toBe(apiProjectId(id) !== undefined);
    }
  });
});
