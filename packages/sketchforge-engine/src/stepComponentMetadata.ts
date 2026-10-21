/** Component labels and colors shared by regular STEP import and assembly explosion. */
import type { LabelTag, OcctKernel, ShapeHandle } from "occt-wasm";
import { componentColorsFromGlb } from "./stepGlbColors.js";
import { stepAssemblyHierarchyFromGlb, stepOccurrenceGeometryFromGlb, type StepAssemblyNode } from "./stepAssemblyHierarchy.js";

export type StepComponentMetadata = { name?: string; occurrenceId?: string; color?: string };
export type StepComponentMetadataResult = {
  bySolid: Map<string, StepComponentMetadata[]>;
  assembly?: StepAssemblyNode[];
};

export function stepShapeKey(cad: OcctKernel, shape: ShapeHandle) {
  const bounds = cad.getBoundingBox(shape, false);
  return [cad.getVolume(shape), bounds.xmin, bounds.ymin, bounds.zmin, bounds.xmax, bounds.ymax, bounds.zmax]
    .map((value) => value.toFixed(5))
    .join(":");
}

function colorHex(color: [number, number, number]) {
  return `#${color.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Read XCAF instance labels and associate leaf component metadata with exact solids. */
export function stepComponentMetadata(cad: OcctKernel, step: string) {
  const metadataBySolid = new Map<string, StepComponentMetadata[]>();
  const document = cad.importXCAFFromSTEP(step);
  let assembly: StepAssemblyNode[] | undefined;
  const occurrenceGeometry = new Map<string, ReturnType<typeof stepOccurrenceGeometryFromGlb>[number][]>();
  try {
    let colorsByName = new Map<string, { count: number; color?: string }>();
    try {
      const glb = document.exportGLTF();
      colorsByName = componentColorsFromGlb(glb);
      assembly = stepAssemblyHierarchyFromGlb(glb, step);
      for (const occurrence of stepOccurrenceGeometryFromGlb(glb, step)) {
        const key = [occurrence.bounds.xmin, occurrence.bounds.ymin, occurrence.bounds.zmin,
          occurrence.bounds.xmax, occurrence.bounds.ymax, occurrence.bounds.zmax]
          .map((value) => value.toFixed(2)).join(":");
        const matches = occurrenceGeometry.get(key) ?? [];
        matches.push(occurrence);
        occurrenceGeometry.set(key, matches);
      }
    } catch {
      // XCAF label data remains usable when the optional color view cannot be exported.
    }
    const leaves: { name: string; nameForOutput?: string; color?: string; solids: ShapeHandle[] }[] = [];
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
      const solids = cad.getSubShapes(info.shapeHandle, "solid");
      const name = info.name.trim();
      leaves.push({
        name,
        ...(name && !/^\d+$/.test(name) ? { nameForOutput: name } : {}),
        ...(inherited ? { color: inherited } : {}),
        solids,
      });
    };
    for (const root of document.getRoots()) visit(root);

    const leafCountByName = new Map<string, number>();
    for (const leaf of leaves) {
      if (leaf.name) leafCountByName.set(leaf.name, (leafCountByName.get(leaf.name) ?? 0) + 1);
    }
    for (const leaf of leaves) {
      const glbCandidate = colorsByName.get(leaf.name);
      const color = leaf.color ?? (leaf.name && leafCountByName.get(leaf.name) === 1 && glbCandidate?.count === 1
        ? glbCandidate.color
        : undefined);
      for (const solid of leaf.solids) {
        const key = stepShapeKey(cad, solid);
        const metadata = metadataBySolid.get(key) ?? [];
        metadata.push({
          ...(leaf.nameForOutput ? { name: leaf.nameForOutput } : {}),
          ...(color ? { color } : {}),
        });
        metadataBySolid.set(key, metadata);
      }
    }

    // Some OCCT builds flatten XCAF leaf labels to the assembly root. Recover
    // product identity only when GLB world-space bounds uniquely identify one
    // source solid and one occurrence. Ambiguous coincident geometry stays flat.
    const solids = cad.getSubShapes(cad.importStep(step), "solid");
    const solidByBounds = new Map<string, ShapeHandle[]>();
    const boundsKey = (bounds: ReturnType<OcctKernel["getBoundingBox"]>) =>
      [bounds.xmin, bounds.ymin, bounds.zmin, bounds.xmax, bounds.ymax, bounds.zmax]
        .map((value) => value.toFixed(2)).join(":");
    for (const solid of solids) {
      const key = boundsKey(cad.getBoundingBox(solid, false));
      const matches = solidByBounds.get(key) ?? [];
      matches.push(solid);
      solidByBounds.set(key, matches);
    }
    for (const [key, candidates] of occurrenceGeometry) {
      const solidsAtBounds = solidByBounds.get(key);
      if (candidates.length !== 1 || solidsAtBounds?.length !== 1) continue;
      const solid = solidsAtBounds[0]!;
      const solidKey = stepShapeKey(cad, solid);
      const existing = metadataBySolid.get(solidKey) ?? [];
      const color = existing.length === 1 ? existing[0]?.color : undefined;
      metadataBySolid.set(solidKey, [{ name: candidates[0]!.name, occurrenceId: candidates[0]!.occurrenceId, ...(color ? { color } : {}) }]);
    }
  } finally {
    document.close();
  }
  return { bySolid: metadataBySolid, ...(assembly ? { assembly } : {}) } satisfies StepComponentMetadataResult;
}
