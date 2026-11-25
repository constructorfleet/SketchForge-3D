import { describe, expect, it } from "vitest";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";
import { resolveProjectParameters, type ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { POST } from "@/app/api/editor/parameters/route";
import { editorParameterRequest } from "@/lib/editorCadRequests";
import { planParameterEdit, type ParameterEdit } from "@/lib/projectParameterEdits";
import { applyKernelFreeBindings as applyBindingsLocally } from "@constructorfleet/sketchforge-engine/parameterBindingPlan";

// The static build's fallback must give the engine's outcome, refusal or result, for the same input.

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

const parameters = table([
  { name: "w", expression: "40", dimension: "length" },
  { name: "t", expression: "3", dimension: "length" },
  { name: "dd", expression: "30", dimension: "length" },
  { name: "a", expression: "30 deg", dimension: "angle" },
  { name: "n", expression: "6", dimension: "unitless" },
]);

function shape(request: Record<string, unknown>, overrides: Partial<WorkplaneShape>): WorkplaneShape {
  const built = shapeFromRequest(request);
  if (!built) throw new Error(`no ${String(request.kind)}`);
  return { ...built, id: `shape-${String(request.kind)}`, name: String(request.kind), ...overrides };
}

async function engineOutcome(shapes: WorkplaneShape[], edit: ParameterEdit) {
  const request = editorParameterRequest("parity", shapes, parameters, edit);
  const response = await POST(new Request(`http://localhost${request.url}`, { method: "POST", body: JSON.stringify(request.body) }));
  const body = await response.json();
  return response.ok ? { ok: true, shapes: body.shapes } : { ok: false, failure: body.failure };
}

function fallbackOutcome(shapes: WorkplaneShape[], edit: ParameterEdit) {
  const planned = planParameterEdit({ parameters, shapes }, edit);
  if (!planned.ok) throw new Error(planned.error.message);
  const local = applyBindingsLocally(planned.project.shapes, parameters, planned.project.parameters);
  if (!local) throw new Error("the fallback declined a plain primitive");
  return local.ok ? { ok: true, shapes: JSON.parse(JSON.stringify(local.shapes)) } : { ok: false, failure: local.failure };
}

const cases: Array<[string, WorkplaneShape[], ParameterEdit]> = [
  ["a joint range check across fields (gear teeth against width)",
    [shape({ kind: "gear", width: 40, depth: 40, toothSize: 3 }, { expressions: { width: "w", depth: "w", toothSize: "t" } })],
    { kind: "update", name: "w", expression: "8" }],
  ["every binding on a touched shape is reapplied",
    [shape({ kind: "box", width: 40, depth: 33, height: 10 }, { expressions: { width: "w", depth: "dd" } })],
    { kind: "update", name: "w", expression: "20" }],
  ["a periodic angle in stored form",
    [shape({ kind: "box", width: 10, depth: 10, height: 10 }, { expressions: { rotation: "a" } })],
    { kind: "update", name: "a", expression: "370 deg" }],
  ["a fractional count",
    [shape({ kind: "cylinder", width: 10, depth: 10, height: 10, sides: 6 }, { expressions: { sides: "n" } })],
    { kind: "update", name: "n", expression: "4.5" }],
  ["a locked shape",
    [shape({ kind: "box", width: 40, depth: 10, height: 10 }, { locked: true, expressions: { width: "w" } })],
    { kind: "update", name: "w", expression: "20" }],
  ["out of range before locked",
    [shape({ kind: "box", width: 40, depth: 10, height: 10 }, { locked: true, expressions: { width: "w" } })],
    { kind: "update", name: "w", expression: "-5" }],
  ["a stale binding stays stale",
    [shape({ kind: "box", width: 40, depth: 10, height: 10 }, { expressions: { width: "w", height: "missing" } })],
    { kind: "update", name: "w", expression: "20" }],
];

describe("static-build binding fallback parity with the engine", () => {
  it.each(cases)("%s", async (_name, shapes, edit) => {
    const engine = await engineOutcome(shapes, edit);
    expect(fallbackOutcome(shapes, edit)).toEqual(engine);
  });

  it("covers both outcomes", async () => {
    const outcomes = await Promise.all(cases.map(([, shapes, edit]) => engineOutcome(shapes, edit)));
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, true, true, false, false, false, true]);
  });

  it.each([
    ["activating a configuration", false, { kind: "activateConfiguration", configuration: "Large" } as ParameterEdit],
    ["activating one the bound field refuses", false, { kind: "activateConfiguration", configuration: "Broken" } as ParameterEdit],
    ["deleting the active configuration", true, { kind: "deleteConfiguration", configuration: "Large" } as ParameterEdit],
    ["setting an override on the active configuration", true, { kind: "setOverride", configuration: "Large", name: "w", expression: "50" } as ParameterEdit],
    ["setting an override the bound field refuses", true, { kind: "setOverride", configuration: "Large", name: "w", expression: "-1" } as ParameterEdit],
    ["clearing an override on the active configuration", true, { kind: "clearOverride", configuration: "Large", name: "w" } as ParameterEdit],
  ])("%s (#618)", async (_name, startActive, edit) => {
    const rows = [{ name: "Large", overrides: { w: "30" } }, { name: "Broken", overrides: { w: "-5" } }];
    const base = { parameters, shapes: [shape({ kind: "box", width: 40, depth: 10, height: 10 }, { expressions: { width: "w" } })], configurations: rows, activeConfiguration: null as string | null };
    // An active start resolves its values, and the bound width, under Large.
    const activated = startActive ? planParameterEdit(base, { kind: "activateConfiguration", configuration: "Large" }) : null;
    if (activated && !activated.ok) throw new Error(activated.error.message);
    const start = activated
      ? { ...activated.project, shapes: activated.project.shapes.map((entry) => ({ ...entry, width: 30 })) }
      : base;
    const configuration = { configurations: start.configurations ?? [], activeConfiguration: start.activeConfiguration ?? null };
    const request = editorParameterRequest("parity", start.shapes, start.parameters, edit, configuration);
    const response = await POST(new Request(`http://localhost${request.url}`, { method: "POST", body: JSON.stringify(request.body) }));
    const body = await response.json();
    const engine = response.ok ? { ok: true, shapes: body.shapes } : { ok: false, failure: body.failure };
    const planned = planParameterEdit(start, edit);
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.recompute).toBe(true);
    const local = applyBindingsLocally(planned.project.shapes, start.parameters, planned.project.parameters);
    expect(local && (local.ok ? { ok: true, shapes: JSON.parse(JSON.stringify(local.shapes)) } : { ok: false, failure: local.failure })).toEqual(engine);
  });
});
