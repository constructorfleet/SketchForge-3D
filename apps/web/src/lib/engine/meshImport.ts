/**
 * A model file, turned into a shape and the asset it came from.
 *
 * The three importers already live here -- `stlImport`, `objImport`,
 * `svgImport` -- and each takes a file name and the bytes. What did not exist
 * was the step after them: an imported shape is only half the import, because
 * the source file is kept as a project asset and the shape points at it by id.
 * Write the shape without the asset and the next save strips the import out of
 * the project; the editor's import flow has always done both, and nothing
 * outside the editor could.
 *
 * STEP is deliberately absent, and the reason moved. Reading one is no longer
 * the obstacle: #66 added `stepImportKernel`, which runs on the server kernel
 * the shell and treatment operations already use, so an import here would work.
 * **Writing** one is the obstacle. A shape whose mesh came from a source asset
 * is re-imported from that asset when the project is read back
 * (`skfProject.ts`, `restoreShapeFromNode`), and the default source importer's
 * STEP branch dynamically loads `lib/brepKernel` -- the *browser's* loader,
 * which section 4 of `docs/ENGINE_EXTRACTION.md` keeps out of the engine. So a
 * STEP import written here would be write-only: the next read of that project
 * would fail with `Cannot find module '/occt/index.js'`, measured rather than
 * supposed.
 *
 * Making it work means passing a server-side `sourceImporter` into
 * `importSkfProject` from `serverProjectDocument.ts`, which also fixes reading
 * a project whose STEP import was made in the *browser* -- a bug that is
 * already there and is not this change's to fix.
 */

import { importedShapeFromObj } from "@/lib/engine/objImport";
import {
  attachProjectAsset,
  projectAssetFromBytes,
  sourceFormatForFileName,
} from "@/lib/engine/projectAssets";
import { importedShapeFromStl } from "@/lib/engine/stlImport";
import { importedShapeFromSvg } from "@/lib/engine/svgImport";
import type { ProjectAsset, WorkplaneShape } from "@/types/sketchforge";

/** The file formats an import can read with no browser and no CAD kernel. */
export const IMPORTABLE_MESH_FORMATS = ["stl", "obj", "svg"] as const;

export type ImportableMeshFormat = (typeof IMPORTABLE_MESH_FORMATS)[number];

export type ImportedMesh = { shape: WorkplaneShape; asset: ProjectAsset };

/** The format a file name names, or null when nothing here can read it. */
export function importableMeshFormat(fileName: string): ImportableMeshFormat | null {
  const format = sourceFormatForFileName(fileName);
  return format && (IMPORTABLE_MESH_FORMATS as readonly string[]).includes(format)
    ? (format as ImportableMeshFormat)
    : null;
}

/**
 * Why an import could not be read, in words, or null when it can be.
 *
 * SVG is read by `three`'s `SVGLoader`, which parses with a `DOMParser`. A
 * browser has one and a bare Node process does not, and the difference shows
 * up as a `ReferenceError` from inside a loader -- so it is said plainly here
 * instead, before any bytes are touched.
 */
function unreadableReason(format: ImportableMeshFormat): string | null {
  if (format !== "svg") return null;
  return typeof DOMParser === "undefined"
    ? "SVG import needs a DOMParser, which this runtime does not provide; export the drawing as STL or OBJ instead."
    : null;
}

/**
 * The shape a model file describes, with the asset that keeps the file itself.
 *
 * `fileName` is load-bearing rather than decoration: it chooses the importer,
 * it names the asset, and for an STL it decides which way is up -- SketchForge's
 * own older exports are Y-up and are recognised by their header.
 *
 * Throws what the importers throw, which is a `LocalizedError` carrying a
 * message key. A caller wanting prose has to word it; `Engine.importMesh` does.
 */
export async function importedMeshFromFile(
  fileName: string,
  bytes: Uint8Array,
  mediaType?: string,
): Promise<ImportedMesh> {
  const format = importableMeshFormat(fileName);
  if (!format) {
    throw new Error(`Cannot import "${fileName}": the readable formats are ${IMPORTABLE_MESH_FORMATS.join(", ")}.`);
  }
  const unreadable = unreadableReason(format);
  if (unreadable) throw new Error(unreadable);

  const shape = format === "obj"
    ? importedShapeFromObj(fileName, new TextDecoder().decode(bytes))
    : format === "svg"
      ? importedShapeFromSvg(fileName, new TextDecoder().decode(bytes))
      // A fresh buffer rather than the view's own: an importer reads the whole
      // `ArrayBuffer`, and a `Uint8Array` decoded from base64 or read off a
      // form may be a window onto a larger one.
      : importedShapeFromStl(fileName, bytes.slice().buffer as ArrayBuffer);

  const asset = await projectAssetFromBytes(fileName, format, bytes, mediaType);
  return { shape: attachProjectAsset(shape, asset.id), asset };
}
