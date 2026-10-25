import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { editorHistoryEntry, editorHistoryForAutosave, editorHistoryForExport } from "@constructorfleet/sketchforge-engine/editorHistory";
import { placementWorkplaneFromSurface } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { projectAssetFromBytes } from "@constructorfleet/sketchforge-engine/projectAssets";
import * as projectAssets from "@constructorfleet/sketchforge-engine/projectAssets";
import { canonicalizeShape, cloneWorkplaneShapeTreeWithFreshIds } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import {
  exportSkfProject,
  importSkfProject,
  inspectSkfProjectPackage,
  SKF_FORMAT_VERSION,
  SKF_LIMITS,
  SKF_SCHEMA_ID,
  type SkfProjectDocumentV1,
  type SkfProjectExportInput,
} from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

function shape(kind: ShapeKind, id = `${kind}-1`, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id,
    name: kind,
    kind,
    color: "#12a4cc",
    x: 1,
    z: 2,
    elevation: 3,
    size: 20,
    width: 20,
    depth: 18,
    height: 16,
    rotation: 15,
    rotationX: 5,
    rotationZ: 10,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

function input(shapes: WorkplaneShape[], overrides: Partial<SkfProjectExportInput> = {}): SkfProjectExportInput {
  const history = [editorHistoryEntry(shapes, [])];
  return {
    projectId: "project-original",
    projectName: "Round trip",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_100_000,
    shapes,
    history,
    historyIndex: 0,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 12.5,
    ...overrides,
  };
}

function packageDocument(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  return { files, document: JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1 };
}

function mutateProject(bytes: Uint8Array, mutate: (document: SkfProjectDocumentV1) => void) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1;
  mutate(document);
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

describe("SketchForge .skf project packages", () => {
  it("accepts bounded full-turn revolve face drafts and rejects unsupported source kinds or combinations", async () => {
    const draftedExtrusion = shape("mesh", "drafted-extrusion", {
      sketchSourceId: "draft-source",
      sketchOperation: "extrude",
      sketchProfile: {
        points: [{ id: "a", x: -5, z: -5 }, { id: "b", x: 5, z: -5 }, { id: "c", x: 5, z: 5 }, { id: "d", x: -5, z: 5 }],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        ],
      },
      faceDraft: {
        sourceFaceId: "selected-face",
        angle: 5,
        pullDirection: "x",
        sourceFaceNormal: { x: 1, y: 0, z: 0 },
      },
      faceDraftSourceSegmentId: "bc",
    });
    const validArchive = await exportSkfProject(input([draftedExtrusion]));
    const restoredDraftedExtrusion = await importSkfProject(validArchive);
    expect(restoredDraftedExtrusion.shapes[0]?.faceDraftSourceSegmentId).toBe("bc");
    const invalidCases: Array<[string, (definition: Record<string, unknown>) => void]> = [
      ["revolve without settings", (definition) => { definition.sketchOperation = "revolve"; }],
      ["partial revolve", (definition) => { definition.sketchOperation = "revolve"; definition.sketchRevolve = { startAngle: 0, sweepAngle: 180, sides: 48, quality: 0 }; }],
      ["helical revolve", (definition) => { definition.sketchOperation = "revolve"; definition.sketchRevolve = { startAngle: 0, sweepAngle: 360, sides: 48, quality: 0, pitch: 1, turns: 1, coreRadius: 0 }; }],
      ["multi-region revolve", (definition) => {
        definition.sketchOperation = "revolve";
        definition.sketchRevolve = { startAngle: 0, sweepAngle: 360, sides: 48, quality: 0, pitch: 0, turns: 1, coreRadius: 0 };
        const points = [[0, 0], [2, 0], [2, 2], [0, 2], [5, 0], [7, 0], [7, 2], [5, 2]] as const;
        definition.sketchProfile = {
          points: points.map(([x, z], index) => ({ id: `p${index}`, x, z })),
          segments: points.map((_, index) => ({ id: `s${index}`, startId: `p${index}`, endId: `p${(index + 1) % 4 + Math.floor(index / 4) * 4}` })),
        };
      }],
      ["prism draft", (definition) => { definition.draftPrismAngle = 3; }],
      ["edge treatment", (definition) => { definition.edgeTreatments = [{ kind: "fillet", amount: 0.5, edgeCount: 1 }]; }],
      ["foreign face-draft sketch segment", (definition) => { definition.faceDraftSourceSegmentId = "does-not-exist"; }],
      ["Bezier segment with face-draft segment lineage", (definition) => {
        const profile = definition.sketchProfile as { points: Array<Record<string, unknown>> };
        profile.points.find((point) => point.id === "b")!.handleOut = { x: 6, z: -4 };
        profile.points.find((point) => point.id === "c")!.handleIn = { x: 6, z: 4 };
      }],
    ];

    for (const [label, mutateDefinition] of invalidCases) {
      const invalidArchive = mutateProject(validArchive, (document) => {
        const node = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((entry) => entry.objectId === draftedExtrusion.id);
        expect(node).toBeDefined();
        mutateDefinition(node!.definition);
      });
      await expect(importSkfProject(invalidArchive), label).rejects.toThrow(/faceDraft/);
    }

    const draftedRevolve = shape("mesh", "drafted-revolve", {
      sketchSourceId: "revolve-draft-source",
      sketchOperation: "revolve",
      sketchProfile: draftedExtrusion.sketchProfile,
      sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 48, quality: 0, pitch: 0, turns: 1, coreRadius: 0 },
      faceDraft: draftedExtrusion.faceDraft,
      faceDraftSourceScale: { width: 1.5, depth: 0.75, height: 2 },
    });
    const revolveArchive = await exportSkfProject(input([draftedRevolve]));
    const restoredRevolve = await importSkfProject(revolveArchive);
    expect(restoredRevolve.shapes[0]?.faceDraft).toEqual(draftedRevolve.faceDraft);
    expect(restoredRevolve.shapes[0]?.faceDraftSourceScale).toEqual(draftedRevolve.faceDraftSourceScale);

    const chamfer = { kind: "chamfer" as const, amount: 0.1, chamferAngle: 45, edgeCount: 16, allEdges: true as const };
    const draftedChamferRevolve = shape("mesh", "drafted-chamfer-revolve", {
      ...draftedRevolve,
      id: "drafted-chamfer-revolve",
      edgeTreatments: [chamfer],
      edgeTreatmentHistory: [{ id: "drafted-chamfer-history", createdAt: 1, feature: chamfer, before: draftedRevolve }],
    });
    const draftedChamferArchive = await exportSkfProject(input([draftedChamferRevolve]));
    const restoredDraftedChamfer = await importSkfProject(draftedChamferArchive);
    expect(restoredDraftedChamfer.shapes[0]?.faceDraft).toEqual(draftedRevolve.faceDraft);
    expect(restoredDraftedChamfer.shapes[0]?.edgeTreatments).toEqual([chamfer]);
    expect(restoredDraftedChamfer.shapes[0]?.edgeTreatmentHistory?.[0]?.before.faceDraft).toEqual(draftedRevolve.faceDraft);
    const { document: draftedChamferDocument } = packageDocument(draftedChamferArchive);
    const faceDraftFeature = draftedChamferDocument.features.find((feature) => feature.type === "face-draft");
    const chamferFeature = draftedChamferDocument.features.find((feature) => feature.type === "chamfer");
    expect(chamferFeature?.dependsOnFeatureIds).toContain(faceDraftFeature?.id);

    const fillet = { kind: "fillet" as const, amount: 0.1, edgeCount: 16, allEdges: true as const };
    const draftedFilletRevolve = shape("mesh", "drafted-fillet-revolve", {
      ...draftedRevolve,
      id: "drafted-fillet-revolve",
      edgeTreatments: [fillet],
      edgeTreatmentHistory: [{ id: "drafted-fillet-history", createdAt: 1, feature: fillet, before: draftedRevolve }],
    });
    const draftedFilletArchive = await exportSkfProject(input([draftedFilletRevolve]));
    const restoredDraftedFillet = await importSkfProject(draftedFilletArchive);
    expect(restoredDraftedFillet.shapes[0]?.faceDraft).toEqual(draftedRevolve.faceDraft);
    expect(restoredDraftedFillet.shapes[0]?.edgeTreatments).toEqual([fillet]);
    expect(restoredDraftedFillet.shapes[0]?.edgeTreatmentHistory?.[0]?.before.faceDraft).toEqual(draftedRevolve.faceDraft);
    const { document: draftedFilletDocument } = packageDocument(draftedFilletArchive);
    const filletDraftFeature = draftedFilletDocument.features.find((feature) => feature.type === "face-draft");
    const filletFeature = draftedFilletDocument.features.find((feature) => feature.type === "fillet");
    expect(filletFeature?.dependsOnFeatureIds).toContain(filletDraftFeature?.id);

    const draftedFilletExtrusion = shape("mesh", "drafted-fillet-extrusion", {
      ...draftedExtrusion,
      id: "drafted-fillet-extrusion",
      edgeTreatments: [fillet],
      edgeTreatmentHistory: [{ id: "drafted-fillet-extrusion-history", createdAt: 1, feature: fillet, before: draftedExtrusion }],
    });
    const draftedFilletExtrusionArchive = await exportSkfProject(input([draftedFilletExtrusion]));
    const restoredDraftedFilletExtrusion = await importSkfProject(draftedFilletExtrusionArchive);
    expect(restoredDraftedFilletExtrusion.shapes[0]?.faceDraft).toEqual(draftedExtrusion.faceDraft);
    expect(restoredDraftedFilletExtrusion.shapes[0]?.edgeTreatments).toEqual([fillet]);
    expect(restoredDraftedFilletExtrusion.shapes[0]?.edgeTreatmentHistory?.[0]?.before.faceDraft)
      .toEqual(draftedExtrusion.faceDraft);
    const { document: draftedFilletExtrusionDocument } = packageDocument(draftedFilletExtrusionArchive);
    const extrusionDraftFeature = draftedFilletExtrusionDocument.features.find((feature) => feature.type === "face-draft");
    const extrusionFilletFeature = draftedFilletExtrusionDocument.features.find((feature) => feature.type === "fillet");
    expect(extrusionFilletFeature?.dependsOnFeatureIds).toContain(extrusionDraftFeature?.id);

    const tolerantChamfer = { ...chamfer, chamferAngle: 45.0005 };
    const tolerantArchive = await exportSkfProject(input([shape("mesh", "tolerant-draft-chamfer", {
      ...draftedRevolve,
      id: "tolerant-draft-chamfer",
      edgeTreatments: [tolerantChamfer],
      edgeTreatmentHistory: [{ id: "tolerant-draft-chamfer-history", createdAt: 1, feature: tolerantChamfer, before: draftedRevolve }],
    })]));
    await expect(importSkfProject(tolerantArchive)).resolves.toBeDefined();

    const edgeHistoryArchive = mutateProject(validArchive, (document) => {
      const node = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((entry) => entry.objectId === draftedExtrusion.id);
      expect(node).toBeDefined();
      node!.edgeTreatmentHistory = [{ id: "prior-edge-treatment", beforeNodeId: "missing-before", createdAt: 1, feature: { kind: "fillet", amount: 0.5, edgeCount: 1 } }];
    });
    await expect(importSkfProject(edgeHistoryArchive), "edge treatment history").rejects.toThrow(/faceDraft/);
  });

  it("preserves the all-edge replay intent through export and import", async () => {
    const feature = { kind: "fillet" as const, amount: 0.25, edgeCount: 12, allEdges: true as const };
    const treated = shape("mesh", "treated-extrusion", {
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{
        id: "fillet-history",
        createdAt: 42,
        feature,
        before: shape("mesh", "treated-extrusion-before"),
      }],
    });

    const restored = await importSkfProject(await exportSkfProject(input([treated])));

    expect(restored.shapes[0]?.edgeTreatments?.[0]?.allEdges).toBe(true);
    expect(restored.shapes[0]?.edgeTreatmentHistory?.[0]?.feature.allEdges).toBe(true);
  });

  it("round-trips an extrusion's editable source sketch and its feature dependency", async () => {
    const extrusion = shape("mesh", "extrusion-1", {
      sketchSourceId: "sketch-source-1",
      sketchOperation: "extrude",
      sketchProfile: {
        points: [
          { id: "a", x: -5, z: -5 }, { id: "b", x: 5, z: -5 },
          { id: "c", x: 5, z: 5 }, { id: "d", x: -5, z: 5 },
        ],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        ],
      },
    });
    const history = [
      editorHistoryEntry([{ ...extrusion, height: 12 }], []),
      editorHistoryEntry([extrusion], []),
    ];
    const bytes = await exportSkfProject(input([extrusion], { history, historyIndex: 1 }));
    const { document } = packageDocument(bytes);
    const extrusionFeature = document.features.find((feature) => feature.type === "sketch-extrusion");
    const sourceSketch = document.sketches.find((sketch) => sketch.id === "sketch-source-1");
    const sourceNode = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((node) => node.nodeId === sourceSketch?.sourceNodeId);

    expect(document.sketches).toContainEqual(expect.objectContaining({ id: "sketch-source-1", objectId: "extrusion-1" }));
    expect(sourceSketch?.sourceObjectId).toBe("sketch-source-1");
    expect(sourceSketch?.sourceNodeId).toBeTruthy();
    expect(sourceNode).toMatchObject({ objectId: "sketch-source-1", objectType: "sketch" });
    expect(sourceNode?.definition.sketchProfile).toMatchObject({ points: expect.arrayContaining([{ id: "a", x: -5, z: -5 }]) });
    expect(extrusionFeature?.inputObjectIds).toEqual(["sketch-source-1"]);
    expect(extrusionFeature?.parameters).toMatchObject({ depth: 16, direction: "positive-y" });

    const restored = await importSkfProject(bytes);
    expect(restored.shapes[0]).toMatchObject({
      sketchSourceId: "sketch-source-1",
      sketchOperation: "extrude",
      sketchProfile: { points: expect.arrayContaining([{ id: "a", x: -5, z: -5 }]) },
      height: 16,
    });
    expect(restored.history.map((entry) => entry.shapes[0].sketchSourceId)).toEqual([
      "sketch-source-1",
      "sketch-source-1",
    ]);
    expect(restored.history.map((entry) => entry.shapes[0].height)).toEqual([12, 16]);
    const missingSource = mutateProject(bytes, (document) => {
      document.sketches[0].sourceNodeId = "missing-source-node";
    });
    await expect(importSkfProject(missingSource)).rejects.toThrow(/missing input object/i);
  });

  it("round-trips stable face IDs and ID-keyed colors", async () => {
    const part = shape("box", "face-id-roundtrip", {
      faceIds: ["surface-bottom", "surface-side-2"],
      faceColors: { "surface-side-2": "#ff0000" },
    });
    const restored = await importSkfProject(await exportSkfProject(input([part])));
    expect(restored.shapes[0]).toMatchObject({ faceIds: part.faceIds, faceColors: part.faceColors });
  });

  it("round-trips a partial revolve's axis offset and rejects a malformed one", async () => {
    const revolve = shape("box", "partial-revolve-axis", { revolveAxisOffset: { x: 37.5, z: -37.5 } });
    const archive = await exportSkfProject(input([revolve]));
    const restored = await importSkfProject(archive);
    expect(restored.shapes[0].revolveAxisOffset).toEqual({ x: 37.5, z: -37.5 });

    const malformed = mutateProject(archive, (document) => {
      const node = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((entry) => entry.objectId === revolve.id);
      expect(node).toBeDefined();
      (node!.definition as Record<string, unknown>).revolveAxisOffset = { x: "far", z: 0 };
    });
    await expect(importSkfProject(malformed)).rejects.toThrow(/revolveAxisOffset\.x/);
  });

  it("round-trips imported STEP assembly names and their parent-child tree", async () => {
    const stepAssembly = [{
      name: "MainAssembly",
      children: [{ name: "SensorPack", children: [{ name: "SensorLeft", children: [] }] }],
    }];
    const imported = shape("mesh", "step-tree", { stepAssembly });
    const restored = await importSkfProject(await exportSkfProject(input([imported])));

    expect(restored.shapes[0]?.stepAssembly).toEqual(stepAssembly);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Upstream issue #116: the camera projection is a workspace preference, so it
  // travels in the project file. A file written by a build that has the setting
  // must still open in one that does not, and the other way round.
  it("round-trips the camera projection and opens a project saved without it", async () => {
    const shapes = [canonicalizeShape(shape("box"))];
    const bytes = await exportSkfProject(input(shapes, {
      workspace: { ...DEFAULT_WORKPLANE_WORKSPACE, cameraProjection: "orthographic" },
    }));

    const { document } = packageDocument(bytes);
    expect(document.editor.workspace.cameraProjection).toBe("orthographic");
    expect((await importSkfProject(bytes)).workspace.cameraProjection).toBe("orthographic");

    const withoutSetting = mutateProject(bytes, (doc) => {
      delete (doc.editor.workspace as Partial<typeof doc.editor.workspace>).cameraProjection;
    });
    expect((await importSkfProject(withoutSetting)).workspace.cameraProjection).toBe("perspective");

    const corrupt = mutateProject(bytes, (doc) => {
      (doc.editor.workspace as Record<string, unknown>).cameraProjection = "isometric";
    });
    expect((await importSkfProject(corrupt)).workspace.cameraProjection).toBe("perspective");
  });

  it("round-trips the saved camera pose and framing", async () => {
    const cameraView = {
      position: { x: 83, y: 62, z: 91 },
      target: { x: 14, y: 8, z: -6 },
      zoom: 1.75,
    };
    const bytes = await exportSkfProject(input([canonicalizeShape(shape("box"))], {
      workspace: { ...DEFAULT_WORKPLANE_WORKSPACE, cameraView },
    }));

    const { document } = packageDocument(bytes);
    expect(document.editor.workspace.cameraView).toEqual(cameraView);
    expect((await importSkfProject(bytes)).workspace.cameraView).toEqual(cameraView);
  });

  it("round-trips bounded autosave history while keeping explicit export depth independent", async () => {
    const history = Array.from({ length: 80 }, (_, x) => editorHistoryEntry([shape("box", "box-1", { x })], ["box-1"]));
    const activeIndex = 60;
    const autosaveHistory = editorHistoryForAutosave(history, activeIndex);
    const bytes = await exportSkfProject(input(history[activeIndex].shapes, {
      history: autosaveHistory.entries,
      historyIndex: autosaveHistory.index,
    }));

    const restored = await importSkfProject(bytes);
    expect(restored.history).toHaveLength(31);
    expect(restored.historyIndex).toBe(30);
    expect(restored.history[0].shapes[0].x).toBe(30);
    expect(restored.history[restored.historyIndex].shapes[0].x).toBe(60);
    expect(restored.shapes[0].x).toBe(60);
    const explicitExportHistory = editorHistoryForExport(history, activeIndex, 50);
    expect(explicitExportHistory.entries).toHaveLength(51);
    expect(explicitExportHistory.index).toBe(50);
    expect(explicitExportHistory.entries.at(-1)?.shapes[0].x).toBe(60);
    expect(history).toHaveLength(80);
  });

  it("round-trips general surface appearance independently of print material", async () => {
    const appearance = {
      presetId: "fabric",
      baseColor: "#b98254",
      roughness: 0.91,
      metalness: 0.03,
      sheen: 0.36,
    };
    const part = shape("box", "chair-seat", { material: "pla", appearance });
    const restored = await importSkfProject(await exportSkfProject(input([part])));

    expect(restored.shapes[0].appearance).toEqual(appearance);
    expect(restored.shapes[0].material).toBe("pla");
  });

  it("rejects out-of-range saved surface parameters", async () => {
    const bytes = await exportSkfProject(input([shape("box", "invalid-appearance")]));
    const invalid = mutateProject(bytes, (document) => {
      document.states[0].nodes[0].definition.appearance = { roughness: 1.2 };
    });

    await expect(importSkfProject(invalid)).rejects.toThrow(/appearance\.roughness/);
  });

  it("encodes shared geometry once across a long transform history and subsequent saves", async () => {
    const points = Array.from({ length: 30_000 }, (_, index) => Math.sin(index));
    const resource = shape("mesh", "shared-geometry", {
      cadDisplayEdges: [{ points }],
      cadDisplayEdgesVersion: 2,
      cadBrep: "Shared regression BREP ".repeat(10_000),
      importedMesh: { positions: points, baseWidth: 2, baseDepth: 2, baseHeight: 2, triangleCount: points.length / 9, sourceFormat: "json" },
    });
    const history = Array.from({ length: 40 }, (_, x) => editorHistoryEntry([{ ...resource, x }], [resource.id]));
    const saveInput = input(history[20].shapes, { history, historyIndex: 20 });
    const hash = vi.spyOn(projectAssets, "sha256Hex");
    const bytes = await exportSkfProject(saveInput);
    expect(hash).toHaveBeenCalledTimes(3);
    hash.mockClear();
    await exportSkfProject(saveInput);
    expect(hash).not.toHaveBeenCalled();

    const { files, document } = packageDocument(bytes);
    expect(document.assets.map((asset) => asset.kind).sort()).toEqual(["brep", "derived-mesh", "display-edges"]);
    expect(files["project.json"].length).toBeLessThan(100_000);
    expect(document.states.every((state) => state.nodes.every((node) => node.definition.cadDisplayEdges === undefined))).toBe(true);
    const restored = await importSkfProject(bytes);
    expect(restored.historyIndex).toBe(20);
    expect(restored.history.map((entry) => entry.shapes[0].x)).toEqual(history.map((entry) => entry.shapes[0].x));
    for (const entry of restored.history) {
      expect(entry.shapes[0].cadDisplayEdges).toBe(restored.shapes[0].cadDisplayEdges);
      expect(entry.shapes[0].importedMesh).toBe(restored.shapes[0].importedMesh);
    }
    expect(restored.shapes[0].cadDisplayEdges).toEqual(resource.cadDisplayEdges);
    expect(restored.shapes[0].cadBrep).toBe(resource.cadBrep);
    hash.mockClear();
    await exportSkfProject(input(restored.shapes, { history: restored.history, historyIndex: restored.historyIndex }));
    expect(hash).toHaveBeenCalledTimes(2); // One mesh and one edge resource, independent of state count.
  });

  it("reads V1 inline display edges and interns them before re-saving", async () => {
    const original = shape("box", "legacy-edges", { cadDisplayEdges: [{ points: [0, 0, 0, 1, 2, 3] }], cadDisplayEdgesVersion: 2 });
    const moved = { ...original, x: 42 };
    const history = [editorHistoryEntry([original], []), editorHistoryEntry([moved], [moved.id])];
    const packaged = await exportSkfProject(input([moved], { history, historyIndex: 1 }));
    const legacy = mutateProject(packaged, (document) => {
      document.formatVersion = 1;
      document.minimumReaderVersion = 1;
      document.assets = document.assets.filter((asset) => asset.kind !== "display-edges");
      for (const state of document.states) for (const node of state.nodes) {
        node.cadDisplayEdgesAssetId = undefined;
        node.definition.cadDisplayEdges = original.cadDisplayEdges;
      }
    });
    const restored = await importSkfProject(legacy);
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0].shapes[0].cadDisplayEdges).toBe(restored.shapes[0].cadDisplayEdges);
    const saved = packageDocument(await exportSkfProject(input(restored.shapes, { history: restored.history, historyIndex: 1 })));
    expect(saved.document.assets.filter((asset) => asset.kind === "display-edges")).toHaveLength(1);
  });

  it("keeps replaced edge and mesh arrays distinct even when their lengths match", async () => {
    const original = shape("mesh", "changed-resources", {
      cadDisplayEdges: [{ points: [0, 0, 0, 1, 1, 1] }],
      importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 1, sourceFormat: "json" },
    });
    await exportSkfProject(input([original]));
    const changed = { ...original, cadDisplayEdges: [{ points: [0, 0, 0, 2, 2, 2] }], importedMesh: { ...original.importedMesh!, normals: original.importedMesh!.positions } };
    const history = [editorHistoryEntry([original], []), editorHistoryEntry([changed], [])];
    const restored = await importSkfProject(await exportSkfProject(input([changed], { history, historyIndex: 1 })));
    expect(restored.history[0].shapes[0].cadDisplayEdges).toEqual(original.cadDisplayEdges);
    expect(restored.shapes[0].cadDisplayEdges).toEqual(changed.cadDisplayEdges);
    expect(restored.history[0].shapes[0].importedMesh?.normals).toBeUndefined();
    expect(restored.shapes[0].importedMesh?.normals).toEqual(changed.importedMesh.normals);
  });

  it("rejects missing and corrupt display-edge resources", async () => {
    const bytes = await exportSkfProject(input([shape("box", "bad-edges", { cadDisplayEdges: [{ points: [0, 0, 0] }] })]));
    await expect(importSkfProject(mutateProject(bytes, (document) => {
      document.states[0].nodes[0].cadDisplayEdgesAssetId = "missing";
    }))).rejects.toThrow(/display-edge asset/);
    const { files, document } = packageDocument(bytes);
    const edge = document.assets.find((asset) => asset.kind === "display-edges")!;
    files[edge.path] = strToU8('[{"points":["invalid",0,0]}]');
    edge.byteLength = files[edge.path].length;
    edge.sha256 = await projectAssets.sha256Hex(files[edge.path]);
    files["project.json"] = strToU8(JSON.stringify(document));
    await expect(importSkfProject(zipSync(files))).rejects.toThrow(/display-edge coordinates/);
  });

  it("round-trips every supported native shape kind and editable properties", async () => {
    const nativeKinds: ShapeKind[] = [
      "box", "cylinder", "sphere", "sketch", "scribble", "cone", "pyramid", "roof", "text", "roundRoof",
      "halfSphere", "torus", "tube", "gear", "ring", "wedge", "polygon", "icosahedron", "loft",
    ];
    const shapes = nativeKinds.map((kind, index) => shape(kind, `${kind}-${index}`, {
      hole: index === 2,
      locked: index === 3,
      hidden: index === 4,
      mirrorX: index === 5,
      sides: index + 3,
      teeth: kind === "gear" ? 18 : undefined,
      toothSize: kind === "gear" ? 3.25 : undefined,
      toothWidth: kind === "gear" ? 2.75 : undefined,
      centerHoleSize: kind === "gear" ? 7.5 : undefined,
      gearType: kind === "gear" ? "helical" : undefined,
      helixAngle: kind === "gear" ? -30 : undefined,
      helixQuality: kind === "gear" ? 24 : undefined,
      loftBottomShape: kind === "loft" ? "Triangle" : undefined,
      loftTopShape: kind === "loft" ? "Hexagon" : undefined,
      loftTopWidth: kind === "loft" ? 16 : undefined,
      loftTopDepth: kind === "loft" ? 14 : undefined,
      loftBottomRotation: kind === "loft" ? 15 : undefined,
      loftTopRotation: kind === "loft" ? 45 : undefined,
      loftSegments: kind === "loft" ? 60 : undefined,
      loftLayers: kind === "loft" ? 30 : undefined,
      text: kind === "text" ? "Editable" : undefined,
      sketchProfile: kind === "sketch" ? {
        points: [
          { id: "p1", x: 0, z: 0 },
          { id: "p2", x: 10, z: 0 },
          { id: "p3", x: 10, z: 10 },
        ],
        segments: [
          { id: "s1", startId: "p1", endId: "p2", kind: "line" },
          { id: "s2", startId: "p2", endId: "p3", kind: "bezier" },
          { id: "s3", startId: "p3", endId: "p1", kind: "line" },
        ],
      } : undefined,
    }));

    const customWorkspace = { ...DEFAULT_WORKPLANE_WORKSPACE, gridColor: "#a34fd1" };
    const exported = await exportSkfProject(input(shapes, { workspace: customWorkspace }));
    const { document } = packageDocument(exported);
    const summary = await inspectSkfProjectPackage(exported);
    const restored = await importSkfProject(exported);

    expect(restored.projectName).toBe("Round trip");
    expect(restored.sourceProjectId).toBe("project-original");
    expect(JSON.stringify(restored.shapes)).toBe(JSON.stringify(shapes.map(canonicalizeShape)));
    expect(restored.workspace).toEqual(customWorkspace);
    expect(restored.snapGrid).toBe(DEFAULT_SNAP_GRID);
    expect(restored.placementElevation).toBe(12.5);
    expect(summary).toEqual({
      projectName: "Round trip",
      createdAt: 1_700_000_000_000,
      modifiedAt: 1_700_000_100_000,
      formatVersion: SKF_FORMAT_VERSION,
    });
    expect(document.assets.filter((entry) => entry.kind === "derived-mesh")).toHaveLength(0);
  });

  it("preserves an oriented placement workplane", async () => {
    const placementWorkplane = placementWorkplaneFromSurface(
      { x: 12, y: 8, z: -3 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    const sketchPlacementWorkplane = placementWorkplaneFromSurface(
      { x: -4, y: 6, z: 9 },
      { x: 0, y: 0, z: -1 },
      { x: 1, y: 0, z: 0 },
    );
    const exported = await exportSkfProject(input([shape("box")], {
      placementElevation: 0,
      placementWorkplane,
      sketchPlacementWorkplane,
    }));
    const restored = await importSkfProject(exported);

    expect(restored.placementWorkplane).toEqual(placementWorkplane);
    expect(restored.sketchPlacementWorkplane).toEqual(sketchPlacementWorkplane);
  });

  it("preserves editable revolve sketch settings and generated geometry", async () => {
    const revolve = shape("mesh", "revolve-sketch", {
      name: "Sketch revolve",
      sketchOperation: "revolve",
      sketchRevolve: { startAngle: 25, sweepAngle: -220, sides: 48, quality: 8, pitch: 1.5, turns: 2, coreRadius: 2.4 },
      sketchProfile: {
        points: [{ id: "p1", x: -4, z: 0 }, { id: "p2", x: -8, z: 0 }, { id: "p3", x: -8, z: 16 }, { id: "p4", x: -4, z: 16 }],
        segments: [
          { id: "s1", startId: "p1", endId: "p2", kind: "line" },
          { id: "s2", startId: "p2", endId: "p3", kind: "line" },
          { id: "s3", startId: "p3", endId: "p4", kind: "line" },
          { id: "s4", startId: "p4", endId: "p1", kind: "line" },
        ],
      },
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 16,
        baseDepth: 16,
        baseHeight: 16,
        triangleCount: 1,
        sourceFormat: "json",
      },
    });
    const bytes = await exportSkfProject(input([revolve]));
    const { document } = packageDocument(bytes);
    const sourceSketchId = "sketch/revolve-sketch";
    const sourceSketch = document.sketches.find((sketch) => sketch.id === sourceSketchId);
    const sourceNode = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((node) => node.nodeId === sourceSketch?.sourceNodeId);
    const revolveFeature = document.features.find((feature) => feature.type === "sketch-revolve");

    expect(sourceSketch).toMatchObject({ sourceObjectId: sourceSketchId, objectId: "revolve-sketch" });
    expect(sourceNode).toMatchObject({ objectId: sourceSketchId, objectType: "sketch" });
    expect(sourceNode?.definition.sketchProfile).toEqual(revolve.sketchProfile);
    expect(revolveFeature?.inputObjectIds).toEqual([sourceSketchId]);
    expect(revolveFeature?.parameters).toMatchObject({ ...revolve.sketchRevolve, mode: "create" });

    const restored = await importSkfProject(bytes);
    expect(restored.shapes[0].sketchSourceId).toBe(sourceSketchId);
    expect(restored.shapes[0].sketchOperation).toBe("revolve");
    expect(restored.shapes[0].sketchRevolve).toEqual(revolve.sketchRevolve);
    expect(restored.shapes[0].sketchProfile).toEqual(revolve.sketchProfile);
    expect(restored.shapes[0].importedMesh?.positions).toEqual(revolve.importedMesh?.positions);
  });

  it("duplicates a revolve with distinct source sketch nodes and feature references", async () => {
    const revolve = shape("mesh", "revolve-original", {
      name: "Sketch revolve",
      sketchOperation: "revolve",
      sketchSourceId: "sketch/revolve-original",
      sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 32, quality: 8, pitch: 0, turns: 1, coreRadius: 0 },
      sketchProfile: {
        points: [{ id: "p1", x: -4, z: 0 }, { id: "p2", x: -8, z: 0 }, { id: "p3", x: -8, z: 12 }, { id: "p4", x: -4, z: 12 }],
        segments: [
          { id: "s1", startId: "p1", endId: "p2", kind: "line" },
          { id: "s2", startId: "p2", endId: "p3", kind: "line" },
          { id: "s3", startId: "p3", endId: "p4", kind: "line" },
          { id: "s4", startId: "p4", endId: "p1", kind: "line" },
        ],
      },
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 16,
        baseDepth: 16,
        baseHeight: 12,
        triangleCount: 1,
        sourceFormat: "json",
      },
    });
    const duplicate = cloneWorkplaneShapeTreeWithFreshIds(revolve, "copy");
    const bytes = await exportSkfProject(input([revolve, duplicate]));
    const { document } = packageDocument(bytes);
    const sketches = document.sketches.filter((sketch) => sketch.operation === "revolve");
    const features = document.features.filter((feature) => feature.type === "sketch-revolve");
    const sourceIds = sketches.map((sketch) => sketch.id);
    const sourceNodeIds = sketches.map((sketch) => sketch.sourceNodeId);

    expect(sourceIds).toHaveLength(2);
    expect(new Set(sourceIds).size).toBe(2);
    expect(new Set(sourceNodeIds).size).toBe(2);
    expect(features).toHaveLength(2);
    expect(new Set(features.map((feature) => feature.id)).size).toBe(2);
    expect(features.map((feature) => feature.inputObjectIds[0]).sort()).toEqual([...sourceIds].sort());

    const restored = await importSkfProject(bytes);
    expect(restored.shapes.map((shape) => shape.sketchSourceId).sort()).toEqual([...sourceIds].sort());
  });

  it("preserves the sweep sketch operation through SKF export and import", async () => {
    const sweepFrames = {
      section: {
        origin: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 1, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
      },
      spine: {
        origin: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 1, y: 0, z: 0 },
      },
    };
    const sweep = shape("mesh", "sweep-sketch", {
      sketchOperation: "sweep",
      sketchSourceId: "source-sketch-42",
      sketchProfile: {
        points: [{ id: "p1", x: 0, z: 0 }, { id: "p2", x: 2, z: 0 }, { id: "p3", x: 2, z: 3 }, { id: "p4", x: 0, z: 3 }, { id: "path1", x: 5, z: 0, sweepRole: "spine", handleOut: { x: 7, z: 1, sweepDepth: 2.5 } }, { id: "path2", x: 12, z: 6, sweepRole: "spine", sweepDepth: 5, handleIn: { x: 10, z: 5, sweepDepth: -1.25 } }],
        segments: [
          { id: "s1", startId: "p1", endId: "p2", kind: "line" },
          { id: "s2", startId: "p2", endId: "p3", kind: "line" },
          { id: "s3", startId: "p3", endId: "p4", kind: "line" },
          { id: "s4", startId: "p4", endId: "p1", kind: "line" },
          { id: "s5", startId: "path1", endId: "path2", kind: "line" },
        ],
        sweepFrames,
      },
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 16,
        baseDepth: 16,
        baseHeight: 16,
        triangleCount: 1,
        sourceFormat: "json",
      },
    });
    const exported = await exportSkfProject(input([sweep]));
    const { document } = packageDocument(exported);
    const restored = await importSkfProject(exported);
    const sourceSketchId = "source-sketch-42";
    const sourceSketch = document.sketches.find((sketch) => sketch.id === sourceSketchId);
    const sourceNode = document.states.find((state) => state.id === document.sceneStateId)?.nodes.find((node) => node.nodeId === sourceSketch?.sourceNodeId);
    const sweepFeature = document.features.find((feature) => feature.type === "sketch-sweep");

    expect(document.sketches[0].operation).toBe("sweep");
    expect(document.features[0].type).toBe("sketch-sweep");
    expect(sourceSketch).toMatchObject({ id: sourceSketchId, sourceObjectId: sourceSketchId, objectId: sweep.id });
    expect(sourceNode).toMatchObject({ objectId: sourceSketchId, objectType: "sketch" });
    expect(sourceNode?.definition.sketchProfile).toEqual(sweep.sketchProfile);
    expect(sweepFeature?.inputObjectIds).toEqual([sourceSketchId]);
    expect(restored.shapes[0].sketchOperation).toBe("sweep");
    expect(restored.shapes[0].sketchSourceId).toBe(sourceSketchId);
    expect(restored.history.map((entry) => entry.shapes[0]?.sketchSourceId)).toEqual([sourceSketchId]);
    expect(restored.shapes[0].sketchProfile).toEqual(sweep.sketchProfile);
    expect(restored.shapes[0].sketchProfile?.sweepFrames).toEqual(sweepFrames);
    expect(restored.shapes[0].sketchProfile?.points.find((point) => point.id === "path2")?.sweepDepth).toBe(5);
    expect(restored.shapes[0].sketchProfile?.points.find((point) => point.id === "path1")?.handleOut?.sweepDepth).toBe(2.5);
    expect(restored.shapes[0].sketchProfile?.points.find((point) => point.id === "path2")?.handleIn?.sweepDepth).toBe(-1.25);
    const repackaged = packageDocument(await exportSkfProject(input(restored.shapes))).document;
    expect(repackaged.sketches).toContainEqual(expect.objectContaining({ id: sourceSketchId, sourceObjectId: sourceSketchId }));

    const invalidHandleDepth = mutateProject(exported, (document) => {
      for (const state of document.states) {
        const node = state.nodes.find((entry) => entry.objectId === sweep.id);
        const profile = node?.definition.sketchProfile as { points: Array<{ id: string; handleOut?: { x: number; z: number; sweepDepth?: number } }> } | undefined;
        const handle = profile?.points.find((point) => point.id === "path1")?.handleOut;
        if (handle) handle.sweepDepth = Number.POSITIVE_INFINITY;
      }
    });
    expect(packageDocument(invalidHandleDepth).document.states.some((state) => state.nodes.some((node) => JSON.stringify(node.definition.sketchProfile).includes('"sweepDepth":null')))).toBe(true);
    await expect(importSkfProject(invalidHandleDepth)).rejects.toThrow(/handleOut\.sweepDepth/);

    const sectionHandleDepth = mutateProject(exported, (document) => {
      for (const state of document.states) {
        const node = state.nodes.find((entry) => entry.objectId === sweep.id);
        const profile = node?.definition.sketchProfile as { points: Array<{ id: string; handleOut?: { x: number; z: number; sweepDepth?: number } }> } | undefined;
        const section = profile?.points.find((point) => point.id === "p1");
        if (section) section.handleOut = { x: 1, z: 1, sweepDepth: 2 };
      }
    });
    await expect(importSkfProject(sectionHandleDepth)).rejects.toThrow(/handleOut\.sweepDepth/);
  });

  it("preserves nested groups, holes, intersection metadata, edge history, B-Rep, and undo/redo", async () => {
    const cadDisplayEdges = [{ points: [0, 0, 0, 1, 2, 3] }];
    const solid = shape("box", "solid", { x: 0, cadDisplayEdges });
    const hole = shape("cylinder", "hole", { hole: true, color: "#b8c2cc", x: 4 });
    const group = shape("mesh", "group", {
      name: "Intersection",
      groupOperation: "intersection",
      groupedBaseWidth: 30,
      groupedBaseDepth: 30,
      groupedBaseHeight: 20,
      groupedShapes: [solid, hole],
      importedMesh: {
        positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        baseWidth: 2,
        baseDepth: 1,
        baseHeight: 2,
        triangleCount: 1,
        sourceFormat: "json",
      },
      cadBrep: "BREP exact payload",
      cadDisplayEdges,
      edgeTreatments: [{ kind: "fillet", amount: 1.25, edgeCount: 3 }],
      edgeTreatmentHistory: [{
        id: "edge-history-1",
        createdAt: 1_700_000_050_000,
        feature: { kind: "fillet", amount: 1.25, edgeCount: 3 },
        before: shape("box", "group", { width: 30, depth: 30, height: 20, cadDisplayEdges }),
      }],
    });
    const before = editorHistoryEntry([solid, hole], ["solid", "hole"]);
    const after = editorHistoryEntry([group], ["group"]);
    const exported = await exportSkfProject(input([group], { history: [before, after], historyIndex: 1 }));
    const { document } = packageDocument(exported);

    expect(document.groups[0].operation).toBe("boolean-intersection");
    expect(document.features.some((feature) => feature.type === "fillet")).toBe(true);
    expect(document.exactCad).toHaveLength(1);
    expect(document.assets.filter((asset) => asset.kind === "display-edges")).toHaveLength(1);

    const restored = await importSkfProject(exported);
    expect(restored.history).toHaveLength(2);
    expect(restored.historyIndex).toBe(1);
    expect(restored.shapes[0].groupedShapes).toEqual([solid, hole]);
    expect(restored.shapes[0].groupOperation).toBe("intersection");
    expect(restored.shapes[0].cadBrep).toBe("BREP exact payload");
    expect(restored.shapes[0].edgeTreatmentHistory?.[0].before.kind).toBe("box");
  });

  it("repairs duplicate descendant IDs from legacy shallow-copied groups during export", async () => {
    const roof = shape("roundRoof", "round-roof-shared-child");
    const box = shape("box", "box-shared-child");
    const original = shape("mesh", "group-original", { groupedShapes: [roof, box] });
    const duplicate = { ...original, id: "group-copy", x: 30 };
    const history = [
      editorHistoryEntry([original], [original.id]),
      editorHistoryEntry([original, duplicate], [duplicate.id]),
    ];

    const exported = await exportSkfProject(input([original, duplicate], { history, historyIndex: 1 }));
    const restored = await importSkfProject(exported);
    const collectIds = (entry: WorkplaneShape): string[] => [
      entry.id,
      ...(entry.groupedShapes ?? []).flatMap(collectIds),
    ];
    const restoredIds = restored.shapes.flatMap(collectIds);

    expect(original.groupedShapes?.[0].id).toBe(duplicate.groupedShapes?.[0].id);
    expect(restored.shapes.map((entry) => entry.id)).toEqual(["group-original", "group-copy"]);
    expect(new Set(restoredIds).size).toBe(restoredIds.length);
    expect(restored.history).toHaveLength(2);
    expect(restored.historyIndex).toBe(1);
  });

  it("preserves every silently packaged undo and redo action", async () => {
    const created = shape("box", "history-box", { width: 20, depth: 20, x: 0 });
    const resized = { ...created, width: 30 };
    const moved = { ...resized, x: 18 };
    const history = [
      editorHistoryEntry([created], ["history-box"]),
      editorHistoryEntry([resized], ["history-box"]),
      editorHistoryEntry([moved], ["history-box"]),
    ];

    const restored = await importSkfProject(await exportSkfProject(input([resized], {
      history,
      historyIndex: 1,
      compressionLevel: 1,
    })));

    expect(restored.history).toHaveLength(3);
    expect(restored.historyIndex).toBe(1);
    expect(restored.history[0].shapes[0]).toMatchObject({ width: 20, x: 0 });
    expect(restored.history[1].shapes[0]).toMatchObject({ width: 30, x: 0 });
    expect(restored.history[2].shapes[0]).toMatchObject({ width: 30, x: 18 });
    expect(restored.shapes[0]).toMatchObject({ width: 30, x: 0 });
  });

  it("stores one original source asset for repeated imported instances and regenerates it once", async () => {
    const sourceBytes = strToU8("solid source");
    const asset = await projectAssetFromBytes("shared.stl", "stl", sourceBytes);
    const importedMesh: NonNullable<WorkplaneShape["importedMesh"]> = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 1,
      sourceFormat: "stl",
      assetId: asset.id,
    };
    const instances = [
      shape("mesh", "instance-a", { importedMesh, x: 0 }),
      shape("mesh", "instance-b", { importedMesh, x: 30 }),
    ];
    const exported = await exportSkfProject(input(instances, { assets: [asset] }));
    const { document } = packageDocument(exported);
    let importCalls = 0;
    const restored = await importSkfProject(exported, {
      sourceImporter: async () => {
        importCalls += 1;
        return { ...importedMesh, assetId: undefined };
      },
    });

    expect(document.assets.filter((entry) => entry.kind === "source")).toHaveLength(1);
    expect(document.assets.filter((entry) => entry.kind === "derived-mesh")).toHaveLength(0);
    expect(restored.assets).toHaveLength(1);
    expect(restored.shapes[0].importedMesh?.assetId).toBe(restored.shapes[1].importedMesh?.assetId);
    expect(importCalls).toBe(1);
  });

  it("exports and imports source-backed projects without Web Crypto", async () => {
    const sourceBytes = strToU8("solid http source");
    const asset = await projectAssetFromBytes("http.stl", "stl", sourceBytes);
    const importedMesh: NonNullable<WorkplaneShape["importedMesh"]> = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 1,
      sourceFormat: "stl",
      assetId: asset.id,
    };
    vi.stubGlobal("crypto", {});

    const exported = await exportSkfProject(input([shape("mesh", "http-object", { importedMesh })], { assets: [asset] }));
    const restored = await importSkfProject(exported, {
      sourceImporter: async () => ({ ...importedMesh, assetId: undefined }),
    });

    expect(packageDocument(exported).document.assets[0].sha256).toBe(asset.sha256);
    expect(restored.assets[0].sha256).toBe(asset.sha256);
    expect(restored.shapes[0].importedMesh?.assetId).toBe(restored.assets[0].id);
  });

  it("shares decoded derived-mesh arrays across restored history states", async () => {
    const importedMesh: NonNullable<WorkplaneShape["importedMesh"]> = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 1,
      sourceFormat: "json",
    };
    const before = shape("mesh", "derived-history", { importedMesh, x: 0 });
    const after = { ...before, x: 20 };
    const history = [editorHistoryEntry([before], []), editorHistoryEntry([after], [after.id])];

    const restored = await importSkfProject(await exportSkfProject(input([after], { history, historyIndex: 1 })));
    const firstPositions = restored.history[0].shapes[0].importedMesh?.positions;
    const secondPositions = restored.history[1].shapes[0].importedMesh?.positions;

    expect(firstPositions).toBe(secondPositions);
    expect(restored.shapes[0].importedMesh?.positions).toBe(secondPositions);
  });

  it.each(["svg", "step"] as const)("stores and restores original %s sources", async (sourceFormat) => {
    const asset = await projectAssetFromBytes(`source.${sourceFormat}`, sourceFormat, strToU8(`${sourceFormat} source`));
    const importedMesh: NonNullable<WorkplaneShape["importedMesh"]> = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 1,
      sourceFormat,
      assetId: asset.id,
      ...(sourceFormat === "step" ? { faceGroups: [0, 1, 0] } : {}),
      ...(sourceFormat === "step" ? { brepStep: "exact STEP" } : {}),
    };
    const exported = await exportSkfProject(input([shape("mesh", `${sourceFormat}-object`, { importedMesh })], { assets: [asset] }));
    const { document } = packageDocument(exported);
    const restored = await importSkfProject(exported, { sourceImporter: async () => importedMesh });

    expect(document.assets.filter((entry) => entry.kind === "source")).toHaveLength(1);
    expect(document.assets.filter((entry) => entry.kind === "derived-mesh")).toHaveLength(0);
    expect(restored.assets[0].sourceFormat).toBe(sourceFormat);
    expect(restored.shapes[0].importedMesh?.sourceFormat).toBe(sourceFormat);
    if (sourceFormat === "step") {
      expect(document.states[0]?.nodes[0]?.importedMesh?.faceGroups).toEqual([0, 1, 0]);
      expect(restored.shapes[0].importedMesh?.faceGroups).toEqual([0, 1, 0]);
    }
    if (sourceFormat === "step") expect(document.exactCad[0].importedStepAssetId).toBeTruthy();
  });

  it("deduplicates and restores reference images stored in sketches and image plates", async () => {
    const dataUrl = "data:image/png;base64,AAECAwQ=";
    const imageShape = shape("sketch", "sketch-images", {
      imagePlate: { dataUrl, mimeType: "image/png", pixelWidth: 2, pixelHeight: 2 },
      sketchProfile: {
        points: [
          { id: "p1", x: 0, z: 0 },
          { id: "p2", x: 10, z: 0 },
          { id: "p3", x: 0, z: 10 },
        ],
        segments: [
          { id: "s1", startId: "p1", endId: "p2" },
          { id: "s2", startId: "p2", endId: "p3" },
          { id: "s3", startId: "p3", endId: "p1" },
        ],
        images: [{
          id: "image-1",
          name: "Reference",
          dataUrl,
          mimeType: "image/png",
          pixelWidth: 2,
          pixelHeight: 2,
          x: 0,
          z: 0,
          width: 10,
          depth: 10,
          lockAspect: true,
          locked: true,
        }],
      },
    });
    const exported = await exportSkfProject(input([imageShape]));
    const { document } = packageDocument(exported);
    const restored = await importSkfProject(exported);

    expect(document.assets.filter((entry) => entry.kind === "image")).toHaveLength(1);
    expect(restored.shapes[0].imagePlate?.dataUrl).toBe(dataUrl);
    expect(restored.shapes[0].sketchProfile?.images?.[0].dataUrl).toBe(dataUrl);
    expect(restored.shapes[0].sketchProfile?.images?.[0].locked).toBe(true);
  });

  it("deduplicates derived geometry when legacy imported objects share one mesh", async () => {
    const mesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 1,
      sourceFormat: "json" as const,
    };
    const exported = await exportSkfProject(input([
      shape("mesh", "legacy-a", { importedMesh: mesh }),
      shape("mesh", "legacy-b", { importedMesh: mesh }),
    ]));
    const { document } = packageDocument(exported);
    const restored = await importSkfProject(exported);

    expect(document.assets.filter((entry) => entry.kind === "derived-mesh")).toHaveLength(1);
    expect(restored.shapes[0].importedMesh?.positions).toEqual(mesh.positions);
    expect(restored.shapes[1].importedMesh?.positions).toEqual(mesh.positions);
  });

  it("exports in a far-western timezone without underflowing the ZIP 1980 date floor", async () => {
    // ZIP stores entry mtimes as DOS dates, and fflate encodes them with local-time
    // getters, rejecting years outside 1980-2099 with "date not in range 1980-2099".
    // A UTC-pinned epoch rolls back to 1979 west of UTC, so exercise the fix under the
    // most extreme western offset. Node re-reads process.env.TZ per Date operation.
    const originalTz = process.env.TZ;
    process.env.TZ = "Etc/GMT+12";
    try {
      const exported = await exportSkfProject(input([shape("box")]));
      const restored = await importSkfProject(exported);
      expect(restored.shapes[0].kind).toBe("box");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("writes compact project data that stays compatible with the reader limit", async () => {
    const exported = await exportSkfProject(input([shape("box")]));
    const { files, document } = packageDocument(exported);
    const projectJson = strFromU8(files["project.json"]);

    expect(projectJson).toBe(JSON.stringify(document));
    await expect(importSkfProject(exported)).resolves.toMatchObject({ projectName: "Round trip" });
  });

  it("refuses to create an .skf package that its reader cannot reopen", async () => {
    const oversizedName = "x".repeat(SKF_LIMITS.projectJsonBytes);

    await expect(exportSkfProject(input([shape("box")], { projectName: oversizedName })))
      .rejects.toThrow("Project data exceeds the 64 MB .skf limit");
  });

  it("migrates the documented v0 JSON project without changing IDs", async () => {
    const box = shape("box", "legacy-box");
    const legacy = strToU8(JSON.stringify({
      schema: SKF_SCHEMA_ID,
      formatVersion: 0,
      project: { id: "legacy-project", name: "Legacy", createdAt: 100, modifiedAt: 200 },
      shapes: [box],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: "0.5 mm",
    }));

    const restored = await importSkfProject(legacy);

    expect(restored.migratedFromVersion).toBe(0);
    expect(restored.sourceProjectId).toBe("legacy-project");
    expect(restored.shapes[0].id).toBe("legacy-box");
    expect(restored.snapGrid).toBe("0.5 mm");
  });

  it("rejects unsupported future versions before restoring any state", async () => {
    const exported = await exportSkfProject(input([shape("box")]));
    const future = mutateProject(exported, (document) => {
      (document as { formatVersion: number }).formatVersion = SKF_FORMAT_VERSION + 1;
    });

    await expect(importSkfProject(future)).rejects.toThrow("requires a newer SketchForge version");
  });

  it("rejects missing references, duplicate IDs, cyclic groups, unknown operations, and corrupt assets", async () => {
    const twoShapes = await exportSkfProject(input([shape("box", "one"), shape("box", "two")]));
    const missing = mutateProject(twoShapes, (document) => {
      document.states[0].rootNodeIds[0] = "missing-node";
    });
    await expect(importSkfProject(missing)).rejects.toThrow("missing node");

    const duplicate = mutateProject(twoShapes, (document) => {
      const [first, second] = document.states[0].nodes;
      second.objectId = first.objectId;
      second.definition.id = first.objectId;
    });
    await expect(importSkfProject(duplicate)).rejects.toThrow("duplicate object ID");

    const grouped = await exportSkfProject(input([shape("mesh", "group-cycle", {
      groupedShapes: [shape("box", "child-a"), shape("box", "child-b")],
    })]));
    const cyclic = mutateProject(grouped, (document) => {
      const root = document.states[0].nodes.find((node) => node.objectId === "group-cycle")!;
      root.groupedShapeNodeIds = [root.nodeId];
    });
    await expect(importSkfProject(cyclic)).rejects.toThrow("Cyclic group");

    const unknownOperation = mutateProject(grouped, (document) => {
      document.features[0].type = "unsupported-operation";
    });
    await expect(importSkfProject(unknownOperation)).rejects.toThrow("Unknown operation type");

    const legacyMesh = await exportSkfProject(input([shape("mesh", "mesh", {
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 1,
        baseDepth: 1,
        baseHeight: 1,
        triangleCount: 1,
        sourceFormat: "json",
      },
    })]));
    const { files, document } = packageDocument(legacyMesh);
    const asset = document.assets.find((entry) => entry.kind === "derived-mesh")!;
    files[asset.path][20] ^= 0xff;
    await expect(importSkfProject(zipSync(files))).rejects.toThrow("integrity check");
  });
});
