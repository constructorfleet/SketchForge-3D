/** Component labels and colors shared by regular STEP import and assembly explosion. */
import type { LabelTag, OcctKernel, ShapeHandle } from "occt-wasm";
import { componentColorsFromGlb } from "./stepGlbColors.js";

export type StepComponentMetadata = { name?: string; color?: string };

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
  try {
    let colorsByName = new Map<string, { count: number; color?: string }>();
    try {
      colorsByName = componentColorsFromGlb(document.exportGLTF());
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
  } finally {
    document.close();
  }
  return metadataBySolid;
}
