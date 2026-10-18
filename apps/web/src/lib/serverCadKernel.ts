/**
 * The OCCT kernel, server side (upstream issue #55, follow-up to #109).
 *
 * The editor runs OCCT as WebAssembly in a browser worker, which means every
 * client downloads a 22 MB kernel and grinds through fillets on whatever
 * hardware it has. The same build runs under Node, so a self-hosted server can
 * do that work instead -- and it is the only way the REST API can offer
 * operations whose geometry is not expressible as parameters.
 *
 * Node-only. Never import this from anything the browser bundles.
 *
 * The kernel is loaded once per process and reused. It holds an arena of shape
 * handles, so every operation releases what it allocated: a long-lived server
 * that leaked handles would grow without bound.
 */

import type { OcctKernel } from "occt-wasm";

let kernelPromise: Promise<OcctKernel> | null = null;

export async function serverCadKernel(): Promise<OcctKernel> {
  kernelPromise ??= (async () => {
    const [{ OcctKernel: KernelConstructor }, { default: createModule }] = await Promise.all([
      import("occt-wasm"),
      // The Emscripten glue resolves its own .wasm relative to itself, which
      // works under Node and is why this takes the packaged path directly
      // rather than the copy staged into public/occt for the browser.
      import("occt-wasm/dist/occt-wasm.js"),
    ]);
    const module = await createModule();
    const Kernel = KernelConstructor as unknown as new (rawModule: unknown) => OcctKernel;
    return new Kernel(module);
  })();

  try {
    return await kernelPromise;
  } catch (error) {
    // A failed load must not be cached, or one bad start disables CAD for the
    // life of the process.
    kernelPromise = null;
    throw error;
  }
}

/** Whether this process can run CAD operations at all. */
export async function serverCadAvailable() {
  try {
    await serverCadKernel();
    return true;
  } catch {
    return false;
  }
}
