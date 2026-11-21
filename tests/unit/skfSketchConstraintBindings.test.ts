import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject, type SkfProjectDocumentV1 } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { ProjectParameter, SketchConstraint, WorkplaneShape } from "@/types/sketchforge";

const table: ProjectParameter[] = [{ name: "w", expression: "10", dimension: "length", value: 10 }];

function sketch(constraints: SketchConstraint[]): WorkplaneShape {
  return {
    id: "profile", name: "profile", kind: "box", color: "#12a4cc", x: 0, z: 0,
    size: 10, width: 10, depth: 10, height: 10, rotation: 0, sketchOperation: "extrude", sketchSourceId: "sketch/profile",
    sketchProfile: {
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 10, z: 10 }],
      segments: [{ id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" }],
      constraints,
    },
  };
}

async function packaged(shape: WorkplaneShape, parameters = table) {
  return exportSkfProject({
    projectName: "Constraint bindings", createdAt: 1, modifiedAt: 1, shapes: [shape],
    history: [editorHistoryEntry([shape], [], parameters)], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0, parameters,
  });
}

function mutateConstraints(bytes: Uint8Array, mutate: (constraints: Array<Record<string, unknown>>) => void) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1;
  for (const state of document.states) {
    for (const node of state.nodes) {
      const profile = (node.definition as { sketchProfile?: { constraints?: Array<Record<string, unknown>> } }).sketchProfile;
      if (profile?.constraints) mutate(profile.constraints);
    }
  }
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

describe(".skf sketch constraint bindings", () => {
  it("round-trips constraint expressions with their resolved values", async () => {
    const constraints: SketchConstraint[] = [
      { id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10, expression: "w" },
      { id: "angle", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 90, expression: "90 deg" },
    ];
    const restored = await importSkfProject(await packaged(sketch(constraints)));

    expect(restored.shapes[0]?.sketchProfile?.constraints).toEqual(constraints);
    expect(restored.constraintBindingIssues).toEqual([]);
  });

  it("loads a stale constraint binding with its stored value and reports it", async () => {
    const constraints: SketchConstraint[] = [{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10, expression: "gone * 2" }];
    const restored = await importSkfProject(await packaged(sketch(constraints)));

    expect(restored.shapes[0]?.sketchProfile?.constraints).toEqual(constraints);
    expect(restored.constraintBindingIssues).toEqual([
      expect.objectContaining({ code: "invalidExpression", shapeId: "profile", constraintId: "d" }),
    ]);
  });

  it("reports a binding on a shelled sketch as not rebuildable on load", async () => {
    const shelled = { ...sketch([{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10, expression: "w" }]), shell: { thickness: 0.5 } };
    const restored = await importSkfProject(await packaged(shelled));

    expect(restored.shapes[0]?.sketchProfile?.constraints?.[0]).toMatchObject({ valueMm: 10, expression: "w" });
    expect(restored.constraintBindingIssues).toEqual([
      expect.objectContaining({ code: "sketchNotRebuildable", shapeId: "profile", constraintId: "d" }),
    ]);
  });

  it("refuses a malformed constraint expression", async () => {
    const bytes = await packaged(sketch([{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10, expression: "w" }]));
    for (const broken of [42, "", "   "]) {
      const mutated = mutateConstraints(bytes, (constraints) => { constraints[0]!.expression = broken; });
      await expect(importSkfProject(mutated)).rejects.toThrow(/constraints\[0\]\.expression/);
    }
    const onHorizontal = await packaged(sketch([{ id: "h", kind: "horizontal", segmentId: "ab" }]));
    const smuggled = mutateConstraints(onHorizontal, (constraints) => { constraints[0]!.expression = "w"; });
    await expect(importSkfProject(smuggled)).rejects.toThrow(/constraints\[0\]\.expression/);
  });
});
