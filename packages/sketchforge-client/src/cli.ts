#!/usr/bin/env node

/**
 * `sketchforge-macro <file> [--name=value ...]`
 *
 * The macro file is imported, not evaluated from a string, and only ever from a
 * path the person running the command typed. Nothing here accepts code over a
 * socket.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import { clientFromEnvironment, targetProjectFromEnvironment, MissingConfigurationError } from "./environment.js";
import { SketchForgeApiError, SketchForgeTransportError } from "./errors.js";
import { macroFromModule, runMacro, type MacroRunReport } from "./macro.js";

const USAGE = `sketchforge-macro <macro-file> [--param=value ...] [--project=<id>] [--json]

Environment:
  SKETCHFORGE_API_TOKEN   required; the server's API token
  SKETCHFORGE_URL         default http://127.0.0.1:3000
  SKETCHFORGE_PROJECT_ID  the project for a macro declaring project: "target"`;

export type ParsedArguments = {
  file?: string;
  params: Record<string, string>;
  projectId?: string;
  json: boolean;
  help: boolean;
};

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = { params: {}, json: false, help: false };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--json") {
      parsed.json = true;
    } else if (argument.startsWith("--")) {
      const [name, ...rest] = argument.slice(2).split("=");
      if (!name || rest.length === 0) throw new Error(`Expected --name=value, got "${argument}".`);
      const value = rest.join("=");
      if (name === "project") parsed.projectId = value;
      else parsed.params[name] = value;
    } else if (!parsed.file) {
      parsed.file = argument;
    } else {
      throw new Error(`Unexpected argument "${argument}"; one macro file at a time.`);
    }
  }
  return parsed;
}

export function describeReport(report: MacroRunReport) {
  const lines = [
    `macro      ${report.macro}`,
    `project    ${report.projectId}${report.projectCreated ? " (created)" : ""}`,
    `shapes     ${report.shapeCount}`,
    `took       ${report.durationMs} ms`,
  ];
  if (report.shapesCleared) lines.splice(2, 0, `cleared    ${report.shapesCleared}`);
  if (report.result !== null && report.result !== undefined) {
    lines.push(`result     ${JSON.stringify(report.result)}`);
  }
  return lines.join("\n");
}

export async function main(argv: readonly string[]) {
  const options = parseArguments(argv);
  if (options.help || !options.file) {
    process.stdout.write(`${USAGE}\n`);
    return options.file ? 0 : 1;
  }

  const absolute = path.resolve(process.cwd(), options.file);
  const module = (await import(pathToFileURL(absolute).href)) as unknown;
  const definition = macroFromModule(module, path.basename(absolute).replace(/\.[cm]?[jt]s$/, ""));

  const client = clientFromEnvironment();
  const report = await runMacro(client, definition, {
    params: options.params,
    targetProjectId: options.projectId ?? targetProjectFromEnvironment(),
    log: (message) => process.stderr.write(`${message}\n`),
  });

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${describeReport(report)}\n`);
  return 0;
}

/** A failure a macro author can act on, rather than a stack trace through fetch. */
function explain(error: unknown) {
  if (error instanceof MissingConfigurationError) return error.message;
  if (error instanceof SketchForgeTransportError) {
    return `${error.message}\nIs the server running, and is SKETCHFORGE_URL pointing at it?`;
  }
  if (error instanceof SketchForgeApiError) {
    if (error.looksDisabled) return "The server has no SKETCHFORGE_API_TOKEN set, so its REST API is switched off.";
    if (error.needsStorage) return "The server has no SKETCHFORGE_PROJECTS_DIR set, so it has nowhere to store projects.";
    return error.message;
  }
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${explain(error)}\n`);
      process.exitCode = 1;
    });
}
