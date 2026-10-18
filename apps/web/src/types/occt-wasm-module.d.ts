/**
 * The Emscripten factory inside occt-wasm.
 *
 * The package ships types for its own API but not for the raw WASM glue, which
 * the server loader needs by path so Node resolves the .wasm beside it.
 */
declare module "occt-wasm/dist/occt-wasm.js" {
  const createModule: (options?: Record<string, unknown>) => Promise<unknown>;
  export default createModule;
}
