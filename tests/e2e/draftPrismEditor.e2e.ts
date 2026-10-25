import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { CAD_TEST_TIMEOUT_MS } from "../unit/support/cadTestTimeout";
import type { SketchProfile } from "@/types/sketchforge";


let buildDraftPrism: typeof import("@/lib/engine/draftPrism").buildDraftPrism;
let kernel: import("occt-wasm").OcctKernel;

const profile: SketchProfile = {
  points: [
    { id: "a", x: 10, z: 20 },
    { id: "b", x: 30, z: 20 },
    { id: "c", x: 30, z: 40 },
    { id: "d", x: 10, z: 40 },
  ],
  segments: [
    { id: "ab", startId: "a", endId: "b", kind: "line" },
    { id: "bc", startId: "b", endId: "c", kind: "line" },
    { id: "cd", startId: "c", endId: "d", kind: "line" },
    { id: "da", startId: "d", endId: "a", kind: "line" },
  ],
};

beforeAll(async () => {
  ({ buildDraftPrism } = await import("@/lib/engine/draftPrism"));
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
  kernel = await OcctKernel.init({ wasm });
});

describe("editor draft-prism operation", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("builds a persistable exact solid from the retained sketch and angle", () => {
    const result = buildDraftPrism(kernel, { profile, height: 12, angle: 5 });

    expect(result.brep).toContain("CASCADE Topology");
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.indices.length).toBe(result.triangleCount * 3);
    const ys = Array.from(result.positions).filter((_, index) => index % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 4);
    expect(Math.max(...ys)).toBeCloseTo(12, 4);
  });

  it("drafts a profile whose segments are stored out of order and reversed the same as the ordered one (#349)", () => {
    const reordered: SketchProfile = {
      points: profile.points,
      segments: [
        { id: "dc", startId: "d", endId: "c", kind: "line" },
        { id: "ad", startId: "a", endId: "d", kind: "line" },
        { id: "cb", startId: "c", endId: "b", kind: "line" },
        { id: "ba", startId: "b", endId: "a", kind: "line" },
      ],
    };
    const volume = (brep: string) => kernel.queryBatch([kernel.fromBREP(brep)])[0]!;
    const ordered = volume(buildDraftPrism(kernel, { profile, height: 12, angle: 5 }).brep);
    const actual = volume(buildDraftPrism(kernel, { profile: reordered, height: 12, angle: 5 }).brep);

    expect(Math.abs(actual.volume - ordered.volume)).toBeLessThan(1e-6);
    expect(actual.centerOfMass.x).toBeCloseTo(ordered.centerOfMass.x, 6);
    expect(actual.centerOfMass.y).toBeCloseTo(ordered.centerOfMass.y, 6);
    expect(actual.centerOfMass.z).toBeCloseTo(ordered.centerOfMass.z, 6);
  });

  it("rejects an unsupported angle before creating geometry", () => {
    expect(() => buildDraftPrism(kernel, { profile, height: 12, angle: 45 })).toThrow(/between -45 and 45/);
  });
});
