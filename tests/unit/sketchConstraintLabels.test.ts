import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(path.resolve(__dirname, "../../apps/web/src/components/SketchWorkspace.tsx"), "utf8");

describe("sketch constraint labels", () => {
  it("names a removed constraint in the interface language, not by its raw kind id", () => {
    expect(workspace).not.toContain('t("editor.sketch.constraints.remove", { kind: constraint.kind })');
    expect(workspace).toContain('t("editor.sketch.constraints.remove", { kind: t(`editor.sketch.constraints.kinds.${constraint.kind}`) })');
  });
});
