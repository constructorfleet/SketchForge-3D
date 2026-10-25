import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stepAssemblyHierarchyFromGlb } from "@constructorfleet/sketchforge-engine/stepAssemblyHierarchy";

const step = await readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");

function glb(nodes: Array<{ name?: string; children?: number[] }>) {
  const json = Buffer.from(JSON.stringify({ scene: 0, scenes: [{ nodes: [0] }], nodes }));
  const paddedLength = (json.byteLength + 3) & ~3;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.byteLength, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return new Uint8Array(bytes);
}

describe("STEP assembly hierarchy bounds", () => {
  it("falls back when the GLB node count exceeds 2,000", () => {
    const nodes = Array.from({ length: 2_001 }, (_, index) => ({ name: index === 0 ? "8" : `node-${index}` }));
    expect(stepAssemblyHierarchyFromGlb(glb(nodes), step)).toBeUndefined();
  });

  it("falls back when an occurrence tree exceeds depth 32", () => {
    const nodes = Array.from({ length: 34 }, (_, index) => ({
      name: index === 0 ? "8" : `node-${index}`,
      ...(index < 33 ? { children: [index + 1] } : {}),
    }));
    expect(stepAssemblyHierarchyFromGlb(glb(nodes), step)).toBeUndefined();
  });
});
