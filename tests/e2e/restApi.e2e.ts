import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The REST API over HTTP, against a server this test starts itself.
//
// The unit tests call the route handlers directly, which is fast and misses a
// whole class of failure: a handler that imports fine under vitest and throws
// `createRequire is not a function` the moment Next bundles it, a route that
// static export cannot prerender, a middleware that never runs in-process.
// Both OCCT and manifold have shipped that exact break here. The only way to
// catch it is to ask a real server a real question.
//
// Not part of `npm run ci` -- it compiles the app on demand, so it is minutes
// rather than seconds. Run it with `npm run test:e2e`.

const TOKEN = "e2e-round-trip-token";
let server: ChildProcess | undefined;
let projectsDir = "";
let origin = "";

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), "sketchforge-e2e-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn("npx", ["next", "dev", "apps/web", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_API_TOKEN: TOKEN, SKETCHFORGE_PROJECTS_DIR: projectsDir },
    stdio: "ignore",
  });

  const deadline = Date.now() + 110_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`the dev server exited with ${server.exitCode}`);
    try {
      // Ask for something that exercises the route, not just the socket: a dev
      // server answers before it has compiled anything.
      const probe = await api("/projects");
      if (probe.status === 200) break;
    } catch {
      // Connection refused while it boots.
    }
    if (Date.now() > deadline) throw new Error("the dev server never answered /api/v1/projects");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

afterAll(async () => {
  // Kill this test's own child and nothing else: a pattern-matched kill here
  // has taken out a developer's own dev server before.
  server?.kill("SIGTERM");
  if (projectsDir) await rm(projectsDir, { recursive: true, force: true });
});

describe("the REST API over HTTP", () => {
  let projectId = "";
  let shapeId = "";

  it("serves the project list to an authorized caller", async () => {
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "E2E round trip" }) });
    expect(created.status).toBe(201);
    projectId = ((created.body.project as Record<string, string>) ?? {}).id;
    expect(projectId).toBeTruthy();
  });

  it("refuses a caller with no token", async () => {
    const response = await fetch(`${origin}/api/v1/projects`);
    expect(response.status).toBe(401);
    expect((await response.json() as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("names the project it cannot find", async () => {
    const missing = await api("/shapes?projectId=project-does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("project_not_found");
  });

  it("builds a standard thread and gives back what it built", async () => {
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "thread", thread: "M8", length: 16, name: "Bolt" }] }),
    });
    expect(created.status).toBe(201);
    const [shape] = created.body.shapes as Array<Record<string, any>>;
    shapeId = shape.id;
    expect(shape.requestKind).toBe("revolve");
    expect(shape.revolve.pitch).toBeCloseTo(1.25, 5);
    // An M8 thread is 8mm across, whatever the mesh tessellation rounds to.
    expect(shape.width).toBeCloseTo(8, 1);
  });

  it("keeps the kind-specific fields on the shape list, not just on the reply", async () => {
    const listed = await api(`/shapes?projectId=${projectId}`);
    expect(listed.status).toBe(200);
    const [shape] = listed.body.shapes as Array<Record<string, any>>;
    // The summary used to carry only the common fields, so a client could not
    // read back the pitch of a thread it had just made.
    expect(shape.revolve).toMatchObject({ pitch: 1.25, sweepAngle: 360 });
    expect(shape.profile).toHaveLength(3);
  });

  it("rebuilds the geometry when a sweep field changes", async () => {
    const before = await api(`/shapes?projectId=${projectId}`);
    const height = (before.body.shapes as Array<Record<string, any>>)[0].height;
    const patched = await api(`/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ pitch: 2 }),
    });
    expect(patched.status).toBe(200);
    const shape = (patched.body.shape ?? patched.body) as Record<string, any>;
    expect(shape.revolve.pitch).toBeCloseTo(2, 5);
    // Same turns at a coarser pitch is a taller bolt; a PATCH that only stored
    // the number without sweeping again would leave the height alone.
    expect(shape.height).toBeGreaterThan(height);
  });

  it("refuses a change naming fields the shape cannot take, and applies none of it", async () => {
    const refused = await api(`/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ sides: 8, sids: 3, radius: 99 }),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("unapplicable_fields");
    expect(refused.body.fields).toEqual(["sids", "radius"]);

    const after = await api(`/shapes?projectId=${projectId}`);
    // `sides` was legitimate, but the request was refused whole.
    expect((after.body.shapes as Array<Record<string, any>>)[0].revolve.sides).toBe(64);
  });
});
