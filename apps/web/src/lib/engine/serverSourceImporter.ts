/**
 * Regenerating an imported mesh from its source asset, server side.
 *
 * A shape whose mesh came from a file does not store that mesh in the project:
 * the asset is stored and the mesh is rebuilt when the project is read, which
 * is what keeps a `.skf` small. `skfProject.ts`'s default importer rebuilds a
 * STEP asset through `stepImport.ts`, which loads OCCT from `/occt/index.js` --
 * a URL that exists in a browser and nowhere else. So on the server that read
 * threw `Cannot find module '/occt/index.js'`, and **any** project holding a
 * STEP source asset was unreadable there: a file imported in the browser and
 * saved to server storage could not be read back by the server at all.
 *
 * This importer is the server's half: STEP goes through the Node kernel, and
 * the formats that need nothing but arithmetic are shared with the browser.
 */
import { LocalizedError } from "@/i18n/LocalizedError";
import { importedShapeFromObj } from "@/lib/engine/objImport";
import { importedShapeFromStepOnKernel } from "@/lib/engine/stepImportKernel";
import { importedShapeFromStl } from "@/lib/engine/stlImport";
import type { SkfSourceImporter } from "@/lib/engine/skfProject";
import type { ProjectAsset } from "@/types/sketchforge";

function meshOf<T extends { importedMesh?: unknown }>(shape: T, asset: ProjectAsset) {
  const mesh = shape.importedMesh;
  if (!mesh) throw new LocalizedError("errors.skf.sourceAssetUnreadable", { name: asset.name });
  return mesh as NonNullable<import("@/types/sketchforge").WorkplaneShape["importedMesh"]>;
}

export const serverSourceImporter: SkfSourceImporter = async (asset) => {
  const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array(asset.bytes as ArrayBuffer);

  if (asset.sourceFormat === "stl") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return meshOf(importedShapeFromStl(asset.name, buffer), asset);
  }
  if (asset.sourceFormat === "obj") {
    return meshOf(importedShapeFromObj(asset.name, new TextDecoder().decode(bytes)), asset);
  }
  if (asset.sourceFormat === "step") {
    const { shape } = await importedShapeFromStepOnKernel(asset.name, new TextDecoder().decode(bytes));
    return meshOf(shape, asset);
  }
  // SVG parsing needs `DOMParser`, which Node does not have. Refused with a
  // sentence rather than left to throw a ReferenceError from inside the
  // importer, and listed here so the gap is visible rather than implied.
  throw new LocalizedError("errors.skf.sourceFormatUnsupportedOnServer", { format: asset.sourceFormat });
};
