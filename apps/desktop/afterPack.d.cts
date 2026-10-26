/** Types for afterPack.cjs, the electron-builder afterPack hook. */

declare function afterPack(context: {
  appOutDir: string;
  electronPlatformName: string;
  packager: { appInfo: { productFilename: string } };
}): Promise<void>;

declare namespace afterPack {
  /** CAD kernel packages found in app.asar, excluding a leading archive slash. */
  function packagedKernelDuplicates(appAsarPath: string): Promise<string[]>;
  /** Filter CAD kernel package paths from archive entries using `/` separators. */
  function packagedKernelDuplicatesFromEntries(entries: string[]): string[];
}

export = afterPack;
