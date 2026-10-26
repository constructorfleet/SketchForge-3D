const fs = require("node:fs");
const { isBuiltin } = require("node:module");
const nodePath = require("node:path");

/**
 * Where Next puts the server externals of a standalone build, relative to the
 * standalone root (and to `Resources/web` once packaged).
 *
 * Under Turbopack each `serverExternalPackages` entry (occt-wasm, manifold-3d)
 * is imported by a hashed name such as `occt-wasm-1b9e064a4904705b`, and that
 * name is a symlink in this directory to the real package in the standalone
 * root `node_modules`. electron-builder never copies a root `node_modules` out
 * of an `extraResources` source, so packaged as-is the links dangle: the server
 * cannot load the CAD kernels and codesign refuses the bundle.
 */
const SERVER_EXTERNALS_DIR = nodePath.join("apps", "web", ".next", "node_modules");

/** The compiled server chunks whose module references are checked. */
const SERVER_CHUNKS_DIR = nodePath.join("apps", "web", ".next", "server");

/**
 * Packages the server may `require()` without shipping them in the web bundle.
 *
 * Node's CommonJS resolver honours NODE_PATH, and the desktop main process
 * points NODE_PATH at `app.asar/node_modules`, where electron-builder packs the
 * root package.json dependencies. These are the packages Next's own runtime
 * requires from there. ES module imports (`import()`, Turbopack's `.y()`)
 * ignore NODE_PATH, which is why 1.27.0 could load `next` and not `occt-wasm`,
 * so nothing an import names is ever excused by this list.
 */
const NODE_PATH_PACKAGES = new Set(["next", "react", "react-dom", "styled-jsx"]);

/**
 * The forms a server chunk names another module by. Turbopack calls its
 * external import `.y("…")` and its external require `.x("…")`; webpack, and
 * any `import(/* webpackIgnore *\/ "…")` that Turbopack leaves alone, keep a
 * plain `import("…")`. A plain `require("…")` is not read: Next's runtime
 * guards optional requires that way, and CommonJS resolves through NODE_PATH.
 */
const REFERENCE_PATTERNS = [
  { kind: "import", pattern: /[\w$]\.y\(\s*"([^"]+)"/g },
  { kind: "import", pattern: /\bimport\(\s*"([^"]+)"\s*\)/g },
  { kind: "require", pattern: /[\w$]\.x\(\s*"([^"]+)"/g },
];

function isInside(child, parent) {
  const relative = nodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

/** A bare specifier's package name and the path inside it: `@a/b/c` -> `@a/b`, `c`. */
function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, nameLength).join("/"), subpath: parts.slice(nameLength).join("/") };
}

function isBareSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes("://");
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = nodePath.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
    }
  }
  return files;
}

/**
 * Every bare module the compiled server names, once per kind and specifier,
 * with the chunks that name it (absolute paths).
 *
 * @param {string} webRoot
 * @returns {{ specifier: string, kind: "import" | "require", files: string[] }[]}
 */
function serverModuleReferences(webRoot) {
  const references = new Map();
  for (const file of listJsFiles(nodePath.join(webRoot, SERVER_CHUNKS_DIR))) {
    const text = fs.readFileSync(file, "utf8");
    for (const { kind, pattern } of REFERENCE_PATTERNS) {
      for (const [, specifier] of text.matchAll(pattern)) {
        if (!isBareSpecifier(specifier)) continue;
        const key = `${kind} ${specifier}`;
        if (!references.has(key)) references.set(key, { specifier, kind, files: new Set() });
        references.get(key).files.add(file);
      }
    }
  }
  return [...references.values()].map((reference) => ({ ...reference, files: [...reference.files] }));
}

function packageExports(packageDir, subpath) {
  try {
    const { exports } = JSON.parse(fs.readFileSync(nodePath.join(packageDir, "package.json"), "utf8"));
    return Boolean(exports && typeof exports === "object" && (exports[`./${subpath}`] || exports["./*"]));
  } catch {
    return false;
  }
}

/**
 * Whether `specifier` resolves from a file in `fromDir` the way Node looks for
 * packages, walking up `node_modules` directories -- but never above
 * `rootDir`. An installed app has nothing above its web bundle; a build
 * packaged inside a checkout does, and would otherwise pass on the
 * repository's own `node_modules`. `skipDir` is left out of the search.
 */
function resolvesInside(specifier, fromDir, rootDir, skipDir) {
  const { name, subpath } = splitSpecifier(specifier);
  let dir = fromDir;
  while (isInside(dir, rootDir)) {
    const candidate = nodePath.join(dir, "node_modules", name);
    if (!(skipDir && isInside(candidate, skipDir)) && fs.existsSync(nodePath.join(candidate, "package.json"))) {
      return !subpath || fs.existsSync(nodePath.join(candidate, subpath)) || packageExports(candidate, subpath);
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Server references that would fail at runtime: one entry per reference, naming the first chunk. */
function unresolvedServerReferences(webRoot, skipDir) {
  const unresolved = [];
  for (const { specifier, kind, files } of serverModuleReferences(webRoot)) {
    if (isBuiltin(specifier)) continue;
    if (kind === "require" && NODE_PATH_PACKAGES.has(splitSpecifier(specifier).name)) continue;
    const failing = files.find((file) => !resolvesInside(specifier, nodePath.dirname(file), webRoot, skipDir));
    if (failing) unresolved.push({ specifier, kind, file: nodePath.relative(webRoot, failing) });
  }
  return unresolved;
}

/**
 * Make a standalone build's server externals ship as real package directories
 * inside `.next/node_modules`, so the bundle no longer depends on the root
 * `node_modules` electron-builder drops. Hashed Turbopack specifiers are
 * rewritten to the package name and share one materialized package with plain
 * imports (including the engine's webpack-ignored OCCT loader).
 *
 * Scoped hashed externals (`@scope/pkg-<hash>`, a link one level down) are not
 * handled; none exist today, and verifyPackagedWebBundle fails loudly on one.
 *
 * @param {string} standaloneDir
 * @returns {string[]}
 */
function materializeServerExternals(standaloneDir) {
  const externalsDir = nodePath.join(standaloneDir, SERVER_EXTERNALS_DIR);
  const copied = [];

  if (fs.existsSync(externalsDir)) {
    for (const name of fs.readdirSync(externalsDir)) {
      const linkPath = nodePath.join(externalsDir, name);
      if (!fs.lstatSync(linkPath).isSymbolicLink()) continue;

      let target;
      try {
        target = fs.realpathSync(linkPath);
      } catch {
        throw new Error(
          `[desktop:web:build] ${nodePath.join(SERVER_EXTERNALS_DIR, name)} links to ${fs.readlinkSync(linkPath)}, `
            + "which the standalone build does not contain.",
        );
      }

      const packageJsonPath = nodePath.join(target, "package.json");
      const packageName = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).name;
      if (!packageName || packageName.includes("/")) {
        throw new Error(`[desktop:web:build] ${linkPath} points to a package without a supported unscoped package name.`);
      }

      // Turbopack hashes server external names. Point those imports at the
      // package's canonical name so the hashed and plain imports can share the
      // same files instead of copying a second 21 MB OCCT package.
      for (const { specifier, files } of serverModuleReferences(standaloneDir)) {
        if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
        const rewritten = `${packageName}${specifier.slice(name.length)}`;
        for (const file of files) {
          const source = fs.readFileSync(file, "utf8");
          fs.writeFileSync(file, source.split(JSON.stringify(specifier)).join(JSON.stringify(rewritten)));
        }
      }

      // rm does not follow links: this removes the link (or Windows junction), not its target.
      fs.rmSync(linkPath, { recursive: true, force: true });
      const packagePath = nodePath.join(externalsDir, packageName);
      if (!fs.existsSync(nodePath.join(packagePath, "package.json"))) {
        fs.cpSync(target, packagePath, { recursive: true, dereference: true });
        copied.push(packageName);
      }
    }
  }

  const rootModules = nodePath.join(standaloneDir, "node_modules");
  for (const { specifier, kind, file } of unresolvedServerReferences(standaloneDir, rootModules)) {
    if (kind !== "import") continue;
    const { name } = splitSpecifier(specifier);
    if (copied.includes(name) || fs.existsSync(nodePath.join(externalsDir, name, "package.json"))) continue;
    const source = nodePath.join(rootModules, name);
    if (!fs.existsSync(nodePath.join(source, "package.json"))) {
      throw new Error(
        `[desktop:web:build] ${file} imports "${specifier}", which the standalone build does not contain.`,
      );
    }
    fs.cpSync(source, nodePath.join(externalsDir, name), { recursive: true, dereference: true });
    copied.push(name);
  }
  return copied;
}

/**
 * Every symlink under `rootDir` whose target does not exist, as paths relative
 * to `rootDir`.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
function findDanglingLinks(rootDir) {
  const dangling = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = nodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!fs.existsSync(entryPath)) dangling.push(nodePath.relative(rootDir, entryPath));
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return dangling;
}

/**
 * Problems in a packaged web bundle (`Resources/web`) that would leave the CAD
 * kernels unloadable or the app unsignable. Empty when the bundle is sound.
 *
 * Fails closed: besides links, every module the compiled server imports must
 * resolve inside the bundle on disk, and every module it requires must be a
 * builtin, one of NODE_PATH_PACKAGES, or on disk too.
 *
 * @param {string} webRoot
 * @returns {string[]}
 */
function verifyPackagedWebBundle(webRoot) {
  const problems = findDanglingLinks(webRoot).map((link) => `dangling link: ${link}`);

  const externalsDir = nodePath.join(webRoot, SERVER_EXTERNALS_DIR);
  if (fs.existsSync(externalsDir)) {
    for (const name of fs.readdirSync(externalsDir)) {
      const entryPath = nodePath.join(externalsDir, name);
      const relative = nodePath.join(SERVER_EXTERNALS_DIR, name);
      if (fs.lstatSync(entryPath).isSymbolicLink()) {
        problems.push(`${relative} is a link; the server external must ship as a real directory.`);
      } else if (!fs.existsSync(nodePath.join(entryPath, "package.json"))) {
        problems.push(`${relative} has no package.json.`);
      }
    }
  }

  for (const { specifier, kind, file } of unresolvedServerReferences(webRoot)) {
    problems.push(kind === "import"
      ? `${file} imports "${specifier}", which does not resolve inside the web bundle (ES module imports ignore NODE_PATH).`
      : `${file} requires "${specifier}", which is not a builtin, not provided through NODE_PATH, and does not resolve inside the web bundle.`);
  }
  return problems;
}

/**
 * The packaged app's resources directory for an electron-builder afterPack
 * context: inside the `.app` on macOS, beside the executable elsewhere.
 *
 * @param {{ appOutDir: string, electronPlatformName: string, productFilename: string }} target
 * @returns {string}
 */
function packagedResourcesDir({ appOutDir, electronPlatformName, productFilename }) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return nodePath.join(appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return nodePath.join(appOutDir, "resources");
}

module.exports = {
  NODE_PATH_PACKAGES,
  SERVER_EXTERNALS_DIR,
  findDanglingLinks,
  materializeServerExternals,
  packagedResourcesDir,
  serverModuleReferences,
  verifyPackagedWebBundle,
};
