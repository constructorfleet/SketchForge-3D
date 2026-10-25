#!/usr/bin/env node
// Stages, checks, and labels the desktop installers that desktop-release.yml
// attaches to a GitHub release.
//
// Each build leg uploads one artifact. A leg that failed uploads nothing, and
// the attach job must still attach every leg that did build, then fail loudly
// and say on the release page which installers are missing. Before this, the
// attach job needed every leg, and six releases were published with no assets.
//
//   stage --artifacts DIR --out DIR --version V --signed true|false
//       Copy each complete leg's files from DIR/<artifact>/ to the out
//       directory and merge the two macOS updater manifests. Writes
//       `complete` and `missing` (comma-separated platforms) to GITHUB_OUTPUT.
//   stale --assets FILE --staged DIR --complete CSV
//       Print the release assets, one per line, that a rebuilt platform
//       replaces under a different name (for example an -unsigned DMG).
//   check --assets FILE --version V --signed true|false
//       Compare the release's asset names with what a complete release holds.
//       Writes `missing` and `unexpected` to GITHUB_OUTPUT.
//   notes --body FILE --missing CSV --run-url URL
//       Print the release notes with the incomplete-installers notice added,
//       replaced, or removed.
import { appendFileSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

export const PLATFORMS = ["windows", "linux", "macos-x64", "macos-arm64"];

const ARTIFACTS = {
  windows: "desktop-windows",
  linux: "desktop-linux",
  "macos-x64": "desktop-macos-x64",
  "macos-arm64": "desktop-macos-arm64",
};

const LABELS = {
  windows: "Windows",
  linux: "Linux",
  "macos-x64": "macOS (Intel)",
  "macos-arm64": "macOS (Apple silicon)",
  "macos-updates": "macOS update manifest",
};

const MAC_MANIFEST = "latest-mac.yml";
const NOTICE_START = "<!-- desktop-installers:start -->";
const NOTICE_END = "<!-- desktop-installers:end -->";

// The files a platform contributes to the release itself.
function releaseFiles(platform, version, signed) {
  const suffix = signed ? "" : "-unsigned";
  switch (platform) {
    case "windows":
      return [`SketchForge-Setup-${version}-x64.exe`, `SketchForge-Setup-${version}-x64.exe.blockmap`, "latest.yml"];
    case "linux":
      return [`SketchForge-${version}-x86_64.AppImage`, "latest-linux.yml"];
    default: {
      const arch = platform.slice("macos-".length);
      return [`SketchForge-${version}-${arch}${suffix}.dmg`, `SketchForge-${version}-${arch}${suffix}.zip`];
    }
  }
}

// The files a leg's artifact must hold for that leg to count as built. A
// signed macOS leg also carries its per-architecture updater manifest, which
// is merged into latest-mac.yml rather than attached itself.
function artifactFiles(platform, version, signed) {
  const files = releaseFiles(platform, version, signed);
  if (signed && platform.startsWith("macos-")) files.push(`latest-mac-${platform.slice("macos-".length)}.yml`);
  return files;
}

// Which platform a release asset belongs to, or null for one this workflow
// does not own. latest-mac.yml is shared by both macOS legs.
function ownerOf(name) {
  if (name === "latest.yml" || /^SketchForge-Setup-.+\.exe(\.blockmap)?$/.test(name)) return ["windows"];
  if (name === "latest-linux.yml" || /^SketchForge-.+\.AppImage$/.test(name)) return ["linux"];
  if (name === MAC_MANIFEST) return ["macos-x64", "macos-arm64"];
  const mac = name.match(/^SketchForge-(?!Setup-).+-(x64|arm64)(-unsigned)?\.(dmg|zip)(\.blockmap)?$/);
  if (mac) return [`macos-${mac[1]}`];
  return null;
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function stageArtifacts({ artifactsDir, outDir, version, signed }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const complete = [];
  const missing = [];
  for (const platform of PLATFORMS) {
    const dir = path.join(artifactsDir, ARTIFACTS[platform]);
    const required = artifactFiles(platform, version, signed);
    const present = await Promise.all(required.map((name) => exists(path.join(dir, name))));
    if (present.every(Boolean)) {
      complete.push(platform);
      for (const name of releaseFiles(platform, version, signed)) await copyFile(path.join(dir, name), path.join(outDir, name));
    } else {
      missing.push(platform);
      const absent = required.filter((_, index) => !present[index]);
      console.log(`${platform}: not attaching, the ${ARTIFACTS[platform]} artifact lacks ${absent.join(", ")}`);
    }
  }

  if (signed && complete.includes("macos-x64") && complete.includes("macos-arm64")) {
    const manifests = await Promise.all(["x64", "arm64"].map(async (arch) =>
      yaml.load(await readFile(path.join(artifactsDir, ARTIFACTS[`macos-${arch}`], `latest-mac-${arch}.yml`), "utf8"))));
    if (new Set(manifests.map((manifest) => manifest.version)).size === 1) {
      const merged = { ...manifests[0], files: manifests.flatMap((manifest) => manifest.files ?? []) };
      // path and sha512 name one architecture's ZIP; left in, every Mac
      // would be offered that one.
      delete merged.path;
      delete merged.sha512;
      await writeFile(path.join(outDir, MAC_MANIFEST), yaml.dump(merged, { noRefs: true }));
    } else {
      console.log(`macOS updater manifests disagree on the version; ${MAC_MANIFEST} is not attached.`);
    }
  }
  return { complete, missing };
}

export function staleAssets({ existing, staged, complete }) {
  const keep = new Set(staged);
  const rebuilt = new Set(complete);
  return existing.filter((name) => {
    const owners = ownerOf(name);
    return owners !== null && owners.every((owner) => rebuilt.has(owner)) && !keep.has(name);
  });
}

export function checkRelease({ assets, version, signed }) {
  const names = new Set(assets);
  const missing = [];
  const missingAssets = [];
  for (const platform of PLATFORMS) {
    const absent = releaseFiles(platform, version, signed).filter((name) => !names.has(name));
    if (absent.length > 0) missing.push(platform);
    missingAssets.push(...absent);
  }
  const unexpected = [];
  if (signed && !names.has(MAC_MANIFEST)) {
    missingAssets.push(MAC_MANIFEST);
    // Explained by a missing macOS leg; named on its own only when both built.
    if (!missing.includes("macos-x64") && !missing.includes("macos-arm64")) missing.push("macos-updates");
  }
  if (!signed && names.has(MAC_MANIFEST)) unexpected.push(MAC_MANIFEST);
  return { missing, missingAssets, unexpected };
}

export function annotateNotes({ body, missing, runUrl }) {
  const pattern = new RegExp(`${NOTICE_START}[\\s\\S]*?${NOTICE_END}\\n*`);
  const stripped = (body ?? "").replace(pattern, "");
  if (missing.length === 0) return stripped;
  const platforms = missing.map((platform) => LABELS[platform] ?? platform).join(", ");
  const notice = [
    NOTICE_START,
    "> [!WARNING]",
    `> The desktop installers for this release are incomplete. Missing: ${platforms}.`,
    `> The [desktop release run](${runUrl}) did not produce them; it can be re-run for this version.`,
    NOTICE_END,
  ].join("\n");
  return `${notice}\n\n${stripped}`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Expected --option value, got ${key}`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

function required(options, key) {
  if (options[key] === undefined) throw new Error(`Missing --${key}`);
  return options[key];
}

function list(value) {
  return value ? value.split(",").filter(Boolean) : [];
}

function lines(file) {
  return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

async function main([command, ...argv]) {
  const options = parseArgs(argv);
  switch (command) {
    case "stage": {
      const result = await stageArtifacts({
        artifactsDir: required(options, "artifacts"),
        outDir: required(options, "out"),
        version: required(options, "version"),
        signed: required(options, "signed") === "true",
      });
      console.log(`Built: ${result.complete.join(", ") || "none"}. Missing: ${result.missing.join(", ") || "none"}.`);
      output({ complete: result.complete.join(","), missing: result.missing.join(",") });
      return;
    }
    case "stale": {
      const names = staleAssets({
        existing: lines(required(options, "assets")),
        staged: await readdir(required(options, "staged")),
        complete: list(options.complete),
      });
      if (names.length > 0) process.stdout.write(`${names.join("\n")}\n`);
      return;
    }
    case "check": {
      const result = checkRelease({
        assets: lines(required(options, "assets")),
        version: required(options, "version"),
        signed: required(options, "signed") === "true",
      });
      for (const name of result.missingAssets) console.log(`::error::The release is missing ${name}`);
      for (const name of result.unexpected) console.log(`::error::Unsigned macOS builds must not publish ${name}`);
      output({ missing: result.missing.join(","), unexpected: result.unexpected.join(",") });
      return;
    }
    case "notes": {
      const body = readFileSync(required(options, "body"), "utf8");
      process.stdout.write(annotateNotes({ body, missing: list(options.missing), runUrl: required(options, "run-url") }));
      return;
    }
    default:
      throw new Error(`Unknown command ${command}. Use stage, stale, check, or notes.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
