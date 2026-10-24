import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Local mode runs `git fetch`, `git merge` and `npm install` in the checkout
// that holds the server. These tests stand in for that whole child-process
// layer, so "nothing ran" is asserted directly rather than inferred.
const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: childProcess.execFile,
  spawn: childProcess.spawn,
}));

const CURRENT = "1.0.0";
const LATEST = "2.0.0";
const ADMIN_KEY = "correct-horse-battery-staple";

let repoRoot = "";

function writeVersion(version: string) {
  writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "sketchforge", version }));
}

async function loadRoute() {
  // The route keeps its version cache and trigger cooldown in module state.
  vi.resetModules();
  return import("@/app/api/app-update/route");
}

function post(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers });
}

function gitWasRun() {
  return childProcess.execFile.mock.calls.some(([command]) => command === "git");
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), "sketchforge-app-update-"));
  mkdirSync(path.join(repoRoot, ".git"));
  writeVersion(CURRENT);
  vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

  childProcess.execFile.mockReset();
  childProcess.spawn.mockReset();
  childProcess.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    // A successful fast-forward is what moves the checkout to the new version.
    if (command === "git" && args[0] === "merge") writeVersion(LATEST);
    callback(null, { stdout: "", stderr: "" });
  });

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: LATEST }), { status: 200 })));
  for (const name of [
    "SKETCHFORGE_APP_VERSION",
    "SKETCHFORGE_UPDATE_ADMIN_KEY",
    "SKETCHFORGE_UPDATE_TRIGGER_URL",
    "SKETCHFORGE_UPDATE_TRIGGER_TOKEN",
    "SKETCHFORGE_LOCAL_UPDATE",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("local-mode POST /api/app-update", () => {
  // `request.url` is built from the Host header, so a LAN client that sends
  // `Host: localhost` looks exactly like this. The forwarded-for value is the
  // client's own claim; Next keeps a client-supplied one rather than replacing it.
  const spoofedLocal = "http://localhost:3000/api/app-update";
  const lanClient = { "x-forwarded-for": "192.168.1.50" };

  it("refuses and runs nothing when neither the admin key nor the local opt-in is configured", async () => {
    const { POST } = await loadRoute();

    const response = await POST(post(spoofedLocal, lanClient));

    expect(response.status).toBe(403);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("requires the configured admin key and runs nothing without it", async () => {
    vi.stubEnv("SKETCHFORGE_UPDATE_ADMIN_KEY", ADMIN_KEY);
    const { POST } = await loadRoute();

    const missing = await POST(post(spoofedLocal, lanClient));
    const wrong = await POST(post(spoofedLocal, { ...lanClient, "x-sketchforge-update-key": "guess" }));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("updates the checkout when the caller supplies the admin key", async () => {
    vi.stubEnv("SKETCHFORGE_UPDATE_ADMIN_KEY", ADMIN_KEY);
    const { POST } = await loadRoute();

    const response = await POST(post(spoofedLocal, { "x-sketchforge-update-key": ADMIN_KEY }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, updateMode: "local", latestVersion: LATEST });
    expect(gitWasRun()).toBe(true);
  });

  it("updates the checkout without a key only when SKETCHFORGE_LOCAL_UPDATE=1", async () => {
    vi.stubEnv("SKETCHFORGE_LOCAL_UPDATE", "1");
    const { POST } = await loadRoute();

    const response = await POST(post(spoofedLocal));

    expect(response.status).toBe(202);
    expect(gitWasRun()).toBe(true);
  });

  it("does not treat a request addressed to a LAN host as local, even with the opt-in", async () => {
    vi.stubEnv("SKETCHFORGE_LOCAL_UPDATE", "1");
    const { POST } = await loadRoute();

    const response = await POST(post("http://192.168.1.10:3000/api/app-update"));

    expect(response.status).toBe(409);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});

describe("GET /api/app-update status for a local checkout", () => {
  const local = "http://localhost:3000/api/app-update";

  it("reports a local install that is not ready when no gate is configured", async () => {
    const { GET } = await loadRoute();

    const status = await (await GET(new Request(local))).json();

    expect(status).toMatchObject({ updateMode: "local", installationReady: false, requiresUpdateKey: false, updateAvailable: true });
  });

  it("asks for the update key when the admin key gates local mode", async () => {
    vi.stubEnv("SKETCHFORGE_UPDATE_ADMIN_KEY", ADMIN_KEY);
    const { GET } = await loadRoute();

    const status = await (await GET(new Request(local))).json();

    expect(status).toMatchObject({ updateMode: "local", installationReady: true, requiresUpdateKey: true });
  });

  it("needs no key when the operator opted in to local updates", async () => {
    vi.stubEnv("SKETCHFORGE_LOCAL_UPDATE", "1");
    const { GET } = await loadRoute();

    const status = await (await GET(new Request(local))).json();

    expect(status).toMatchObject({ updateMode: "local", installationReady: true, requiresUpdateKey: false });
  });
});
