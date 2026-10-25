/** Component labels and colors shared by regular STEP import and assembly explosion. */
import type { LabelTag, OcctKernel, ShapeHandle } from "occt-wasm";
import { componentColorsFromGlb } from "./stepGlbColors.js";
import { stepAssemblyHierarchyFromGlb, stepComponentNamesByOccurrence, stepOccurrenceGeometryFromGlb, type StepAssemblyNode } from "./stepAssemblyHierarchy.js";

export type StepComponentMetadata = { name?: string; occurrenceId?: string; color?: string };
export type StepComponentMetadataResult = {
  bySolid: Map<string, StepComponentMetadata[]>;
  assembly?: StepAssemblyNode[];
};

function expandNamedProductPaths(root: StepAssemblyNode): StepAssemblyNode {
  const prefix = `${root.name} / `;
  const children: StepAssemblyNode[] = [];
  for (const component of root.children) {
    if (component.children.length || !component.name.startsWith(prefix)) {
      children.push(component);
      continue;
    }
    const segments = component.name.slice(prefix.length).split(" / ").filter(Boolean);
    if (segments.length < 2) {
      children.push({ ...component, name: segments[0] ?? component.name });
      continue;
    }
    let target = children;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let group = target.find((child) => child.name === name && child.id?.startsWith("step-path:"));
      if (!group) {
        group = { id: `step-path:${root.id ?? root.name}:${segments.slice(0, index + 1).join("/")}`, name, children: [] };
        target.push(group);
      }
      target = group.children;
    }
    target.push({ ...component, name: segments.at(-1)! });
  }
  return { ...root, children };
}

export function stepShapeKey(cad: OcctKernel, shape: ShapeHandle) {
  const bounds = cad.getBoundingBox(shape, false);
  return [cad.getVolume(shape), bounds.xmin, bounds.ymin, bounds.zmin, bounds.xmax, bounds.ymax, bounds.zmax]
    .map((value) => value.toFixed(5))
    .join(":");
}

function stepColorsInShapeOrder(step: string, expectedCount: number): string[] | undefined {
  const entities = [...step.matchAll(/^#(\d+)\s*=\s*([\s\S]*?);/gm)].map((match) => ({
    id: Number(match[1]),
    text: match[2]!,
  }));
  const byId = new Map(entities.map((entity) => [entity.id, entity.text]));
  const refs = (text: string) => [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  const colorFrom = (id: number, seen = new Set<number>()): string | undefined => {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const text = byId.get(id);
    if (!text) return undefined;
    const rgb = /^COLOUR_RGB\([^,]*,\s*([\d.e+-]+),\s*([\d.e+-]+),\s*([\d.e+-]+)\s*\)$/i.exec(text.trim());
    if (rgb) {
      // OCCT 8 serializes the supplied RGB values through its linear color
      // conversion. Convert them back to the sRGB hex values used by the app.
      const channels = rgb.slice(1).map((value) => {
        const channel = Number(value);
        const linear = channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
        return Math.round(linear * 255);
      });
      return `#${channels.map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
    }
    for (const child of refs(text)) {
      const color = colorFrom(child, seen);
      if (color) return color;
    }
    return undefined;
  };

  const colorByShape = new Map<number, string>();
  for (const { text } of entities.filter(({ text }) => /^STYLED_ITEM\(/i.test(text.trim()))) {
    const references = refs(text);
    const target = references.at(-1);
    if (target === undefined) continue;
    for (const style of references.slice(0, -1)) {
      const color = colorFrom(style);
      if (color) {
        colorByShape.set(target, color);
        break;
      }
    }
  }

  const ordered = new Map<number, { representation: number; color: string }>();
  for (const { id, text } of entities.filter(({ text }) => /^ADVANCED_BREP_SHAPE_REPRESENTATION\(/i.test(text.trim()))) {
    const shapeId = refs(text).find((reference) => colorByShape.has(reference));
    const color = shapeId === undefined ? undefined : colorByShape.get(shapeId);
    if (shapeId !== undefined && color && !ordered.has(shapeId)) ordered.set(shapeId, { representation: id, color });
  }
  const colors = [...ordered.values()].sort((a, b) => a.representation - b.representation).map(({ color }) => color);
  return colors.length === expectedCount ? colors : undefined;
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
    const occurrenceNames = stepComponentNamesByOccurrence(step);
    const hasProductNames = [...occurrenceNames.values()].some((name) =>
      name.trim() && !/^(?:\d+|SOLID|COMPOUND|SHAPE|BODY)$/i.test(name.trim())
      && !/^Open CASCADE STEP translator\b/i.test(name.trim()),
    );
    if (!assembly && hasProductNames) {
      // The installed XCAF GLB exporter can omit occurrence nodes for some
      // valid STEP assemblies. Recover the editable one-level product grouping
      // directly from labels rather than dropping all grouping metadata.
      const labelTree = (label: LabelTag): StepAssemblyNode => {
        const info = document.getLabelInfo(label);
        const rawName = info.name.trim();
        const occurrenceId = /^\d+$/.test(rawName) ? rawName : undefined;
        const name = occurrenceId ? occurrenceNames.get(occurrenceId) ?? rawName : rawName;
        return {
          id: occurrenceId ? `step-occurrence:${occurrenceId}` : `step-xcaf-label:${info.labelId}`,
          name: name || `Component ${info.labelId}`,
          children: document.getChildren(label).map(labelTree),
        };
      };
      const roots = document.getRoots().map(labelTree).filter((root) => root.children.length > 0);
      if (roots.length) assembly = roots.map(expandNamedProductPaths);
    }
    const leaves: { name: string; nameForOutput?: string; occurrenceId?: string; color?: string; solids: ShapeHandle[] }[] = [];
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
      const rawName = info.name.trim();
      const occurrenceId = /^\d+$/.test(rawName) && hasProductNames && occurrenceNames.has(rawName) ? rawName : undefined;
      const name = occurrenceId ? occurrenceNames.get(occurrenceId) ?? rawName : rawName;
      leaves.push({
        name,
        ...(name && !/^\d+$/.test(name) ? { nameForOutput: name } : {}),
        ...(occurrenceId ? { occurrenceId: `step-occurrence:${occurrenceId}` } : {}),
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
          ...(leaf.occurrenceId ? { occurrenceId: leaf.occurrenceId } : {}),
          ...(color ? { color } : {}),
        });
        metadataBySolid.set(key, metadata);
      }
    }

    if ([...metadataBySolid.values()].every((candidates) => candidates.every(({ color }) => !color))) {
      const colors = stepColorsInShapeOrder(step, metadataBySolid.size);
      if (colors) {
        [...metadataBySolid.values()].forEach((candidates, index) => {
          for (const candidate of candidates) candidate.color = colors[index];
        });
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
