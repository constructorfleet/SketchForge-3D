import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/projects/route";
import { POST as createApiProject } from "@/app/api/v1/projects/route";
import { PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { directoryProjectStore } from "@constructorfleet/sketchforge-engine";
import { readProjectDocument, writeProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";

// Pins every refusal and revision rule of both server write paths (#677).

const TOKEN = "characterisation-token";
let root = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-write-paths-"));
  process.env[SERVER_PROJECTS_ENV] = root;
  process.env[API_TOKEN_ENV] = TOKEN;
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
  else process.env[SERVER_PROJECTS_ENV] = previousRoot;
  if (previousToken === undefined) delete process.env[API_TOKEN_ENV];
  else process.env[API_TOKEN_ENV] = previousToken;
  await fs.rm(root, { recursive: true, force: true });
});

type Fields = { metadata?: unknown; project?: Uint8Array<ArrayBuffer>; revision?: string; baseRevision?: string; baseMetadataRevision?: string };

function post(fields: Fields, projectId = "p1") {
  const formData = new FormData();
  if (fields.metadata !== undefined) formData.append("metadata", JSON.stringify(fields.metadata));
  if (fields.project) formData.append("project", new Blob([fields.project]));
  if (fields.revision !== undefined) formData.append("revision", fields.revision);
  if (fields.baseRevision !== undefined) formData.append("baseRevision", fields.baseRevision);
  if (fields.baseMetadataRevision !== undefined) formData.append("baseMetadataRevision", fields.baseMetadataRevision);
  return POST(new Request(`http://localhost/api/projects?projectId=${projectId}`, { method: "POST", headers: { Origin: "http://localhost" }, body: formData }));
}

function remove(projectId = "p1") {
  return DELETE(new Request(`http://localhost/api/projects?projectId=${projectId}`, { method: "DELETE", headers: { Origin: "http://localhost" } }));
}

async function sidecar(projectId = "p1") {
  return JSON.parse(await fs.readFile(path.join(root, `${projectId}.json`), "utf8").catch(() => "null")) as unknown;
}

async function packageBytes(projectId = "p1") {
  return fs.readFile(path.join(root, `${projectId}.skf`)).then((bytes) => [...bytes]).catch(() => null);
}

async function outcome(response: Response | Promise<Response>) {
  const settled = await response;
  return { status: settled.status, body: await settled.json() as unknown, sidecar: await sidecar(), package: await packageBytes() };
}

async function seed(metadata: Record<string, unknown> | null, bytes: number[] | null = null) {
  if (metadata) await fs.writeFile(path.join(root, "p1.json"), JSON.stringify(metadata));
  if (bytes) await fs.writeFile(path.join(root, "p1.skf"), new Uint8Array(bytes));
}

async function tombstone(record: Record<string, unknown> | string) {
  await fs.mkdir(path.join(root, ".deleted"), { recursive: true });
  await fs.writeFile(path.join(root, ".deleted", "p1.json"), typeof record === "string" ? record : JSON.stringify(record));
}

const stored = { id: "p1", name: "Stored", revision: 20, updatedAt: 20, metadataRevision: 3 };
const bytes = new Uint8Array([9, 8, 7]);

describe("dashboard POST /api/projects refusals", () => {
  it("refuses any write to a deleted project with the deleted revision", async () => {
    await tombstone({ deletedAt: 1, revision: 33, metadataRevision: 4 });
    expect(await outcome(post({ metadata: stored }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "deleted",
          "deletedRevision": 33,
          "error": "This project was deleted from the server",
          "errorKey": "errors.projects.deleted",
        },
        "package": null,
        "sidecar": null,
        "status": 410,
      }
    `);
    expect(await outcome(post({ project: bytes, revision: "40", baseRevision: "33" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "deleted",
          "deletedRevision": 33,
          "error": "This project was deleted from the server",
          "errorKey": "errors.projects.deleted",
        },
        "package": null,
        "sidecar": null,
        "status": 410,
      }
    `);
  });

  it("refuses a write to a project whose delete record is unreadable, naming revision 0", async () => {
    await tombstone("{not json");
    expect(await outcome(post({ project: bytes, revision: "40" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "deleted",
          "deletedRevision": 0,
          "error": "This project was deleted from the server",
          "errorKey": "errors.projects.deleted",
        },
        "package": null,
        "sidecar": null,
        "status": 410,
      }
    `);
  });

  it("refuses a write even when the files outlived their delete record", async () => {
    await seed(stored, [1]);
    await tombstone({ deletedAt: 1, revision: 20, metadataRevision: 3 });
    expect(await outcome(post({ metadata: { ...stored, name: "Late" }, baseMetadataRevision: "3" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "deleted",
          "deletedRevision": 20,
          "error": "This project was deleted from the server",
          "errorKey": "errors.projects.deleted",
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 410,
      }
    `);
  });

  it("refuses a based metadata-only write when no file is stored, without a deleted revision", async () => {
    expect(await outcome(post({ metadata: stored, baseMetadataRevision: "0" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "deleted",
          "error": "This project was deleted from the server",
          "errorKey": "errors.projects.deleted",
        },
        "package": null,
        "sidecar": null,
        "status": 410,
      }
    `);
  });

  it("does not treat a non-numeric metadata base as based", async () => {
    expect(await outcome(post({ metadata: stored, baseMetadataRevision: "x" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 1,
              "name": "Stored",
              "revision": 20,
              "updatedAt": 20,
            },
            "packageBytes": 0,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": null,
        "sidecar": {
          "id": "p1",
          "metadataRevision": 1,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 201,
      }
    `);
  });

  it("refuses a package with a stale base as a conflict naming the stored revision", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ project: bytes, revision: "99", baseRevision: "19" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "newerRevision",
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
          "storedRevision": 20,
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("prefers the base conflict over the clock refusal", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ project: bytes, revision: "5", baseRevision: "19" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "newerRevision",
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
          "storedRevision": 20,
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("refuses a package with a stale clock revision without a conflict field", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ project: bytes, revision: "19" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("takes a combined write's clock revision from its metadata", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ metadata: { ...stored, revision: 19 }, project: bytes, revision: "99" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("refuses a metadata write with a stale metadata base", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ metadata: { ...stored, name: "Stale" }, baseMetadataRevision: "2" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "conflict": "newerMetadata",
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
          "storedMetadataRevision": 3,
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("prefers the clock refusal over the metadata conflict", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ metadata: { ...stored, revision: 19 }, project: bytes, baseMetadataRevision: "2" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "This project was changed elsewhere. Reload before saving again.",
          "errorKey": "errors.projects.changedBeforeSave",
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });

  it("reports a held lock as busy", async () => {
    await seed(stored, [1]);
    await fs.writeFile(path.join(root, "p1.lock"), "");
    expect(await outcome(post({ metadata: stored }))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "This project is currently being saved",
          "errorKey": "errors.projects.busySaving",
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 409,
      }
    `);
  });
});

describe("dashboard POST /api/projects revision rules", () => {
  it("creates a project from metadata, counting the first metadata write", async () => {
    expect(await outcome(post({ metadata: { id: "p1", name: "New", revision: 7, updatedAt: 7 } }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 1,
              "name": "New",
              "revision": 7,
              "updatedAt": 7,
            },
            "packageBytes": 0,
            "projectId": "p1",
            "updatedAt": 7,
          },
        },
        "package": null,
        "sidecar": {
          "id": "p1",
          "metadataRevision": 1,
          "name": "New",
          "revision": 7,
          "updatedAt": 7,
        },
        "status": 201,
      }
    `);
  });

  it("keeps the stored package revision on a metadata-only write", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ metadata: { ...stored, name: "Renamed", revision: 50 }, baseMetadataRevision: "3" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 4,
              "name": "Renamed",
              "revision": 20,
              "updatedAt": 20,
            },
            "packageBytes": 1,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 4,
          "name": "Renamed",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("keeps the sent revision on a metadata-only write when the stored one is not positive", async () => {
    await seed({ ...stored, revision: 0 }, [1]);
    expect(await outcome(post({ metadata: { ...stored, revision: 50 } }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 4,
              "name": "Stored",
              "revision": 50,
              "updatedAt": 20,
            },
            "packageBytes": 1,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 4,
          "name": "Stored",
          "revision": 50,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("accepts a based metadata write while only the package is stored", async () => {
    await seed(null, [1]);
    expect(await outcome(post({ metadata: stored, baseMetadataRevision: "0" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 1,
              "name": "Stored",
              "revision": 20,
              "updatedAt": 20,
            },
            "packageBytes": 1,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          1,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 1,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 201,
      }
    `);
  });

  it("raises the sidecar revision to a newer package and reports the sidecar as it was", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ project: bytes, revision: "30", baseRevision: "20" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 3,
              "name": "Stored",
              "revision": 20,
              "updatedAt": 20,
            },
            "packageBytes": 3,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 30,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("leaves the sidecar alone for a package at the stored revision", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ project: bytes, revision: "20", baseRevision: "20" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 3,
              "name": "Stored",
              "revision": 20,
              "updatedAt": 20,
            },
            "packageBytes": 3,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 20,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("leaves the sidecar alone for a package with no revision field, even below a negative stored revision", async () => {
    await seed({ ...stored, revision: -5 }, [1]);
    expect(await outcome(post({ project: bytes }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 3,
              "name": "Stored",
              "revision": -5,
              "updatedAt": 20,
            },
            "packageBytes": 3,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": -5,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("treats a non-numeric package revision as revision 0", async () => {
    await seed({ ...stored, revision: -5 }, [1]);
    expect(await outcome(post({ project: bytes, revision: "abc", baseRevision: "abc" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 3,
              "name": "Stored",
              "revision": -5,
              "updatedAt": 20,
            },
            "packageBytes": 3,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 3,
          "name": "Stored",
          "revision": 0,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });

  it("stores a package with no sidecar and reports no project", async () => {
    expect(await outcome(post({ project: bytes, revision: "30" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": null,
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": null,
        "status": 201,
      }
    `);
  });

  it("writes a combined write's metadata revision as sent", async () => {
    await seed(stored, [1]);
    expect(await outcome(post({ metadata: { ...stored, revision: 40, name: "Both" }, project: bytes, revision: "99", baseRevision: "20", baseMetadataRevision: "3" }))).toMatchInlineSnapshot(`
      {
        "body": {
          "project": {
            "metadata": {
              "id": "p1",
              "metadataRevision": 4,
              "name": "Both",
              "revision": 40,
              "updatedAt": 20,
            },
            "packageBytes": 3,
            "projectId": "p1",
            "updatedAt": 20,
          },
        },
        "package": [
          9,
          8,
          7,
        ],
        "sidecar": {
          "id": "p1",
          "metadataRevision": 4,
          "name": "Both",
          "revision": 40,
          "updatedAt": 20,
        },
        "status": 200,
      }
    `);
  });
});

describe("stored sidecar text and revision headers", () => {
  it("writes the dashboard sidecar as indented JSON and serves the package with its revision", async () => {
    await seed(stored, [1]);
    await post({ project: bytes, revision: "30", baseRevision: "20" });
    expect(await fs.readFile(path.join(root, "p1.json"), "utf8")).toBe(`${JSON.stringify({ ...stored, revision: 30 }, null, 2)}\n`);
    const served = await GET(new Request("http://localhost/api/projects?projectId=p1"));
    expect(served.headers.get("X-SketchForge-Revision")).toBe("30");
  });

  it("writes the REST sidecar as indented JSON and answers with the new revision as the ETag", async () => {
    const authorized = (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Content-Type", "application/json");
      return new Request(`http://localhost${url}`, { ...init, headers });
    };
    const created = await createApiProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Pinned" }) }));
    const projectId = (await created.json() as { project: { id: string } }).project.id;
    const shapes = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ kind: "cube", size: 10 }) }));
    const { revision } = await shapes.json() as { revision: number };

    expect(shapes.headers.get("etag")).toBe(`"${revision}"`);
    const text = await fs.readFile(path.join(root, `${projectId}.json`), "utf8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(JSON.parse(text)).toMatchObject({ revision, updatedAt: revision, shapes: 1, metadataRevision: 1 });
  });
});

describe("dashboard DELETE /api/projects", () => {
  it("deletes a stored project and records its revisions", async () => {
    await seed(stored, [1]);
    expect(await outcome(remove())).toMatchInlineSnapshot(`
      {
        "body": {
          "deleted": true,
          "projectId": "p1",
        },
        "package": null,
        "sidecar": null,
        "status": 200,
      }
    `);
    const record = JSON.parse(await fs.readFile(path.join(root, ".deleted", "p1.json"), "utf8")) as Record<string, number>;
    expect({ ...record, deletedAt: typeof record.deletedAt }).toMatchInlineSnapshot(`
      {
        "deletedAt": "number",
        "metadataRevision": 3,
        "revision": 20,
      }
    `);
  });

  it("records a delete for a project it never held and reports it missing", async () => {
    expect(await outcome(remove())).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "That project is not on the server",
          "errorKey": "errors.projects.notFound",
        },
        "package": null,
        "sidecar": null,
        "status": 404,
      }
    `);
    expect(await fs.readdir(path.join(root, ".deleted"))).toEqual(["p1.json"]);
  });
});

describe("REST v1 and MCP store", () => {
  function caught(promise: Promise<unknown>) {
    return promise.then(
      (value) => ({ value }),
      (error: Error & { currentRevision?: number }) => ({ error: { name: error.name, message: error.message, currentRevision: error.currentRevision } }),
    );
  }

  it("refuses an If-Match that does not name the stored revision", async () => {
    await seed(stored);
    expect(await caught(directoryProjectStore(root, "19").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "error": {
          "currentRevision": 20,
          "message": "The project changed since the supplied revision.",
          "name": "ProjectRevisionMismatchError",
        },
      }
    `);
    expect(await caught(directoryProjectStore(root, "20").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
    expect(await caught(directoryProjectStore(root, "*").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
    expect(await caught(directoryProjectStore(root).withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
  });

  it("compares If-Match against revision 0 when the stored one is not a number", async () => {
    await seed({ ...stored, revision: "20" });
    expect(await caught(directoryProjectStore(root, "20").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "error": {
          "currentRevision": 0,
          "message": "The project changed since the supplied revision.",
          "name": "ProjectRevisionMismatchError",
        },
      }
    `);
    expect(await caught(directoryProjectStore(root, "0").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
  });

  it("ignores If-Match for a project that is not stored", async () => {
    expect(await caught(directoryProjectStore(root, "19").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
  });

  it("does not check delete records", async () => {
    await seed(stored);
    await tombstone({ deletedAt: 1, revision: 20, metadataRevision: 3 });
    expect(await caught(directoryProjectStore(root, "20").withLock("p1", async () => "ran"))).toMatchInlineSnapshot(`
      {
        "value": {
          "busy": false,
          "result": "ran",
        },
      }
    `);
  });

  it("advances the revision past the clock when the clock is ahead", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    await seed(stored);
    const document = await readProjectDocument(root, "p1");
    const { revision, metadata } = await writeProjectDocument(root, "p1", { ...document!, projectName: "Renamed" }, []);
    expect({ revision, metadata, sidecar: await sidecar() }).toMatchInlineSnapshot(`
      {
        "metadata": {
          "id": "p1",
          "metadataRevision": 4,
          "name": "Renamed",
          "revision": 1000,
          "shapes": 0,
          "updatedAt": 1000,
        },
        "revision": 1000,
        "sidecar": {
          "id": "p1",
          "metadataRevision": 4,
          "name": "Renamed",
          "revision": 1000,
          "shapes": 0,
          "updatedAt": 1000,
        },
      }
    `);
  });

  it("advances the revision past the stored one when the clock is behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 10 });
    await seed({ ...stored, metadataRevision: "x" });
    const document = await readProjectDocument(root, "p1");
    const { revision, metadata } = await writeProjectDocument(root, "p1", document!, []);
    expect({ revision, metadata }).toMatchInlineSnapshot(`
      {
        "metadata": {
          "id": "p1",
          "metadataRevision": 1,
          "name": "Stored",
          "revision": 21,
          "shapes": 0,
          "updatedAt": 21,
        },
        "revision": 21,
      }
    `);
  });

  it("bumps from the document it was handed, not the sidecar on disk", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 10 });
    await seed(stored);
    const document = await readProjectDocument(root, "p1");
    await seed({ ...stored, revision: 500, metadataRevision: 50 });
    const { revision, metadata } = await writeProjectDocument(root, "p1", document!, []);
    expect({ revision, metadataRevision: metadata.metadataRevision }).toMatchInlineSnapshot(`
      {
        "metadataRevision": 4,
        "revision": 21,
      }
    `);
  });

  it("answers a stale If-Match on a REST v1 write with revision_mismatch", async () => {
    const authorized = (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Content-Type", "application/json");
      return new Request(`http://localhost${url}`, { ...init, headers });
    };
    const created = await createApiProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Pinned" }) }));
    const projectId = (await created.json() as { project: { id: string } }).project.id;
    const shapes = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ kind: "cube", size: 10 }) }));
    const { shapes: [shape], revision } = await shapes.json() as { shapes: Array<{ id: string }>; revision: number };

    const stale = await patchShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shape!.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${revision - 1}"` },
      body: JSON.stringify({ name: "Must not apply" }),
    }));

    const body = await stale.json() as Record<string, unknown>;
    expect({ status: stale.status, body: { ...body, revision: body.revision === revision } }).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "revision_mismatch",
          "error": "The project changed since the supplied revision.",
          "revision": true,
        },
        "status": 409,
      }
    `);
  });
});
