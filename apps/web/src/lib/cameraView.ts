import * as THREE from "three";
import type { CameraView } from "@/types/sketchforge";

type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export function captureCameraView(camera: ViewCamera, target: THREE.Vector3): CameraView {
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target: { x: target.x, y: target.y, z: target.z },
    zoom: camera.zoom,
  };
}

export function restoreCameraView(camera: ViewCamera, target: THREE.Vector3, view: CameraView) {
  camera.position.set(view.position.x, view.position.y, view.position.z);
  target.set(view.target.x, view.target.y, view.target.z);
  camera.zoom = view.zoom;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}
