import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The server runs as `node` (UID 1000). Docker creates the mount point for a
 * fresh named or anonymous volume owned by root whenever the path does not
 * already exist in the image, and the storage directories are whatever
 * `SKETCHFORGE_SHARED_PROJECTS_DIR` and `SKETCHFORGE_PROJECTS_DIR` name, so no
 * fixed set of directories baked into the image can cover them. The container
 * therefore starts as root in an entrypoint that creates the configured
 * directories, hands them to `node`, and drops privileges before the server
 * starts.
 *
 * No Docker daemon runs under the unit suite. These tests pin the image's
 * shape and exercise the entrypoint script directly; the `smoke` job in
 * docker.yml runs the built image against fresh volumes on every pull request.
 */
const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };
const ENTRYPOINT = "deploy/docker/entrypoint.sh";
const posix = process.platform !== "win32";

function runnerStage() {
  const dockerfile = read("deploy/docker/Dockerfile").replace(/\\\n/g, " ");
  const start = dockerfile.indexOf("AS runner");
  expect(start, "the Dockerfile has no runner stage").toBeGreaterThan(-1);
  return dockerfile.slice(start);
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; "runs-on"?: string; steps: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function dockerWorkflow(): Workflow {
  // YAML 1.1 reads a bare `on:` key as boolean true.
  const workflow = yaml.load(read(".github/workflows/docker.yml")) as Partial<Workflow> & { true?: Workflow["on"] };
  return { on: workflow.on ?? workflow.true ?? {}, jobs: workflow.jobs ?? {} };
}

function runEntrypoint(env: Record<string, string>, command: string[] = ["sh", "-c", "echo ran as $(id -u)"]) {
  const result = spawnSync("sh", [join(root, ENTRYPOINT), ...command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the Docker image prepares the configured storage directories at container start", () => {
  it("starts as root in an entrypoint that drops to node", () => {
    const stage = runnerStage();
    expect(stage, "the runner stage must not switch to USER node; the entrypoint drops privileges after chown").not.toMatch(/^USER node/m);
    expect(stage).toMatch(/apk add --no-cache[^\n]*\bsu-exec\b/);
    expect(stage).toMatch(new RegExp(`^COPY [^\\n]*${ENTRYPOINT} `, "m"));
    expect(stage).toMatch(new RegExp(`^ENTRYPOINT \\["/app/${ENTRYPOINT}"\\]`, "m"));
    expect(stage).toMatch(/^CMD \["node", "deploy\/docker\/start-server.mjs"\]/m);
  });

  it("does not bake a fixed storage path for SKETCHFORGE_PROJECTS_DIR into the image", () => {
    const stage = runnerStage();
    expect(stage).not.toContain("/data/my-projects");
    const declared = JSON.parse(stage.match(/^VOLUME (\[.*\])$/m)?.[1] ?? "[]") as string[];
    expect(declared).toEqual(["/data/projects"]);
  });

  it("reads both storage variables in the entrypoint and hands the directories to node", () => {
    const script = read(ENTRYPOINT);
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    expect(script).toContain("SKETCHFORGE_SHARED_PROJECTS_DIR");
    expect(script).toContain("SKETCHFORGE_PROJECTS_DIR");
    expect(script).toMatch(/chown [^\n]*node:node/);
    expect(script).toMatch(/exec su-exec node "\$@"/);
  });

  it("stays healthy when shared projects are intentionally disabled", () => {
    const healthcheck = runnerStage().match(/^HEALTHCHECK .*$/m)?.[0] ?? "";
    expect(healthcheck).toContain("/api/shared-projects");
    // An empty SKETCHFORGE_SHARED_PROJECTS_DIR answers 200 with enabled:false,
    // which is a configuration, not a fault.
    expect(healthcheck).not.toContain('"enabled":true');
  });
});

describe.runIf(posix)("the entrypoint without root privileges", () => {
  it("creates the configured directories where it can and runs the command as the current user", () => {
    const base = mkdtempSync(join(tmpdir(), "sketchforge-entrypoint-"));
    try {
      const shared = join(base, "shared", "library");
      const projects = join(base, "projects");
      const result = runEntrypoint({ SKETCHFORGE_SHARED_PROJECTS_DIR: shared, SKETCHFORGE_PROJECTS_DIR: projects });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(shared)).toBe(true);
      expect(existsSync(projects)).toBe(true);
      expect(result.stdout.trim()).toBe(`ran as ${process.getuid?.() ?? ""}`);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips an empty variable and still starts the server", () => {
    const result = runEntrypoint({ SKETCHFORGE_SHARED_PROJECTS_DIR: "", SKETCHFORGE_PROJECTS_DIR: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ran as");
    expect(result.stderr).toBe("");
  });

  it("names the unwritable path and the expected UID instead of failing silently", () => {
    if (process.getuid?.() === 0) return; // root can write anywhere; the Docker smoke job covers that path.
    const base = mkdtempSync(join(tmpdir(), "sketchforge-entrypoint-"));
    try {
      const locked = join(base, "locked");
      writeFileSync(locked, "not a directory");
      const unwritable = join(base, "readonly");
      spawnSync("mkdir", [unwritable]);
      chmodSync(unwritable, 0o500);
      const result = runEntrypoint({ SKETCHFORGE_SHARED_PROJECTS_DIR: join(locked, "library"), SKETCHFORGE_PROJECTS_DIR: unwritable });
      // The server still starts: a read-only shared library is a valid deployment, so the entrypoint warns instead of exiting.
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("ran as");
      expect(result.stderr).toContain(join(locked, "library"));
      expect(result.stderr).toContain(unwritable);
      expect(result.stderr).toContain(`uid ${process.getuid?.()}`);
    } finally {
      chmodSync(join(base, "readonly"), 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("pull requests run the built image against fresh volumes", () => {
  it("triggers docker.yml on pull_request without publishing from it", () => {
    const workflow = dockerWorkflow();
    expect(Object.keys(workflow.on)).toContain("pull_request");
    const publishing = Object.values(workflow.jobs).filter((job) =>
      job.steps.some((step) => step.with?.push === true || step.uses?.startsWith("docker/login-action")),
    );
    expect(publishing.length).toBeGreaterThan(0);
    for (const job of publishing) expect(job.if ?? "").toMatch(/github\.event_name != 'pull_request'/);
  });

  it("smoke-tests a native single-arch build at a custom storage path, as the container user, and under --user", () => {
    const smoke = dockerWorkflow().jobs.smoke;
    expect(smoke, "docker.yml has no smoke job").toBeDefined();
    expect(smoke.if ?? "").not.toMatch(/pull_request/);
    const build = smoke.steps.find((step) => step.uses?.startsWith("docker/build-push-action"));
    expect(build?.with?.push).toBe(false);
    expect(build?.with?.load).toBe(true);
    expect(build?.with?.platforms).toBeUndefined();
    const script = smoke.steps.map((step) => step.run ?? "").join("\n");
    // A path the image never heard of proves the directories are prepared at run time, not baked in.
    expect(script).toMatch(/SKETCHFORGE_PROJECTS_DIR=\/srv\/[\w-]+/);
    expect(script).toMatch(/SKETCHFORGE_PROJECTS_DIR=\/data\/my-projects/);
    expect(script).toMatch(/docker volume create/);
    expect(script).toMatch(/id -u/);
    expect(script).toMatch(/--user 1000:1000/);
    expect(script).toMatch(/\/api\/v1\/projects/);
    expect(script).toMatch(/Health\.Status/);
    expect(script).toMatch(/SKETCHFORGE_SHARED_PROJECTS_DIR=\s/);
  });
});
