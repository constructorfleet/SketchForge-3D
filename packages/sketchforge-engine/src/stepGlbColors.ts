type GlbColorDocument = {
  nodes?: Array<{ name?: string; mesh?: number }>;
  meshes?: Array<{ name?: string; primitives?: Array<{ material?: number }> }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
};

export type NamedGlbColor = { count: number; color?: string };

function colorHex(color: readonly number[]) {
  return `#${color.slice(0, 3).map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Return only unambiguous, uniformly colored GLB node/mesh names. */
export function componentColorsFromGlb(glb: Uint8Array): Map<string, NamedGlbColor> {
  const candidates = new Map<string, { count: number; colors: Set<string> }>();
  const empty = () => new Map<string, NamedGlbColor>();
  if (glb.byteLength < 20) return empty();
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return empty();

  let json: GlbColorDocument | null = null;
  let offset = 12;
  while (offset + 8 <= glb.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > glb.byteLength) return empty();
    if (type === 0x4e4f534a) {
      try {
        json = JSON.parse(new TextDecoder().decode(glb.subarray(start, end)).trim()) as GlbColorDocument;
      } catch {
        return empty();
      }
      break;
    }
    offset = end;
  }
  if (!json) return empty();

  for (const node of json.nodes ?? []) {
    const mesh = typeof node.mesh === "number" ? json.meshes?.[node.mesh] : undefined;
    const nodeName = node.name?.trim();
    const meshName = mesh?.name?.trim();
    const names = new Set([nodeName, meshName].filter((name): name is string => Boolean(name)));
    if (!names.size || !mesh?.primitives?.length) continue;

    const colors = new Set<string>();
    let completeColor = !nodeName || !meshName || nodeName === meshName;
    for (const primitive of mesh.primitives) {
      const factor = typeof primitive.material === "number"
        ? json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor
        : undefined;
      if (!factor || factor.length < 3 || !factor.slice(0, 3).every(Number.isFinite)) {
        completeColor = false;
        break;
      }
      colors.add(colorHex(factor));
    }

    for (const name of names) {
      const candidate = candidates.get(name) ?? { count: 0, colors: new Set<string>() };
      candidate.count += 1;
      if (completeColor && colors.size === 1) candidate.colors.add([...colors][0]!);
      else candidate.colors.add("");
      candidates.set(name, candidate);
    }
  }

  return new Map([...candidates].map(([name, candidate]) => [name, {
    count: candidate.count,
    ...(candidate.count === 1 && candidate.colors.size === 1 && !candidate.colors.has("")
      ? { color: [...candidate.colors][0]! }
      : {}),
  }]));
}
