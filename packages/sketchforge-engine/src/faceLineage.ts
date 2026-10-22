import type { EvolutionData } from "occt-wasm";
import { createLocalId } from "./localIds.js";

/**
 * Keep a source face ID only when OCCT history gives a unique one-to-one
 * relation. occt-wasm 3.6 encodes each Modified relation as triples of source
 * hash, relation kind, and result hash. Unchanged faces retain their hash.
 * Split, merged, generated, malformed, or hash-ambiguous topology gets fresh
 * IDs so persisted colors are never assigned by guesswork.
 */
export function faceIdsFromEvolution(
  shapeId: string,
  sourceFaceIds: readonly string[] | undefined,
  sourceFaceHashes: readonly number[],
  resultFaceHashes: readonly number[],
  evolution: Pick<EvolutionData, "modified" | "generated">,
): string[] {
  const sourceHashCounts = countValues(sourceFaceHashes);
  const resultHashCounts = countValues(resultFaceHashes);
  const resultByHash = uniqueIndexes(resultFaceHashes, resultHashCounts);
  const sourceByHash = uniqueIndexes(sourceFaceHashes, sourceHashCounts);
  const generated = new Set(evolution.generated);
  const relations: Array<[sourceHash: number, resultHash: number]> = [];

  sourceFaceHashes.forEach((hash) => {
    if (resultByHash.has(hash)) relations.push([hash, hash]);
  });
  if (evolution.modified.length % 3 === 0) {
    for (let index = 0; index < evolution.modified.length; index += 3) {
      const sourceHash = evolution.modified[index]!;
      const relationKind = evolution.modified[index + 1]!;
      const resultHash = evolution.modified[index + 2]!;
      if (relationKind === 1 && sourceByHash.has(sourceHash) && resultByHash.has(resultHash)) {
        relations.push([sourceHash, resultHash]);
      }
    }
  }

  const targetsBySource = new Map<number, Set<number>>();
  const sourcesByTarget = new Map<number, Set<number>>();
  for (const [sourceHash, resultHash] of relations) {
    if (generated.has(resultHash)) continue;
    addRelation(targetsBySource, sourceHash, resultHash);
    addRelation(sourcesByTarget, resultHash, sourceHash);
  }

  const sourceForResult = new Map<number, number>();
  for (const [sourceHash, targets] of targetsBySource) {
    if (targets.size !== 1) continue;
    const resultHash = targets.values().next().value as number | undefined;
    if (resultHash === undefined || sourcesByTarget.get(resultHash)?.size !== 1) continue;
    const sourceIndex = sourceByHash.get(sourceHash);
    const resultIndex = resultByHash.get(resultHash);
    if (sourceIndex !== undefined && resultIndex !== undefined) sourceForResult.set(resultIndex, sourceIndex);
  }

  const used = new Set<string>();
  return resultFaceHashes.map((_, resultIndex) => {
    const sourceIndex = sourceForResult.get(resultIndex);
    const inherited = sourceIndex === undefined
      ? undefined
      : sourceFaceIds?.[sourceIndex] ?? `face_${encodeURIComponent(shapeId)}_${sourceIndex}`;
    if (inherited && !used.has(inherited)) {
      used.add(inherited);
      return inherited;
    }
    const fresh = createLocalId(`${shapeId}-face-${resultIndex}`);
    used.add(fresh);
    return fresh.startsWith("face_") ? fresh : `face_${fresh}`;
  });
}

function countValues(values: readonly number[]) {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function uniqueIndexes(values: readonly number[], counts: Map<number, number>) {
  const indexes = new Map<number, number>();
  values.forEach((value, index) => {
    if (counts.get(value) === 1) indexes.set(value, index);
  });
  return indexes;
}

function addRelation(map: Map<number, Set<number>>, from: number, to: number) {
  const values = map.get(from) ?? new Set<number>();
  values.add(to);
  map.set(from, values);
}
