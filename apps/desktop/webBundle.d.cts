/** Types for webBundle.cjs, which desktop packaging loads as plain CommonJS. */

declare const webBundle: {
  /** Packages the server may require() from app.asar through NODE_PATH. */
  NODE_PATH_PACKAGES: ReadonlySet<string>;
  /** Where a standalone build keeps its server externals, relative to its root. */
  SERVER_EXTERNALS_DIR: string;
  /** Symlinks under rootDir whose target is missing, relative to rootDir. */
  findDanglingLinks: (rootDir: string) => string[];
  /** Normalize bundle-relative diagnostic paths to `/` on every platform. */
  normalizeRelativePath: (relativePath: string) => string;
  /** Copy linked and plainly imported server externals into .next/node_modules; returns the names copied. */
  materializeServerExternals: (standaloneDir: string) => string[];
  /** The packaged resources directory for an electron-builder afterPack target. */
  packagedResourcesDir: (target: { appOutDir: string; electronPlatformName: string; productFilename: string }) => string;
  /** Every bare module the compiled server imports or requires, with the chunks that name it. */
  serverModuleReferences: (webRoot: string) => { specifier: string; kind: "import" | "require"; files: string[] }[];
  /** Problems that would leave the packaged CAD kernels unloadable or the app unsignable. */
  verifyPackagedWebBundle: (webRoot: string) => string[];
};

export = webBundle;
