import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";
import { createPackage } from "@electron/asar";
import webBundleModule from "../../apps/desktop/webBundle.cjs";
import afterPackModule from "../../apps/desktop/afterPack.cjs";

const {
  findDanglingLinks,
  materializeServerExternals,
  packagedResourcesDir,
  serverModuleReferences,
  verifyPackagedWebBundle,
} = webBundleModule;

const repoRoot = path.resolve(__dirname, "..", "..");
const scratchDirs: string[] = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-web-bundle-"));
  scratchDirs.push(dir);
  return dir;
}

// A directory link that works on every CI host: Windows creates junctions
// without the symlink privilege, and a junction must have an absolute target.
function linkDir(target: string, link: string) {
  fs.symlinkSync(path.resolve(target), link, process.platform === "win32" ? "junction" : "dir");
}

function writeFile(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writePackage(modulesDir: string, name: string) {
  writeFile(path.join(modulesDir, name, "package.json"), JSON.stringify({ name }));
  writeFile(path.join(modulesDir, name, "dist", "occt-wasm.js"), `${name} glue`);
  writeFile(path.join(modulesDir, name, "dist", "kernel.wasm"), `${name} bytes`);
}

/**
 * A minified Turbopack server chunk: `.y()` is its external import (an ES
 * module import, which ignores NODE_PATH) and `.x()` its external require.
 */
const TURBOPACK_CHUNK = [
  'module.exports=[1,e=>{e.y("occt-wasm-1b9e064a4904705b")},',
  '2,e=>{e.y("occt-wasm-1b9e064a4904705b/dist/occt-wasm.js")},',
  '3,e=>{e.y("manifold-3d-da2d2d8b0ea51a45")},',
  '4,e=>{e.x("next/dist/compiled/next-server/app-route-turbo.runtime.prod.js")},',
  '5,e=>{e.x("node:fs");e.x("crypto");e.x("../chunks/[turbopack]_runtime.js")}];',
].join("");

/** What the engine's `import(/* webpackIgnore: true *\/ "occt-wasm")` leaves in a chunk. */
const BARE_IMPORT_CHUNK = 'module.exports=[6,t=>{Promise.all([import("occt-wasm"),import("occt-wasm/dist/occt-wasm.js")])}];';

/**
 * The layout `next build` writes with `output: "standalone"` under Turbopack:
 * each `serverExternalPackages` entry is a hashed link in `.next/node_modules`
 * pointing at the real package in the standalone root `node_modules`.
 */
function standaloneFixture(chunks: Record<string, string> = { "chunks/route.js": TURBOPACK_CHUNK }) {
  const standalone = scratch();
  const rootModules = path.join(standalone, "node_modules");
  writePackage(rootModules, "occt-wasm");
  writePackage(rootModules, "manifold-3d");
  const externals = path.join(standalone, "apps", "web", ".next", "node_modules");
  fs.mkdirSync(externals, { recursive: true });
  linkDir(path.join(rootModules, "occt-wasm"), path.join(externals, "occt-wasm-1b9e064a4904705b"));
  linkDir(path.join(rootModules, "manifold-3d"), path.join(externals, "manifold-3d-da2d2d8b0ea51a45"));
  for (const [file, contents] of Object.entries(chunks)) writeFile(path.join(standalone, "apps", "web", ".next", "server", file), contents);
  return { standalone, rootModules, externals };
}

/**
 * The shipped 1.27.0 bundle (Next 15, webpack): no `.next/node_modules`, no
 * `node_modules` anywhere, and chunks that `import("occt-wasm")` by its plain
 * name. Its server answered every CAD request with ERR_MODULE_NOT_FOUND.
 */
function webpackReleaseFixture() {
  const webRoot = scratch();
  writeFile(
    path.join(webRoot, "apps", "web", ".next", "server", "app", "api", "v1", "align", "route.js"),
    'var b=require("../../../../webpack-runtime.js");b.C(a);a.exports={9890:a=>{a.exports=import("manifold-3d")},'
      + '99222:a=>{a.exports=import("occt-wasm")},1:a=>{a.exports=require("next/dist/server/app-render/work-async-storage.external.js")},'
      + '2:a=>{a.exports=require("react")}};',
  );
  return webRoot;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("materializeServerExternals", () => {
  it("normalizes hashed external imports to one copy at the package name", () => {
    const { standalone, rootModules, externals } = standaloneFixture();

    const copied = materializeServerExternals(standalone);

    expect(copied.sort()).toEqual(["manifold-3d", "occt-wasm"]);
    const occt = path.join(externals, "occt-wasm");
    expect(fs.lstatSync(occt).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(occt).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(occt, "dist", "kernel.wasm"), "utf8")).toBe("occt-wasm bytes");
    expect(fs.existsSync(path.join(externals, "occt-wasm-1b9e064a4904705b"))).toBe(false);
    expect(fs.readFileSync(path.join(standalone, "apps/web/.next/server/chunks/route.js"), "utf8"))
      .not.toContain("occt-wasm-1b9e064a4904705b");

    // electron-builder drops the standalone root node_modules; the copy must
    // stand on its own once that directory is gone.
    fs.rmSync(rootModules, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(externals, "manifold-3d", "package.json"), "utf8"))
      .toContain("manifold-3d");
    expect(findDanglingLinks(standalone)).toEqual([]);
  });

  it("shares the normalized package with chunks that already import its plain name", () => {
    const { standalone, rootModules, externals } = standaloneFixture({
      "chunks/route.js": TURBOPACK_CHUNK,
      "chunks/step.js": BARE_IMPORT_CHUNK,
    });

    const copied = materializeServerExternals(standalone);

    expect(copied.filter((name) => name === "occt-wasm")).toHaveLength(1);
    fs.rmSync(rootModules, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(externals, "occt-wasm", "dist", "occt-wasm.js"), "utf8")).toBe("occt-wasm glue");
    expect(fs.existsSync(path.join(externals, "occt-wasm-1b9e064a4904705b"))).toBe(false);
    expect(verifyPackagedWebBundle(standalone)).toEqual([]);
  });

  it("fails, naming the package, when a chunk imports one the standalone build does not contain", () => {
    const { standalone } = standaloneFixture({ "chunks/step.js": 'import("brepkit-wasm")' });

    expect(() => materializeServerExternals(standalone)).toThrow(/brepkit-wasm/);
  });

  it("fails, naming the link, when an external points at a package the build did not trace", () => {
    const { standalone, rootModules } = standaloneFixture();
    fs.rmSync(path.join(rootModules, "occt-wasm"), { recursive: true, force: true });

    expect(() => materializeServerExternals(standalone)).toThrow(/occt-wasm-1b9e064a4904705b/);
  });

  it("does nothing for a build with no hashed externals", () => {
    const standalone = scratch();
    fs.mkdirSync(path.join(standalone, "apps", "web", ".next"), { recursive: true });

    expect(materializeServerExternals(standalone)).toEqual([]);
  });
});

describe("findDanglingLinks", () => {
  it("lists links whose target is missing, relative to the scanned root", () => {
    const { standalone, rootModules } = standaloneFixture();
    fs.rmSync(rootModules, { recursive: true, force: true });

    expect(findDanglingLinks(standalone).sort()).toEqual([
      path.join("apps", "web", ".next", "node_modules", "manifold-3d-da2d2d8b0ea51a45"),
      path.join("apps", "web", ".next", "node_modules", "occt-wasm-1b9e064a4904705b"),
    ]);
  });
});

describe("serverModuleReferences", () => {
  it("reads Turbopack external imports and requires and plain import() calls, and nothing relative", () => {
    const { standalone } = standaloneFixture({ "chunks/route.js": TURBOPACK_CHUNK, "chunks/step.js": BARE_IMPORT_CHUNK });

    const references = serverModuleReferences(path.join(standalone))
      .map(({ specifier, kind }) => `${kind} ${specifier}`)
      .sort();

    expect(references).toEqual([
      "import manifold-3d-da2d2d8b0ea51a45",
      "import occt-wasm",
      "import occt-wasm-1b9e064a4904705b",
      "import occt-wasm-1b9e064a4904705b/dist/occt-wasm.js",
      "import occt-wasm/dist/occt-wasm.js",
      "require crypto",
      "require next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
      "require node:fs",
    ]);
  });
});

describe("verifyPackagedWebBundle", () => {
  it("reports the dangling CAD links the unmaterialized bundle ships with", () => {
    const { standalone, rootModules } = standaloneFixture();
    fs.rmSync(rootModules, { recursive: true, force: true });

    const problems = verifyPackagedWebBundle(standalone);

    expect(problems.join("\n")).toMatch(/dangling link.*occt-wasm-1b9e064a4904705b/);
    expect(problems.join("\n")).toMatch(/dangling link.*manifold-3d-da2d2d8b0ea51a45/);
  });

  it("reports a server external that is still a link, even a working one", () => {
    const { standalone } = standaloneFixture();

    expect(verifyPackagedWebBundle(standalone).join("\n")).toMatch(/occt-wasm-1b9e064a4904705b is a link/);
  });

  it("rejects the 1.27.0 layout: plain imports of the CAD kernels with nothing on disk", () => {
    const problems = verifyPackagedWebBundle(webpackReleaseFixture()).join("\n");

    expect(problems).toMatch(/imports "occt-wasm".*does not resolve/);
    expect(problems).toMatch(/imports "manifold-3d".*does not resolve/);
    // next and react are required (CommonJS) and resolve through NODE_PATH into app.asar.
    expect(problems).not.toMatch(/"next|"react/);
  });

  it("does not count a package above the web bundle, where an installed app has none", () => {
    // A build packaged inside a checkout resolves upward into the repository's
    // own node_modules; the installed app has nothing there.
    const outside = scratch();
    writePackage(path.join(outside, "node_modules"), "occt-wasm");
    const webRoot = path.join(outside, "Resources", "web");
    writeFile(path.join(webRoot, "apps", "web", ".next", "server", "chunks", "step.js"), BARE_IMPORT_CHUNK);

    expect(verifyPackagedWebBundle(webRoot).join("\n")).toMatch(/imports "occt-wasm".*does not resolve/);
  });

  it("reports an external require that is neither a builtin, nor in app.asar, nor on disk", () => {
    const { standalone } = standaloneFixture({ "chunks/route.js": 'e.x("left-pad");e.x("next/dist/server/next.js");e.x("node:fs");e.x("path")' });
    materializeServerExternals(standalone);

    const problems = verifyPackagedWebBundle(standalone).join("\n");

    expect(problems).toMatch(/requires "left-pad"/);
    expect(problems).not.toMatch(/next\/dist|node:fs|"path"/);
  });

  it("reports a scoped hashed external, which materializing does not handle", () => {
    const { standalone, rootModules, externals } = standaloneFixture();
    writePackage(path.join(rootModules, "@scope"), "kernel");
    fs.mkdirSync(path.join(externals, "@scope"));
    linkDir(path.join(rootModules, "@scope", "kernel"), path.join(externals, "@scope", "kernel-0123456789abcdef"));
    materializeServerExternals(standalone);
    fs.rmSync(rootModules, { recursive: true, force: true });

    expect(verifyPackagedWebBundle(standalone).join("\n")).toMatch(/@scope/);
  });

  it("accepts a materialized bundle", () => {
    const { standalone, rootModules } = standaloneFixture();
    materializeServerExternals(standalone);
    fs.rmSync(rootModules, { recursive: true, force: true });

    expect(verifyPackagedWebBundle(standalone)).toEqual([]);
  });
});

describe("desktop afterPack hook", () => {
  it("keeps OCCT and Manifold only in the standalone web bundle, not app.asar", () => {
    const config = loadYaml(fs.readFileSync(path.join(repoRoot, "apps/desktop/electron-builder.yml"), "utf8")) as {
      files?: string[];
    };

    expect(config.files).toContain("!node_modules/occt-wasm{,/**/*}");
    expect(config.files).toContain("!node_modules/manifold-3d{,/**/*}");
  });

  it("does not keep the obsolete second public OCCT copy", () => {
    expect(fs.existsSync(path.join(repoRoot, "apps/web/public/assets/occt"))).toBe(false);
  });

  it("detects CAD kernel copies in app.asar", async () => {
    const appDir = scratch();
    const appAsar = path.join(scratch(), "app.asar");
    writeFile(path.join(appDir, "node_modules/occt-wasm/package.json"), "{}");
    writeFile(path.join(appDir, "node_modules/manifold-3d/package.json"), "{}");
    await createPackage(appDir, appAsar);

    await expect(afterPackModule.packagedKernelDuplicates(appAsar)).resolves.toEqual(expect.arrayContaining([
      "node_modules/occt-wasm/package.json",
      "node_modules/manifold-3d/package.json",
    ]));
  });

  it("rejects a package when a CAD kernel remains in app.asar", async () => {
    const appOutDir = scratch();
    const resourcesDir = path.join(appOutDir, "resources");
    const { standalone } = standaloneFixture();
    materializeServerExternals(standalone);
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.cpSync(standalone, path.join(resourcesDir, "web"), { recursive: true });

    const appDir = scratch();
    writeFile(path.join(appDir, "node_modules/occt-wasm/package.json"), "{}");
    await createPackage(appDir, path.join(resourcesDir, "app.asar"));

    await expect(afterPackModule({
      appOutDir,
      electronPlatformName: "linux",
      packager: { appInfo: { productFilename: "SketchForge" } },
    })).rejects.toThrow(/CAD kernels are duplicated in app\.asar/);
  });

  it("finds Resources inside the macOS app and resources beside the Windows and Linux executable", () => {
    expect(packagedResourcesDir({ appOutDir: "/out/mac-arm64", electronPlatformName: "darwin", productFilename: "SketchForge" }))
      .toBe(path.join("/out/mac-arm64", "SketchForge.app", "Contents", "Resources"));
    expect(packagedResourcesDir({ appOutDir: "/out/win-unpacked", electronPlatformName: "win32", productFilename: "SketchForge" }))
      .toBe(path.join("/out/win-unpacked", "resources"));
    expect(packagedResourcesDir({ appOutDir: "/out/linux-unpacked", electronPlatformName: "linux", productFilename: "SketchForge" }))
      .toBe(path.join("/out/linux-unpacked", "resources"));
  });

  it("fails the package when the packaged web bundle has a dangling link", async () => {
    const appOutDir = scratch();
    const { standalone, rootModules } = standaloneFixture();
    fs.rmSync(rootModules, { recursive: true, force: true });
    fs.mkdirSync(path.join(appOutDir, "resources"));
    fs.renameSync(standalone, path.join(appOutDir, "resources", "web"));

    await expect(afterPackModule({
      appOutDir,
      electronPlatformName: "linux",
      packager: { appInfo: { productFilename: "SketchForge" } },
    })).rejects.toThrow(/dangling link/);
  });

  it("is the afterPack hook electron-builder runs", () => {
    const config = loadYaml(fs.readFileSync(path.join(repoRoot, "apps", "desktop", "electron-builder.yml"), "utf8")) as {
      afterPack?: string;
    };

    expect(config.afterPack).toBe("apps/desktop/afterPack.cjs");
  });
});
