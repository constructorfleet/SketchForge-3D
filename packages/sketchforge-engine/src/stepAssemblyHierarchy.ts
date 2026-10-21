/** Bounded product-tree metadata recovered from an XCAF GLB and STEP labels. */
import * as THREE from "three";
import { readGlbScene, readGlbSceneDocument, type GlbSceneDocument } from "./stepGlbDocument.js";

export type StepAssemblyNode = { id?: string; name: string; children: StepAssemblyNode[] };

const MAX_HIERARCHY_NODES = 2_000;
const MAX_HIERARCHY_DEPTH = 32;

type StepEntity = { id: number; type: string; args: string[] };

function entities(step: string): StepEntity[] {
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < step.length; index += 1) {
    const char = step[index];
    if (char === "'") {
      if (quoted && step[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ";") {
      records.push(step.slice(start, index));
      start = index + 1;
    }
  }

  const result: StepEntity[] = [];
  for (const record of records) {
    const match = /^\s*#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/i.exec(record);
    if (!match) continue;
    const args: string[] = [];
    let argStart = 0;
    let depth = 0;
    quoted = false;
    const body = match[3]!;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (char === "'") {
        if (quoted && body[index + 1] === "'") index += 1;
        else quoted = !quoted;
      } else if (!quoted && char === "(") depth += 1;
      else if (!quoted && char === ")") depth -= 1;
      else if (!quoted && depth === 0 && char === ",") {
        args.push(body.slice(argStart, index).trim());
        argStart = index + 1;
      }
    }
    args.push(body.slice(argStart).trim());
    result.push({ id: Number(match[1]), type: match[2]!.toUpperCase(), args });
  }
  return result;
}

function reference(value: string | undefined) {
  const match = /^#(\d+)$/.exec(value?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

function stepString(value: string | undefined) {
  const match = /^'((?:[^']|'')*)'$/.exec(value?.trim() ?? "");
  return match?.[1]?.replaceAll("''", "'").trim() ?? "";
}

export function stepComponentNamesByOccurrence(step: string) {
  const records = entities(step);
  const productNameById = new Map<number, string>();
  const productByFormationId = new Map<number, string>();
  const productByDefinitionId = new Map<number, string>();

  for (const entity of records) {
    if (entity.type === "PRODUCT") productNameById.set(entity.id, stepString(entity.args[0]));
  }
  for (const entity of records) {
    if (entity.type !== "PRODUCT_DEFINITION_FORMATION") continue;
    const productId = reference(entity.args[2]);
    if (productId !== undefined) productByFormationId.set(entity.id, productNameById.get(productId) ?? "");
  }
  for (const entity of records) {
    if (entity.type !== "PRODUCT_DEFINITION") continue;
    const formationId = reference(entity.args[2]);
    if (formationId !== undefined) productByDefinitionId.set(entity.id, productByFormationId.get(formationId) ?? "");
  }

  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entity of records) {
    if (entity.type !== "NEXT_ASSEMBLY_USAGE_OCCURRENCE") continue;
    const occurrenceId = stepString(entity.args[0]);
    const childDefinitionId = reference(entity.args[4]);
    if (!occurrenceId || childDefinitionId === undefined) continue;
    const explicitName = stepString(entity.args[1]);
    const name = explicitName && !/^\d+$/.test(explicitName)
      ? explicitName
      : productByDefinitionId.get(childDefinitionId) ?? "";
    if (!name) continue;
    const existing = names.get(occurrenceId);
    if (existing && existing !== name) ambiguous.add(occurrenceId);
    else names.set(occurrenceId, name);
  }
  for (const id of ambiguous) names.delete(id);
  return names;
}

/**
 * Read a display tree from OCCT's XCAF glTF export. Product names are taken
 * from STEP occurrence records because OCCT's glTF exporter names occurrence
 * nodes with the STEP relationship id. Geometry-only mesh nodes are folded
 * into their component occurrence. Files outside the importer metadata budget
 * never reach this helper.
 */
export function stepAssemblyHierarchyFromGlb(glb: Uint8Array, step: string): StepAssemblyNode[] | undefined {
  const document = readGlbSceneDocument(glb);
  const nodes = document?.nodes;
  if (!nodes?.length || nodes.length > MAX_HIERARCHY_NODES) return undefined;
  const namesByOccurrence = stepComponentNamesByOccurrence(step);
  if (!namesByOccurrence.size) return undefined;

  const sceneNodes = document?.scenes?.[document.scene ?? 0]?.nodes;
  const hasChild = new Set((nodes ?? []).flatMap((node) => node.children ?? []));
  const roots = sceneNodes?.length ? sceneNodes : nodes.flatMap((_, index) => hasChild.has(index) ? [] : [index]);
  let visited = 0;
  let mapped = 0;
  let invalid = false;

  const visit = (index: number, depth: number, path: Set<number>): StepAssemblyNode | null => {
    if (depth > MAX_HIERARCHY_DEPTH || index < 0 || index >= nodes.length || path.has(index)) {
      invalid = true;
      return null;
    }
    visited += 1;
    if (visited > MAX_HIERARCHY_NODES) {
      invalid = true;
      return null;
    }
    const node = nodes[index]!;
    const nextPath = new Set(path).add(index);
    const children = (node.children ?? []).map((child) => visit(child, depth + 1, nextPath)).filter((child): child is StepAssemblyNode => child !== null);
    // XCAF exports a separate mesh node under a component occurrence. That
    // node describes the same product's B-Rep representation, not a product
    // relationship, so it is intentionally omitted from the display tree.
    if (typeof node.mesh === "number" && children.length === 0) return null;
    const rawName = node.name?.trim() ?? "";
    const occurrenceName = namesByOccurrence.get(rawName);
    if (occurrenceName) mapped += 1;
    const name = occurrenceName ?? rawName;
    if (!name) return children.length === 1 ? children[0]! : null;
    return { id: occurrenceName ? `step-occurrence:${rawName}` : `step-node:${index}`, name, children };
  };

  let result = roots.map((root) => visit(root, 0, new Set())).filter((node): node is StepAssemblyNode => node !== null);
  if (invalid || mapped === 0) return undefined;

  // Some writers emit a scene wrapper and a product node with the same label.
  // Removing only this one-child duplicate keeps the product tree intact.
  while (result.length === 1 && result[0]!.children.length === 1 && result[0]!.name === result[0]!.children[0]!.name) {
    result = result[0]!.children;
  }
  return result.some((root) => root.children.length > 0) ? result : undefined;
}

export type StepOccurrenceGeometry = {
  occurrenceId: string;
  name: string;
  bounds: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
};

function nodeTransform(node: NonNullable<GlbSceneDocument["nodes"]>[number]) {
  if (node.matrix?.length === 16) return new THREE.Matrix4().fromArray(node.matrix);
  const translation = node.translation ?? [0, 0, 0];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0),
    new THREE.Quaternion(rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1),
    new THREE.Vector3(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1),
  );
}

function meshBounds(document: NonNullable<ReturnType<typeof readGlbSceneDocument>>, meshIndex: number) {
  const mesh = document.meshes?.[meshIndex];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const primitive of mesh?.primitives ?? []) {
    const positionIndex = primitive.attributes?.POSITION;
    const accessor = typeof positionIndex === "number" ? document.accessors?.[positionIndex] : undefined;
    if (accessor?.type !== "VEC3" || accessor.min?.length !== 3 || accessor.max?.length !== 3
      || !accessor.min.every(Number.isFinite) || !accessor.max.every(Number.isFinite)) continue;
    found = true;
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, accessor.min[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, accessor.max[axis]!);
    }
  }
  return found ? { minimum, maximum } : undefined;
}

function transformedBounds(bounds: { minimum: number[]; maximum: number[] }, transform: THREE.Matrix4) {
  const result = { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity };
  for (const x of [bounds.minimum[0]!, bounds.maximum[0]!]) {
    for (const y of [bounds.minimum[1]!, bounds.maximum[1]!]) {
      for (const z of [bounds.minimum[2]!, bounds.maximum[2]!]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(transform).multiplyScalar(1_000);
        result.xmin = Math.min(result.xmin, point.x);
        result.ymin = Math.min(result.ymin, point.y);
        result.zmin = Math.min(result.zmin, point.z);
        result.xmax = Math.max(result.xmax, point.x);
        result.ymax = Math.max(result.ymax, point.y);
        result.zmax = Math.max(result.zmax, point.z);
      }
    }
  }
  return result;
}

/** Map bounded GLB mesh extents to the closest named source occurrence. */
export function stepOccurrenceGeometryFromGlb(glb: Uint8Array, step: string): StepOccurrenceGeometry[] {
  const document = readGlbScene(glb)?.document;
  const nodes = document?.nodes;
  if (!document || !nodes?.length || nodes.length > MAX_HIERARCHY_NODES) return [];
  const namesByOccurrence = stepComponentNamesByOccurrence(step);
  if (!namesByOccurrence.size) return [];
  const hasChild = new Set(nodes.flatMap((node) => node.children ?? []));
  const roots = document.scenes?.[document.scene ?? 0]?.nodes?.length
    ? document.scenes[document.scene ?? 0]!.nodes!
    : nodes.flatMap((_, index) => hasChild.has(index) ? [] : [index]);
  const result: StepOccurrenceGeometry[] = [];
  let visited = 0;
  const visit = (index: number, parent: THREE.Matrix4, parentOccurrence?: string, depth = 0, path = new Set<number>()) => {
    if (depth > MAX_HIERARCHY_DEPTH || index < 0 || index >= nodes.length || path.has(index)) return;
    visited += 1;
    if (visited > MAX_HIERARCHY_NODES) return;
    const node = nodes[index]!;
    const world = parent.clone().multiply(nodeTransform(node));
    const rawName = node.name?.trim() ?? "";
    // Mesh nodes are geometry leaves and may coincidentally reuse a STEP
    // relationship number. Only non-mesh nodes represent occurrences.
    const occurrence = typeof node.mesh !== "number" && namesByOccurrence.has(rawName) ? rawName : parentOccurrence;
    if (typeof node.mesh === "number" && occurrence) {
      const bounds = meshBounds(document, node.mesh);
      const name = namesByOccurrence.get(occurrence);
      if (bounds && name) result.push({ occurrenceId: `step-occurrence:${occurrence}`, name, bounds: transformedBounds(bounds, world) });
    }
    const nextPath = new Set(path).add(index);
    for (const child of node.children ?? []) visit(child, world, occurrence, depth + 1, nextPath);
  };
  for (const root of roots) visit(root, new THREE.Matrix4(), undefined);
  return result;
}
