import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine,
  directoryProjectStore,
  exportProjectScene,
  importSkfProject,
  type ProjectParameter,
} from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";

const parameters: ProjectParameter[] = [
  { name: "wall", expression: "2 mm", dimension: "length", value: 2 },
  { name: "depth", expression: "wall * 5", dimension: "length", value: 10 },
];

describe("server project parameters", () => {
  let root: string;
  const projectId = "parameter-project";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-parameters-"));
    await writeProjectMetadata(root, projectId, { id: projectId, name: "Parameters", createdAt: 1, revision: 1 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads a project with no package yet as an empty table", async () => {
    expect((await directoryProjectStore(root).read(projectId))?.parameters).toEqual([]);
  });

  it("stores the table and keeps it through a shape change", async () => {
    const store = directoryProjectStore(root);
    const document = (await store.read(projectId))!;
    await store.write(projectId, { ...document, parameters }, []);
    expect((await store.read(projectId))?.parameters).toEqual(parameters);

    const added = await createEngine(store).addShapes(projectId, [{ kind: "box", width: 10 }]);
    expect(added.ok).toBe(true);

    const after = (await store.read(projectId))!;
    expect(after.shapes).toHaveLength(1);
    expect(after.parameters).toEqual(parameters);
  });

  it("exports the table in a server-side .skf export", async () => {
    const store = directoryProjectStore(root);
    const document = (await store.read(projectId))!;

    const artifact = await exportProjectScene({ ...document, parameters }, { format: "skf" });

    expect((await importSkfProject(artifact.data)).parameters).toEqual(parameters);
  });
});
