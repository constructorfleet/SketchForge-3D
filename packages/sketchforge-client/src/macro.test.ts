import { describe, expect, it } from "vitest";
import { SketchForgeClient } from "./client.js";
import {
  defineMacro,
  macroFromModule,
  resolveMacroParams,
  resolveMacroProject,
  runMacro,
  runStamp,
} from "./macro.js";
import { fakeServer, type FakeServer } from "./testing.js";

function client(server: FakeServer) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch });
}

function projectList(...names: Array<{ id: string; name: string }>) {
  return { body: { projects: names.map((entry) => ({ ...entry, shapes: 0, revision: 1, updatedAt: 0, packageBytes: 0 })) } };
}

function createdProject(id: string, name: string) {
  return { status: 201, body: { project: { id, name, shapes: 0, revision: 1, updatedAt: 0, packageBytes: 0 } } };
}

describe("runStamp", () => {
  it("is a sortable date and time", () => {
    expect(runStamp(new Date("2026-01-02T11:45:30.123Z"))).toBe("20260102-114530");
  });
});

describe("resolveMacroParams", () => {
  it("coerces an override to the type of its default", () => {
    const resolved = resolveMacroParams({ count: 5, name: "Plate", tapped: true }, { count: "9", name: "Rail", tapped: "no" });
    expect(resolved).toEqual({ count: 9, name: "Rail", tapped: false });
  });

  it("keeps defaults nobody overrode", () => {
    expect(resolveMacroParams({ count: 5 }, {})).toEqual({ count: 5 });
  });

  it("refuses a parameter the macro does not declare, rather than ignoring a typo", () => {
    expect(() => resolveMacroParams({ count: 5 }, { cuont: "9" })).toThrow(/Unknown parameter "cuont".*count/s);
  });

  it("refuses a number that is not one", () => {
    expect(() => resolveMacroParams({ count: 5 }, { count: "many" })).toThrow(/must be a number/);
  });

  it("refuses a boolean that is neither", () => {
    expect(() => resolveMacroParams({ tapped: true }, { tapped: "maybe" })).toThrow(/must be true or false/);
  });
});

describe("resolveMacroProject", () => {
  it("stamps a fresh project's name so no run reuses another's", async () => {
    const server = fakeServer(createdProject("p9", "Bolt plate 20260102-114530"));
    const resolved = await resolveMacroProject(client(server), "fresh", {
      fallbackName: "Bolt plate",
      now: new Date("2026-01-02T11:45:30Z"),
    });
    expect(server.calls[0]?.body).toEqual({ name: "Bolt plate 20260102-114530" });
    expect(resolved).toMatchObject({ created: true, cleared: 0 });
    expect(resolved.project.id).toBe("p9");
  });

  it("empties an existing project for replace, so a rerun is idempotent", async () => {
    const server = fakeServer(
      projectList({ id: "p1", name: "Bolt plate" }),
      { body: { shapes: [{ id: "s1", locked: false }] } },
      { body: { deleted: true, id: "s1" } },
    );
    const resolved = await resolveMacroProject(client(server), { mode: "replace", name: "Bolt plate" }, {
      fallbackName: "ignored",
    });
    expect(resolved).toMatchObject({ created: false, cleared: 1 });
    expect(server.calls.map((call) => call.method)).toEqual(["GET", "GET", "DELETE"]);
  });

  it("creates the named project for replace when it is not there yet", async () => {
    const server = fakeServer(projectList(), createdProject("p2", "Bolt plate"));
    const resolved = await resolveMacroProject(client(server), { mode: "replace", name: "Bolt plate" }, {
      fallbackName: "ignored",
    });
    expect(resolved).toMatchObject({ created: true, cleared: 0 });
    expect(server.calls[1]?.body).toEqual({ name: "Bolt plate" });
  });

  it("leaves an existing project alone for reuse", async () => {
    const server = fakeServer(projectList({ id: "p1", name: "Shelf" }));
    const resolved = await resolveMacroProject(client(server), { mode: "reuse", name: "Shelf" }, { fallbackName: "Shelf" });
    expect(resolved).toMatchObject({ created: false, cleared: 0 });
    expect(server.calls).toHaveLength(1);
  });

  it("refuses to guess a project for target mode", async () => {
    const server = fakeServer({ body: {} });
    await expect(
      resolveMacroProject(client(server), "target", { fallbackName: "Add rib" }),
    ).rejects.toThrow(/SKETCHFORGE_PROJECT_ID/);
    expect(server.calls).toHaveLength(0);
  });

  it("checks the named project exists before the macro starts", async () => {
    const server = fakeServer({ body: { project: { id: "p5", name: "Frame", createdAt: 0, snapGrid: {}, workspace: {}, shapes: [] } } });
    const resolved = await resolveMacroProject(client(server), "target", { fallbackName: "Add rib", targetProjectId: "p5" });
    expect(server.calls[0]?.url).toContain("projectId=p5");
    expect(resolved.project.id).toBe("p5");
  });
});

describe("runMacro", () => {
  it("hands the macro its project and reports what landed in it", async () => {
    const server = fakeServer(
      createdProject("p3", "Row 20260102-114530"),
      { status: 201, body: { shapes: [{ id: "s1" }], revision: 2 } },
      { body: { shapes: [{ id: "s1" }, { id: "s2" }] } },
    );
    const macro = defineMacro({
      name: "Row",
      project: "fresh",
      params: { count: 2 },
      run: async ({ project, params }) => {
        await project.add({ kind: "box", width: params.count });
        return { count: params.count };
      },
    });

    const report = await runMacro(client(server), macro, { params: { count: "3" }, now: new Date("2026-01-02T11:45:30Z") });
    expect(report).toMatchObject({
      macro: "Row",
      projectId: "p3",
      projectCreated: true,
      shapeCount: 2,
      result: { count: 3 },
    });
    expect(server.calls[1]?.body).toEqual({ kind: "box", width: 3 });
  });

  it("refuses a bad parameter before it creates anything", async () => {
    const server = fakeServer({ body: {} });
    const macro = defineMacro({ name: "Row", project: "fresh", params: { count: 2 }, run: () => undefined });
    await expect(runMacro(client(server), macro, { params: { count: "lots" } })).rejects.toThrow(/must be a number/);
    expect(server.calls).toHaveLength(0);
  });
});

describe("macroFromModule", () => {
  it("takes a defined macro from the default export", () => {
    const macro = defineMacro({ name: "Plate", project: "replace", run: () => undefined });
    expect(macroFromModule({ default: macro }, "file")).toMatchObject({ name: "Plate", project: "replace" });
  });

  it("takes a named macro export", () => {
    const macro = defineMacro({ name: "Plate", project: "reuse", run: () => undefined });
    expect(macroFromModule({ macro }, "file")).toMatchObject({ project: "reuse" });
  });

  it("runs a bare exported function in a fresh project, the only safe assumption", () => {
    expect(macroFromModule({ default: () => undefined }, "bolt-plate")).toMatchObject({
      name: "bolt-plate",
      project: "fresh",
    });
  });

  it("explains itself when the module exports something else", () => {
    expect(() => macroFromModule({ default: 42 }, "bolt-plate")).toThrow(/does not look like a macro/);
    expect(() => macroFromModule({}, "bolt-plate")).toThrow(/defineMacro/);
  });

  it("rejects a macro object with no project mode, rather than choosing one", () => {
    expect(() => macroFromModule({ default: { name: "x", run: () => undefined } }, "file")).toThrow(/does not look like a macro/);
  });
});
