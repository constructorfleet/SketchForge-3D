// Shared lazy loader for brepjs + the occt-wasm (OpenCascade) kernel. Both the
// STEP exporter and importer call this so the 22 MB kernel loads at most once
// per session, on first use, and stays out of the initial bundle.
//
// occt-wasm is staged into public/occt by scripts/copy-occt-wasm.mjs and loaded
// at runtime, deliberately outside the Next bundler — the Emscripten glue self
// loads ./occt-wasm.js relative to its own URL and does not survive bundling.
// OCCT_INDEX_URL is typed as string (not a literal) so TypeScript treats the
// dynamic import as runtime-resolved rather than a module to resolve.
const OCCT_INDEX_URL: string = "/occt/index.js";
const OCCT_NODE_INDEX_URL: string = "occt-wasm/dist/occt-wasm.js";
const OCCT_PACKAGE_URL: string = "occt-wasm";
const OCCT_WASM_URL = "/occt/occt-wasm.wasm";

export type Brep = typeof import("brepjs");
export type BrepSolid = ReturnType<Brep["box"]>;
type OcctWasmModule = typeof import("occt-wasm");
type OcctKernel = import("occt-wasm").OcctKernel;

let brepReady: Promise<Brep> | null = null;
let kernelReady: Promise<OcctKernel> | null = null;

/** Load the registered OCCT instance for operations that need its XCAF API. */
export async function loadOcctKernel(): Promise<OcctKernel> {
  kernelReady ??= (async () => {
    if (typeof window !== "undefined") {
      const occt = (await import(/* webpackIgnore: true */ OCCT_INDEX_URL)) as unknown as OcctWasmModule;
      return occt.OcctKernel.init({ wasm: OCCT_WASM_URL });
    }
    const [{ OcctKernel: KernelConstructor }, { default: createModule }] = await Promise.all([
      import(/* webpackIgnore: true */ OCCT_PACKAGE_URL),
      import(/* webpackIgnore: true */ OCCT_NODE_INDEX_URL),
    ]) as [typeof import("occt-wasm"), { default: () => Promise<unknown> }];
    const module = await createModule();
    const Kernel = KernelConstructor as unknown as new (rawModule: unknown) => OcctKernel;
    return new Kernel(module);
  })();
  try {
    return await kernelReady;
  } catch (error) {
    kernelReady = null;
    throw error;
  }
}

export async function loadBrepWithOcct(): Promise<Brep> {
  // Cache the in-flight/resolved load, but drop a rejected attempt so a transient
  // failure (e.g. a blip fetching the 22 MB wasm) can be retried on the next call
  // instead of poisoning STEP for the rest of the session.
  brepReady ??= (async () => {
    const [brep, kernel] = await Promise.all([import("brepjs"), loadOcctKernel()]);
    brep.registerKernel("occt-wasm", brep.OcctWasmAdapter.fromKernel(kernel));
    return brep;
  })().catch((error) => {
    brepReady = null;
    throw error;
  });
  return brepReady;
}
