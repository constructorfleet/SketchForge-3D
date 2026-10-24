import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { transformMesh } from "@constructorfleet/sketchforge-engine/meshTransform";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(kind: "cylinder" | "cone", rotationX: number) {
  return {
    id: kind,
    name: kind,
    kind,
    color: "#888888",
    x: 0,
    z: 0,
    elevation: 0,
    width: 40,
    depth: 40,
    height: 40,
    size: 40,
    sides: 12,
    rotation: 40,
    rotationX,
    rotationZ: 30,
  } as WorkplaneShape;
}

describe("transformMesh round primitives with yaw and roll", () => {
  it.each([
    ["cylinder", 0],
    ["cone", 0],
    ["cylinder", 20],
    ["cone", 20],
  ] as const)("matches the viewport transform for a %s with pitch %d°", (kind, pitch) => {
    const source = shape(kind, pitch);
    const actual = transformMesh({ name: kind, vertices: [[0, source.height, 0]], faces: [] }, source).vertices[0]!;
    const expected = new THREE.Vector3(0, source.height / 2, 0)
      .applyEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(source.rotationX ?? 0),
        THREE.MathUtils.degToRad(source.rotation ?? 0),
        THREE.MathUtils.degToRad(source.rotationZ ?? 0),
        "XYZ",
      ))
      .add(new THREE.Vector3(0, source.height / 2, 0));

    expect(actual[0]).toBeCloseTo(expected.x, 5);
    expect(actual[1]).toBeCloseTo(expected.y, 5);
    expect(actual[2]).toBeCloseTo(expected.z, 5);
  });
});
