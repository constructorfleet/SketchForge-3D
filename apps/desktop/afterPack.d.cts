/** Types for afterPack.cjs, the electron-builder afterPack hook. */

declare function afterPack(context: {
  appOutDir: string;
  electronPlatformName: string;
  packager: { appInfo: { productFilename: string } };
}): Promise<void>;

export = afterPack;
