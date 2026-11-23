import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

// Issue #650: a package served with a revision label later than its bytes would let
// the next save, based on that label, overwrite the newer copy without a conflict.
const interleave = vi.hoisted(() => ({ afterPackageRead: null as null | (() => Promise<void>) }));

vi.mock("@/lib/engine/serverProjectFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/serverProjectFiles")>();
  return {
    ...actual,
    readProjectPackage: async (root: string, projectId: string) => {
      const bytes = await actual.readProjectPackage(root, projectId);
      const write = interleave.afterPackageRead;
      interleave.afterPackageRead = null;
      if (write) await write();
      return bytes;
    },
  };
});

const { GET } = await import("@/app/api/projects/route");
const files = await import("@/lib/engine/serverProjectFiles");

let projectsRoot = "";
let previousProjectsRoot: string | undefined;

describe("serving a package while another client saves", () => {
  beforeEach(async () => {
    previousProjectsRoot = process.env[SERVER_PROJECTS_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-projects-race-"));
    process.env[SERVER_PROJECTS_ENV] = projectsRoot;
  });

  afterEach(async () => {
    if (previousProjectsRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
    else process.env[SERVER_PROJECTS_ENV] = previousProjectsRoot;
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });

  it("never labels a package with a revision newer than its bytes", async () => {
    const root = (await files.ensureProjectsDirectory())!;
    await files.writeProjectPackage(root, "project-1", new Uint8Array([10]));
    await files.writeProjectMetadata(root, "project-1", { id: "project-1", name: "Bracket", revision: 10 });

    // Another client's save, package then sidecar, lands between the reads.
    interleave.afterPackageRead = async () => {
      await files.writeProjectPackage(root, "project-1", new Uint8Array([20]));
      await files.writeProjectMetadata(root, "project-1", { id: "project-1", name: "Bracket", revision: 20 });
    };
    const response = await GET(new Request("http://localhost/api/projects?projectId=project-1"));
    const bytesRevision = new Uint8Array(await response.arrayBuffer())[0];
    const label = Number(response.headers.get("X-SketchForge-Revision"));

    expect(label).toBeLessThanOrEqual(bytesRevision);
  });
});
