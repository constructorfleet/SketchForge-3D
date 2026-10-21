import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { captureCameraView, restoreCameraView } from "@/lib/cameraView";

describe("saved camera view", () => {
  it("restores camera position, target, and zoom for the active projection", () => {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 6000);
    const target = new THREE.Vector3();
    const view = {
      position: { x: 83, y: 62, z: 91 },
      target: { x: 14, y: 8, z: -6 },
      zoom: 1.75,
    };

    restoreCameraView(camera, target, view);

    expect(captureCameraView(camera, target)).toEqual(view);
    expect(camera.getWorldDirection(new THREE.Vector3()).dot(
      target.clone().sub(camera.position).normalize(),
    )).toBeCloseTo(1, 10);
  });
});
