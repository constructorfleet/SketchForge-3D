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
    env: {
      ...process.env,
      // The config puts the dev compiler in `.next-dev` only when NODE_ENV says
      // development, and Next leaves an NODE_ENV that is already set alone --
      // under vitest that is `test`, so this dev server would build into
      // `.next` and fight the production build `productionApi.e2e.ts` runs.
      // The symptom is the other suite's build failing, or this one dying with
      // "Cannot find module for page: /_document" when its chunks vanish.
      NODE_ENV: "development",
      SKETCHFORGE_API_TOKEN: TOKEN,
      SKETCHFORGE_PROJECTS_DIR: projectsDir,
    },
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

  it("lists a box's faces and hollows it into a tray", async () => {
    // The route that matters most to get out of the bundle rather than out of
    // vitest: hollowing loads OCCT through `serverExternalPackages`, and a
    // handler that imports fine in-process has twice thrown
    // `createRequire is not a function` once Next bundled it.
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "box", width: 20, depth: 20, height: 20, name: "Pot" }] }),
    });
    expect(created.status).toBe(201);
    const potId = (created.body.shapes as Array<Record<string, any>>)[0].id;

    const faces = await api(`/faces?projectId=${projectId}&shapeId=${potId}`);
    expect(faces.status).toBe(200);
    const listed = faces.body.faces as Array<Record<string, any>>;
    expect(listed).toHaveLength(6);
    const top = listed.filter((face) => face.facing === "top");
    expect(top).toHaveLength(1);
    expect(top[0].centroid.y).toBeCloseTo(20, 5);

    const misnamed = await api(`/shell?projectId=${projectId}&shapeId=${potId}`, {
      method: "POST",
      body: JSON.stringify({ thickness: 2, openFaces: ["sideways"] }),
    });
    expect(misnamed.status).toBe(400);
    expect(misnamed.body.code).toBe("cad_failed");
    expect(misnamed.body.error as string).toMatch(/not a face direction/);

    // Refused first, so the next request also proves the project was left alone.
    const refused = await api(`/shell?projectId=${projectId}&shapeId=${potId}`, {
      method: "POST",
      body: JSON.stringify({ thickness: 12, openFaces: ["top"] }),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("cad_failed");

    const hollowed = await api(`/shell?projectId=${projectId}&shapeId=${potId}`, {
      method: "POST",
      body: JSON.stringify({ thickness: 2, openFaces: ["top"] }),
    });
    expect(hollowed.status).toBe(200);
    const shape = hollowed.body.shape as Record<string, any>;
    expect(shape.id).toBe(potId);
    expect(shape.kind).toBe("mesh");
    // Hollowing takes material from the inside, so the outside is unchanged.
    expect(shape.width).toBeCloseTo(20, 1);
    expect(shape.height).toBeCloseTo(20, 1);
    expect(hollowed.body.triangles as number).toBeGreaterThan(0);

    // A tray has an inside: more faces than the six it started with.
    const after = await api(`/faces?projectId=${projectId}&shapeId=${potId}`);
    expect((after.body.faces as unknown[]).length).toBeGreaterThan(6);
  });

  it("measures a round post's real radius, and the gap between two shapes", async () => {
    // Measuring is the same bundling risk as hollowing -- it reaches OCCT's
    // curve and surface analysis through `serverExternalPackages` -- and it is
    // also the one capability whose whole value is the number being exact, so
    // it is worth asking a real server for it rather than only a route handler.
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({
        shapes: [
          { kind: "cylinder", width: 15, depth: 15, height: 22, x: -23, z: 9, name: "Post" },
          { kind: "box", width: 40, depth: 25, height: 10, x: 57, z: 9, name: "Plate" },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const [post, plate] = (created.body.shapes as Array<Record<string, any>>).map((shape) => shape.id as string);

    const measured = await api(`/measurements?projectId=${projectId}&shapeId=${post}`);
    expect(measured.status).toBe(200);
    const entries = measured.body.measurements as Array<Record<string, any>>;

    // The rim at each end of a 15 mm post: a true circle of radius 7.5, whose
    // circumference is 2pi(7.5) = 47.1238898038469. A tessellated cylinder
    // would list straight edges here and no radius at all.
    const rims = entries.filter((entry) => entry.entity === "edge" && entry.geometryType === "circle");
    expect(rims).toHaveLength(2);
    for (const rim of rims) {
      expect(rim.length).toBeCloseTo(2 * Math.PI * 7.5, 5);
      expect(rim.radius).toBeCloseTo(7.5, 5);
      expect(rim.diameter).toBeCloseTo(15, 5);
      expect(rim.sweepDegrees).toBeCloseTo(360, 5);
    }
    // The wall: lateral area 2pi(7.5)(22) = 1036.7255756846319.
    const wall = entries.find((entry) => entry.entity === "face" && entry.geometryType === "cylinder");
    expect(wall).toBeDefined();
    expect(wall!.radius).toBeCloseTo(7.5, 5);
    expect(wall!.area).toBeCloseTo(2 * Math.PI * 7.5 * 22, 4);
    // A flat end is a plane, and a plane has no radius -- with the reason said.
    const end = entries.find((entry) => entry.entity === "face" && entry.geometryType === "plane");
    expect(end!.radius).toBeNull();
    expect(end!.radiusUnavailable).toBe("notCurved");

    // The post spans -30.5..-15.5 on X and the plate 37..77, so their nearest
    // walls are 37 - (-15.5) = 52.5 apart. Their centres are 80 apart, and a
    // measurement taken between centroids -- or between bounding-box centres --
    // would say 80. They overlap in Y and share a Z, so the gap is purely in X.
    const gap = await api(`/measurements?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ from: { shapeId: post }, to: { shapeId: plate } }),
    });
    expect(gap.status).toBe(200);
    expect(gap.body.distance as number).toBeCloseTo(52.5, 4);
    expect(gap.body.angleDegrees).toBeNull();
    expect(gap.body.angleUnavailable).toBe("notPlanar");

    // Two faces of the plate that bound its 10 mm thickness, by index.
    const plateFaces = ((await api(`/measurements?projectId=${projectId}&shapeId=${plate}`))
      .body.measurements as Array<Record<string, any>>)
      .filter((entry) => entry.entity === "face" && Math.abs(entry.area - 1000) < 1e-6);
    expect(plateFaces).toHaveLength(2);
    const across = await api(`/measurements?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({
        from: { shapeId: plate, entity: "face", index: plateFaces[0].index },
        to: { shapeId: plate, entity: "face", index: plateFaces[1].index },
      }),
    });
    expect(across.body.distance as number).toBeCloseTo(10, 5);
    // Opposite faces: their outward normals point away from each other.
    expect(across.body.angleDegrees as number).toBeCloseTo(180, 5);

    const refused = await api(`/measurements?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ from: { shapeId: plate, entity: "face", index: 0 }, to: { shapeId: plate, entity: "face" } }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_request");
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
