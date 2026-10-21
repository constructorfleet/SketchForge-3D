/** Split a retained STEP source into positioned, independently editable solids. Node-only. */

import * as THREE from "three";
import type { LabelTag, OcctKernel, ShapeHandle } from "occt-wasm";
import { importedShapeFromTriangleSoup } from "./stlImport.js";
import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import type { ProjectAsset, WorkplaneShape } from "./domain/sketchforge.js";
import { meshYawDegrees } from "./workplaneShapes.js";

export const MAX_EXPLODE_SOLIDS = 200;
export const MAX_EXPLODE_SOURCE_BYTES = 8 * 1024 * 1024;
const X_AXIS = { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } as const;

function boundsOf(cad: Parameters<Parameters<typeof withCadKernel>[0]>[0], shape: ShapeHandle) {
  return cad.getBoundingBox(shape, false);
}

type ComponentMetadata = { name?: string; color?: string };
type GlbColorDocument = {
  nodes?: Array<{ name?: string; mesh?: number }>;
  meshes?: Array<{
    name?: string;
    primitives?: Array<{ material?: number }>;
  }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
};

function shapeKey(cad: OcctKernel, shape: ShapeHandle) {
  const bounds = boundsOf(cad, shape);
  const values = [
    cad.getVolume(shape), bounds.xmin, bounds.ymin, bounds.zmin,
    bounds.xmax, bounds.ymax, bounds.zmax,
  ];
  return values.map((value) => value.toFixed(5)).join(":");
}

function colorHex(color: [number, number, number]) {
  return `#${color.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function componentColorsFromGlb(glb: Uint8Array) {
  const colorsByName = new Map<string, Set<string>>();
  if (glb.byteLength < 20) return new Map<string, string>();
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return new Map<string, string>();

  let json: GlbColorDocument | null = null;
  let offset = 12;
  while (offset + 8 <= glb.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > glb.byteLength) return new Map<string, string>();
    if (type === 0x4e4f534a) {
      try {
        json = JSON.parse(new TextDecoder().decode(glb.subarray(start, end)).trim()) as GlbColorDocument;
      } catch {
        return new Map<string, string>();
      }
      break;
    }
    offset = end;
  }
  if (!json) return new Map<string, string>();

  for (const node of json.nodes ?? []) {
    const mesh = typeof node.mesh === "number" ? json.meshes?.[node.mesh] : undefined;
    const names = new Set([node.name?.trim(), mesh?.name?.trim()].filter((name): name is string => Boolean(name)));
    if (!names.size || !mesh?.primitives?.length) continue;
    const colors = new Set<string>();
    let hasUncoloredPrimitive = false;
    for (const primitive of mesh.primitives) {
      const factor = typeof primitive.material === "number"
        ? json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor
        : undefined;
      if (!factor || factor.length < 3 || !factor.slice(0, 3).every(Number.isFinite)) {
        hasUncoloredPrimitive = true;
        break;
      }
      colors.add(colorHex([factor[0]!, factor[1]!, factor[2]!]));
    }
    if (hasUncoloredPrimitive || colors.size !== 1) continue;
    for (const name of names) {
      const entries = colorsByName.get(name) ?? new Set<string>();
      entries.add([...colors][0]!);
      colorsByName.set(name, entries);
    }
  }
  return new Map([...colorsByName].flatMap(([name, colors]) =>
    colors.size === 1 ? [[name, [...colors][0]!] as const] : []));
}

/** Read XCAF instance labels and associate leaf component metadata with its exact solid. */
function stepComponentMetadata(cad: OcctKernel, step: string) {
  const metadataBySolid = new Map<string, ComponentMetadata[]>();
  const document = cad.importXCAFFromSTEP(step);
  try {
    let colorsByName = new Map<string, string>();
    try {
      colorsByName = componentColorsFromGlb(document.exportGLTF());
    } catch {
      // The XCAF label data remains usable when the optional color view cannot be exported.
    }
    const visit = (label: LabelTag, inheritedColor?: string) => {
      const info = document.getLabelInfo(label);
      const labelColor = info.hasColor ? colorHex(info.color) : undefined;
      const children = document.getChildren(label);
      const inherited = labelColor ?? inheritedColor;
      if (children.length) {
        for (const child of children) visit(child, inherited);
        return;
      }
      if (info.isAssembly || !info.shapeHandle) return;
      const color = inherited ?? (info.name ? colorsByName.get(info.name) : undefined);
      const solids = cad.getSubShapes(info.shapeHandle, "solid");
      for (const solid of solids) {
        const key = shapeKey(cad, solid);
        const metadata = metadataBySolid.get(key) ?? [];
        metadata.push({
          ...(info.name.trim() && !/^\d+$/.test(info.name.trim()) ? { name: info.name.trim() } : {}),
          ...(color ? { color } : {}),
        });
        metadataBySolid.set(key, metadata);
      }
    };
    for (const root of document.getRoots()) visit(root);
  } finally {
    document.close();
  }
  return metadataBySolid;
}

/** Turn a STEP-imported mesh shape into one exact mesh/B-rep-backed shape per solid. */
export function explodeStepAssembly(shape: WorkplaneShape, source: ProjectAsset): Promise<WorkplaneShape[]> {
  if (shape.importedMesh?.sourceFormat !== "step" || !shape.importedMesh.assetId) {
    return Promise.reject(new ServerCadError("Only a STEP import with its original source asset can be exploded."));
  }
  if (source.sourceFormat !== "step" || source.byteLength > MAX_EXPLODE_SOURCE_BYTES) {
    return Promise.reject(new ServerCadError(`STEP explosion supports source files up to ${MAX_EXPLODE_SOURCE_BYTES} bytes.`, 413));
  }
  return withCadKernel((cad) => {
    const imported = cad.importStep(new TextDecoder().decode(source.bytes));
    const solids = cad.getSubShapes(imported, "solid");
    if (solids.length < 2) throw new ServerCadError("This STEP file contains only one solid; there is nothing to explode.");
    if (solids.length > MAX_EXPLODE_SOLIDS) throw new ServerCadError(`STEP explosion supports at most ${MAX_EXPLODE_SOLIDS} solids; this file contains ${solids.length}.`, 413);

    // Match the importer's Z-up conversion and scene-wide recentering.
    const turnedAssembly = cad.rotate(imported, X_AXIS, -Math.PI / 2);
    const assemblyBounds = boundsOf(cad, turnedAssembly);
    const centerX = (assemblyBounds.xmin + assemblyBounds.xmax) / 2;
    const floorY = assemblyBounds.ymin;
    const centerZ = (assemblyBounds.zmin + assemblyBounds.zmax) / 2;
    const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(meshYawDegrees(shape)),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ));
    const mirrors = new THREE.Vector3(shape.mirrorX ? -1 : 1, shape.mirrorY ? -1 : 1, shape.mirrorZ ? -1 : 1);
    const parentCenter = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
    const componentMetadata = stepComponentMetadata(cad, new TextDecoder().decode(source.bytes));

    return solids.map((solid, index) => {
      const metadata = componentMetadata.get(shapeKey(cad, solid))?.shift();
      const turned = cad.rotate(solid, X_AXIS, -Math.PI / 2);
      const positioned = cad.translate(turned, -centerX, -floorY, -centerZ);
      const bounds = boundsOf(cad, positioned);
      const partX = (bounds.xmin + bounds.xmax) / 2;
      const partY = bounds.ymin;
      const partZ = (bounds.zmin + bounds.zmax) / 2;
      const local = cad.translate(positioned, -partX, -partY, -partZ);
      const mesh = cad.tessellate(positioned);
      const positions: number[] = [];
      const normals: number[] = [];
      for (let cursor = 0; cursor < mesh.indices.length; cursor += 1) {
        const vertex = mesh.indices[cursor]! * 3;
        positions.push(mesh.positions[vertex]!, mesh.positions[vertex + 1]!, mesh.positions[vertex + 2]!);
        if (mesh.normals.length === mesh.positions.length) normals.push(mesh.normals[vertex]!, mesh.normals[vertex + 1]!, mesh.normals[vertex + 2]!);
      }
      const child = importedShapeFromTriangleSoup(metadata?.name ?? `${shape.name} ${index + 1}`, positions, normals.length ? normals : undefined, "step");
      const offset = new THREE.Vector3(partX, partY - shape.height / 2, partZ).multiply(mirrors).applyMatrix4(rotation).add(parentCenter);
      child.color = metadata?.color ?? shape.color;
      child.material = shape.material;
      child.appearance = shape.appearance;
      child.hole = shape.hole;
      child.hidden = shape.hidden;
      child.locked = shape.locked;
      child.rotation = shape.rotation;
      child.rotationX = shape.rotationX;
      child.rotationZ = shape.rotationZ;
      child.mirrorX = shape.mirrorX;
      child.mirrorY = shape.mirrorY;
      child.mirrorZ = shape.mirrorZ;
      child.x = offset.x;
      child.elevation = offset.y;
      child.z = offset.z;
      child.importedMesh!.brepStep = cad.exportStep(local);
      return child;
    });
  });
}
