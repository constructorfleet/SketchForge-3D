import { NextResponse } from "next/server";
import { apiRequestBodyBytes } from "@/lib/apiV1";
import { createEngine, type Engine, type ProjectDocument, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import type { ProjectConfiguration, ProjectParameter, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_EDITOR_PARAMETER_REQUEST_BYTES = 32 * 1024 * 1024;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

type Edit =
  | { kind: "add"; name: string; expression: string; dimension: ProjectParameter["dimension"] }
  | { kind: "update"; name: string; expression?: string; dimension?: ProjectParameter["dimension"] }
  | { kind: "rename"; name: string; newName: string }
  | { kind: "delete"; name: string }
  | { kind: "bindShape"; shapeId: string; field: string; expression: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function readEdit(value: unknown): Edit | null {
  if (!isRecord(value)) return null;
  if (value.kind === "bindShape") {
    const expressionOk = value.expression === null || typeof value.expression === "string";
    return typeof value.shapeId === "string" && typeof value.field === "string" && expressionOk ? value as Edit : null;
  }
  if (typeof value.name !== "string") return null;
  const optional = (key: string) => value[key] === undefined || typeof value[key] === "string";
  if (value.kind === "add" && typeof value.expression === "string" && typeof value.dimension === "string") return value as Edit;
  if (value.kind === "update" && optional("expression") && optional("dimension")) return value as Edit;
  if (value.kind === "rename" && typeof value.newName === "string") return value as Edit;
  if (value.kind === "delete") return value as Edit;
  return null;
}

/** Holds one in-memory project, so an edit runs through the engine without touching storage. */
function memoryStore(
  shapes: WorkplaneShape[],
  parameters: ProjectParameter[],
  configurations: ProjectConfiguration[],
  activeConfiguration: string | null,
) {
  const workplane = horizontalPlacementWorkplane(0);
  let document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "editor",
    createdAt: 0,
    shapes,
    history: [],
    historyIndex: 0,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: workplane,
    sketchPlacementWorkplane: workplane,
    parameters,
    configurations,
    activeConfiguration,
  };
  const store: ProjectStore = {
    read: async () => document,
    write: async (_projectId, next, nextShapes) => {
      document = { ...next, shapes: nextShapes };
      return { revision: 1 };
    },
    withLock: async (_projectId, work) => ({ busy: false, result: await work() }),
    list: async () => [],
  };
  return { store, current: () => document };
}

function run(engine: Engine, edit: Edit) {
  const id = "editor";
  if (edit.kind === "add") return engine.addParameter(id, { name: edit.name, expression: edit.expression, dimension: edit.dimension });
  if (edit.kind === "update") {
    return engine.updateParameter(id, edit.name, {
      ...(edit.expression === undefined ? {} : { expression: edit.expression }),
      ...(edit.dimension === undefined ? {} : { dimension: edit.dimension }),
    });
  }
  if (edit.kind === "rename") return engine.renameParameter(id, edit.name, edit.newName);
  if (edit.kind === "bindShape") return engine.bindShapeField(id, edit.shapeId, edit.field, edit.expression);
  return engine.deleteParameter(id, edit.name);
}

/**
 * Applies a parameter edit to the editor's in-memory shapes with the engine's
 * binding recompute, so bound geometry moves exactly as through REST. Stores nothing.
 */
export async function POST(request: Request) {
  // Streamed and capped: a chunked body has no content-length to check up front.
  const bytes = await apiRequestBodyBytes(request, { maxBytes: MAX_EDITOR_PARAMETER_REQUEST_BYTES });
  if (bytes instanceof Response) return bytes;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(value)) return json({ error: "Expected a JSON object." }, 400);
    body = value;
  } catch {
    return json({ error: "Expected a JSON object." }, 400);
  }
  if (typeof body.projectId !== "string" || !body.projectId.trim()) return json({ error: "A project id is required." }, 400);
  if (!Array.isArray(body.shapes) || !body.shapes.every((shape) => isRecord(shape) && typeof shape.id === "string")) {
    return json({ error: "Valid shapes are required." }, 400);
  }
  if (!Array.isArray(body.parameters)) return json({ error: "A parameter table is required." }, 400);
  const edit = readEdit(body.edit);
  if (!edit) return json({ error: "A parameter edit is required." }, 400);

  if (body.configurations !== undefined && !Array.isArray(body.configurations)) return json({ error: "Configurations must be a list." }, 400);
  if (body.activeConfiguration !== undefined && body.activeConfiguration !== null && typeof body.activeConfiguration !== "string") {
    return json({ error: "The active configuration must be a name or null." }, 400);
  }
  // Values resolve under the active configuration (#618), so the engine needs the rows too.
  const memory = memoryStore(
    body.shapes as WorkplaneShape[],
    body.parameters as ProjectParameter[],
    (body.configurations ?? []) as ProjectConfiguration[],
    (body.activeConfiguration ?? null) as string | null,
  );
  try {
    const result = await run(createEngine(memory.store), edit);
    if (!result.ok) return json({ failure: result.failure }, 422);
    const { shapes, parameters, configurations, activeConfiguration } = memory.current();
    return json({ shapes, parameters: parameters ?? [], configurations: configurations ?? [], activeConfiguration: activeConfiguration ?? null });
  } catch {
    // Kernel exception text can carry server paths; the editor shows its own message.
    return json({ error: "The parameter edit could not be applied." }, 422);
  }
}
