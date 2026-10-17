import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ROTATION_RING_AXES, createRotationRingSet } from "@/lib/rotationRings";

/**
 * The viewport disposes the selection-helper group whenever the selection
 * changes, and hides it for the duration of a rotate drag. The ring set must
 * therefore not live inside it: these tests reproduce both behaviours against a
 * stand-in scene so the rings cannot be parented back into it unnoticed.
 */
function disposeChildren(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[group.children.length - 1];
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
  }
}

function sceneWithRings() {
  const scene = new THREE.Group();
  const helperLayer = new THREE.Group();
  const ringSet = createRotationRingSet();
  // Mirrors the viewport: helpers and rings are siblings under the scene.
  scene.add(helperLayer, ringSet.group);
  return { scene, helperLayer, ringSet };
}

describe("rotation ring set lifetime", () => {
  it("survives a selection-helper rebuild", () => {
    const { scene, helperLayer, ringSet } = sceneWithRings();
    helperLayer.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));

    disposeChildren(helperLayer);

    expect(scene.children).toContain(ringSet.group);
    for (const axis of ROTATION_RING_AXES) {
      const mesh = ringSet.rings[axis].mesh;
      expect(mesh.parent, `${axis} ring lost its parent`).not.toBeNull();
      // A disposed geometry drops its attributes; the rings must keep theirs.
      expect(mesh.geometry.getAttribute("position"), `${axis} ring geometry disposed`).toBeTruthy();
    }
  });

  it("stays visible while the selection helpers are hidden for a rotate drag", () => {
    const { helperLayer, ringSet } = sceneWithRings();
    ringSet.group.visible = true;

    helperLayer.visible = false;

    expect(ringSet.group.visible).toBe(true);
  });

  it("is raycastable from the scene, not only from the helper group", () => {
    const { helperLayer, ringSet } = sceneWithRings();
    ringSet.group.visible = true;
    for (const axis of ROTATION_RING_AXES) ringSet.rings[axis].mesh.visible = true;
    ringSet.group.scale.setScalar(10);
    ringSet.group.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    raycaster.layers.enableAll();
    raycaster.set(new THREE.Vector3(0, 0, 40), new THREE.Vector3(0, 0, -1));

    // What the viewport picks against: helper children plus the ring group.
    const targets = [...helperLayer.children, ringSet.group];
    const hits = raycaster.intersectObjects(targets, true);
    expect(hits.some((hit) => typeof hit.object.userData.rotationRingAxis === "string"
      || hit.object.parent === ringSet.group)).toBe(true);
  });
});
