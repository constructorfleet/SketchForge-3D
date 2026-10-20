/**
 * Manifold under Node, for the REST API's revolved shapes.
 *
 * The editor loads manifold from a copy staged beside the page, because the
 * browser needs the .wasm at a URL it can fetch. Node resolves the package
 * itself, so this takes it directly -- the same move `serverCadKernel` makes
 * for OCCT.
 *
 * Node-only. Never import this from anything the browser bundles.
 */

import type { ManifoldToplevel } from "manifold-3d";

let runtimePromise: Promise<ManifoldToplevel> | null = null;

export async function serverManifoldRuntime(): Promise<ManifoldToplevel> {
  runtimePromise ??= (async () => {
    const { default: manifoldModule } = await import("manifold-3d");
    const runtime = await manifoldModule();
    runtime.setup();
    return runtime;
  })();

  try {
    return await runtimePromise;
  } catch (error) {
    // A failed load must not be cached, or one bad start disables revolves for
    // the life of the process.
    runtimePromise = null;
    throw error;
  }
}
