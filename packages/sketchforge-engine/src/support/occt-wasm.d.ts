declare module "occt-wasm/dist/occt-wasm.js" {
  const createModule: () => Promise<unknown>;
  export default createModule;
}
