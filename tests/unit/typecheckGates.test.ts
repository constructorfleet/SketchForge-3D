import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript-legacy";
import { describe, expect, it } from "vitest";

// TypeScript 7's incremental builder can reuse diagnostics after a re-exported
// module resolves to a different file, so a gate may pass on stale results (#658).
const repositoryRoot = path.resolve(__dirname, "../..");
const packageDirectories = [".", "packages/sketchforge-engine", "packages/sketchforge-client"];

type TscInvocation = { script: string; directory: string; args: string[] };

function tscInvocations(): TscInvocation[] {
  return packageDirectories.flatMap((directory) => {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, directory, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Object.entries(manifest.scripts ?? {}).flatMap(([name, command]) =>
      command.split(/&&|\|\||;/).map((part) => part.trim().split(/\s+/)).filter((args) => args[0] === "tsc")
        .map((args) => ({ script: `${directory}:${name}`, directory, args: args.slice(1) })));
  });
}

function flagValue(args: string[], ...flags: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    const [flag, inline] = arg.split("=", 2);
    if (flags.includes(flag)) return inline ?? args[index + 1];
  }
  return undefined;
}

function effectiveOptions(directory: string, project: string): ts.CompilerOptions {
  const configPath = path.resolve(repositoryRoot, directory, project.endsWith(".json") ? project : path.join(project, "tsconfig.json"));
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) throw new Error(`${configPath}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath).options;
}

function usesBuildInfo({ directory, args }: TscInvocation): boolean {
  const cliIncremental = flagValue(args, "--incremental", "-i");
  if (cliIncremental === "false") return false;
  const options = effectiveOptions(directory, flagValue(args, "-p", "--project") ?? "tsconfig.json");
  return Boolean(options.incremental || options.composite || cliIncremental === "true");
}

describe("typecheck gates", () => {
  it("finds the tsc gates it guards", () => {
    const scripts = tscInvocations().map(({ script }) => script);
    expect(scripts).toEqual(expect.arrayContaining([".:typecheck", ".:typecheck:tests", ".:client:typecheck", "packages/sketchforge-engine:typecheck"]));
  });

  it("never reuses a tsbuildinfo file", () => {
    const cached = tscInvocations().filter(usesBuildInfo).map(({ script, args }) => `${script}: tsc ${args.join(" ")}`);
    expect(cached).toEqual([]);
  });
});
