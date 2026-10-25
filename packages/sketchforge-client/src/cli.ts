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
import { promises as fs } from "node:fs";
import { clientFromEnvironment, targetProjectFromEnvironment, MissingConfigurationError } from "./environment.js";
import type { Environment } from "./environment.js";
import { SketchForgeApiError, SketchForgeTransportError } from "./errors.js";
import type { SketchForgeClient } from "./client.js";
import { IMPORTABLE_MESH_FORMATS, PROJECT_EXPORT_FORMATS, type ProjectExportFormat } from "./types.js";
import { macroFromModule, runMacro, type MacroRunReport } from "./macro.js";

const USAGE = `sketchforge-macro <macro-file> [--param=value ...] [--project=<id>] [--json]
sketchforge-macro projects list
sketchforge-macro projects create <name>
sketchforge-macro projects delete <project-id>
sketchforge-macro export --format <fmt> --out <file> [--project <id>]
sketchforge-macro import <file> [--project <id>]

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

function optionValues(arguments_: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument "${argument}".`);
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals < 0 ? arguments_[++index] : argument.slice(equals + 1);
    if (!name || !value || value.startsWith("--")) throw new Error(`Expected a value for --${name || "?"}.`);
    if (values.has(name)) throw new Error(`Option --${name} may only be given once.`);
    values.set(name, value);
  }
  return values;
}

function requiredOption(options: Map<string, string>, name: string) {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function rejectUnknownOptions(options: Map<string, string>, allowed: readonly string[]) {
  const unknown = [...options.keys()].find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`Unknown option --${unknown}.`);
}

function selectedProject(options: Map<string, string>, environment: Environment) {
  const projectId = options.get("project") ?? targetProjectFromEnvironment(environment);
  if (!projectId) throw new Error("Choose a project with --project <id> or SKETCHFORGE_PROJECT_ID.");
  return projectId;
}

/** Execute one direct project, import, or export command using the public client resources. */
export async function executeDirectCommand(argv: readonly string[], client: SketchForgeClient, environment: Environment = process.env): Promise<string> {
  const [command, ...rest] = argv;
  if (command === "projects") {
    const [action, ...arguments_] = rest;
    if (action === "list" && arguments_.length === 0) {
      const projects = await client.projects.list();
      return projects.length
        ? projects.map((project) => `${project.id}\t${project.name}\t${project.shapes} shapes`).join("\n")
        : "No projects.";
    }
    if (action === "create" && arguments_.length === 1) {
      const project = await client.projects.create(arguments_[0]!);
      return `Created project ${project.id} (${project.name}).`;
    }
    if (action === "delete" && arguments_.length === 1) {
      const deleted = await client.projects.delete(arguments_[0]!);
      if (!deleted.deleted) throw new Error(`Project ${arguments_[0]} was not found.`);
      return `Deleted project ${arguments_[0]}.`;
    }
    throw new Error("Use projects list, projects create <name>, or projects delete <project-id>.");
  }

  if (command === "export") {
    const options = optionValues(rest);
    rejectUnknownOptions(options, ["format", "out", "project"]);
    const format = requiredOption(options, "format");
    if (!(PROJECT_EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new Error(`--format must be one of: ${PROJECT_EXPORT_FORMATS.join(", ")}.`);
    }
    const outputPath = path.resolve(requiredOption(options, "out"));
    const projectId = selectedProject(options, environment);
    const artifact = await client.exports.export(projectId, { format: format as ProjectExportFormat });
    await fs.writeFile(outputPath, artifact.data);
    return `Exported ${artifact.filename} (${artifact.bytes} bytes) to ${outputPath}.`;
  }

  if (command === "import") {
    const [file, ...arguments_] = rest;
    if (!file) throw new Error("Use import <file> [--project <id>].");
    const options = optionValues(arguments_);
    rejectUnknownOptions(options, ["project"]);
    const absolute = path.resolve(file);
    const fileName = path.basename(absolute);
    if (!(IMPORTABLE_MESH_FORMATS as readonly string[]).some((extension) => fileName.toLowerCase().endsWith(`.${extension}`))) {
      throw new Error(`Import supports: ${IMPORTABLE_MESH_FORMATS.join(", ")}.`);
    }
    const bytes = new Uint8Array(await fs.readFile(absolute));
    let projectId = options.get("project") ?? targetProjectFromEnvironment(environment);
    let created = false;
    if (!projectId) {
      const name = path.parse(fileName).name || "Imported design";
      projectId = (await client.projects.create(name)).id;
      created = true;
    }
    const imported = await client.imports.apply(projectId, { fileName, bytes });
    return `Imported ${fileName} into project ${projectId}${created ? " (created)" : ""}; shape ${imported.shape.id}.`;
  }

  throw new Error(`Unknown direct command "${command ?? ""}".`);
}

export async function main(argv: readonly string[], environment: Environment = process.env, fetch?: typeof globalThis.fetch) {
  if (["projects", "export", "import"].includes(argv[0] ?? "")) {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const client = clientFromEnvironment(environment, fetch ? { fetch } : {});
    process.stdout.write(`${await executeDirectCommand(argv, client, environment)}\n`);
    return 0;
  }

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
