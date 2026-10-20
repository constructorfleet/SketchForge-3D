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
 * The kernel is loaded once per process and reused, and `withCadKernel` is the
 * only way in: it runs one operation at a time and empties the handle arena
 * afterwards.
 *
 * Both halves of that matter. The arena is global to the kernel, so releasing
 * handles by hand while another operation holds its own leaves dangling
 * pointers -- which surface much later as "null function or function signature
 * mismatch" from an unrelated call. And the WASM build is single-threaded, so
 * serialising costs nothing that was ever available.
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

let pending: Promise<unknown> = Promise.resolve();

/**
 * Run one CAD operation with exclusive use of the kernel.
 *
 * Everything the operation allocated is released when it finishes, so nothing
 * has to track handles and a long-lived server cannot grow without bound.
 * Queue position is kept even if the previous operation threw.
 */
export function withCadKernel<T>(work: (cad: OcctKernel) => Promise<T> | T): Promise<T> {
  const run = pending.then(async () => {
    const cad = await serverCadKernel();
    try {
      const result = await work(cad);
      try {
        cad.releaseAll();
      } catch {
        // Nothing left to release is the state this wanted anyway.
      }
      return result;
    } catch (error) {
      // An OCCT operation that throws leaves the kernel in a state its own
      // API cannot describe, let alone repair: a later unrelated call fails
      // with "null function or function signature mismatch" instead. The
      // editor's answer is to terminate the worker and start another, and
      // this is the same move -- the next request builds a fresh kernel.
      //
      // A fillet radius that does not fit is the common way to get here, so
      // this has to be a recovery rather than a fault.
      discardCadKernel();
      throw error;
    }
  });
  pending = run.catch(() => undefined);
  return run;
}

/** Drop the loaded kernel so the next caller builds a new one. */
export function discardCadKernel() {
  kernelPromise = null;
}
