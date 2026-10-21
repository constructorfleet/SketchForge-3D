import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { GET as getShapes, PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "test-token-value";

/**
 * The round trip the API documents: read a shape, change a number, send it back.
 *
 * Every case here failed silently before. A shape read back carried none of its
 * kind's parameters, a thread read back as an anonymous mesh, and a `PATCH`
 * naming any of them answered 200 having changed nothing -- which is the one
 * answer a script cannot tell from success.
 */

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

type Summary = Record<string, unknown> & { id: string; kind: string };

async function makeProject() {
  const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Round trip" }) }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function addShape(projectId: string, shape: Record<string, unknown>) {
  const response = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify(shape) }));
  const payload = await response.json() as { shapes?: Summary[]; error?: string };
  expect(payload.error, payload.error).toBeUndefined();
  return payload.shapes![0];
}

async function readShape(projectId: string, shapeId: string) {
  const response = await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`));
  const payload = await response.json() as { shapes: Summary[] };
  return payload.shapes.find((shape) => shape.id === shapeId)!;
}

async function patch(projectId: string, shapeId: string, body: Record<string, unknown>) {
  const response = await patchShape(
    authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify(body) }),
  );
  return { status: response.status, payload: await response.json() as { shape?: Summary; error?: string; code?: string; fields?: string[] } };
}

describe("REST API shape round trip", () => {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-roundtrip-"));
    process.env[SERVER_PROJECTS_ENV] = projectsRoot;
    process.env[API_TOKEN_ENV] = TOKEN;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
    else process.env[SERVER_PROJECTS_ENV] = previousRoot;
    if (previousToken === undefined) delete process.env[API_TOKEN_ENV];
    else process.env[API_TOKEN_ENV] = previousToken;
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });

  it("reports the parameters each kind was built from", async () => {
    const projectId = await makeProject();

    const cone = await addShape(projectId, { kind: "cone", width: 20, sides: 12, topRadius: 3, baseRadius: 9 });
    expect(cone).toMatchObject({ sides: 12, topRadius: 3, baseRadius: 9 });

    const tube = await addShape(projectId, { kind: "tube", bevel: 2.5 });
    expect(tube.bevel).toBe(2.5);

    const gear = await addShape(projectId, { kind: "gear", teeth: 17, toothSize: 1.5, centerHoleSize: 4, gearType: "helical", helixAngle: 20 });
    expect(gear).toMatchObject({ teeth: 17, toothSize: 1.5, centerHoleSize: 4, gearType: "helical", helixAngle: 20 });

    const text = await addShape(projectId, { kind: "text", text: "HELLO", font: "Multilanguage", bevel: 1, segments: 4 });
    expect(text).toMatchObject({ text: "HELLO", font: "Multilanguage", bevel: 1, segments: 4 });

    const loft = await addShape(projectId, { kind: "loft", loftTopShape: "Pentagon", loftTopWidth: 10, loftLayers: 5 });
    expect(loft).toMatchObject({ loftTopShape: "Pentagon", loftTopWidth: 10, loftLayers: 5 });

    const sphere = await addShape(projectId, { kind: "sphere", steps: 12 });
    expect(sphere.steps).toBe(12);
  });

  it("says which kind would build the shape again, when one would", async () => {
    const projectId = await makeProject();

    const cube = await addShape(projectId, { kind: "cube", size: 10 });
    expect(cube.kind).toBe("box");
    expect(cube.requestKind).toBe("box");

    const thread = await addShape(projectId, { kind: "thread", size: "M8", turns: 2 });
    expect(thread.kind).toBe("mesh");
    expect(thread.requestKind).toBe("revolve");
    expect(thread.sketchOperation).toBe("revolve");
  });

  it("reports a sweep's stable source sketch identity", async () => {
    const projectId = await makeProject();
    const sweep = await addShape(projectId, {
      kind: "sketchSweep",
      profile: {
        points: [
          { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
          { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
          { id: "p0", x: 0, z: 0 }, { id: "p1", x: 10, z: 0 },
        ],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          { id: "spine", startId: "p0", endId: "p1" },
        ],
      },
    });

    expect(sweep.sketchSourceId).toBe(`sketch/${sweep.id}`);
    expect((await readShape(projectId, sweep.id)).sketchSourceId).toBe(`sketch/${sweep.id}`);
    const changed = await patch(projectId, sweep.id, { sketchSourceId: "sketch/replaced" });
    expect(changed.status).toBe(200);
    expect(changed.payload.shape?.sketchSourceId).toBe(`sketch/${sweep.id}`);
  });

  it("rebuilds a sketch sweep from an edited profile and preserves its identities and placement", async () => {
    const projectId = await makeProject();
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
    const sweep = await addShape(projectId, { kind: "sketchSweep", name: "Edited duct", profile, x: 12, z: -4, elevation: 7 });
    const widerProfile = {
      ...profile,
      points: profile.points.map((point) => point.sweepRole === "section" ? { ...point, x: point.x * 2 } : point),
    };

    const changed = await patch(projectId, sweep.id, { sketchProfile: widerProfile });

    expect(changed.status, JSON.stringify(changed.payload)).toBe(200);
    expect(changed.payload.shape).toMatchObject({
      id: sweep.id, sketchSourceId: sweep.sketchSourceId, sketchOperation: "sweep", sketchProfile: widerProfile,
      name: "Edited duct", x: 12, z: -4, elevation: 7,
    });
    expect(changed.payload.shape!.width as number).toBeGreaterThan(sweep.width as number);
    expect((await readShape(projectId, sweep.id)).sketchProfile).toEqual(widerProfile);
  });

  it("validates replacement sweep profiles and refuses them on other shapes", async () => {
    const projectId = await makeProject();
    const box = await addShape(projectId, { kind: "box" });
    const refused = await patch(projectId, box.id, { sketchProfile: { points: [], segments: [] } });
    expect(refused.status).toBe(422);
    expect(refused.payload).toMatchObject({ code: "unapplicable_fields", fields: ["sketchProfile"] });

    const sweep = await addShape(projectId, {
      kind: "sketchSweep",
      profile: {
        points: [
          { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 }, { id: "c", x: 1, z: 1 },
          { id: "d", x: -1, z: 1 }, { id: "p0", x: 0, z: 0 }, { id: "p1", x: 10, z: 0 },
        ],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          { id: "spine", startId: "p0", endId: "p1" },
        ],
      },
    });
    const invalid = await patch(projectId, sweep.id, { sketchProfile: { points: [], segments: [] } });
    expect(invalid.status).toBe(400);
    expect(invalid.payload.code).toBe("invalid_request");
    expect((await readShape(projectId, sweep.id)).sketchProfile).toEqual(sweep.sketchProfile);
  });

  it("reports a thread's sweep and the outline it ran round", async () => {
    const projectId = await makeProject();
    const thread = await addShape(projectId, { kind: "thread", size: "M8", turns: 3 });

    expect(thread.revolve).toMatchObject({ pitch: 1.25, turns: 3 });
    expect((thread.revolve as { coreRadius: number }).coreRadius).toBeGreaterThan(0);
    const profile = thread.profile as number[][];
    expect(profile).toHaveLength(3);
    // Distances come back on the side a request writes them, not the side the
    // revolve stores them on.
    expect(profile.every(([distance]) => distance > 0)).toBe(true);
  });

  it("applies a parameter the shape's kind is built from", async () => {
    const projectId = await makeProject();
    const cylinder = await addShape(projectId, { kind: "cylinder", width: 10, sides: 96 });

    const changed = await patch(projectId, cylinder.id, { sides: 6 });
    expect(changed.status).toBe(200);
    expect(changed.payload.shape!.sides).toBe(6);
    expect((await readShape(projectId, cylinder.id)).sides).toBe(6);
  });

  it("refuses a parameter the shape's kind has no use for, and names it", async () => {
    const projectId = await makeProject();
    const box = await addShape(projectId, { kind: "box", width: 10, height: 12 });

    const refused = await patch(projectId, box.id, { sides: 6, height: 40 });
    expect(refused.status).toBe(422);
    expect(refused.payload.code).toBe("unapplicable_fields");
    expect(refused.payload.fields).toEqual(["sides"]);
    // Refused outright rather than applied in part: the height did not move.
    expect((await readShape(projectId, box.id)).height).toBe(12);
  });

  it("refuses a field it has never heard of rather than dropping it", async () => {
    const projectId = await makeProject();
    const box = await addShape(projectId, { kind: "box" });

    const refused = await patch(projectId, box.id, { sids: 6 });
    expect(refused.status).toBe(422);
    expect(refused.payload.fields).toEqual(["sids"]);
  });

  it("rebuilds a thread's geometry when its pitch changes", async () => {
    const projectId = await makeProject();
    const thread = await addShape(projectId, { kind: "thread", size: "M8", turns: 4 });
    const beforeHeight = thread.height as number;

    const changed = await patch(projectId, thread.id, { pitch: 2 });
    expect(changed.status).toBe(200);
    expect((changed.payload.shape!.revolve as { pitch: number }).pitch).toBe(2);
    // Four turns at a coarser pitch is a taller bolt, so the mesh really was
    // swept again rather than the number being stored beside the old geometry.
    expect(changed.payload.shape!.height as number).toBeGreaterThan(beforeHeight);

    const reread = await readShape(projectId, thread.id);
    expect((reread.revolve as { pitch: number }).pitch).toBe(2);
    expect(reread.requestKind).toBe("revolve");
  });

  it("keeps a revolve's identity and placement across a rebuild", async () => {
    const projectId = await makeProject();
    const thread = await addShape(projectId, { kind: "thread", size: "M6", turns: 3, x: 12, z: -4, name: "Stud" });

    const changed = await patch(projectId, thread.id, { turns: 5 });
    expect(changed.payload.shape).toMatchObject({ id: thread.id, sketchSourceId: thread.sketchSourceId, name: "Stud", x: 12, z: -4 });
  });

  it("refuses a sweep setting on a shape that has no sweep", async () => {
    const projectId = await makeProject();
    const box = await addShape(projectId, { kind: "box" });

    const refused = await patch(projectId, box.id, { pitch: 2 });
    expect(refused.status).toBe(422);
    expect(refused.payload.code).toBe("unapplicable_fields");
    expect(refused.payload.fields).toEqual(["pitch"]);
  });

  it("takes its own summary back unchanged", async () => {
    const projectId = await makeProject();
    const gear = await addShape(projectId, { kind: "gear", teeth: 17, toothSize: 1.5, helixAngle: 15 });

    const changed = await patch(projectId, gear.id, gear);
    expect(changed.status).toBe(200);
    expect(changed.payload.shape).toEqual(gear);
  });

  it("takes a thread's own summary back unchanged", async () => {
    const projectId = await makeProject();
    const thread = await addShape(projectId, { kind: "thread", size: "M5", turns: 2 });

    const changed = await patch(projectId, thread.id, thread);
    expect(changed.status).toBe(200);
    expect(changed.payload.shape!.revolve).toEqual(thread.revolve);
    expect(changed.payload.shape!.height).toBeCloseTo(thread.height as number, 4);
  });

  /**
   * One status code covers several unrelated refusals, which is why there is a
   * code beside it: a client cannot decide whether to retry from `409` alone.
   */
  describe("error codes", () => {
    it("tells a missing project from a missing shape from a disabled API", async () => {
      const projectId = await makeProject();
      const box = await addShape(projectId, { kind: "box" });

      const noProject = await patch("project-nowhere", box.id, { x: 1 });
      expect(noProject.status).toBe(404);
      expect(noProject.payload.code).toBe("project_not_found");

      const noShape = await patch(projectId, "shape-nowhere", { x: 1 });
      expect(noShape.status).toBe(404);
      expect(noShape.payload.code).toBe("shape_not_found");

      delete process.env[API_TOKEN_ENV];
      const disabled = await getShapes(new Request(`http://localhost/api/v1/shapes?projectId=${projectId}`));
      expect(disabled.status).toBe(404);
      expect(await disabled.json()).toMatchObject({ code: "api_disabled" });
    });

    it("tells a locked shape from a busy project", async () => {
      const projectId = await makeProject();
      const box = await addShape(projectId, { kind: "box" });
      await patch(projectId, box.id, { locked: true });

      const locked = await patch(projectId, box.id, { x: 5 });
      expect(locked.status).toBe(409);
      expect(locked.payload.code).toBe("shape_locked");
    });
  });
});
