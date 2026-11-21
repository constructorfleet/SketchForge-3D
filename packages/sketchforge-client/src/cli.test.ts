import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SketchForgeClient } from "./client.js";
import { fakeServer } from "./testing.js";
import { executeDirectCommand, explainFailure } from "./cli.js";
import { SketchForgeApiError } from "./errors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function client(server: ReturnType<typeof fakeServer>) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch });
}

const project = { id: "p1", name: "Plate", shapes: 1, revision: 1, updatedAt: 0, packageBytes: 128 };

describe("direct CLI commands", () => {
  it("lists, creates, and deletes projects through the client resources", async () => {
    const server = fakeServer(
      { body: { projects: [project] } },
      { status: 201, body: { project } },
      { body: { deleted: true, id: "p1" } },
    );
    const api = client(server);

    await expect(executeDirectCommand(["projects", "list"], api)).resolves.toContain("Plate");
    await expect(executeDirectCommand(["projects", "create", "Plate"], api)).resolves.toContain("p1");
    await expect(executeDirectCommand(["projects", "delete", "p1"], api)).resolves.toContain("Deleted");
    expect(server.calls.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "http://localhost:3100/api/v1/projects"],
      ["POST", "http://localhost:3100/api/v1/projects"],
      ["DELETE", "http://localhost:3100/api/v1/projects?projectId=p1"],
    ]);
  });

  it("exports an artifact to the requested output path", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-cli-"));
    directories.push(directory);
    const output = path.join(directory, "part.stl");
    const server = fakeServer({ body: { format: "stl", filename: "part.stl", mimeType: "model/stl", bytes: 3, shapeCount: 1, base64: "AQID" } });

    await expect(executeDirectCommand(["export", "--format", "stl", "--out", output], client(server), { SKETCHFORGE_PROJECT_ID: "p1" })).resolves.toContain("part.stl");
    expect([...await fs.readFile(output)]).toEqual([1, 2, 3]);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/exports?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ format: "stl" });
  });

  it("imports a file into a newly created project through the client resources", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-cli-"));
    directories.push(directory);
    const file = path.join(directory, "bracket.stl");
    await fs.writeFile(file, Uint8Array.from([1, 2, 3]));
    const server = fakeServer(
      { status: 201, body: { project } },
      { status: 201, body: { shape: { id: "s1", name: "bracket", kind: "mesh" }, triangles: 1, revision: 2 } },
    );

    await expect(executeDirectCommand(["import", file], client(server))).resolves.toContain("p1");
    expect(server.calls[0]?.body).toEqual({ name: "bracket" });
    expect(server.calls[1]?.url).toBe("http://localhost:3100/api/v1/imports?projectId=p1");
    expect(server.calls[1]?.body).toMatchObject({ fileName: "bracket.stl", data: "AQID" });
  });

  it("lists, creates, changes, renames, and deletes parameters in the selected project", async () => {
    const wall = { name: "wall", expression: "2 mm", dimension: "length", value: 2 };
    const written = { parameter: wall, parameters: [wall], shapes: [{ id: "s1" }], revision: 2 };
    const server = fakeServer(
      { body: { parameters: [wall], bindingIssues: [{ shapeId: "s1", field: "width", code: "unknownName", message: "Unknown name gap." }], revision: 1 } },
      { status: 201, body: written },
      { body: { ...written, parameter: { ...wall, expression: "3 mm", value: 3 } } },
      { body: { ...written, parameter: { ...wall, name: "shell" } } },
      { body: { deleted: true, name: "shell", parameters: [], shapes: [], revision: 5 } },
    );
    const api = client(server);
    const environment = { SKETCHFORGE_PROJECT_ID: "p1" };

    const listed = await executeDirectCommand(["parameters", "list"], api, environment);
    expect(listed).toContain("wall\t2 mm\tlength\t2");
    expect(listed).toContain("s1 width: Unknown name gap.");
    await expect(executeDirectCommand(["parameters", "create", "wall", "2 mm"], api, environment)).resolves.toContain("Created parameter wall = 2 (1 shape rebuilt).");
    await expect(executeDirectCommand(["parameters", "update", "wall", "--expression", "3 mm", "--project", "p2"], api, environment)).resolves.toContain("wall = 3");
    await expect(executeDirectCommand(["parameters", "rename", "wall", "shell"], api, environment)).resolves.toContain("Renamed parameter wall to shell");
    await expect(executeDirectCommand(["parameters", "delete", "shell"], api, environment)).resolves.toContain("Deleted parameter shell.");

    expect(server.calls.map(({ method, url, body }) => [method, new URL(url).search, body])).toEqual([
      ["GET", "?projectId=p1", undefined],
      ["POST", "?projectId=p1", { name: "wall", expression: "2 mm", dimension: "length" }],
      ["PATCH", "?projectId=p2&name=wall", { expression: "3 mm" }],
      ["PATCH", "?projectId=p1&name=wall", { name: "shell" }],
      ["DELETE", "?projectId=p1&name=shell", undefined],
    ]);
  });

  it("refuses a parameter dimension the server does not know, before sending anything", async () => {
    const server = fakeServer({ body: {} });
    await expect(executeDirectCommand(["parameters", "create", "wall", "2", "--dimension", "volume"], client(server), { SKETCHFORGE_PROJECT_ID: "p1" })).rejects.toThrow(/length, angle, unitless/);
    await expect(executeDirectCommand(["parameters", "update", "wall"], client(server), { SKETCHFORGE_PROJECT_ID: "p1" })).rejects.toThrow(/--expression or --dimension/);
    expect(server.calls).toHaveLength(0);
  });
});

describe("CLI failure messages", () => {
  function inUse(body: Record<string, unknown>) {
    return new SketchForgeApiError({
      method: "DELETE",
      url: "http://localhost:3100/api/v1/parameters?projectId=p1&name=wall",
      status: 409,
      code: "parameter_in_use",
      detail: "Parameter \"wall\" is in use.",
      body: { error: "Parameter \"wall\" is in use.", code: "parameter_in_use", parameter: "wall", ...body },
    });
  }

  it("names everything that still uses a parameter a delete was refused for", () => {
    const message = explainFailure(inUse({
      dependents: ["gap"],
      shapeDependents: [{ shapeId: "s1", fields: ["width", "x"] }],
      sketchConstraintDependents: [{ shapeId: "s2", constraintIds: ["c1", "c2"] }],
      configurationDependents: ["Large"],
    }));
    expect(message).toBe([
      "Parameter \"wall\" is in use.",
      "Still used by: parameter gap, shape s1 (width, x), sketch s2 (constraints c1, c2), configuration Large.",
    ].join("\n"));
  });

  it("keeps the server's sentence alone when it names no dependents", () => {
    expect(explainFailure(inUse({}))).toBe("Parameter \"wall\" is in use.");
  });
});
