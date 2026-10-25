const nodePath = require("node:path");
const { packagedResourcesDir, verifyPackagedWebBundle } = require("./webBundle.cjs");

/**
 * electron-builder afterPack hook: refuse to finish a package whose web bundle
 * has dangling links or linked server externals. It runs before signing and
 * before the installer is built, on every platform and for `--dir` builds, so a
 * bundle that cannot load the CAD kernels never becomes a release asset.
 *
 * @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context
 */
module.exports = async function afterPack(context) {
  const resourcesDir = packagedResourcesDir({
    appOutDir: context.appOutDir,
    electronPlatformName: context.electronPlatformName,
    productFilename: context.packager.appInfo.productFilename,
  });
  const webRoot = nodePath.join(resourcesDir, "web");
  const problems = verifyPackagedWebBundle(webRoot);
  if (problems.length > 0) {
    throw new Error(`[desktop:afterPack] The packaged web bundle at ${webRoot} is not shippable:\n  ${problems.join("\n  ")}`);
  }
};
