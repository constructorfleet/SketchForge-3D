import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - the MCP bridge and its helpers are plain ESM scripts with no types.
import { MACRO_DIR_ENV, listMacros, runMacroByName } from "../../packages/sketchforge-client/mcp/macroTools.mjs";

let macroDirectory = "";
let outsideDirectory = "";

type SpawnCall = { command: string; args: string[]; options: { cwd?: string; env?: Record<string, string> } };

/**
 * A child process that reports a run without starting one, so the test covers
 * which file would be run rather than whether Node can run it.
 */
function fakeSpawn(calls: SpawnCall[], stdout = '{"shapeCount":3}', code = 0) {
  return (command: string, args: string[], options: SpawnCall["options"]) => {
    calls.push({ command, args, options });
    const handlers: Record<string, Array<(value: unknown) => void>> = {};
    const stream = {
      on(event: string, handler: (value: unknown) => void) {
        if (event === "data") handler(stdout);
      },
    };
    setTimeout(() => (handlers.close ?? []).forEach((handler) => handler(code)), 1);
    return {
      stdout: stream,
      stderr: { on: () => undefined },
      kill: () => undefined,
      on(event: string, handler: (value: unknown) => void) {
        handlers[event] = [...(handlers[event] ?? []), handler];
      },
    };
  };
}

beforeEach(async () => {
  macroDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-macros-"));
  outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-outside-"));
  await fs.writeFile(path.join(macroDirectory, "plate.mjs"), "export default { name: 'x', project: 'fresh', run: () => {} };\n");
  await fs.writeFile(path.join(macroDirectory, "flange.py"), "MACRO = None\n");
  await fs.writeFile(path.join(macroDirectory, "notes.txt"), "not a macro\n");
  await fs.writeFile(path.join(outsideDirectory, "secret.mjs"), "export default () => {};\n");
});

afterEach(async () => {
  await fs.rm(macroDirectory, { recursive: true, force: true });
  await fs.rm(outsideDirectory, { recursive: true, force: true });
});

describe("macro listing", () => {
  it("refuses to list anything until an operator configures a directory", async () => {
    await expect(listMacros({})).rejects.toThrow(/SKETCHFORGE_MACRO_DIR/);
  });

  it("lists only files a runner can run", async () => {
    const listing = await listMacros({ [MACRO_DIR_ENV]: macroDirectory });
    expect(listing.macros.map((macro: { name: string }) => macro.name)).toEqual(["flange.py", "plate.mjs"]);
  });

  it("says which runner each macro needs", async () => {
    const listing = await listMacros({ [MACRO_DIR_ENV]: macroDirectory });
    expect(listing.macros.map((macro: { language: string }) => macro.language)).toEqual(["python", "javascript"]);
  });
});

describe("running a macro by name", () => {
  const environment = () => ({ [MACRO_DIR_ENV]: macroDirectory, SKETCHFORGE_MACRO_RUNNER_JS: "/runner/cli.js" });

  it("runs the installed file and returns the runner's report", async () => {
    const calls: SpawnCall[] = [];
    const result = await runMacroByName(
      { macro: "plate.mjs", params: { holes: 5, size: "M8", tapped: true } },
      { environment: environment(), spawn: fakeSpawn(calls) },
    );

    expect(result.report).toEqual({ shapeCount: 3 });
    expect(calls[0]?.args).toEqual([
      "/runner/cli.js",
      path.join(macroDirectory, "plate.mjs"),
      "--json",
      "--holes=5",
      "--size=M8",
      "--tapped=true",
    ]);
  });

  it("uses the python runner for a python macro", async () => {
    const calls: SpawnCall[] = [];
    await runMacroByName({ macro: "flange.py" }, { environment: environment(), spawn: fakeSpawn(calls) });
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-m", "sketchforge3d.macro"]);
  });

  it("refuses a name that is not in the listing", async () => {
    await expect(
      runMacroByName({ macro: "notes.txt" }, { environment: environment(), spawn: fakeSpawn([]) }),
    ).rejects.toThrow(/No macro named/);
  });

  it("refuses a path that would escape the macro directory", async () => {
    const escape = path.join("..", path.basename(outsideDirectory), "secret.mjs");
    await expect(
      runMacroByName({ macro: escape }, { environment: environment(), spawn: fakeSpawn([]) }),
    ).rejects.toThrow(/No macro named/);
    await expect(
      runMacroByName({ macro: "/etc/passwd" }, { environment: environment(), spawn: fakeSpawn([]) }),
    ).rejects.toThrow(/No macro named/);
  });

  it("refuses a parameter name that is not one a macro could declare", async () => {
    await expect(
      runMacroByName(
        { macro: "plate.mjs", params: { "holes; rm -rf /": 1 } },
        { environment: environment(), spawn: fakeSpawn([]) },
      ),
    ).rejects.toThrow(/not a parameter name/);
  });

  it("refuses a structured parameter value", async () => {
    await expect(
      runMacroByName(
        { macro: "plate.mjs", params: { holes: { count: 5 } } },
        { environment: environment(), spawn: fakeSpawn([]) },
      ),
    ).rejects.toThrow(/number, string or boolean/);
  });

  it("passes a shell metacharacter through as one argument rather than interpreting it", async () => {
    const calls: SpawnCall[] = [];
    await runMacroByName(
      { macro: "plate.mjs", params: { size: "M8; touch /tmp/pwned" } },
      { environment: environment(), spawn: fakeSpawn(calls) },
    );
    expect(calls[0]?.args.at(-1)).toBe("--size=M8; touch /tmp/pwned");
  });

  it("reports a failing macro with what it printed", async () => {
    await expect(
      runMacroByName(
        { macro: "plate.mjs" },
        { environment: environment(), spawn: fakeSpawn([], "boom", 1) },
      ),
    ).rejects.toThrow(/failed \(exit 1\)/);
  });
});
