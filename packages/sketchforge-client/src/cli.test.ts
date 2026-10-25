import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SketchForgeClient } from "./client.js";
import { fakeServer } from "./testing.js";
import { executeDirectCommand } from "./cli.js";

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
});
