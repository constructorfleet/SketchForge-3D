import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "@/app/api/projects/route";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

let projectsRoot = "";
let previousProjectsRoot: string | undefined;

type Listing = { enabled: boolean; projects: Array<{ projectId: string; packageBytes: number; metadata: Record<string, unknown> }> };

function metadata(overrides: Record<string, unknown> = {}) {
  return { id: "project-1", name: "Bracket", revision: 10, updatedAt: 10, ...overrides };
}

function saveRequest(
  projectId: string,
  fields: { metadata?: unknown; project?: Uint8Array<ArrayBuffer>; revision?: number; baseRevision?: number; baseMetadataRevision?: number },
  origin = "http://localhost",
) {
  const formData = new FormData();
  if (fields.metadata !== undefined) formData.append("metadata", JSON.stringify(fields.metadata));
  if (fields.project) formData.append("project", new Blob([fields.project]));
  if (fields.revision !== undefined) formData.append("revision", String(fields.revision));
  if (fields.baseRevision !== undefined) formData.append("baseRevision", String(fields.baseRevision));
  if (fields.baseMetadataRevision !== undefined) formData.append("baseMetadataRevision", String(fields.baseMetadataRevision));
  return new Request(`http://localhost/api/projects?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { Origin: origin },
    body: formData,
  });
}

async function listing() {
  return await (await GET(new Request("http://localhost/api/projects"))).json() as Listing;
}

describe("server project storage", () => {
  beforeEach(async () => {
    previousProjectsRoot = process.env[SERVER_PROJECTS_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-projects-"));
    process.env[SERVER_PROJECTS_ENV] = projectsRoot;
  });

  afterEach(async () => {
    if (previousProjectsRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
    else process.env[SERVER_PROJECTS_ENV] = previousProjectsRoot;
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });

  it("reports itself disabled when no directory is configured", async () => {
    delete process.env[SERVER_PROJECTS_ENV];

    const payload = await listing();

    expect(payload.enabled).toBe(false);
    expect(payload.projects).toEqual([]);
  });

  it("lists a saved project with the metadata the dashboard sent", async () => {
    expect((await POST(saveRequest("project-1", { metadata: metadata() }))).status).toBe(201);

    const payload = await listing();

    expect(payload.enabled).toBe(true);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0].projectId).toBe("project-1");
    expect(payload.projects[0].metadata.name).toBe("Bracket");
  });

  it("keeps the packed project and its metadata on separate writes", async () => {
    await POST(saveRequest("project-1", { metadata: metadata() }));
    await POST(saveRequest("project-1", { project: new Uint8Array([1, 2, 3, 4]), revision: 11 }));

    const payload = await listing();
    expect(payload.projects[0].packageBytes).toBe(4);
    // The package write carried no metadata, so the name the list owns survived it.
    expect(payload.projects[0].metadata.name).toBe("Bracket");

    const response = await GET(new Request("http://localhost/api/projects?projectId=project-1"));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  // Issue #650: two clients on one directory must not overwrite each other's newer package.
  it("records a package write's revision in the sidecar, so the next writer's base can be checked", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));
    expect((await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 30, baseRevision: 10 }))).status).toBe(200);

    expect((await listing()).projects[0].metadata.revision).toBe(30);
    expect((await listing()).projects[0].metadata.name).toBe("Bracket");
  });

  it("refuses a package write whose base is older than the stored revision, even with a newer clock", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));
    // Client B saves over the revision both clients loaded.
    await POST(saveRequest("project-1", { project: new Uint8Array([2, 2]), revision: 20, baseRevision: 10 }));

    // Client A's clock is later, but its copy is still based on revision 10.
    const response = await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 40, baseRevision: 10 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorKey: "errors.projects.changedBeforeSave", conflict: "newerRevision", storedRevision: 20 });

    const stored = await GET(new Request("http://localhost/api/projects?projectId=project-1"));
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new Uint8Array([2, 2]));
    expect((await listing()).projects[0].metadata.revision).toBe(20);
  });

  it("serves a package with the sidecar revision it was stored at", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));
    await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 25, baseRevision: 10 }));

    const response = await GET(new Request("http://localhost/api/projects?projectId=project-1"));
    expect(response.headers.get("X-SketchForge-Revision")).toBe("25");
  });

  it("refuses a package write whose clock revision is older than the stored one, without calling it a conflict", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 20 }) }));

    const response = await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 10 }));

    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("conflict");
  });

  it("reports a stale base as a conflict even when the clock revision is stale too", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 20 }) }));

    const response = await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 10, baseRevision: 5 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ conflict: "newerRevision", storedRevision: 20 });
  });

  // The sidecar revision follows package writes, so a list write sent while a save
  // was in flight can carry an older one. It must still land, and not move the revision.
  it("accepts a metadata write with an older revision and keeps the stored revision", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));
    await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 20, baseRevision: 10 }));

    const response = await POST(saveRequest("project-1", { metadata: metadata({ revision: 10, name: "Renamed", thumbnailVersion: 3 }) }));

    expect(response.status).toBe(200);
    const stored = (await listing()).projects[0].metadata;
    expect(stored).toMatchObject({ name: "Renamed", thumbnailVersion: 3, revision: 20 });
  });

  // A rename or settings change does not move the package revision, so metadata has its own counter.
  it("counts metadata writes, and keeps the count across package writes", async () => {
    const first = await (await POST(saveRequest("project-1", { metadata: metadata() }))).json() as { project: { metadata: Record<string, unknown> } };
    expect(first.project.metadata.metadataRevision).toBe(1);
    await POST(saveRequest("project-1", { metadata: metadata({ name: "Renamed" }), baseMetadataRevision: 1 }));
    await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 20, baseRevision: 10 }));

    expect((await listing()).projects[0].metadata).toMatchObject({ metadataRevision: 2, revision: 20, name: "Renamed" });
  });

  it("refuses a write from a tab holding older state", async () => {
    await POST(saveRequest("project-1", { metadata: metadata() }));
    // Another client renames it.
    await POST(saveRequest("project-1", { metadata: metadata({ name: "Renamed elsewhere" }), baseMetadataRevision: 1 }));

    // This client's list still holds the first state.
    const response = await POST(saveRequest("project-1", { metadata: metadata({ thumbnailVersion: 4 }), baseMetadataRevision: 1 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ conflict: "newerMetadata", storedMetadataRevision: 2 });
    expect((await listing()).projects[0].metadata.name).toBe("Renamed elsewhere");
  });

  it("does not let a metadata write move the revision ahead of the package", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));

    await POST(saveRequest("project-1", { metadata: metadata({ revision: 99 }) }));

    expect((await listing()).projects[0].metadata.revision).toBe(10);
  });

  it("labels a missing package's 404 with the sidecar revision", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 10 }) }));

    const response = await GET(new Request("http://localhost/api/projects?projectId=project-1"));

    expect(response.status).toBe(404);
    expect(response.headers.get("X-SketchForge-Revision")).toBe("10");
  });

  it("accepts a save that repeats the revision it already stored", async () => {
    await POST(saveRequest("project-1", { metadata: metadata({ revision: 20 }) }));

    const response = await POST(saveRequest("project-1", { metadata: metadata({ revision: 20, name: "Renamed" }) }));

    expect(response.status).toBe(200);
    expect((await listing()).projects[0].metadata.name).toBe("Renamed");
  });

  it("requires something to write", async () => {
    expect((await POST(saveRequest("project-1", {}))).status).toBe(400);
  });

  it("refuses a project id that would escape the directory", async () => {
    expect((await POST(saveRequest("../escaped", { metadata: metadata() }))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/projects?projectId=..%2Fescaped"))).status).toBe(400);
    await expect(fs.access(path.join(projectsRoot, "..", "escaped.json"))).rejects.toThrow();
  });

  it("only accepts same-origin writes", async () => {
    const response = await POST(saveRequest("project-1", { metadata: metadata() }, "http://evil.example"));

    expect(response.status).toBe(403);
    expect((await listing()).projects).toEqual([]);
  });

  it("deletes both halves of a project", async () => {
    await POST(saveRequest("project-1", { metadata: metadata() }));
    await POST(saveRequest("project-1", { project: new Uint8Array([1, 2, 3]), revision: 11 }));

    const response = await DELETE(new Request("http://localhost/api/projects?projectId=project-1", { method: "DELETE", headers: { Origin: "http://localhost" } }));

    expect(response.status).toBe(200);
    expect(await fs.readdir(projectsRoot)).toEqual([]);
  });

  it("reports a project that is not there", async () => {
    const response = await DELETE(new Request("http://localhost/api/projects?projectId=project-1", { method: "DELETE", headers: { Origin: "http://localhost" } }));
    expect(response.status).toBe(404);

    const missing = await GET(new Request("http://localhost/api/projects?projectId=project-1"));
    expect(missing.status).toBe(404);
  });

  // Issue #672: a write sent before a delete can land after it.
  describe("writes based on a copy that was since deleted", () => {
    async function deleteProject() {
      await DELETE(new Request("http://localhost/api/projects?projectId=project-1", { method: "DELETE", headers: { Origin: "http://localhost" } }));
    }

    it("refuses a metadata write based on a deleted project", async () => {
      await POST(saveRequest("project-1", { metadata: metadata() }));
      await POST(saveRequest("project-1", { project: new Uint8Array([1, 2]), revision: 11, baseRevision: 10 }));
      await deleteProject();

      const response = await POST(saveRequest("project-1", { metadata: metadata({ name: "Late" }), baseMetadataRevision: 1 }));

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ conflict: "deleted", errorKey: "errors.projects.notFound" });
      expect((await listing()).projects).toEqual([]);
      expect(await fs.readdir(projectsRoot)).toEqual([]);
    });

    it("lets a client that kept a deleted project open store it again, package first", async () => {
      await POST(saveRequest("project-1", { metadata: metadata() }));
      await deleteProject();

      // Another client that kept the project open may store it again (#665), then send its entry.
      expect((await POST(saveRequest("project-1", { project: new Uint8Array([1, 2]), revision: 11, baseRevision: 10 }))).status).toBe(201);
      expect((await POST(saveRequest("project-1", { metadata: metadata(), baseMetadataRevision: 1 }))).status).toBe(201);
      expect((await listing()).projects.map((record) => record.projectId)).toEqual(["project-1"]);
    });

    it("still creates a project from a first write that names no base", async () => {
      expect((await POST(saveRequest("project-1", { metadata: metadata() }))).status).toBe(201);
      await deleteProject();

      // A new project and a migration upload both send their first write without a base.
      expect((await POST(saveRequest("project-2", { project: new Uint8Array([1]), revision: 11 }))).status).toBe(201);
      expect((await POST(saveRequest("project-2", { metadata: metadata({ id: "project-2" }) }))).status).toBe(201);
      expect((await listing()).projects.map((record) => record.projectId)).toEqual(["project-2"]);
    });

    it("accepts a based metadata write while only the package is stored", async () => {
      await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 11 }));

      expect((await POST(saveRequest("project-1", { metadata: metadata(), baseMetadataRevision: 0 }))).status).toBe(201);
    });
  });

  // Issue #672: a client re-deletes a project its own late write put back, but not one another client saved since.
  describe("deletes conditional on what a write stored", () => {
    type Stored = { revision: number; metadataRevision: number; package?: string };
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    function conditionalDelete(expected: Stored) {
      const query = new URLSearchParams({
        projectId: "project-1",
        expectedRevision: String(expected.revision),
        expectedMetadataRevision: String(expected.metadataRevision),
        ...(expected.package ? { expectedPackage: expected.package } : {}),
      });
      return DELETE(new Request(`http://localhost/api/projects?${query}`, { method: "DELETE", headers: { Origin: "http://localhost" } }));
    }

    it("reports what a package write stored, and deletes when nothing changed since", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { stored } = await (await POST(saveRequest("project-1", { project: bytes, revision: 11, baseRevision: 10 }))).json() as { stored: Stored };
      expect(stored).toEqual({ revision: 0, metadataRevision: 0, package: digest(bytes) });

      expect((await conditionalDelete(stored)).status).toBe(200);
      expect(await fs.readdir(projectsRoot)).toEqual([]);
    });

    it("keeps a project another client saved after the write the delete is based on", async () => {
      const { stored } = await (await POST(saveRequest("project-1", { project: new Uint8Array([1]), revision: 11, baseRevision: 10 }))).json() as { stored: Stored };
      // Another client that kept the project open saves it back (#665).
      await POST(saveRequest("project-1", { project: new Uint8Array([2, 2]), revision: 12, baseRevision: 10 }));
      await POST(saveRequest("project-1", { metadata: metadata(), baseMetadataRevision: 0 }));

      const response = await conditionalDelete(stored);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ conflict: "changed" });
      expect((await listing()).projects.map((record) => record.projectId)).toEqual(["project-1"]);
      expect((await fs.readdir(projectsRoot)).sort()).toEqual(["project-1.json", "project-1.skf"]);
    });

    it("reports the stored package with a create, so its delete sees a package saved since", async () => {
      const { stored } = await (await POST(saveRequest("project-1", { metadata: metadata() }))).json() as { stored: Stored };
      expect(stored).toEqual({ revision: 10, metadataRevision: 1, package: "none" });
      await POST(saveRequest("project-1", { project: new Uint8Array([2]), revision: 10, baseRevision: 10 }));

      expect((await conditionalDelete(stored)).status).toBe(409);
      expect((await listing()).projects).toHaveLength(1);
    });
  });

  it("does not list a project whose package arrived without its metadata", async () => {
    // Migration writes the package first and the metadata second, so a run
    // that fails in between leaves a project the listing does not show -- and
    // the next run migrates it again instead of opening it empty.
    await POST(saveRequest("project-1", { project: new Uint8Array([1, 2, 3]), revision: 11 }));

    expect((await listing()).projects).toEqual([]);
    expect(await fs.readdir(projectsRoot)).toEqual(["project-1.skf"]);
  });

  it("ignores a stray file that is not a project", async () => {
    await fs.writeFile(path.join(projectsRoot, "notes.txt"), "hello");
    await fs.writeFile(path.join(projectsRoot, "broken.json"), "{ not json");

    expect((await listing()).projects).toEqual([]);
  });
});
