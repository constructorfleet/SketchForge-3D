import type { WorkplaneShape } from "./domain/sketchforge.js";
import { createLocalId } from "./localIds.js";
import { shapeFaces, type ServerCadFace } from "./serverCadShell.js";
import { canonicalizeShape } from "./workplaneShapes.js";

const UNIQUE_CURVED_FACE_SURFACES = new Set(["cone", "sphere", "torus", "cylinder"]);

/** Preserve face IDs and colors only when topology has a unique geometric counterpart. */
export async function preserveUnambiguousFaceMetadata(
  previous: WorkplaneShape,
  next: WorkplaneShape,
): Promise<WorkplaneShape> {
  if (!previous.faceIds?.length && !previous.faceColors) return next;
  const before = await shapeFaces(previous);
  const after = await shapeFaces(next);
  const signature = (face: ServerCadFace) => face.normal
    ? `${face.surfaceType}:${Math.round(face.normal.x * 1000)}:${Math.round(face.normal.y * 1000)}:${Math.round(face.normal.z * 1000)}:${face.facing ?? "interior"}`
    : undefined;
  const beforeBySignature = new Map<string, ServerCadFace[]>();
  const afterBySignature = new Map<string, ServerCadFace[]>();
  for (const face of before) {
    const key = signature(face);
    if (key) beforeBySignature.set(key, [...(beforeBySignature.get(key) ?? []), face]);
  }
  for (const face of after) {
    const key = signature(face);
    if (key) afterBySignature.set(key, [...(afterBySignature.get(key) ?? []), face]);
  }
  const beforeBySurface = new Map<string, ServerCadFace[]>();
  const afterBySurface = new Map<string, ServerCadFace[]>();
  for (const face of before) beforeBySurface.set(face.surfaceType, [...(beforeBySurface.get(face.surfaceType) ?? []), face]);
  for (const face of after) afterBySurface.set(face.surfaceType, [...(afterBySurface.get(face.surfaceType) ?? []), face]);

  const beforeForAfter = new Map<number, ServerCadFace>();
  const matchedBefore = new Set<number>();
  for (const face of after) {
    const key = signature(face);
    const oldMatches = key ? beforeBySignature.get(key) ?? [] : [];
    const newMatches = key ? afterBySignature.get(key) ?? [] : [];
    if (oldMatches.length === 1 && newMatches.length === 1) {
      beforeForAfter.set(face.index, oldMatches[0]!);
      matchedBefore.add(oldMatches[0]!.index);
    }
  }
  for (const face of after) {
    if (beforeForAfter.has(face.index) || !UNIQUE_CURVED_FACE_SURFACES.has(face.surfaceType)) continue;
    const oldMatches = beforeBySurface.get(face.surfaceType) ?? [];
    const newMatches = afterBySurface.get(face.surfaceType) ?? [];
    if (oldMatches.length === 1 && newMatches.length === 1 && !matchedBefore.has(oldMatches[0]!.index)) {
      beforeForAfter.set(face.index, oldMatches[0]!);
      matchedBefore.add(oldMatches[0]!.index);
    }
  }

  const ids = after.map((face) => beforeForAfter.get(face.index)?.id
    ?? `face_${createLocalId(`${next.id}-${face.index}`)}`);
  const mappedColors: Record<string, string> = {};
  for (const [key, color] of Object.entries(previous.faceColors ?? {})) {
    const oldIndex = /^\d+$/.test(key) ? Number(key) : -1;
    const oldFace = oldIndex >= 0 ? before[oldIndex] : before.find((face) => face.id === key);
    if (!oldFace) continue;
    const matched = after.find((face) => beforeForAfter.get(face.index)?.index === oldFace.index);
    if (matched) mappedColors[ids[matched.index]!] = color;
  }
  return canonicalizeShape({
    ...next,
    faceIds: ids,
    faceColors: Object.keys(mappedColors).length ? mappedColors : undefined,
  });
}
