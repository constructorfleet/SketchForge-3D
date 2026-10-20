import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("the extracted engine package", () => {
  it("exposes a Node entry point and does not resolve through the web app", async () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", "import('@sketchforge/engine').then(engine => console.log(JSON.stringify({ createEngine: typeof engine.createEngine, directoryProjectStore: typeof engine.directoryProjectStore, importSkfProject: typeof engine.importSkfProject })))"], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ createEngine: "function", directoryProjectStore: "function", importSkfProject: "function" });
  });
});
