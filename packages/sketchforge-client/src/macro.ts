/**
 * Macros: a script that is handed a connected project and builds something in it.
 *
 * The hard part of a macro is not the geometry, it is what happens the second
 * time it runs. A script that appends shapes to a project it found is a script
 * that doubles the part on every run, and the mistake is invisible until
 * someone opens the project. So a macro cannot choose a project implicitly: it
 * declares a `project` mode, and the runner -- not the macro body -- does what
 * that mode says before the macro sees anything.
 *
 *   fresh     a new project every run, named uniquely. Nothing is ever reused,
 *             so a run can never corrupt an earlier one.
 *   replace   one project of that name, emptied first. Re-running gives the
 *             same result, which is what "idempotent" means for a build script.
 *   reuse     one project of that name, left as it is. For a macro that adds a
 *             feature to whatever is already there; it is the caller's problem
 *             if that runs twice.
 *   target    the project id the operator names, never created and never
 *             cleared. Refuses to run without one.
 */

import type { SketchForgeClient, ProjectHandle } from "./client.js";
import { centeredOffsets, grid, mm, ring, row } from "./layout.js";
import type { ProjectSummary } from "./types.js";

/**
 * The layout arithmetic, handed to the macro rather than imported by it.
 *
 * A macro file is usually a loose script in a folder somewhere, not a module in
 * a project with a dependency on this package -- so everything it needs arrives
 * in its context and it imports nothing at all.
 */
export const macroLayout = { centeredOffsets, grid, mm, ring, row } as const;

export type MacroLayout = typeof macroLayout;

export type MacroProjectMode = "fresh" | "replace" | "reuse" | "target";

export type MacroProjectSpec =
  | MacroProjectMode
  | {
      mode: MacroProjectMode;
      /** The project's name. `fresh` appends a stamp to it. */
      name?: string;
    };

export type MacroParameterValue = number | string | boolean;

export type MacroContext<Params extends Record<string, MacroParameterValue>> = {
  client: SketchForgeClient;
  /** The project the mode resolved to, already created or emptied as declared. */
  project: ProjectHandle;
  params: Params;
  layout: MacroLayout;
  /** Progress, on stderr, so a macro's own result can be piped. */
  log: (message: string) => void;
};

export type MacroDefinition<Params extends Record<string, MacroParameterValue>> = {
  name: string;
  description?: string;
  project: MacroProjectSpec;
  /**
   * Defaults for every parameter the macro takes.
   *
   * They double as the schema: a CLI argument is coerced to the type of the
   * default, and a name with no default is refused rather than passed through
   * as a string the macro will silently misread.
   */
  params?: Params;
  run: (context: MacroContext<Params>) => Promise<unknown> | unknown;
};

/** Identity, but it pins the parameter types so `context.params` is typed inside `run`. */
export function defineMacro<Params extends Record<string, MacroParameterValue>>(
  definition: MacroDefinition<Params>,
): MacroDefinition<Params> {
  return definition;
}

function normalizeSpec(spec: MacroProjectSpec): { mode: MacroProjectMode; name?: string } {
  return typeof spec === "string" ? { mode: spec } : spec;
}

/** A stamp that sorts chronologically and survives a filename: `20260102-114530`. */
export function runStamp(now = new Date()) {
  const digits = now.toISOString().replace(/[-:T]/g, "");
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
}

export type ResolvedMacroProject = {
  project: ProjectHandle;
  summary: ProjectSummary | null;
  created: boolean;
  cleared: number;
};

/**
 * The project a macro runs in, per its declared mode.
 *
 * `replace` looks the project up by name, which the API does not index -- so it
 * lists every project and matches. That is fine for the handful a workshop has
 * and would not be for thousands.
 */
export async function resolveMacroProject(
  client: SketchForgeClient,
  spec: MacroProjectSpec,
  options: { fallbackName: string; targetProjectId?: string | undefined; now?: Date },
): Promise<ResolvedMacroProject> {
  const { mode, name } = normalizeSpec(spec);
  const wantedName = name ?? options.fallbackName;

  if (mode === "target") {
    if (!options.targetProjectId) {
      throw new Error(
        `Macro "${options.fallbackName}" runs in an existing project: set SKETCHFORGE_PROJECT_ID or pass --project.`,
      );
    }
    // Read it before the macro starts, so a wrong id fails as a 404 here
    // rather than halfway through a part.
    await client.projects.get(options.targetProjectId);
    return { project: client.project(options.targetProjectId), summary: null, created: false, cleared: 0 };
  }

  if (mode === "fresh") {
    const summary = await client.projects.create(`${wantedName} ${runStamp(options.now)}`);
    return { project: client.project(summary.id), summary, created: true, cleared: 0 };
  }

  const existing = await client.projects.findByName(wantedName);
  if (!existing) {
    const summary = await client.projects.create(wantedName);
    return { project: client.project(summary.id), summary, created: true, cleared: 0 };
  }

  const project = client.project(existing.id);
  const cleared = mode === "replace" ? await project.clear() : 0;
  return { project, summary: existing, created: false, cleared };
}

/** A macro's parameters, with CLI overrides coerced to the type of each default. */
export function resolveMacroParams<Params extends Record<string, MacroParameterValue>>(
  defaults: Params | undefined,
  overrides: Record<string, string>,
): Params {
  const resolved = { ...(defaults ?? ({} as Params)) } as Record<string, MacroParameterValue>;
  for (const [key, raw] of Object.entries(overrides)) {
    if (!(key in resolved)) {
      const known = Object.keys(resolved);
      throw new Error(
        `Unknown parameter "${key}". This macro takes: ${known.length ? known.join(", ") : "no parameters"}.`,
      );
    }
    const fallback = resolved[key];
    if (typeof fallback === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Parameter "${key}" must be a number, not "${raw}".`);
      resolved[key] = value;
    } else if (typeof fallback === "boolean") {
      if (!/^(true|false|1|0|yes|no)$/i.test(raw)) {
        throw new Error(`Parameter "${key}" must be true or false, not "${raw}".`);
      }
      resolved[key] = /^(true|1|yes)$/i.test(raw);
    } else {
      resolved[key] = raw;
    }
  }
  return resolved as Params;
}

export type MacroRunReport = {
  macro: string;
  projectId: string;
  projectCreated: boolean;
  shapesCleared: number;
  shapeCount: number;
  durationMs: number;
  result: unknown;
};

/** Runs a macro and reports what it did to the project, as the CLI prints it. */
export async function runMacro<Params extends Record<string, MacroParameterValue>>(
  client: SketchForgeClient,
  definition: MacroDefinition<Params>,
  options: {
    params?: Record<string, string>;
    targetProjectId?: string | undefined;
    log?: (message: string) => void;
    now?: Date;
  } = {},
): Promise<MacroRunReport> {
  const log = options.log ?? (() => {});
  const params = resolveMacroParams(definition.params, options.params ?? {});
  const started = Date.now();
  const resolved = await resolveMacroProject(client, definition.project, {
    fallbackName: definition.name,
    targetProjectId: options.targetProjectId,
    ...(options.now ? { now: options.now } : {}),
  });

  if (resolved.created) log(`project ${resolved.project.id} created`);
  if (resolved.cleared) log(`${resolved.cleared} existing shape(s) removed`);

  const result = await definition.run({ client, project: resolved.project, params, layout: macroLayout, log });
  const shapes = await resolved.project.listShapes();

  return {
    macro: definition.name,
    projectId: resolved.project.id,
    projectCreated: resolved.created,
    shapesCleared: resolved.cleared,
    shapeCount: shapes.length,
    durationMs: Date.now() - started,
    result: result ?? null,
  };
}

/**
 * A macro module's export, whichever way it was written.
 *
 * `export default defineMacro(...)` is the documented form; a module exporting
 * a bare function is accepted as the smallest thing that can work, and runs in
 * a fresh project because that is the only mode that is safe to assume.
 */
export function macroFromModule(module: unknown, fallbackName: string): MacroDefinition<Record<string, MacroParameterValue>> {
  const candidate =
    module && typeof module === "object"
      ? ((module as { default?: unknown; macro?: unknown }).default ?? (module as { macro?: unknown }).macro)
      : undefined;

  if (typeof candidate === "function") {
    return {
      name: fallbackName,
      project: "fresh",
      run: candidate as MacroDefinition<Record<string, MacroParameterValue>>["run"],
    };
  }

  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as MacroDefinition<never>).run === "function" &&
    (candidate as MacroDefinition<never>).project
  ) {
    const definition = candidate as MacroDefinition<Record<string, MacroParameterValue>>;
    return { ...definition, name: definition.name || fallbackName };
  }

  throw new Error(
    `${fallbackName} does not look like a macro: export default defineMacro({ name, project, run }), or a function taking the macro context.`,
  );
}
