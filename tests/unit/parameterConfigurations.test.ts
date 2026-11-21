import { describe, expect, it } from "vitest";
import {
  activateConfiguration,
  addConfiguration,
  addParameter,
  clearConfigurationOverride,
  configurationIssues,
  deleteConfiguration,
  deleteParameter,
  PROJECT_CONFIGURATION_LIMIT,
  renameConfiguration,
  renameParameter,
  resolveConfiguration,
  setConfigurationOverride,
  updateParameter,
  type ProjectConfiguration,
  type ProjectParameter,
  type ProjectParameterError,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine";
import { SKF_LIMITS } from "@constructorfleet/sketchforge-engine/skfProject";

type Project = {
  parameters: ProjectParameter[];
  configurations?: ProjectConfiguration[];
  activeConfiguration?: string | null;
  shapes: string[];
};

function ok<T>(result: ProjectParameterResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}

function failed<T>(result: ProjectParameterResult<T>): ProjectParameterError {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

function resolved(current: Project, name: string | null) {
  const table = resolveConfiguration(current, name);
  if (!table.ok) throw new Error(table.error.message);
  return { ...current, parameters: table.parameters };
}

function values(current: Project) {
  return Object.fromEntries(current.parameters.map((parameter) => [parameter.name, parameter.value]));
}

/** wall = 2 mm, depth = wall * 5, with configurations Small (base) and Large (wall = 4). */
function configured(): Project {
  let current: Project = { parameters: [], shapes: ["kept"] };
  current = ok(addParameter(current, { name: "wall", expression: "2", dimension: "length" }));
  current = ok(addParameter(current, { name: "depth", expression: "wall * 5", dimension: "length" }));
  current = ok(addConfiguration(current, { name: "Small" }));
  current = ok(addConfiguration(current, { name: "Large", overrides: { wall: "4" } }));
  return current;
}

describe("parameter configurations", () => {
  it("adds configurations without changing the base values, and keeps other project fields", () => {
    const current = configured();

    expect(current.configurations).toEqual([{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "4" } }]);
    expect(current.activeConfiguration).toBeNull();
    expect(values(current)).toEqual({ wall: 2, depth: 10 });
    expect(current.shapes).toEqual(["kept"]);
  });

  it("resolves values under the active configuration and keeps base expressions", () => {
    const large = ok(activateConfiguration(configured(), "Large"));

    expect(large.activeConfiguration).toBe("Large");
    expect(large.parameters).toEqual([
      { name: "wall", expression: "2", dimension: "length", value: 4 },
      { name: "depth", expression: "wall * 5", dimension: "length", value: 20 },
    ]);
    const base = ok(activateConfiguration(large, null));
    expect(base.activeConfiguration).toBeNull();
    expect(values(base)).toEqual({ wall: 2, depth: 10 });
  });

  it("does not change the input project", () => {
    const before = configured();
    const snapshot = structuredClone(before);
    ok(activateConfiguration(before, "Large"));
    ok(setConfigurationOverride(before, "Small", "wall", "1"));
    ok(renameParameter(before, "wall", "shell"));
    expect(before).toEqual(snapshot);
  });

  it("resolves any configuration on demand without activating it", () => {
    const current = configured();
    expect(values(resolved(current, "Large"))).toEqual({ wall: 4, depth: 20 });
    expect(values(resolved(current, null))).toEqual({ wall: 2, depth: 10 });
    expect(resolveConfiguration(current, "Medium")).toMatchObject({ ok: false, error: { code: "unknownConfiguration" } });
  });

  it("sets and clears overrides, and recomputes the active table", () => {
    let current = ok(activateConfiguration(configured(), "Large"));
    current = ok(setConfigurationOverride(current, "Large", "depth", "wall * 10"));
    expect(values(current)).toEqual({ wall: 4, depth: 40 });
    expect(current.configurations![1]).toEqual({ name: "Large", overrides: { wall: "4", depth: "wall * 10" } });

    current = ok(clearConfigurationOverride(current, "Large", "wall"));
    expect(values(current)).toEqual({ wall: 2, depth: 20 });
    expect(current.configurations![1]).toEqual({ name: "Large", overrides: { depth: "wall * 10" } });
  });

  it("validates an override in a configuration that is not active", () => {
    const current = configured();
    expect(failed(setConfigurationOverride(current, "Small", "wall", "30 deg"))).toMatchObject({
      code: "invalidExpression", parameter: "wall", configuration: "Small", expressionError: { code: "dimensionMismatch" },
    });
    expect(failed(setConfigurationOverride(current, "Small", "wall", "depth"))).toMatchObject({
      code: "invalidExpression", configuration: "Small", expressionError: { code: "cycle" },
    });
    expect(failed(setConfigurationOverride(current, "Small", "missing", "1"))).toMatchObject({ code: "unknownParameter", parameter: "missing" });
    expect(failed(setConfigurationOverride(current, "Medium", "wall", "1"))).toMatchObject({ code: "unknownConfiguration", configuration: "Medium" });
    expect(failed(addConfiguration(current, { name: "Bad", overrides: { wall: "1 deg" } }))).toMatchObject({ code: "invalidExpression", configuration: "Bad" });
  });

  it("refuses a base change that breaks a configuration that is not active", () => {
    let current = ok(addParameter(configured(), { name: "lip", expression: "1", dimension: "length" }));
    current = ok(setConfigurationOverride(current, "Large", "lip", "depth / 10"));

    // A dimension change in the base breaks the Large override of lip, which reads depth.
    expect(failed(updateParameter(current, "depth", { expression: "30", dimension: "angle" }))).toMatchObject({
      code: "invalidExpression", parameter: "lip", configuration: "Large",
    });
  });

  it("renames parameters inside configuration rows, keys and override expressions", () => {
    const current = ok(setConfigurationOverride(configured(), "Large", "depth", "wall * 6"));
    const renamed = ok(renameParameter(current, "wall", "shell"));

    expect(renamed.configurations).toEqual([
      { name: "Small", overrides: {} },
      { name: "Large", overrides: { shell: "4", depth: "shell * 6" } },
    ]);
    expect(values(resolved(renamed, "Large"))).toEqual({ shell: 4, depth: 24 });
  });

  it("refuses to delete a parameter an override references, and drops the deleted parameter's own overrides", () => {
    let current = ok(addParameter(configured(), { name: "lip", expression: "1", dimension: "length" }));
    current = ok(setConfigurationOverride(current, "Small", "depth", "lip * 10"));
    current = ok(setConfigurationOverride(current, "Large", "lip", "3"));

    expect(failed(deleteParameter(current, "lip"))).toMatchObject({ code: "parameterInUse", parameter: "lip", configurationDependents: ["Small"] });

    current = ok(clearConfigurationOverride(current, "Small", "depth"));
    const deleted = ok(deleteParameter(current, "lip"));
    expect(deleted.configurations).toEqual([{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "4" } }]);
  });

  it("renames and deletes configurations, and the active name follows", () => {
    let current = ok(activateConfiguration(configured(), "Large"));
    current = ok(renameConfiguration(current, "Large", "XL"));
    expect(current.activeConfiguration).toBe("XL");
    expect(current.configurations!.map(({ name }) => name)).toEqual(["Small", "XL"]);
    expect(failed(renameConfiguration(current, "XL", "Small"))).toMatchObject({ code: "duplicateConfigurationName" });

    current = ok(deleteConfiguration(current, "XL"));
    expect(current.activeConfiguration).toBeNull();
    expect(values(current)).toEqual({ wall: 2, depth: 10 });
    expect(failed(deleteConfiguration(current, "XL"))).toMatchObject({ code: "unknownConfiguration" });
  });

  it("rejects invalid and duplicate configuration names", () => {
    const current = configured();
    for (const name of ["", "  ", " Large", "a\nb", "x".repeat(101), 3 as unknown as string]) {
      expect(failed(addConfiguration(current, { name })).code).toBe("invalidConfigurationName");
    }
    expect(failed(addConfiguration(current, { name: "Large" })).code).toBe("duplicateConfigurationName");
    expect(failed(activateConfiguration(current, "Medium")).code).toBe("unknownConfiguration");
  });

  it("refuses activation that breaks an entry the current table resolves", () => {
    // A stale override, as a tolerant load keeps it.
    const current: Project = { ...configured(), configurations: [{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "nope" } }] };
    expect(configurationIssues(current)).toEqual([
      expect.objectContaining({ configuration: "Large", parameter: "wall", error: expect.objectContaining({ code: "invalidExpression" }) }),
      expect.objectContaining({ configuration: "Large", parameter: "depth" }),
    ]);
    expect(failed(activateConfiguration(current, "Large"))).toMatchObject({ code: "invalidExpression", parameter: "wall", configuration: "Large" });
    // A base change to the overridden parameter itself does not touch the stale Large entry.
    expect(values(ok(updateParameter(current, "wall", { expression: "3" })))).toEqual({ wall: 3, depth: 15 });
  });

  it("does not let a stale override in an inactive configuration block edits to its dependents", () => {
    // Large's wall override is stale, so Large's depth, which reads wall, fails there before and after each edit.
    const current: Project = { ...configured(), configurations: [{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "nope" } }] };

    expect(values(ok(updateParameter(current, "depth", { expression: "wall * 6" })))).toEqual({ wall: 2, depth: 12 });
    expect(values(ok(addParameter(current, { name: "lip", expression: "wall / 2", dimension: "length" })))).toEqual({ wall: 2, depth: 10, lip: 1 });
    expect(values(ok(renameParameter(current, "depth", "deep")))).toEqual({ wall: 2, deep: 10 });
    expect(values(ok(renameParameter(current, "wall", "shell")))).toEqual({ shell: 2, depth: 10 });
    expect(ok(renameParameter(current, "wall", "shell")).configurations![1]!.overrides).toEqual({ shell: "nope" });
    expect(values(ok(deleteParameter(current, "depth")))).toEqual({ wall: 2 });

    // A new parameter must still resolve where its own dependencies do.
    expect(failed(addParameter(current, { name: "bad", expression: "wall * wall", dimension: "length" }))).toMatchObject({ code: "invalidExpression", parameter: "bad" });
    // A dependent the edit itself breaks is still refused, in Small, which resolved it before.
    expect(failed(updateParameter(current, "depth", { expression: "30 deg" }))).toMatchObject({ code: "invalidExpression", parameter: "depth" });
  });

  it("holds the active configuration to the base rule: a touched entry must resolve there", () => {
    const current: Project = { ...configured(), configurations: [{ name: "Large", overrides: { wall: "nope" } }], activeConfiguration: "Large" };

    expect(failed(addParameter(current, { name: "lip", expression: "wall / 2", dimension: "length" }))).toMatchObject({ parameter: "lip", configuration: "Large" });
    expect(failed(updateParameter(current, "depth", { expression: "wall * 7" }))).toMatchObject({ parameter: "depth", configuration: "Large" });
    // A literal does not read the stale entry, so it resolves.
    expect(values(ok(updateParameter(current, "depth", { expression: "12" }))).depth).toBe(12);
  });

  it("does not let a stale base entry block a rename", () => {
    const stale: Project = { ...configured(), parameters: [{ name: "wall", expression: "nope", dimension: "length", value: 2 }, configured().parameters[1]!] };
    expect(values(ok(renameParameter(stale, "wall", "shell")))).toEqual({ shell: 2, depth: 10 });
  });

  it("does not count an override key that names no parameter as a dependent", () => {
    const current: Project = { ...configured(), configurations: [{ name: "Small", overrides: { ghost: "wall * 3" } }, { name: "Large", overrides: { depth: "wall * 2" } }] };
    expect(failed(deleteParameter(current, "wall"))).toMatchObject({ code: "parameterInUse", configurationDependents: ["Large"] });
    const onlyGhost: Project = { ...current, configurations: [{ name: "Small", overrides: { ghost: "lip" } }] };
    const withLip = ok(addParameter({ ...onlyGhost, configurations: [] }, { name: "lip", expression: "1", dimension: "length" }));
    expect(ok(deleteParameter({ ...withLip, configurations: onlyGhost.configurations }, "lip")).parameters.map(({ name }) => name)).toEqual(["wall", "depth"]);
  });

  it("drops a stale override instead of applying it to a parameter added or renamed to its name", () => {
    // Keys naming no parameter, as a tolerant load keeps them.
    const stale: Project = { ...configured(), configurations: [{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "4", lip: "50", rim: "70" } }], activeConfiguration: "Large" };

    const added = ok(addParameter(stale, { name: "lip", expression: "1", dimension: "length" }));
    expect(values(added).lip).toBe(1);
    expect(added.configurations![1]!.overrides).toEqual({ wall: "4", rim: "70" });

    const renamed = ok(renameParameter(stale, "depth", "rim"));
    expect(values(renamed).rim).toBe(20);
    expect(renamed.configurations![1]!.overrides).toEqual({ wall: "4", lip: "50" });
  });

  it("returns structured errors for malformed input instead of throwing", () => {
    const current = configured();
    expect(failed(addConfiguration(current, null as never)).code).toBe("invalidConfiguration");
    expect(failed(addConfiguration(current, { name: "Odd", overrides: { wall: 3 } as never })).code).toBe("invalidConfiguration");
    expect(failed(activateConfiguration({ ...current, configurations: "x" as never }, null)).code).toBe("invalidConfiguration");
    expect(failed(setConfigurationOverride(current, "Small", "wall", 3 as never)).code).toBe("invalidExpression");
  });

  it("caps the number of configurations at the .skf limit", () => {
    expect(PROJECT_CONFIGURATION_LIMIT).toBe(SKF_LIMITS.configurations);
    const full: Project = {
      ...configured(),
      configurations: Array.from({ length: PROJECT_CONFIGURATION_LIMIT }, (_, index) => ({ name: `C${index}`, overrides: {} })),
    };
    expect(failed(addConfiguration(full, { name: "One more" })).code).toBe("tooManyConfigurations");
  });

  it("keeps projects without configurations free of configuration fields", () => {
    const plain = ok(addParameter({ parameters: [], shapes: [] }, { name: "wall", expression: "2", dimension: "length" }));
    expect(plain).toEqual({ parameters: [{ name: "wall", expression: "2", dimension: "length", value: 2 }], shapes: [] });
  });
});
