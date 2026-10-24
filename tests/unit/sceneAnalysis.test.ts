/**
 * The editor's interference and wall-thickness analysis (#380).
 *
 * The editor runs both in its CAD worker on the parts it would send for an
 * exact cut, so these check the two halves the worker joins: the parts the
 * selection becomes, and the kernel-agnostic analysis over the solids built
 * from them. Overlaps are checked by their common volume rather than by
 * bounding extents -- a part placed at the wrong x still overlaps its
 * neighbour's box, but not by the same volume.
 */

import { describe, expect, it } from "vitest";
import type { OcctKernel } from "occt-wasm";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { interferenceBetweenSolids, MAX_INTERFERENCE_CANDIDATES, MAX_INTERFERENCE_SHAPES, sampledWallThickness } from "@constructorfleet/sketchforge-engine/cadAnalysis";
import { exactPartSolid } from "@constructorfleet/sketchforge-engine/exactBooleanSolids";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { createSceneAnalysisRunner, interferenceTargets, sceneAnalysisOperand, sceneAnalysisRefusalText, wallThicknessTarget } from "@/lib/sceneAnalysis";
import { translatorFor } from "@/i18n/translator";
import type { CadModifierMeshPart } from "@/lib/cadModifierTypes";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(id: string, x: number, extras: Partial<WorkplaneShape> = {}) {
  return sceneShape({ id, name: `Box ${id}`, kind: "box", color: "#123456", width: 10, depth: 10, height: 10, size: 10, x, ...extras });
}

const noMesh = () => null;

function exactSolid(cad: OcctKernel, part: CadModifierMeshPart) {
  if (!part.exact) throw new Error("expected an exact part");
  return exactPartSolid(cad, part.exact);
}

describe("scene analysis targets", () => {
  it("checks the selection when two or more shapes are selected, leaving out hidden shapes and cutters", () => {
    const shapes = [box("a", 0), box("b", 5), box("c", 50), box("hole", 0, { hole: true }), box("hidden", 0, { hidden: true })];
    expect(interferenceTargets(shapes, ["a", "b", "hole", "hidden"]).map((shape) => shape.id)).toEqual(["a", "b"]);
  });

  it("checks every visible solid when fewer than two shapes are selected", () => {
    const shapes = [box("a", 0), box("b", 5), box("c", 50), box("hole", 0, { hole: true }), box("hidden", 0, { hidden: true })];
    expect(interferenceTargets(shapes, []).map((shape) => shape.id)).toEqual(["a", "b", "c"]);
    expect(interferenceTargets(shapes, ["c"]).map((shape) => shape.id)).toEqual(["a", "b", "c"]);
  });

  it("measures wall thickness only for exactly one selected solid", () => {
    const shapes = [box("a", 0), box("b", 5), box("hole", 0, { hole: true })];
    expect(wallThicknessTarget(shapes, ["a"])?.id).toBe("a");
    expect(wallThicknessTarget(shapes, ["a", "b"])).toBeNull();
    expect(wallThicknessTarget(shapes, ["hole"])).toBeNull();
    expect(wallThicknessTarget(shapes, [])).toBeNull();
  });

  it("describes a parametric shape exactly and falls back to its tessellation, marked as such", () => {
    const exact = sceneAnalysisOperand(box("a", 3), noMesh);
    expect(exact).toMatchObject({ id: "a", name: "Box a", tessellated: false, part: { hole: false, exact: { transform: [1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0] } } });

    const mirrored: WorkplaneShape = { ...box("m", 0), mirrorX: true };
    const positions = new Float32Array(9);
    const indices = new Uint32Array([0, 1, 2]);
    expect(sceneAnalysisOperand(mirrored, () => ({ positions, indices }))).toMatchObject({ id: "m", tessellated: true, part: { positions, indices, hole: false } });
    expect(sceneAnalysisOperand(mirrored, noMesh)).toBeNull();
  });
});

describe("scene analysis on the kernel", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("reports exactly one colliding pair for two overlapping boxes, with their exact common volume", async () => {
    const cad = await serverCadKernel();
    try {
      const operands = [box("a", 0), box("b", 4), box("far", 40)].map((shape) => sceneAnalysisOperand(shape, noMesh)!);
      const result = interferenceBetweenSolids(cad, operands, (operand) => exactSolid(cad, operand.part), 0);
      if (!result.ok) throw new Error(JSON.stringify(result.refusal));
      expect(result.value.shapesChecked).toBe(3);
      expect(result.value.pairs).toHaveLength(1);
      expect(result.value.pairs[0]).toMatchObject({ a: { id: "a", name: "Box a" }, b: { id: "b", name: "Box b" }, gap: 0, precision: "exact" });
      // 6 mm of the 10 mm boxes overlap along x: 6 * 10 * 10.
      expect(result.value.pairs[0]!.overlapVolume).toBeCloseTo(600, 6);
      expect(result.value.method).toBe("OCCT exact distance and common volume; AABB candidate prefilter");
    } finally {
      cad.releaseAll();
    }
  });

  it("refuses an oversized request whole, naming the limit", async () => {
    const cad = await serverCadKernel();
    try {
      const many = Array.from({ length: MAX_INTERFERENCE_SHAPES + 1 }, (_, index) => ({ id: `s${index}`, name: `s${index}`, tessellated: false }));
      expect(interferenceBetweenSolids(cad, many, () => { throw new Error("no solid should be built"); }, 0))
        .toEqual({ ok: false, refusal: { reason: "too_many_shapes", limit: MAX_INTERFERENCE_SHAPES, given: MAX_INTERFERENCE_SHAPES + 1 } });

      const dense = Array.from({ length: 33 }, (_, index) => sceneAnalysisOperand(box(`d${index}`, 0), noMesh)!);
      expect(interferenceBetweenSolids(cad, dense, (operand) => exactSolid(cad, operand.part), 0))
        .toMatchObject({ ok: false, refusal: { reason: "too_many_candidates", limit: MAX_INTERFERENCE_CANDIDATES } });
    } finally {
      cad.releaseAll();
    }
  });

  it("samples the wall of a placed solid and discloses how", async () => {
    const cad = await serverCadKernel();
    try {
      const operand = sceneAnalysisOperand(box("plate", 12, { height: 4, width: 30, depth: 20 }), noMesh)!;
      expect(sampledWallThickness(cad, exactSolid(cad, operand.part))).toEqual({
        minimum: expect.closeTo(4, 6),
        unit: "mm",
        method: "sampled-opposing-surface-distance",
        samplesPerFace: 25,
        facesChecked: 6,
      });
    } finally {
      cad.releaseAll();
    }
  });
});

describe("scene analysis refusals", () => {
  it("refuses an oversized interference check before reaching the worker, in the user's language", async () => {
    let posted = 0;
    const runner = createSceneAnalysisRunner(async () => { posted += 1; throw new Error("the worker must not be asked"); }, noMesh);
    const shapes = Array.from({ length: MAX_INTERFERENCE_SHAPES + 3 }, (_, index) => box(`s${index}`, index * 20));
    const outcome = await runner.interference(shapes);
    expect(posted).toBe(0);
    expect(outcome).toEqual({ ok: false, refusal: { reason: "too_many_shapes", limit: MAX_INTERFERENCE_SHAPES, given: MAX_INTERFERENCE_SHAPES + 3 } });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(sceneAnalysisRefusalText(translatorFor("en"), outcome.refusal)).toBe(
      `Interference checks at most ${MAX_INTERFERENCE_SHAPES} shapes at a time, and ${MAX_INTERFERENCE_SHAPES + 3} were given. Select fewer shapes and check again.`,
    );
  });

  it("translates the worker's pair-count refusal, naming the limit", () => {
    expect(sceneAnalysisRefusalText(translatorFor("en"), { reason: "too_many_candidates", limit: MAX_INTERFERENCE_CANDIDATES, given: 528 })).toBe(
      `Too many shapes sit close together: ${528} pairs would need an exact check, and the limit is ${MAX_INTERFERENCE_CANDIDATES}. Select fewer shapes and check again.`,
    );
  });

  it("names a shape it has no geometry for rather than leaving it out of the report", async () => {
    const runner = createSceneAnalysisRunner(async () => { throw new Error("the worker must not be asked"); }, noMesh);
    const mirrored: WorkplaneShape = { ...box("m", 0), mirrorX: true };
    const outcome = await runner.interference([box("a", 0), mirrored]);
    expect(outcome).toEqual({ ok: false, refusal: { reason: "no_geometry", name: "Box m" } });
  });
});
