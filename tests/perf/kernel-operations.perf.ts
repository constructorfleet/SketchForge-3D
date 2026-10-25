import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRevolveRequest, revolvedShapeFromRequest } from "@constructorfleet/sketchforge-engine/revolveRequests";
import { serverManifoldRuntime } from "@constructorfleet/sketchforge-engine/serverManifoldRuntime";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { serverCadKernel, withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { buildGroupFromSelection } from "@constructorfleet/sketchforge-engine/serverShapeBooleans";
import { explodeStepAssembly } from "@constructorfleet/sketchforge-engine/serverStepExplode";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { importedShapeFromTriangleSoup } from "@constructorfleet/sketchforge-engine/stlImport";
import { checkInterference } from "@constructorfleet/sketchforge-engine/serverCadInterference";
import { sectionShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadSection";
import { applyEdgeTreatment } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import type { ProjectAsset } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { assertKernelBudget, type KernelBudget } from "./support/kernelBudget";

// These are regression ceilings with headroom, not interactive latency targets.
const BUDGETS = {
  cut20: { wallMs: 30_000, heapDeltaMb: 128 },
  explode200: { wallMs: 60_000, heapDeltaMb: 256 },
  interference128: { wallMs: 30_000, heapDeltaMb: 128 },
  section50000: { wallMs: 180_000, heapDeltaMb: 512 },
  revolveFillet: { wallMs: 15_000, heapDeltaMb: 128 },
} satisfies Record<string, KernelBudget>;

async function measure<T>(workload: keyof typeof BUDGETS, run: () => Promise<T>): Promise<T> {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  let measured: KernelBudget;
  let succeeded = false;
  let result: T;
  try {
    result = await run();
    succeeded = true;
  } finally {
    measured = {
      wallMs: performance.now() - started,
      heapDeltaMb: (process.memoryUsage().heapUsed - heapBefore) / 1024 ** 2,
    };
    // Print before asserting, including failed operations, for the CI artifact.
    console.log(JSON.stringify({ workload, ...measured, succeeded, budget: BUDGETS[workload] }));
  }
  assertKernelBudget(measured, BUDGETS[workload]);
  return result;
}

function box(id: string, x: number) {
  return sceneShape({ id, name: id, kind: "box", color: "#123456", width: 2, depth: 2, height: 2, x });
}

describe("bounded kernel operation benchmarks", () => {
  beforeAll(async () => { await serverCadKernel(); });

  it("cuts twenty overlapping solids", async () => {
    const solids = Array.from({ length: 20 }, (_, i) => box(`solid-${i}`, i * 1.5));
    const cutter = { ...box("cutter", 14.25), width: 31, depth: 1, height: 4, elevation: -1, hole: true };
    const result = await measure("cut20", () => buildGroupFromSelection([...solids, cutter]));
    expect(result).toHaveProperty("group.cadBrep");
    if (!("group" in result) || !result.group.cadBrep) throw new Error(JSON.stringify(result));
    const brep = result.group.cadBrep;
    const volume = await withCadKernel((cad) => cad.getVolume(cad.fromBREP(brep)));
    expect(volume).toBeCloseTo(61, 5);
  });

  it("explodes a two-hundred-solid STEP document", async () => {
    const step = await withCadKernel((cad) => {
      const document = cad.createXCAFDocument();
      try {
        for (let i = 0; i < 200; i++) {
          document.addShape(cad.translate(cad.makeBox(1, 1, 1), i * 2, 0, 0), { name: `Part ${i}` });
        }
        return document.exportSTEP();
      } finally { document.close(); }
    });
    const bytes = new TextEncoder().encode(step);
    expect(bytes.byteLength).toBeLessThan(8 * 1024 ** 2);
    const source: ProjectAsset = { id: "assembly", name: "200-parts.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "benchmark" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;
    const result = await measure("explode200", () => explodeStepAssembly({ ...imported.shape, stepAssembly: undefined }, source));
    expect(result).toHaveLength(200);
    expect(result.every((part) => part.importedMesh?.brepStep)).toBe(true);
  });

  it("checks interference among 128 shapes with 64 penetrating pairs", async () => {
    const shapes = Array.from({ length: 128 }, (_, i) => box(`part-${i}`, Math.floor(i / 2) * 10 + i % 2));
    const result = await measure("interference128", () => checkInterference(shapes));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.shapesChecked).toBe(128);
    expect(result.value.pairs).toHaveLength(64);
    for (const pair of result.value.pairs) expect(pair.overlapVolume).toBeCloseTo(4, 6);
  });

  it("sections an actual 50,000-triangle closed mesh", async () => {
    const indexed = new THREE.BoxGeometry(10, 10, 10, 50, 50, 100);
    const geometry = indexed.toNonIndexed();
    const positions = Array.from(geometry.getAttribute("position").array);
    indexed.dispose();
    geometry.dispose();
    expect(positions.length / 9).toBe(50_000);
    const shape = importedShapeFromTriangleSoup("dense-box.stl", positions, undefined);
    expect(shape.importedMesh?.triangleCount).toBe(50_000);
    const svg = await measure("section50000", () => sectionShapesToSvg([shape], { plane: "xy", offset: 5 }));
    expect(svg).toContain("<svg");
    expect(svg).toMatch(/<path[^>]+d="M/);
    const coordinates = [...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])]);
    for (const axis of [0, 1]) {
      expect(Math.min(...coordinates.map((point) => point[axis]!))).toBeCloseTo(-5, 4);
      expect(Math.max(...coordinates.map((point) => point[axis]!))).toBeCloseTo(5, 4);
    }
  }, 240_000);

  it("fillets every edge of a 24-sided display revolve using exact topology", async () => {
    const parsed = parseRevolveRequest({ profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24 });
    if (!parsed.ok) throw new Error(parsed.error);
    const shape = revolvedShapeFromRequest(await serverManifoldRuntime(), parsed, { name: "Fillet benchmark" });
    const result = await measure("revolveFillet", () => applyEdgeTreatment(shape!, { kind: "fillet", amount: 0.2 }));
    const volume = await withCadKernel((cad) => cad.getVolume(cad.fromBREP(result.brep)));
    const removed = 4 * Math.PI * 0.2 ** 2 * (1 - Math.PI / 4) * (10 + 5);
    expect(volume).toBeCloseTo(Math.PI * (100 - 25) * 10 - removed, 3);
  });
});
