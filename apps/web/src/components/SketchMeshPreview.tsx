"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * A small 3D inset for a sketch operation, drawn from the mesh the kernel
 * builds. Revolve and sweep both use it so the solid is visible while the
 * profile is still being drawn.
 */
export function SketchMeshPreview({ positions, indices = null, title, empty, label }: {
  positions: number[] | null;
  indices?: number[] | null;
  title: string;
  empty: string;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !positions?.length) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 5000);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (indices?.length) geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({ color: "#8ccf79", roughness: 0.68, metalness: 0.02, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    scene.add(new THREE.HemisphereLight("#ffffff", "#b7cadd", 2.2));
    const key = new THREE.DirectionalLight("#ffffff", 3.2);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    scene.add(key);
    const fill = new THREE.DirectionalLight("#b9ddff", 1.2);
    fill.position.set(4, 2, -3);
    scene.add(fill);

    const bounds = geometry.boundingBox ?? new THREE.Box3().setFromObject(mesh);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1);
    // Frame the whole solid, not just its bounding sphere: a long sweep would
    // otherwise fill the inset and hide where it starts and ends.
    const distance = (longest / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.5;
    camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.75, 1.2).normalize(), distance);
    camera.lookAt(center);
    camera.near = Math.max(0.01, distance / 1000);
    camera.far = distance * 10;
    camera.updateProjectionMatrix();

    const render = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [indices, positions]);

  return (
    <aside className="sketch-mesh-preview" aria-label={label}>
      <div className="sketch-mesh-preview-title">{title}</div>
      {positions?.length ? <canvas ref={canvasRef} /> : <div className="sketch-mesh-preview-empty">{empty}</div>}
    </aside>
  );
}
