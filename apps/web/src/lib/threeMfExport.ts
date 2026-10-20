/**
 * 3MF export: the OPC package modern slicers prefer.
 *
 * Unlike STL this keeps the unit (millimetre), one named object per shape, a
 * per-item placement transform, and the shape's colour. The package is a ZIP
 * holding three parts:
 *
 *   [Content_Types].xml   OPC content-type map (relationships + model part)
 *   _rels/.rels           package relationship pointing at the model part
 *   3D/3dmodel.model      the model XML itself
 *
 * Colour rides on the core specification's `<basematerials>` resource and the
 * object's `pid`/`pindex`, not on the materials-and-properties extension. The
 * extension would need a `requiredextensions` declaration that makes readers
 * which do not implement it reject the whole file, whereas `displaycolor` is
 * core: a reader that ignores it still gets correct geometry. Nothing here
 * therefore depends on an extension namespace.
 */
import { zip } from "fflate";
import { sketchForgeToZUp, type MeshPoint } from "@/lib/engine/meshCoordinates";

export type ThreeMfExportMesh = {
  name: string;
  vertices: readonly MeshPoint[];
  faces: readonly (readonly [number, number, number])[];
  /** `#rrggbb`; anything else falls back to the neutral default below. */
  color?: string;
};

export const THREE_MF_MODEL_PATH = "3D/3dmodel.model";
export const THREE_MF_CONTENT_TYPES_PATH = "[Content_Types].xml";
export const THREE_MF_RELS_PATH = "_rels/.rels";

export const THREE_MF_CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
export const THREE_MF_MODEL_RELATIONSHIP = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
export const THREE_MF_MODEL_CONTENT_TYPE = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

const DEFAULT_DISPLAY_COLOR = "#cfd8df";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shortest decimal that reads back as the same double, with -0 flattened.
 *
 * 3MF numbers are plain decimals, so exponent notation (which `String` reaches
 * for below 1e-7 and at 1e21) has to be spelled out or readers reject it.
 */
function modelNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  const text = String(value);
  if (!text.includes("e") && !text.includes("E")) return text;
  const fixed = value.toFixed(12);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** Normalizes `#rgb`/`#rrggbb`/`#rrggbbaa` to the `#RRGGBBAA` 3MF wants. */
export function displayColorFor(color: string | undefined) {
  const text = (color ?? "").trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}FF`.toUpperCase();
  if (/^#[0-9a-f]{6}$/i.test(text)) return `${text}FF`.toUpperCase();
  if (/^#[0-9a-f]{8}$/i.test(text)) return text.toUpperCase();
  return `${DEFAULT_DISPLAY_COLOR}FF`.toUpperCase();
}

type PreparedObject = {
  /** Mesh vertices in the object's own frame: world Z-up minus `translation`. */
  vertices: [number, number, number][];
  faces: readonly (readonly [number, number, number])[];
  translation: [number, number, number];
};

/**
 * Moves each object into a local frame so the build item carries a real
 * transform rather than an identity one.
 *
 * The origin is the footprint centre in X/Y and the lowest Z, which is where a
 * slicer expects a part's own origin to sit: centred on the plate and resting
 * on it. Applying the item transform to the stored mesh reproduces the source
 * coordinates.
 */
function prepareObject(mesh: ThreeMfExportMesh): PreparedObject {
  const worldVertices = mesh.vertices.map((vertex) => sketchForgeToZUp(vertex));
  if (worldVertices.length === 0) {
    return { vertices: [], faces: mesh.faces, translation: [0, 0, 0] };
  }
  const bounds = worldVertices.reduce(
    (current, [x, y, z]) => ({
      minX: Math.min(current.minX, x),
      maxX: Math.max(current.maxX, x),
      minY: Math.min(current.minY, y),
      maxY: Math.max(current.maxY, y),
      minZ: Math.min(current.minZ, z),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity },
  );
  const translation: [number, number, number] = [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    bounds.minZ,
  ];
  return {
    vertices: worldVertices.map(([x, y, z]) => [x - translation[0], y - translation[1], z - translation[2]]),
    faces: mesh.faces,
    translation,
  };
}

export function threeMfContentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    `  <Default Extension="model" ContentType="${THREE_MF_MODEL_CONTENT_TYPE}"/>`,
    "</Types>",
    "",
  ].join("\n");
}

export function threeMfRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `  <Relationship Id="rel0" Target="/${THREE_MF_MODEL_PATH}" Type="${THREE_MF_MODEL_RELATIONSHIP}"/>`,
    "</Relationships>",
    "",
  ].join("\n");
}

/**
 * The `3D/3dmodel.model` XML.
 *
 * Resource ids share one namespace, so the base-materials group takes id 1 and
 * the objects start at 2. The group is declared before the objects that point
 * at it, as the core specification requires.
 */
export function threeMfModelXml(meshes: readonly ThreeMfExportMesh[]) {
  const prepared = meshes.map(prepareObject);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${THREE_MF_CORE_NAMESPACE}">`,
    '  <metadata name="Application">SketchForge</metadata>',
    "  <resources>",
  ];
  if (meshes.length > 0) {
    lines.push('    <basematerials id="1">');
    meshes.forEach((mesh) => {
      lines.push(`      <base name="${escapeXml(mesh.name)}" displaycolor="${displayColorFor(mesh.color)}"/>`);
    });
    lines.push("    </basematerials>");
  }
  prepared.forEach((object, index) => {
    lines.push(`    <object id="${index + 2}" type="model" pid="1" pindex="${index}" name="${escapeXml(meshes[index].name)}">`);
    lines.push("      <mesh>");
    lines.push("        <vertices>");
    object.vertices.forEach(([x, y, z]) => {
      lines.push(`          <vertex x="${modelNumber(x)}" y="${modelNumber(y)}" z="${modelNumber(z)}"/>`);
    });
    lines.push("        </vertices>");
    lines.push("        <triangles>");
    object.faces.forEach(([a, b, c]) => {
      lines.push(`          <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    });
    lines.push("        </triangles>");
    lines.push("      </mesh>");
    lines.push("    </object>");
  });
  lines.push("  </resources>");
  lines.push("  <build>");
  prepared.forEach((object, index) => {
    const [tx, ty, tz] = object.translation;
    const transform = ["1", "0", "0", "0", "1", "0", "0", "0", "1", modelNumber(tx), modelNumber(ty), modelNumber(tz)].join(" ");
    lines.push(`    <item objectid="${index + 2}" transform="${transform}"/>`);
  });
  lines.push("  </build>");
  lines.push("</model>");
  lines.push("");
  return lines.join("\n");
}

function zipAsync(files: Record<string, Uint8Array>) {
  return new Promise<Uint8Array>((resolve, reject) => {
    // Same reproducibility pin as the .skf writer: fflate encodes the ZIP
    // entry mtime as a DOS date using local-time getters and rejects years
    // outside 1980-2099, so a UTC-pinned epoch rolls back to 1979 west of
    // UTC. Building it from local components keeps the year at 1980
    // everywhere, which keeps the archive byte-identical between runs.
    zip(files, { level: 6, mtime: new Date(1980, 0, 1) }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/** Packages the meshes as a 3MF archive. Entry order follows the OPC convention. */
export async function exportMeshesTo3mf(meshes: readonly ThreeMfExportMesh[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return zipAsync({
    [THREE_MF_CONTENT_TYPES_PATH]: encoder.encode(threeMfContentTypesXml()),
    [THREE_MF_RELS_PATH]: encoder.encode(threeMfRelsXml()),
    [THREE_MF_MODEL_PATH]: encoder.encode(threeMfModelXml(meshes)),
  });
}
