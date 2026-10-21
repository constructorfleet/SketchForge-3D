/** Small, defensive reader for the JSON chunk of a binary glTF document. */
export type GlbSceneDocument = {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{ name?: string; mesh?: number; children?: number[] }>;
  meshes?: Array<{ name?: string; primitives?: Array<{ material?: number }> }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
};

export function readGlbSceneDocument(glb: Uint8Array): GlbSceneDocument | null {
  if (glb.byteLength < 20) return null;
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return null;

  let offset = 12;
  while (offset + 8 <= glb.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > glb.byteLength) return null;
    if (type === 0x4e4f534a) {
      try {
        return JSON.parse(new TextDecoder().decode(glb.subarray(start, end)).trim()) as GlbSceneDocument;
      } catch {
        return null;
      }
    }
    offset = end;
  }
  return null;
}
