/**
 * Running macros from the MCP bridge, by name only.
 *
 * `freecad-mcp` exposes an `execute_code` tool, which is remote code execution
 * by design: whatever the model writes, the CAD process runs. This does not.
 * The only thing an MCP client can ask for here is one of the files an operator
 * put in `SKETCHFORGE_MACRO_DIR`, chosen from the listing this module produces,
 * with parameters that reach the macro as strings. There is no inline-code tool
 * and no opt-in flag that adds one: a macro is reviewed once, by the person who
 * installed it, rather than on every call.
 *
 * With no macro directory configured, both tools report that and do nothing, so
 * a default install exposes no way to run a local file at all.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MACRO_DIR_ENV = "SKETCHFORGE_MACRO_DIR";
export const MACRO_TIMEOUT_ENV = "SKETCHFORGE_MACRO_TIMEOUT_MS";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Macros are scripts for the two runners this repo ships; nothing else is executable. */
const RUNNABLE_EXTENSIONS = new Set([".mjs", ".js", ".py"]);

// Installed from npm, this module sits at <package>/mcp, so the JavaScript
// macro runner it spawns is its own package's `dist/cli.js` -- the same path it
// has in a checkout. The Python package only exists in a checkout; without it,
// a Python macro runs against a pip-installed `sketchforge3d`, which is what
// anyone running this from npx will have.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientPackageRoot = path.resolve(moduleDirectory, "..");
const bundledPythonSource = path.resolve(clientPackageRoot, "..", "sketchforge-py", "src");

export class MacroToolError extends Error {}

export function macroDirectory(environment = process.env) {
  const configured = environment[MACRO_DIR_ENV];
  if (!configured) {
    throw new MacroToolError(
      `No macro directory is configured. Set ${MACRO_DIR_ENV} to a folder of reviewed macro files to enable this tool; ` +
        "it runs only files that are already in that folder, never code sent to it.",
    );
  }
  return path.resolve(configured);
}

function pythonRunnerEnvironment(environment) {
  const pythonPath = existsSync(bundledPythonSource)
    ? [bundledPythonSource, environment.PYTHONPATH].filter(Boolean).join(path.delimiter)
    : environment.PYTHONPATH;
  return {
    command: environment.SKETCHFORGE_MACRO_PYTHON || "python3",
    environment: { ...environment, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) },
  };
}

function inspectPythonMacro(filePath, environment) {
  const runner = pythonRunnerEnvironment(environment);
  return new Promise((resolve) => {
    const child = spawn(runner.command, ["-m", "sketchforge3d.macro", filePath, "--describe", "--json"], {
      cwd: path.dirname(filePath),
      env: runner.environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      child.kill("SIGKILL");
      resolve(null);
    }, 5_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        finished = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(null);
      }
    });
    child.on("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The macros an operator has installed.
 *
 * The listing is also the allow-list: a run request is matched against these
 * names, so a name is never joined onto a path and `../` cannot escape.
 */
export async function listMacros(environment = process.env) {
  const directory = macroDirectory(environment);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new MacroToolError(`${directory} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const macros = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!RUNNABLE_EXTENSIONS.has(extension)) continue;
    const full = path.join(directory, entry.name);
    const info = await stat(full).catch(() => null);
    // A symlink out of the directory is still a file the operator put there on
    // purpose; what matters is that the name came from this listing.
    if (!info?.isFile()) continue;
    const metadata = extension === ".py" ? await inspectPythonMacro(full, environment) : null;
    macros.push({
      name: entry.name,
      language: extension === ".py" ? "python" : "javascript",
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      ...(metadata ? { metadata } : {}),
    });
  }
  return { directory, macros: macros.sort((left, right) => left.name.localeCompare(right.name)) };
}

function javascriptRunner(environment) {
  const configured = environment.SKETCHFORGE_MACRO_RUNNER_JS;
  if (configured) return configured;
  const bundled = path.join(clientPackageRoot, "dist", "cli.js");
  if (existsSync(bundled)) return bundled;
  throw new MacroToolError(
    "No JavaScript macro runner was found. Build it with `npm run build --prefix packages/sketchforge-client`, " +
      "or point SKETCHFORGE_MACRO_RUNNER_JS at an installed sketchforge-macro.",
  );
}

function runnerFor(macroName, environment) {
  if (environment.SKETCHFORGE_PROJECTS_DIR) {
    if (path.extname(macroName).toLowerCase() === ".py") {
      throw new MacroToolError("Python macros need the HTTP API adapter; local project mode runs JavaScript macros directly against the engine.");
    }
    return { command: process.execPath, leadingArguments: [path.join(moduleDirectory, "localMacroRunner.mjs")], extraEnvironment: {} };
  }
  if (path.extname(macroName).toLowerCase() === ".py") {
    const runner = pythonRunnerEnvironment(environment);
    return {
      command: runner.command,
      leadingArguments: ["-m", "sketchforge3d.macro"],
      extraEnvironment: runner.environment,
    };
  }
  return { command: process.execPath, leadingArguments: [javascriptRunner(environment)], extraEnvironment: {} };
}

function parameterArguments(params) {
  if (params === undefined || params === null) return [];
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new MacroToolError("params must be an object of name/value pairs.");
  }
  return Object.entries(params).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new MacroToolError(`"${name}" is not a parameter name a macro can declare.`);
    }
    if (value !== null && typeof value === "object") {
      throw new MacroToolError(`Parameter "${name}" must be a number, string or boolean.`);
    }
    return `--${name}=${String(value)}`;
  });
}

function truncate(text) {
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n...output truncated...` : text;
}

/**
 * Runs one installed macro and reports what the runner printed.
 *
 * `spawn` with an argument list rather than a shell: a parameter value is one
 * argument whatever it contains, and no part of it is ever parsed as a command.
 */
export async function runMacroByName(request, options = {}) {
  const environment = options.environment ?? process.env;
  const spawnImpl = options.spawn ?? spawn;
  const name = typeof request?.macro === "string" ? request.macro.trim() : "";
  if (!name) throw new MacroToolError("Name the macro to run; sketchforge_list_macros shows what is installed.");

  const { directory, macros } = await listMacros(environment);
  const match = macros.find((macro) => macro.name === name);
  if (!match) {
    throw new MacroToolError(
      `No macro named "${name}" is installed in ${directory}. Installed: ${macros.map((macro) => macro.name).join(", ") || "none"}.`,
    );
  }

  const { command, leadingArguments, extraEnvironment } = runnerFor(match.name, environment);
  const args = [...leadingArguments, path.join(directory, match.name), "--json", ...parameterArguments(request.params)];
  if (typeof request.projectId === "string" && request.projectId) args.push(`--project=${request.projectId}`);

  const timeoutMs = Number(request.timeoutMs ?? environment[MACRO_TIMEOUT_ENV] ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: directory,
      env: { ...environment, ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new MacroToolError(`${command} could not be run: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new MacroToolError(`${match.name} was still running after ${timeoutMs} ms and was stopped.`));
        return;
      }
      if (code !== 0) {
        reject(new MacroToolError(`${match.name} failed (exit ${code}): ${truncate(stderr || stdout).trim()}`));
        return;
      }
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        // A macro that printed something other than the runner's report is not
        // an error; the text is what the caller gets.
      }
      resolve({
        macro: match.name,
        durationMs: Date.now() - started,
        report,
        ...(report ? {} : { output: truncate(stdout).trim() }),
        log: truncate(stderr).trim(),
      });
    });
  });
}

export const macroTools = [
  {
    name: "sketchforge_list_macros",
    description:
      "List the macro scripts an operator has installed in SKETCHFORGE_MACRO_DIR. These are the only macros sketchforge_run_macro will run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sketchforge_run_macro",
    description:
      "Run one installed macro by name, offline by default or against an optional SketchForge server URL. Parameters are the macro's own declared parameters. Only files already present in SKETCHFORGE_MACRO_DIR can be run; code cannot be passed in.",
    inputSchema: {
      type: "object",
      required: ["macro"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to run against local project files." },
        macro: { type: "string", description: "A file name from sketchforge_list_macros." },
        params: {
          type: "object",
          description: "The macro's parameters, as name/value pairs of numbers, strings or booleans.",
        },
        projectId: { type: "string", description: "The project to build in, for a macro declaring project: target." },
        timeoutMs: { type: "number", description: "How long to let the macro run. Defaults to 120000." },
      },
    },
  },
];
