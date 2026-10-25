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
let serverOutput = "";

function captureServerOutput(chunk: Buffer | string) {
  const text = String(chunk)
    .replaceAll(TOKEN, "[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[redacted]");
  serverOutput = `${serverOutput}${text}`.slice(-8_192);
}

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
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverOutput = "";
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);

  const deadline = Date.now() + 110_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`the dev server exited with ${server.exitCode}`);
    try {
      // Ask for something that exercises the route, not just the socket: a dev
      // server answers before it has compiled anything.
      // A server that accepts the connection but stalls must not keep this
      // readiness loop blocked past its wall-clock deadline.
      const probe = await api("/projects", { signal: AbortSignal.timeout(2_000) });
      if (probe.status === 200) break;
    } catch {
      // Connection refused while it boots.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the dev server never answered /api/v1/projects\n` +
          `Last Next server output (up to 8192 characters):\n${serverOutput || "(no output)"}`,
      );
    }
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
      body: JSON.stringify({ shapes: [{ kind: "thread", size: "M8", length: 16, name: "Bolt" }] }),
    });
    expect(created.status).toBe(201);
    const [shape] = created.body.shapes as Array<Record<string, any>>;
    shapeId = shape.id;
    expect(shape.requestKind).toBe("revolve");
    expect(shape.revolve.pitch).toBeCloseTo(1.25, 5);
    // An M8 thread is 8mm across, whatever the mesh tessellation rounds to.
    expect(shape.width).toBeCloseTo(8, 1);
  });

  it("groups and ungroups through the running HTTP API with contract-shaped replies and errors", async () => {
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [
        { kind: "box", name: "Group A", width: 10, depth: 10, height: 10 },
        { kind: "box", name: "Group B", width: 10, depth: 10, height: 10, x: 15 },
      ] }),
    });
    expect(created.status).toBe(201);
    const ids = (created.body.shapes as Array<Record<string, string>>).map(({ id }) => id);

    const grouped = await api(`/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids, clientTag: "e2e-batch" }) });
    expect(grouped.status).toBe(201);
    expect(grouped.body).toMatchObject({ revision: expect.any(Number), shape: { id: expect.any(String), groupedCount: 2 } });
    const groupId = (grouped.body.shape as Record<string, string>).id;

    const ungrouped = await api(`/groups?projectId=${projectId}&shapeId=${groupId}`, { method: "DELETE" });
    expect(ungrouped.status).toBe(200);
    expect(ungrouped.body).toMatchObject({ revision: expect.any(Number), shapes: expect.arrayContaining([expect.objectContaining({ name: "Group A" }), expect.objectContaining({ name: "Group B" })]) });

    const ungroupedShapes = ungrouped.body.shapes as Array<Record<string, string>>;
    const scalar = await api(`/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: ungroupedShapes[0].id }) });
    expect(scalar.status).toBe(400);
    expect(scalar.body.code).toBe("geometry_failed");

    const invalid = await api(`/groups?projectId=${projectId}&shapeId=${shapeId}`, { method: "DELETE" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("invalid_request");
  });

  it("splits a group through the running HTTP API with contract-shaped replies and errors", async () => {
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [
        { kind: "box", name: "Part A", width: 8, depth: 8, height: 8 },
        { kind: "box", name: "Part B", width: 8, depth: 8, height: 8, x: 12 },
      ] }),
    });
    expect(created.status).toBe(201);
    const ids = (created.body.shapes as Array<Record<string, string>>).map(({ id }) => id);
    const grouped = await api(`/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids }) });
    expect(grouped.status).toBe(201);
    const groupId = (grouped.body.shape as Record<string, string>).id;

    const split = await api(`/parts?projectId=${encodeURIComponent(` ${projectId} `)}&shapeId=${encodeURIComponent(` ${groupId} `)}`, { method: "POST" });
    expect(split.status).toBe(200);
    expect(split.body).toMatchObject({ revision: expect.any(Number), shapes: expect.arrayContaining([expect.objectContaining({ name: "Part A" }), expect.objectContaining({ name: "Part B" })]) });

    const plain = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "box", name: "Plain body", width: 8, depth: 8, height: 8 }] }),
    });
    expect(plain.status).toBe(201);
    const plainId = (plain.body.shapes as Array<Record<string, string>>)[0].id;
    const notGroup = await api(`/parts?projectId=${projectId}&shapeId=${plainId}`, { method: "POST" });
    expect(notGroup.status).toBe(422);
    expect(notGroup.body.code).toBe("invalid_request");
  });

  it("builds an explicitly selected fine-pitch thread", async () => {
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "thread", size: "M8x1", length: 8, name: "Fine bolt" }] }),
    });
    expect(created.status).toBe(201);
    const [shape] = created.body.shapes as Array<Record<string, any>>;
    expect(shape.name).toBe("Fine bolt");
    expect(shape.revolve.pitch).toBe(1);
  });

  it("builds a sketch sweep from a section and an orthogonal spine through the public API", async () => {
    const profile = {
      points: [
        { id: "s0", x: -1, z: -1, sweepRole: "section" },
        { id: "s1", x: 1, z: -1, sweepRole: "section" },
        { id: "s2", x: 1, z: 1, sweepRole: "section" },
        { id: "s3", x: -1, z: 1, sweepRole: "section" },
        { id: "p0", x: 0, z: 0, sweepRole: "spine" },
        { id: "p1", x: 10, z: 0, sweepRole: "spine" },
      ],
      segments: [
        { id: "s01", startId: "s0", endId: "s1" },
        { id: "s12", startId: "s1", endId: "s2" },
        { id: "s23", startId: "s2", endId: "s3" },
        { id: "s30", startId: "s3", endId: "s0" },
        { id: "p01", startId: "p0", endId: "p1" },
      ],
    };
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ kind: "sketchSweep", name: "API sweep", profile }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [shape] = created.body.shapes as Array<Record<string, any>>;
    expect(shape).toMatchObject({ kind: "mesh", requestKind: "sketchSweep", sketchOperation: "sweep", sketchSourceId: `sketch/${shape.id}`, name: "API sweep", sketchProfile: profile });
    expect(shape.width).toBeGreaterThan(0);
    expect(shape.height).toBeGreaterThan(0);
    expect(shape.depth).toBeGreaterThan(0);
    const listed = await api(`/shapes?projectId=${projectId}`);
    expect((listed.body.shapes as Array<Record<string, any>>).find((candidate) => candidate.id === shape.id)).toMatchObject({ sketchSourceId: `sketch/${shape.id}`, sketchProfile: profile });
  });

  it("rejects malformed sketch sweep topology before invoking the CAD kernel", async () => {
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ kind: "sketchSweep", profile: { points: [], segments: [] } }),
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe("invalid_request");
    expect(created.body.error).toContain("between 5 and 5000 points");
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

  it("rebuilds a sketch sweep when PATCH targets its persisted source sketch", async () => {
    const profile = {
      points: [
        { id: "a", x: -1, z: -1, sweepRole: "section" }, { id: "b", x: 1, z: -1, sweepRole: "section" },
        { id: "c", x: 1, z: 1, sweepRole: "section" }, { id: "d", x: -1, z: 1, sweepRole: "section" },
        { id: "p0", x: 0, z: 0, sweepRole: "spine" }, { id: "p1", x: 10, z: 0, sweepRole: "spine" },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
        { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        { id: "spine", startId: "p0", endId: "p1" },
      ],
    };
    const created = await api(`/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ kind: "sketchSweep", name: "Source edit", profile }),
    });
    expect(created.status).toBe(201);
    const [sweep] = created.body.shapes as Array<Record<string, any>>;
    const editedProfile = {
      ...profile,
      points: profile.points.map((point) => point.sweepRole === "section" ? { ...point, x: point.x * 2 } : point),
    };

    const patched = await api(`/shapes?projectId=${projectId}&shapeId=${encodeURIComponent(sweep.sketchSourceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ sketchProfile: editedProfile }),
    });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const rebuilt = patched.body.shape as Record<string, any>;
    expect(rebuilt).toMatchObject({ id: sweep.id, sketchSourceId: sweep.sketchSourceId, sketchProfile: editedProfile });
    expect(rebuilt.width).toBeGreaterThan(sweep.width);
    const listed = await api(`/shapes?projectId=${projectId}`);
    expect((listed.body.shapes as Array<Record<string, any>>).find((shape) => shape.id === sweep.id)?.sketchProfile).toEqual(editedProfile);
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

  it("draws a round post as a circle, not a polygon", async () => {
    // The SVG export runs OCCT's hidden-line removal through the same
    // `serverExternalPackages` path as measuring does, and its whole point is
    // that a projected curve is a curve: the old client-side export flattened
    // a triangle mesh, so a cylinder's outline was whatever polygon the mesher
    // had chosen.
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Drawing" }) });
    const drawingProject = ((created.body.project as Record<string, string>) ?? {}).id;
    const post = await api(`/shapes?projectId=${drawingProject}`, {
      method: "POST",
      body: JSON.stringify({ shapes: [{ kind: "cylinder", width: 30, depth: 30, height: 12, name: "Post" }] }),
    });
    expect(post.status).toBe(201);

    const exported = await api(`/exports?projectId=${drawingProject}`, {
      method: "POST",
      body: JSON.stringify({ format: "svg", view: "top" }),
    });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: "svg", mimeType: "image/svg+xml", filename: "Drawing.svg", shapeCount: 1 });
    const svg = Buffer.from(exported.body.base64 as string, "base64").toString("utf8");

    const outline = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#111111"/g)]
      .flatMap((match) => [...match[1].matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((point) => [Number(point[1]), Number(point[2])]));
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const radii = outline.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1]));
    const outer = Math.max(...radii);
    const rim = radii.filter((radius) => radius > outer * 0.5);
    expect(rim.length).toBeGreaterThanOrEqual(24);
    expect((outer - Math.min(...rim)) / outer).toBeLessThan(0.01);

    const grid = await api(`/exports?projectId=${drawingProject}`, { method: "POST", body: JSON.stringify({ format: "svg" }) });
    expect(grid.status).toBe(200);
    const sheet = Buffer.from(grid.body.base64 as string, "base64").toString("utf8");
    for (const label of ["Front", "Top", "Right", "Iso"]) expect(sheet).toContain(`>${label}</text>`);
    expect(sheet).toContain("30 × 30 × 12 (X×Y×Z)");

    const section = await api(`/exports?projectId=${drawingProject}`, {
      method: "POST",
      body: JSON.stringify({ format: "svg", section: { plane: "xy", offset: 6 } }),
    });
    expect(section.status).toBe(200);
    const sectionSvg = Buffer.from(section.body.base64 as string, "base64").toString("utf8");
    expect(sectionSvg).toContain('data-plane="xy"');
    expect(sectionSvg).toContain('data-offset="6"');
    expect(sectionSvg).toContain("<path");
  });

  it("keeps the editor's kernel SVG and section DXF byte-for-byte in step with REST", async () => {
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Editor parity" }) });
    const drawingProject = ((created.body.project as Record<string, string>) ?? {}).id;
    await api(`/shapes?projectId=${drawingProject}`, { method: "POST", body: JSON.stringify({ shapes: [{ kind: "box", name: "Plate", width: 20, depth: 12, height: 8 }] }) });
    const detail = await api(`/projects?projectId=${drawingProject}`);
    const shapes = ((detail.body.project as Record<string, unknown>).shapes as Array<Record<string, unknown>>);

    const restSvg = await api(`/exports?projectId=${drawingProject}`, { method: "POST", body: JSON.stringify({ format: "svg", view: "top" }) });
    const editorSvg = await fetch(`${origin}/api/editor/cad`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "export", projectId: drawingProject, format: "svg", name: "Editor parity", view: "top", shapes }) });
    expect(restSvg.status).toBe(200);
    expect(editorSvg.status).toBe(200);
    expect(Buffer.from(await editorSvg.arrayBuffer()).toString("utf8")).toBe(Buffer.from(restSvg.body.base64 as string, "base64").toString("utf8"));

    const section = { plane: "xy", offset: 4 };
    const restDxf = await api(`/exports?projectId=${drawingProject}`, { method: "POST", body: JSON.stringify({ format: "dxf", section }) });
    const editorDxf = await fetch(`${origin}/api/editor/cad`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "export", projectId: drawingProject, format: "dxf", name: "Editor parity", section, shapes }) });
    expect(restDxf.status).toBe(200);
    expect(editorDxf.status).toBe(200);
    expect(Buffer.from(await editorDxf.arrayBuffer()).toString("utf8")).toBe(Buffer.from(restDxf.body.base64 as string, "base64").toString("utf8"));
  });

  it("repeats, aligns and distributes a row over HTTP", async () => {
    // Its own project: this walks the three arranging routes in the order a
    // script would -- make the copies, line them up, space them out -- and the
    // shared one above is a thread, which has no row in it.
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Bolt rail" }) });
    const rail = ((created.body.project as Record<string, string>) ?? {}).id;

    const boss = await api(`/shapes?projectId=${rail}`, {
      method: "POST",
      body: JSON.stringify({ kind: "cylinder", width: 9, depth: 9, height: 6, x: 11, z: -4, name: "Boss" }),
    });
    const bossId = (boss.body.shapes as Array<Record<string, string>>)[0].id;

    // Four at a 25 mm pitch, which is centre to centre: 11, 36, 61, 86.
    const repeated = await api(`/patterns?projectId=${rail}`, {
      method: "POST",
      body: JSON.stringify({ ids: [bossId], kind: "linear", count: 4, stepX: 25 }),
    });
    expect(repeated.status).toBe(201);
    expect(repeated.body.created).toBe(3);
    const copies = (repeated.body.shapes as Array<Record<string, any>>).map((shape) => shape.id);
    expect((repeated.body.shapes as Array<Record<string, any>>).map((shape) => shape.x)).toEqual([36, 61, 86]);

    // A taller shape off the row, to align the bosses' tops to.
    const post = await api(`/shapes?projectId=${rail}`, {
      method: "POST",
      body: JSON.stringify({ kind: "box", width: 8, depth: 8, height: 20, x: 11, z: 40, elevation: 3 }),
    });
    const postId = (post.body.shapes as Array<Record<string, string>>)[0].id;

    const aligned = await api(`/align?projectId=${rail}`, {
      method: "POST",
      body: JSON.stringify({ ids: [bossId, ...copies, postId], axis: "y", target: "max", anchorId: postId }),
    });
    expect(aligned.status).toBe(200);
    expect(aligned.body.anchorId).toBe(postId);
    // The post's top is 3 + 20 = 23, so a 6 mm boss sits at 17 to match it.
    expect(aligned.body.moved).toBe(4);
    const tops = (aligned.body.shapes as Array<Record<string, any>>).map((shape) => shape.elevation + shape.height);
    expect(new Set(tops)).toEqual(new Set([23]));

    // And then re-spaced by centres across the span the outer two define.
    const spread = await api(`/distribute?projectId=${rail}`, {
      method: "POST",
      body: JSON.stringify({ ids: [bossId, ...copies], axis: "x", spacing: "centers" }),
    });
    expect(spread.status).toBe(200);
    // They were already at an even 25 mm pitch, so there is nothing to do --
    // and that is reported rather than written.
    expect(spread.body.moved).toBe(0);
    expect(spread.body.axis).toBe("x");
  });

  it("imports an STL over HTTP and keeps the file with the project", async () => {
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Imported plate" }) });
    const projectForImport = ((created.body.project as Record<string, string>) ?? {}).id;

    // A unit tetrahedron in the slicer's Z-up convention, written as ASCII STL.
    // Four facets is the smallest closed solid there is, and its own three side
    // lengths differ so a swapped axis cannot hide.
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
    const stl = `solid wedge\n${facets}\nendsolid wedge`;

    const imported = await api(`/imports?projectId=${projectForImport}`, {
      method: "POST",
      body: JSON.stringify({ fileName: "wedge.stl", data: Buffer.from(stl, "utf8").toString("base64") }),
    });
    expect(imported.status).toBe(201);
    expect(imported.body.triangles).toBe(4);
    // Z-up: the file's Z is SketchForge's height, so 30 x 18 x 9 reads as 30
    // wide, 18 deep and 9 high. Through a real server rather than in-process,
    // because the importers pull `three` into the route bundle and that is the
    // kind of thing only a bundled server gets wrong.
    expect(imported.body.shape).toMatchObject({ kind: "mesh", name: "wedge", width: 30, depth: 18, height: 9 });

    const read = await api(`/projects?projectId=${projectForImport}`);
    expect((read.body.project as Record<string, unknown[]>).shapes).toHaveLength(1);

    const refused = await api(`/imports?projectId=${projectForImport}`, {
      method: "POST",
      body: JSON.stringify({ fileName: "wedge.3mf", data: Buffer.from(stl, "utf8").toString("base64") }),
    });
    expect(refused.status).toBe(415);
    expect(refused.body.code).toBe("unsupported_format");
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
