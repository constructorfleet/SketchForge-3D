const nodePath = require("node:path");
const asar = require("@electron/asar");
const { packagedResourcesDir, verifyPackagedWebBundle } = require("./webBundle.cjs");

const KERNEL_PACKAGES = ["occt-wasm", "manifold-3d"];

/**
 * Return CAD kernel packages that were accidentally copied into app.asar.
 * The desktop web server loads its own copies from Resources/web.
 *
 * @param {string} appAsarPath
 * @returns {Promise<string[]>}
 */
async function packagedKernelDuplicates(appAsarPath) {
  const entries = await asar.listPackage(appAsarPath);
  return entries
    .map((entry) => entry.replace(/^\//, ""))
    .filter((entry) => KERNEL_PACKAGES.some((name) =>
      entry === `node_modules/${name}` || entry.startsWith(`node_modules/${name}/`)));
}

/**
 * electron-builder afterPack hook: refuse to finish a package whose web bundle
 * has dangling links or linked server externals, or duplicated CAD kernels in
 * app.asar. It runs before signing and before the installer is built, on every
 * platform and for `--dir` builds, so a broken bundle or duplicate kernel copy
 * never ships.
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

  const appAsar = nodePath.join(resourcesDir, "app.asar");
  const duplicateKernels = await packagedKernelDuplicates(appAsar);
  if (duplicateKernels.length > 0) {
    throw new Error(`[desktop:afterPack] CAD kernels are duplicated in app.asar:\n  ${duplicateKernels.join("\n  ")}`);
  }
};

module.exports.packagedKernelDuplicates = packagedKernelDuplicates;
