import { describe, expect, it } from "vitest";
import { componentColorsFromGlb } from "@constructorfleet/sketchforge-engine/stepGlbColors";

function glb(json: unknown) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(jsonBytes.length / 4) * 4;
  const bytes = new Uint8Array(20 + paddedLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20);
  bytes.set(jsonBytes, 20);
  return bytes;
}

const material = (color: [number, number, number]) => ({ pbrMetallicRoughness: { baseColorFactor: [...color, 1] } });

describe("STEP GLB component colors", () => {
  it("marks repeated component names ambiguous even when GLB node order differs", () => {
    const colors = componentColorsFromGlb(glb({
      nodes: [
        { name: "Repeated", mesh: 0 },
        { name: "Unique", mesh: 1 },
        { name: "Repeated", mesh: 2 },
      ],
      meshes: [
        { primitives: [{ material: 0 }] },
        { primitives: [{ material: 1 }] },
        { primitives: [{ material: 2 }] },
      ],
      materials: [material([1, 0, 0]), material([0, 1, 0]), material([0, 0, 1])],
    }));

    expect(colors.get("Repeated")).toEqual({ count: 2, color: undefined });
    expect(colors.get("Unique")).toEqual({ count: 1, color: "#00ff00" });
  });

  it("rejects a component with any primitive that has no explicit material color", () => {
    const colors = componentColorsFromGlb(glb({
      nodes: [{ name: "Partial", mesh: 0 }],
      meshes: [{ primitives: [{ material: 0 }, {}] }],
      materials: [material([1, 0, 0])],
    }));

    expect(colors.get("Partial")).toEqual({ count: 1, color: undefined });
  });

  it("does not treat conflicting node and mesh names as a component identity", () => {
    const colors = componentColorsFromGlb(glb({
      nodes: [{ name: "Node label", mesh: 0 }],
      meshes: [{ name: "Mesh label", primitives: [{ material: 0 }] }],
      materials: [material([1, 0, 0])],
    }));

    expect(colors.get("Node label")).toBeUndefined();
    expect(colors.get("Mesh label")).toEqual({ count: 1, color: undefined });
  });

  it("associates a uniformly colored STEP occurrence ID with its product mesh name", () => {
    const colors = componentColorsFromGlb(glb({
      nodes: [{ name: "1", mesh: 0 }],
      meshes: [{ name: "Housing", primitives: [{ material: 0 }] }],
      materials: [material([0.8, 0.1, 0.2])],
    }));

    expect(colors.get("1")).toEqual({ count: 1, color: "#cc1a33" });
    expect(colors.get("Housing")).toEqual({ count: 1, color: "#cc1a33" });
  });
});
