import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The REST API against a server built the way one is actually deployed.
//
// `restApi.e2e.ts` starts `next dev`, which compiles each route on demand and
// never prerenders anything. A production build does, and that difference hid
// a shipped bug: a route handler exporting only GET, touching no API Next
// recognises as dynamic, is rendered at build time and then served from the
// full route cache for ever. The build has no API token, so the cached body is
// `404 {"code":"api_disabled"}` -- which is what a deployed server answered for
// `GET /api/v1/edges` regardless of how it was configured at runtime.
//
// Every other route escaped by accident, by exporting POST or DELETE as well.
// So the regression this file guards is subtle and invisible to every other
// test we have: it only appears in a built server, and only on a route that is
// read-only.
//
// Not part of `npm run ci` -- it runs a production build, so it is minutes.
// Run it with `npm run test:e2e`.

const TOKEN = "e2e-production-token";
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

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
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
  return {
    status: response.status,
    // `HIT` is how a response served from the build-time prerender identifies
    // itself, and is the symptom this file exists to catch.
    cache: response.headers.get("x-nextjs-cache"),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

beforeAll(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), "sketchforge-prod-e2e-"));
  // Deliberately built with no token in the environment, which is how a real
  // image is built: the prerendered body would be the "API is disabled" 404.
  await run("npx", ["next", "build", "apps/web"]);

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn("npx", ["next", "start", "apps/web", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_API_TOKEN: TOKEN, SKETCHFORGE_PROJECTS_DIR: projectsDir },
    stdio: "ignore",
  });

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`the production server exited with ${server.exitCode}`);
    try {
      const probe = await api("/projects");
      if (probe.status === 200) break;
    } catch {
      // Connection refused while it boots.
    }
    if (Date.now() > deadline) throw new Error("the production server never answered /api/v1/projects");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}, 600_000);

afterAll(async () => {
  // This test's own child and nothing else.
  server?.kill("SIGTERM");
  if (projectsDir) await rm(projectsDir, { recursive: true, force: true });
});

describe("the REST API from a production build", { timeout: 180_000 }, () => {
  let projectId = "";
  let shapeId = "";

  it("creates a project and a box to read geometry from", async () => {
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Production build" }) });
    expect(created.status).toBe(201);
    projectId = ((created.body.project as Record<string, string>) ?? {}).id;
    expect(projectId).toBeTruthy();

    const shape = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "box", width: 20, depth: 20, height: 20, name: "Pot" }] }),
    });
    expect(shape.status).toBe(201);
    shapeId = (shape.body.shapes as Array<Record<string, string>>)[0].id;
  });

  it("answers the read-only routes with data rather than a cached 404", async () => {
    // `edges`, `faces`, and `properties` answered `404 api_disabled` with `x-nextjs-cache: HIT`
    // from a built server, whatever the token was, because they export only GET.
    // `measurements` escapes by exporting POST as well, which is the accident
    // every other route in `/api/v1` relies on -- it is in this loop so that
    // losing the POST handler, or splitting the between-entities measurement
    // onto a GET-only route of its own, cannot quietly reintroduce the trap.
    for (const route of ["edges", "faces", "measurements"] as const) {
      const listed = await api(`/${route}?projectId=${projectId}&shapeId=${shapeId}`);
      expect(listed.status, route).toBe(200);
      expect(listed.cache, route).not.toBe("HIT");
      expect((listed.body[route] as unknown[]).length, route).toBeGreaterThan(0);
    }
    const properties = await api(`/properties?projectId=${projectId}&shapeId=${shapeId}`);
    expect(properties.status).toBe(200);
    expect(properties.cache).not.toBe("HIT");
    expect(properties.body.properties).toMatchObject({ provenance: { source: "parametric", precision: "exact" } });
  });

  it("still refuses an unauthorized caller, which the cache would have faked", async () => {
    // The mirror image: with the route no longer prerendered, a 404 for a bad
    // token has to come from the handler, not from the build.
    const response = await fetch(`${origin}/api/v1/faces?projectId=${projectId}&shapeId=${shapeId}`);
    expect(response.status).toBe(401);
    expect((await response.json() as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("names the allowed methods when asked", async () => {
    const response = await fetch(`${origin}/api/v1/properties`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, OPTIONS");
  });

  it("imports an STL, which pulls three's loaders through a bundled server", async () => {
    // Same class of failure as the OCCT one below: the import route reaches
    // `three/examples/jsm/loaders/STLLoader.js`, and a loader that resolves
    // under vitest can still fail to bundle. Nothing else here imports a model
    // on the server side.
    const corners = [[0, 0, 0], [30, 0, 0], [0, 18, 0], [0, 0, 9]];
    const facets = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]].map(([a, b, c]) => [
      "facet normal 0 0 0",
      "  outer loop",
      `    vertex ${corners[a].join(" ")}`,
      `    vertex ${corners[b].join(" ")}`,
      `    vertex ${corners[c].join(" ")}`,
      "  endloop",
      "endfacet",
    ].join("\n")).join("\n");

    const imported = await api(`/imports?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({
        fileName: "wedge.stl",
        data: Buffer.from(`solid wedge\n${facets}\nendsolid wedge`, "utf8").toString("base64"),
      }),
    });
    expect(imported.status).toBe(201);
    expect(imported.body.triangles).toBe(4);
    expect(imported.body.shape).toMatchObject({ width: 30, depth: 18, height: 9 });
  });

  it("hollows a shape, which is the whole OCCT path through a bundled server", async () => {
    // The bundling failure this repo has hit twice -- `createRequire is not a
    // function` from Emscripten glue that `serverExternalPackages` did not
    // cover -- only appears in a built server, which no other test runs.
    const hollowed = await api(`/shell?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "POST",
      body: JSON.stringify({ thickness: 2, openFaces: ["top"] }),
    });
    expect(hollowed.status).toBe(200);
    expect((hollowed.body.shape as Record<string, unknown>).kind).toBe("mesh");
    expect(hollowed.body.triangles as number).toBeGreaterThan(0);
  });
});
