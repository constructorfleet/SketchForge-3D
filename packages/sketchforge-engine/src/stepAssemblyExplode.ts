/**
 * Split a retained STEP source into positioned, independently editable solids
 * on whichever OCCT kernel the caller holds.
 *
 * The server runs this through `withCadKernel` (`serverStepExplode`), and the
 * editor runs it on the browser kernel STEP import already loaded
 * (`explodeStepAssemblyInBrowser`), so both produce the same groups and leaves.
 */

import * as THREE from "three";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { importedShapeFromTriangleSoup } from "./stlImport.js";
import { stepComponentMetadata, stepShapeKey } from "./stepComponentMetadata.js";
import { groupedShapeFromSelection } from "./serverShapeGroups.js";
import { loadOcctKernel } from "./support/lib/brepKernel.js";
import type { ProjectAsset, StepAssemblyNode, StepAssemblyPathNode, WorkplaneShape } from "./domain/sketchforge.js";
import { meshYawDegrees } from "./workplaneShapes.js";

export const MAX_EXPLODE_SOLIDS = 200;
export const MAX_EXPLODE_SOURCE_BYTES = 8 * 1024 * 1024;
const X_AXIS = { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } as const;

/** Why an explosion was refused, so each caller can word it its own way. */
export type StepExplodeRefusal = "not_step" | "source_too_large" | "single_solid" | "too_many_solids";

/** A refused explosion: an English message, an HTTP-style status, and a stable reason. */
export class StepExplodeError extends Error {
  readonly reason: StepExplodeRefusal;
  readonly status: number;
  readonly params: Record<string, number>;

  constructor(reason: StepExplodeRefusal, message: string, status = 422, params: Record<string, number> = {}) {
    super(message);
    this.name = "StepExplodeError";
    this.reason = reason;
    this.status = status;
    this.params = params;
  }
}

/**
 * The shapes that replace the imported assembly.
 *
 * `hierarchy` is `nested` when the source product tree was rebuilt as groups,
 * and `flat` when it could not be matched unambiguously (or there was none),
 * in which case `shapes` are the top-level solids.
 */
export type StepAssemblyExplosion = { shapes: WorkplaneShape[]; hierarchy: "nested" | "flat" };

function boundsOf(cad: OcctKernel, shape: ShapeHandle) {
  return cad.getBoundingBox(shape, false);
}

function leafPaths(nodes: StepAssemblyNode[], parentPath: StepAssemblyPathNode[] = []): StepAssemblyPathNode[][] {
  return nodes.flatMap((node) => {
    const path = [...parentPath, { ...(node.id ? { id: node.id } : {}), name: node.name }];
    return node.children.length ? leafPaths(node.children, path) : [path];
  });
}

function uniqueNamedPath(paths: StepAssemblyPathNode[][], name: string) {
  const matches = paths.filter((path) => path.at(-1)?.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function groupExplodedHierarchy(parts: WorkplaneShape[], roots: StepAssemblyNode[]): WorkplaneShape[] | null {
  const partsByOccurrence = new Map<string, WorkplaneShape[]>();
  for (const part of parts) {
    const occurrenceId = part.stepComponent?.occurrenceId;
    if (!occurrenceId) return null;
    const matches = partsByOccurrence.get(occurrenceId) ?? [];
    matches.push(part);
    partsByOccurrence.set(occurrenceId, matches);
  }

  const consumed = new Set<WorkplaneShape>();
  let complete = true;
  const namedGroup = (name: string, children: WorkplaneShape[]) => {
    const group = groupedShapeFromSelection(children, { allowSingle: true, name });
    if (!group) {
      complete = false;
      return children;
    }
    return [group];
  };
  const visit = (node: StepAssemblyNode): WorkplaneShape[] => {
    if (!node.children.length) {
      if (!node.id) {
        complete = false;
        return [];
      }
      const matches = partsByOccurrence.get(node.id);
      if (!matches?.length) {
        complete = false;
        return [];
      }
      matches.forEach((part) => consumed.add(part));
      return matches.length > 1 ? namedGroup(node.name, matches) : matches;
    }
    const children = node.children.flatMap(visit);
    if (!children.length) return [];
    return namedGroup(node.name, children);
  };

  const grouped = roots.flatMap(visit);
  // Keep the proven flat behavior when even one source solid cannot be
  // associated to a product occurrence. A partial tree would hide geometry.
  return complete && consumed.size === parts.length && grouped.length ? grouped : null;
}

/** Refuse, without touching a kernel, a shape or source that cannot be exploded. */
export function assertStepExplodable(shape: WorkplaneShape, source: ProjectAsset) {
  if (shape.importedMesh?.sourceFormat !== "step" || !shape.importedMesh.assetId) {
    throw new StepExplodeError("not_step", "Only a STEP import with its original source asset can be exploded.");
  }
  if (source.sourceFormat !== "step" || source.byteLength > MAX_EXPLODE_SOURCE_BYTES) {
    throw new StepExplodeError("source_too_large", `STEP explosion supports source files up to ${MAX_EXPLODE_SOURCE_BYTES} bytes.`, 413, { bytes: MAX_EXPLODE_SOURCE_BYTES });
  }
}

/** Turn a STEP-imported mesh shape into one exact mesh/B-rep-backed shape per solid, on `cad`. */
export function explodeStepAssemblyWithKernel(cad: OcctKernel, shape: WorkplaneShape, source: ProjectAsset): StepAssemblyExplosion {
  assertStepExplodable(shape, source);
  const imported = cad.importStep(new TextDecoder().decode(source.bytes));
  const solids = cad.getSubShapes(imported, "solid");
  if (solids.length < 2) throw new StepExplodeError("single_solid", "This STEP file contains only one solid; there is nothing to explode.");
  if (solids.length > MAX_EXPLODE_SOLIDS) {
    throw new StepExplodeError("too_many_solids", `STEP explosion supports at most ${MAX_EXPLODE_SOLIDS} solids; this file contains ${solids.length}.`, 413, { max: MAX_EXPLODE_SOLIDS, count: solids.length });
  }

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
  const paths = leafPaths(shape.stepAssembly ?? []);
  const occurrencePartIndexes = new Map<string, number>();

  const parts = solids.map((solid, index) => {
    const candidates = componentMetadata.bySolid.get(stepShapeKey(cad, solid)) ?? [];
    const firstCandidate = candidates[0];
    const metadata = firstCandidate ? {
      ...(candidates.length === 1 && firstCandidate.name ? { name: firstCandidate.name } : {}),
      ...(candidates.length === 1 && firstCandidate.occurrenceId ? { occurrenceId: firstCandidate.occurrenceId } : {}),
      ...(candidates.every((candidate) => candidate.color === firstCandidate.color) && firstCandidate.color
        ? { color: firstCandidate.color }
        : {}),
    } : undefined;
    const path = metadata?.occurrenceId
      ? paths.find((candidate) => candidate.at(-1)?.id === metadata.occurrenceId)
      : metadata?.name ? uniqueNamedPath(paths, metadata.name) : undefined;
    const occurrenceId = path?.at(-1)?.id;
    const occurrencePartIndex = occurrenceId ? (occurrencePartIndexes.get(occurrenceId) ?? 0) : 0;
    if (occurrenceId) occurrencePartIndexes.set(occurrenceId, occurrencePartIndex + 1);
    const componentName = path?.at(-1)?.name ?? (paths.length === 0 ? metadata?.name : undefined);
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
    const child = importedShapeFromTriangleSoup(componentName ?? `${shape.name} ${index + 1}`, positions, normals.length ? normals : undefined, "step");
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
    if (path && occurrenceId) {
      child.stepComponent = {
        id: `${occurrenceId}/solid-${occurrencePartIndex + 1}`,
        occurrenceId,
        path,
      };
    }
    return child;
  });
  const grouped = groupExplodedHierarchy(parts, shape.stepAssembly ?? []);
  return grouped ? { shapes: grouped, hierarchy: "nested" } : { shapes: parts, hierarchy: "flat" };
}

/**
 * Explode on the browser kernel that STEP import loads.
 *
 * Like browser STEP import, this leaves the kernel's handle arena alone: the
 * same kernel backs brepjs for STEP export, and emptying the arena under it
 * would dangle handles it still holds.
 */
export async function explodeStepAssemblyInBrowser(shape: WorkplaneShape, source: ProjectAsset): Promise<StepAssemblyExplosion> {
  assertStepExplodable(shape, source);
  const kernel = await loadOcctKernel();
  return explodeStepAssemblyWithKernel(kernel, shape, source);
}
