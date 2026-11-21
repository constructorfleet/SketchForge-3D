import { describe, expect, it } from "vitest";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";
import { resolveProjectParameters, type ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import { SOURCE_MESSAGES } from "@/i18n/locales";
import {
  applyBindingsLocally,
  configurationIssueMessages,
  parameterEditNotice,
  parameterErrorMessage,
  parameterRows,
  planParameterEdit,
  type ParameterProject,
} from "@/lib/projectParameterEdits";
import type { ProjectConfiguration, WorkplaneShape } from "@/types/sketchforge";

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

function box(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const shape = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 });
  if (!shape) throw new Error("no box");
  return { ...shape, id: "box", name: "Box", expressions: { width: "w" }, ...overrides };
}

function project(configurations: ProjectConfiguration[] = [], activeConfiguration: string | null = null): ParameterProject {
  return {
    parameters: table([{ name: "w", expression: "10", dimension: "length" }, { name: "h", expression: "5", dimension: "length" }]),
    shapes: [box()],
    configurations,
    activeConfiguration,
  };
}

function planned(start: ParameterProject, edit: Parameters<typeof planParameterEdit>[1]) {
  const result = planParameterEdit(start, edit);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function message(key: string) {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], SOURCE_MESSAGES);
}

describe("configuration edits", () => {
  it("adds, renames and deletes configurations without moving geometry", () => {
    const added = planned(project(), { kind: "addConfiguration", configuration: "Large", overrides: { w: "30" } });
    expect(added.recompute).toBe(false);
    expect(added.project.configurations).toEqual([{ name: "Large", overrides: { w: "30" } }]);
    const renamed = planned(added.project, { kind: "renameConfiguration", configuration: "Large", newName: "Big" });
    expect(renamed.recompute).toBe(false);
    expect(renamed.project.configurations).toEqual([{ name: "Big", overrides: { w: "30" } }]);
    const deleted = planned(renamed.project, { kind: "deleteConfiguration", configuration: "Big" });
    expect(deleted.recompute).toBe(false);
    expect(deleted.project.configurations).toEqual([]);
    // Deleting the active configuration returns to the base table, which moves bound geometry.
    const active = planned(planned(added.project, { kind: "activateConfiguration", configuration: "Large" }).project, { kind: "deleteConfiguration", configuration: "Large" });
    expect(active.recompute).toBe(true);
    expect(active.project.activeConfiguration).toBeNull();
  });

  it("activates a configuration, re-resolving values and asking for a recompute", () => {
    const start = project([{ name: "Large", overrides: { w: "30" } }]);
    const active = planned(start, { kind: "activateConfiguration", configuration: "Large" });
    expect(active.recompute).toBe(true);
    expect(active.project.activeConfiguration).toBe("Large");
    expect(active.project.parameters.find((parameter) => parameter.name === "w")).toMatchObject({ expression: "10", value: 30 });
    // The static fallback moves the plain box the same way.
    expect(applyBindingsLocally(active.project.shapes, start.parameters, active.project.parameters)).toMatchObject({ ok: true, shapes: [{ width: 30 }] });
    const base = planned(active.project, { kind: "activateConfiguration", configuration: null });
    expect(base.project.activeConfiguration).toBeNull();
    expect(base.project.parameters.find((parameter) => parameter.name === "w")?.value).toBe(10);
  });

  it("sets and clears an override, recomputing only when it is active", () => {
    const inactive = planned(project([{ name: "Large", overrides: {} }]), { kind: "setOverride", configuration: "Large", name: "w", expression: "40" });
    expect(inactive.recompute).toBe(false);
    expect(inactive.project.configurations).toEqual([{ name: "Large", overrides: { w: "40" } }]);
    const active = planned(project([{ name: "Large", overrides: {} }], "Large"), { kind: "setOverride", configuration: "Large", name: "w", expression: "40" });
    expect(active.recompute).toBe(true);
    expect(active.project.parameters.find((parameter) => parameter.name === "w")?.value).toBe(40);
    const cleared = planned(active.project, { kind: "clearOverride", configuration: "Large", name: "w" });
    expect(cleared.recompute).toBe(true);
    expect(cleared.project.parameters.find((parameter) => parameter.name === "w")?.value).toBe(10);
  });

  it("refuses an override that breaks the configuration, leaving the project unchanged", () => {
    const start = project([{ name: "Large", overrides: {} }]);
    const before = JSON.stringify(start);
    const refused = planParameterEdit(start, { kind: "setOverride", configuration: "Large", name: "w", expression: "h +" });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalidExpression", configuration: "Large" } });
    expect(JSON.stringify(start)).toBe(before);
    if (refused.ok) return;
    const shown = parameterErrorMessage(refused.error);
    expect(shown).toMatchObject({ key: "editor.parameters.error.parseError", configuration: "Large" });
    expect(typeof message("editor.parameters.configurations.inConfiguration")).toBe("string");
  });

  it("names every committed edit in a catalog notice", () => {
    const edits: Array<[Parameters<typeof parameterEditNotice>[0], string, Record<string, string>]> = [
      [{ kind: "add", name: "w", expression: "1", dimension: "length" }, "editor.parameters.notice.added", { name: "w" }],
      [{ kind: "rename", name: "w", newName: "v" }, "editor.parameters.notice.renamed", { name: "v" }],
      [{ kind: "activateConfiguration", configuration: "Large" }, "editor.parameters.configurations.notice.activated", { name: "Large" }],
      [{ kind: "activateConfiguration", configuration: null }, "editor.parameters.configurations.notice.activatedBase", {}],
      [{ kind: "renameConfiguration", configuration: "Large", newName: "Big" }, "editor.parameters.configurations.notice.renamed", { name: "Big" }],
      [{ kind: "setOverride", configuration: "Large", name: "w", expression: "3" }, "editor.parameters.configurations.notice.overrideSet", { name: "Large", parameter: "w" }],
      [{ kind: "clearOverride", configuration: "Large", name: "w" }, "editor.parameters.configurations.notice.overrideCleared", { name: "Large", parameter: "w" }],
    ];
    for (const [edit, key, values] of edits) {
      expect(parameterEditNotice(edit)).toEqual({ key, values });
      expect(typeof message(key), key).toBe("string");
    }
  });

  it("shows the overrides of the configuration being edited, active or not", () => {
    const start = project([{ name: "Large", overrides: { w: "30" } }, { name: "Small", overrides: { h: "2" } }]);
    const active = planned(start, { kind: "activateConfiguration", configuration: "Large" });
    const rows = (configuration: string | null) => parameterRows(active.project.parameters, active.project.configurations, configuration)
      .map(({ name, value, override }) => ({ name, value, override }));
    expect(rows("Large")).toEqual([{ name: "w", value: "30", override: "30" }, { name: "h", value: "5", override: undefined }]);
    // Values stay those of the active configuration; overrides are those of the one selected.
    expect(rows("Small")).toEqual([{ name: "w", value: "30", override: undefined }, { name: "h", value: "5", override: "2" }]);
    expect(rows(null).every((row) => row.override === undefined)).toBe(true);
  });

  it("lists the issues of a stale configuration so it can be fixed", () => {
    const stale = project([{ name: "Old", overrides: { w: "missing * 2" } }]);
    expect(configurationIssueMessages(stale, "Old")).toEqual([{ parameter: "w", message: { key: "editor.parameters.error.unknownName", values: { name: "w" } } }]);
    expect(configurationIssueMessages(stale, null)).toEqual([]);
    // A stale configuration can still be renamed, edited and deleted while it is not active.
    const fixed = planned(stale, { kind: "setOverride", configuration: "Old", name: "w", expression: "12" });
    expect(fixed.recompute).toBe(false);
    expect(configurationIssueMessages(fixed.project, "Old")).toEqual([]);
    expect(planned(stale, { kind: "renameConfiguration", configuration: "Old", newName: "Older" }).project.configurations).toEqual([{ name: "Older", overrides: { w: "missing * 2" } }]);
    expect(planned(stale, { kind: "deleteConfiguration", configuration: "Old" }).project.configurations).toEqual([]);
  });
});
