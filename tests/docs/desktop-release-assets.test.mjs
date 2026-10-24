import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import {
  annotateNotes,
  checkRelease,
  staleAssets,
  stageArtifacts,
} from "../../scripts/release/desktop-release-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/release/desktop-release-assets.mjs");
const execFileAsync = promisify(execFile);
const version = "1.23.0";

function macManifest(arch) {
  return yaml.dump({
    version,
    files: [
      { url: `SketchForge-${version}-${arch}.zip`, sha512: `zip-${arch}`, size: 1 },
      { url: `SketchForge-${version}-${arch}.dmg`, sha512: `dmg-${arch}`, size: 2 },
    ],
    path: `SketchForge-${version}-${arch}.zip`,
    sha512: `zip-${arch}`,
    releaseDate: "2026-10-24T04:25:00.000Z",
  });
}

// Lays out a download-artifact pattern download: one directory per leg that
// uploaded, holding exactly what that leg's composite action stores.
async function artifacts(legs, { signed = true, omit = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sketchforge-desktop-assets-"));
  const suffix = signed ? "" : "-unsigned";
  const files = {
    "desktop-windows": {
      [`SketchForge-Setup-${version}-x64.exe`]: "exe",
      [`SketchForge-Setup-${version}-x64.exe.blockmap`]: "blockmap",
      "latest.yml": "version: 1.23.0\n",
    },
    "desktop-linux": {
      [`SketchForge-${version}-x86_64.AppImage`]: "appimage",
      "latest-linux.yml": "version: 1.23.0\n",
    },
    "desktop-macos-x64": {
      [`SketchForge-${version}-x64${suffix}.dmg`]: "dmg",
      [`SketchForge-${version}-x64${suffix}.zip`]: "zip",
      ...(signed ? { "latest-mac-x64.yml": macManifest("x64") } : {}),
    },
    "desktop-macos-arm64": {
      [`SketchForge-${version}-arm64${suffix}.dmg`]: "dmg",
      [`SketchForge-${version}-arm64${suffix}.zip`]: "zip",
      ...(signed ? { "latest-mac-arm64.yml": macManifest("arm64") } : {}),
    },
  };
  for (const leg of legs) {
    await mkdir(path.join(dir, leg), { recursive: true });
    for (const [name, content] of Object.entries(files[leg])) {
      if (omit.includes(name)) continue;
      await writeFile(path.join(dir, leg, name), content);
    }
  }
  return { dir, out: path.join(dir, "release"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const allLegs = ["desktop-windows", "desktop-linux", "desktop-macos-x64", "desktop-macos-arm64"];

test("stages every leg that built when one leg failed, as in the v1.23.0 run", async () => {
  const { dir, out, cleanup } = await artifacts(["desktop-windows", "desktop-linux", "desktop-macos-arm64"]);
  try {
    const result = await stageArtifacts({ artifactsDir: dir, outDir: out, version, signed: true });
    assert.deepEqual(result.complete, ["windows", "linux", "macos-arm64"]);
    assert.deepEqual(result.missing, ["macos-x64"]);
    assert.deepEqual((await readdir(out)).sort(), [
      `SketchForge-${version}-arm64.dmg`,
      `SketchForge-${version}-arm64.zip`,
      `SketchForge-${version}-x86_64.AppImage`,
      `SketchForge-Setup-${version}-x64.exe`,
      `SketchForge-Setup-${version}-x64.exe.blockmap`,
      "latest-linux.yml",
      "latest.yml",
    ]);
  } finally {
    await cleanup();
  }
});

test("merges both macOS updater manifests into latest-mac.yml when both legs built", async () => {
  const { dir, out, cleanup } = await artifacts(allLegs);
  try {
    const result = await stageArtifacts({ artifactsDir: dir, outDir: out, version, signed: true });
    assert.deepEqual(result.missing, []);
    const staged = await readdir(out);
    assert.ok(staged.includes("latest-mac.yml"));
    assert.ok(!staged.includes("latest-mac-x64.yml") && !staged.includes("latest-mac-arm64.yml"));
    const merged = yaml.load(await readFile(path.join(out, "latest-mac.yml"), "utf8"));
    assert.equal(merged.version, version);
    assert.deepEqual(merged.files.map((file) => file.url), [
      `SketchForge-${version}-x64.zip`,
      `SketchForge-${version}-x64.dmg`,
      `SketchForge-${version}-arm64.zip`,
      `SketchForge-${version}-arm64.dmg`,
    ]);
    assert.equal(merged.path, undefined, "a single-arch path would send every Mac to one architecture");
    assert.equal(merged.sha512, undefined);
  } finally {
    await cleanup();
  }
});

test("treats a leg with a missing file as not built and stages none of it", async () => {
  const { dir, out, cleanup } = await artifacts(allLegs, { omit: ["latest-linux.yml"] });
  try {
    const result = await stageArtifacts({ artifactsDir: dir, outDir: out, version, signed: true });
    assert.deepEqual(result.missing, ["linux"]);
    assert.ok(!(await readdir(out)).some((name) => name.endsWith(".AppImage")));
  } finally {
    await cleanup();
  }
});

test("unsigned macOS builds are staged under their -unsigned names without an updater manifest", async () => {
  const { dir, out, cleanup } = await artifacts(allLegs, { signed: false });
  try {
    const result = await stageArtifacts({ artifactsDir: dir, outDir: out, version, signed: false });
    assert.deepEqual(result.missing, []);
    const staged = await readdir(out);
    assert.ok(staged.includes(`SketchForge-${version}-x64-unsigned.dmg`));
    assert.ok(!staged.includes("latest-mac.yml"));
  } finally {
    await cleanup();
  }
});

test("stale assets are only those of a platform this run rebuilt", () => {
  const existing = [
    `SketchForge-${version}-x64-unsigned.dmg`,
    `SketchForge-${version}-x64-unsigned.zip`,
    `SketchForge-${version}-arm64-unsigned.dmg`,
    `SketchForge-Setup-${version}-x64.exe`,
    "latest.yml",
    "latest-mac.yml",
    "sketchforge-1.23.0.tar.gz",
  ];
  const staged = [`SketchForge-${version}-x64.dmg`, `SketchForge-${version}-x64.zip`, `SketchForge-Setup-${version}-x64.exe`, "latest.yml"];
  assert.deepEqual(staleAssets({ existing, staged, complete: ["windows", "macos-x64"] }), [
    `SketchForge-${version}-x64-unsigned.dmg`,
    `SketchForge-${version}-x64-unsigned.zip`,
  ], "arm64 did not rebuild, so its assets and the shared latest-mac.yml stay");

  assert.deepEqual(
    staleAssets({ existing, staged, complete: ["macos-x64", "macos-arm64"] }),
    [
      `SketchForge-${version}-x64-unsigned.dmg`,
      `SketchForge-${version}-x64-unsigned.zip`,
      `SketchForge-${version}-arm64-unsigned.dmg`,
      "latest-mac.yml",
    ],
    "both macOS legs rebuilt without producing latest-mac.yml, so the old one is stale",
  );
});

test("checks the release for every platform's installers and updater manifests", () => {
  const complete = [
    `SketchForge-Setup-${version}-x64.exe`,
    `SketchForge-Setup-${version}-x64.exe.blockmap`,
    "latest.yml",
    `SketchForge-${version}-x86_64.AppImage`,
    "latest-linux.yml",
    `SketchForge-${version}-x64.dmg`,
    `SketchForge-${version}-x64.zip`,
    `SketchForge-${version}-arm64.dmg`,
    `SketchForge-${version}-arm64.zip`,
    "latest-mac.yml",
  ];
  assert.deepEqual(checkRelease({ assets: complete, version, signed: true }), { missing: [], missingAssets: [], unexpected: [] });

  const withoutIntel = complete.filter((name) => !name.includes("-x64.dmg") && !name.includes("-x64.zip") && name !== "latest-mac.yml");
  assert.deepEqual(checkRelease({ assets: withoutIntel, version, signed: true }), {
    missing: ["macos-x64"],
    missingAssets: [`SketchForge-${version}-x64.dmg`, `SketchForge-${version}-x64.zip`, "latest-mac.yml"],
    unexpected: [],
  });

  assert.deepEqual(checkRelease({ assets: [], version, signed: true }).missing, ["windows", "linux", "macos-x64", "macos-arm64"]);

  const unsigned = checkRelease({
    assets: complete.map((name) => name.replace(/-(x64|arm64)\.(dmg|zip)$/, "-$1-unsigned.$2")),
    version,
    signed: false,
  });
  assert.deepEqual(unsigned.missing, []);
  assert.deepEqual(unsigned.unexpected, ["latest-mac.yml"], "unsigned builds must not publish an updater manifest");
});

test("marks an incomplete release on its page, and clears the mark once complete", () => {
  const body = "## Features\n\n* something\n";
  const runUrl = "https://github.com/constructorfleet/SketchForge-3D/actions/runs/1";
  const marked = annotateNotes({ body, missing: ["macos-x64", "windows"], runUrl });
  assert.match(marked, /macOS \(Intel\)/);
  assert.match(marked, /Windows/);
  assert.ok(marked.includes(runUrl));
  assert.ok(marked.endsWith(body), "the generated release notes are kept as they were");

  const remarked = annotateNotes({ body: marked, missing: ["linux"], runUrl });
  assert.doesNotMatch(remarked, /macOS \(Intel\)/, "a re-run replaces the old mark instead of stacking another");
  assert.match(remarked, /Linux/);

  assert.equal(annotateNotes({ body: remarked, missing: [], runUrl }), body);
  assert.equal(annotateNotes({ body, missing: [], runUrl }), body);
});

test("the stage and check commands report to GITHUB_OUTPUT for the workflow", async () => {
  const { dir, out, cleanup } = await artifacts(["desktop-linux"]);
  const output = path.join(dir, "github-output");
  await writeFile(output, "");
  try {
    await execFileAsync(process.execPath, [script, "stage", "--artifacts", dir, "--out", out, "--version", version, "--signed", "true"], {
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.match(await readFile(output, "utf8"), /^complete=linux$/m);
    assert.match(await readFile(output, "utf8"), /^missing=windows,macos-x64,macos-arm64$/m);

    const assets = path.join(dir, "assets.txt");
    await writeFile(assets, `SketchForge-${version}-x86_64.AppImage\nlatest-linux.yml\n`);
    await writeFile(output, "");
    await execFileAsync(process.execPath, [script, "check", "--assets", assets, "--version", version, "--signed", "true"], {
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.match(await readFile(output, "utf8"), /^missing=windows,macos-x64,macos-arm64$/m);
  } finally {
    await cleanup();
  }
});
