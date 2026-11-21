import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { GET as getShapes, PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { GET as listParameters, POST as createParameter } from "@/app/api/v1/parameters/route";
import { PATCH as patchConstraint } from "@/app/api/v1/sketch-constraints/route";
import { POST as groupShapes } from "@/app/api/v1/groups/route";
import { GET as getProperties } from "@/app/api/v1/properties/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { directoryProjectStore } from "@/lib/engine/projectStore";

const TOKEN = "test-token-value";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

type Json = Record<string, unknown>;
type Constraint = Json & { id: string };
type Summary = Json & { id: string; sketchProfile: { constraints: Constraint[] } };

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function call(handler: (request: Request) => Promise<Response>, url: string, init: RequestInit = {}) {
  const response = await handler(authorized(url, init));
  return { status: response.status, etag: response.headers.get("etag"), body: await response.json() as Json };
}

/** A 2 x 2 section, corner `a` fixed and both sides dimensioned, swept along a 10 mm spine. */
function sweepProfile(extra: Constraint[] = []) {
  return {
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
    constraints: [
      { id: "fix-a", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 },
      { id: "h-ab", kind: "horizontal", segmentId: "ab" },
      { id: "v-bc", kind: "vertical", segmentId: "bc" },
      { id: "h-cd", kind: "horizontal", segmentId: "cd" },
      { id: "v-da", kind: "vertical", segmentId: "da" },
      { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2 },
      { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
      ...extra,
    ],
  };
}

/** A project with `w = 3` and one constrained sweep. */
async function sweepProject(extra: Constraint[] = []) {
  const created = await call(createProject, "/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Sketch constraints" }) });
  const projectId = (created.body.project as { id: string }).id;
  expect((await call(createParameter, `/api/v1/parameters?projectId=${projectId}`, {
    method: "POST", body: JSON.stringify({ name: "w", expression: "3", dimension: "length" }),
  })).status).toBe(201);
  const shapes = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, {
    method: "POST", body: JSON.stringify({ kind: "sketchSweep", name: "Bar", profile: sweepProfile(extra) }),
  });
  expect(shapes.status, JSON.stringify(shapes.body)).toBe(201);
  return { projectId, shape: (shapes.body.shapes as Summary[])[0]! };
}

const bind = (projectId: string, shapeId: string, constraintId: string, body: Json, headers: HeadersInit = {}) =>
  call(patchConstraint, `/api/v1/sketch-constraints?projectId=${projectId}&shapeId=${encodeURIComponent(shapeId)}&constraintId=${constraintId}`, {
    method: "PATCH", body: JSON.stringify(body), headers,
  });

const patchProfile = (projectId: string, shapeId: string, body: Json) =>
  call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${encodeURIComponent(shapeId)}`, { method: "PATCH", body: JSON.stringify(body) });

async function volumeAndCentre(projectId: string, shapeId: string) {
  const read = await call(getProperties, `/api/v1/properties?projectId=${projectId}&shapeId=${shapeId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const properties = read.body.properties as { volume: number; centerOfMass: { x: number; y: number; z: number } };
  return { volume: properties.volume, centre: properties.centerOfMass };
}

const constraintIn = (shape: Summary, id: string) => shape.sketchProfile.constraints.find((constraint) => constraint.id === id)!;
const withConstraint = (shape: Summary, id: string, patch: Json) => ({
  ...shape.sketchProfile,
  constraints: shape.sketchProfile.constraints.map((constraint) => (constraint.id === id ? { ...constraint, ...patch } : constraint)),
});

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-sketch-constraints-"));
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
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

describe("/api/v1/sketch-constraints", () => {
  it("registers bindSketchConstraint as a conditional write", () => {
    const operations = API_V1_OPERATIONS.filter((operation) => operation.path === "/api/v1/sketch-constraints");
    expect(operations.map(({ method, operationId, ifMatch }) => ({ method, operationId, ifMatch }))).toEqual([
      { method: "PATCH", operationId: "bindSketchConstraint", ifMatch: true },
    ]);
  });

  it("binds a constraint, rebuilds the solid from it, reports the expression, and unbinds with null", async () => {
    const { projectId, shape } = await sweepProject();
    const original = await volumeAndCentre(projectId, shape.id);

    const bound = await bind(projectId, shape.id, "width", { expression: "w" });

    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(bound.etag).toBe(`"${bound.body.revision}"`);
    expect(bound.body.constraint).toEqual({ id: "width", kind: "distance", value: 3, expression: "w" });
    const summary = bound.body.shape as Summary;
    expect(summary.sketchConstraints).toEqual([
      { id: "width", kind: "distance", value: 3, expression: "w" },
      { id: "depth", kind: "distance", value: 2 },
    ]);
    expect(constraintIn(summary, "width")).toMatchObject({ valueMm: 3, expression: "w" });
    const solved = await volumeAndCentre(projectId, shape.id);
    expect(original.volume).toBeCloseTo(40, 2);
    expect(solved.volume).toBeCloseTo(60, 2);
    // A twin given the solved profile through its sketch source, the path a binding takes, matches.
    const twin = await sweepProject();
    const literal = { ...summary.sketchProfile, constraints: summary.sketchProfile.constraints.map(({ expression: _expression, ...rest }) => rest) };
    expect((await patchProfile(twin.projectId, twin.shape.sketchSourceId as string, { sketchProfile: literal })).status).toBe(200);
    const manual = await volumeAndCentre(twin.projectId, twin.shape.id);
    expect(solved.volume).toBeCloseTo(manual.volume, 4);
    expect(solved.centre.x).toBeCloseTo(manual.centre.x, 4);
    expect(solved.centre.y).toBeCloseTo(manual.centre.y, 4);
    expect(solved.centre.z).toBeCloseTo(manual.centre.z, 4);
    // A uniform 3 x 2 section swept 10 mm up: the centre of mass is the box centre the sweep keeps, (0, 5, 0).
    expect(summary).toMatchObject({ x: 0, z: 0, elevation: 0, width: 3, depth: 2, height: 10 });
    expect(solved.centre.x).toBeCloseTo(0, 4);
    expect(solved.centre.y).toBeCloseTo(5, 4);
    expect(solved.centre.z).toBeCloseTo(0, 4);
    expect(original.centre.y).toBeCloseTo(5, 4);

    const unbound = await bind(projectId, shape.id, "width", { expression: null });
    expect(unbound.status).toBe(200);
    expect(unbound.body.constraint).toEqual({ id: "width", kind: "distance", value: 3 });
    expect((await volumeAndCentre(projectId, shape.id)).volume).toBeCloseTo(60, 2);
  });

  it("honours If-Match and refuses malformed bodies", async () => {
    const { projectId, shape } = await sweepProject();
    const revision = (await call(listParameters, `/api/v1/parameters?projectId=${projectId}`)).body.revision as number;

    expect(await bind(projectId, shape.id, "width", { expression: "w" }, { "If-Match": `"${revision - 1}"` }))
      .toMatchObject({ status: 409, body: { code: "revision_mismatch", revision } });
    expect(constraintIn((await bind(projectId, shape.id, "width", { expression: "w" }, { "If-Match": `"${revision}"` })).body.shape as Summary, "width"))
      .toMatchObject({ expression: "w" });
    expect(await bind(projectId, shape.id, "width", {})).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(await bind(projectId, shape.id, "width", { expression: 3 })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    const tooLong = await bind(projectId, shape.id, "width", { expression: `${"1+".repeat(5000)}1` });
    expect(tooLong).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(tooLong.body.error).toMatch(/10,000 characters/);
    expect((await call(patchConstraint, `/api/v1/sketch-constraints?projectId=${projectId}&shapeId=${shape.id}`, {
      method: "PATCH", body: JSON.stringify({ expression: "w" }),
    })).status).toBe(400);
  });

  it("maps lock, out of range, unknown constraint, unbindable kind and unsolvable refusals with constraintId", async () => {
    const diagonal = { id: "diagonal", kind: "distance", pointIds: ["a", "c"], valueMm: Math.SQRT2 * 2 };
    const { projectId, shape } = await sweepProject([diagonal]);
    const store = directoryProjectStore(projectsRoot);
    const before = JSON.stringify((await store.read(projectId))!.shapes);

    expect(await bind(projectId, shape.id, "width", { expression: "-w" }))
      .toMatchObject({ status: 422, body: { code: "invalid_expression", reason: "outOfRange", shapeId: shape.id, constraintId: "width" } });
    expect(await bind(projectId, shape.id, "width", { expression: "nope" }))
      .toMatchObject({ status: 422, body: { code: "invalid_expression", reason: "invalidExpression", constraintId: "width", expressionError: { code: "unknownName" } } });
    expect(await bind(projectId, shape.id, "missing", { expression: "w" }))
      .toMatchObject({ status: 422, body: { code: "invalid_request", reason: "constraintNotFound", constraintId: "missing" } });
    expect(await bind(projectId, shape.id, "h-ab", { expression: "w" }))
      .toMatchObject({ status: 422, body: { code: "unapplicable_fields", reason: "constraintNotBindable", constraintId: "h-ab" } });
    expect(await bind(projectId, shape.id, "width", { expression: "w" }))
      .toMatchObject({ status: 422, body: { code: "geometry_failed", shapeId: shape.id, constraintIds: expect.arrayContaining(["diagonal"]) } });
    expect(await bind(projectId, "nowhere", "width", { expression: "w" })).toMatchObject({ status: 404, body: { code: "shape_not_found" } });
    expect(JSON.stringify((await store.read(projectId))!.shapes)).toBe(before);

    expect((await patchProfile(projectId, shape.id, { locked: true })).status).toBe(200);
    expect(await bind(projectId, shape.id, "depth", { expression: "w" })).toMatchObject({ status: 409, body: { code: "shape_locked", shapeId: shape.id } });
  });

  it("names a locked group that holds the sketch, so the caller knows what to unlock", async () => {
    const { projectId, shape } = await sweepProject();
    const box = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ kind: "box", x: 20 }) });
    const grouped = await call(groupShapes, `/api/v1/groups?projectId=${projectId}`, {
      method: "POST", body: JSON.stringify({ ids: [shape.id, (box.body.shapes as Summary[])[0]!.id] }),
    });
    expect(grouped.status, JSON.stringify(grouped.body)).toBe(201);
    const groupId = (grouped.body.shape as Summary).id;
    expect((await patchProfile(projectId, groupId, { locked: true })).status).toBe(200);

    // Grouping gives the child a new id; its sketchSourceId still finds it.
    expect(shape.sketchSourceId).toEqual(expect.any(String));
    const locked = await bind(projectId, shape.sketchSourceId as string, "width", { expression: "w" });
    expect(locked).toMatchObject({ status: 409, body: { code: "shape_locked", shapeId: groupId } });
    expect(locked.body.error).toContain(groupId);
  });

  it("binds a new constraint expression sent in a PATCH /shapes profile, and refuses one that disagrees with its value", async () => {
    const { projectId, shape } = await sweepProject();

    const changed = await patchProfile(projectId, shape.id, { sketchProfile: withConstraint(shape, "width", { expression: "w" }) });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(constraintIn(changed.body.shape as Summary, "width")).toMatchObject({ valueMm: 3, expression: "w" });
    expect((await volumeAndCentre(projectId, shape.id)).volume).toBeCloseTo(60, 2);

    // The whole summary sent back, its read-only sketchConstraints included, keeps the binding.
    const echoed = await patchProfile(projectId, shape.id, { ...(changed.body.shape as Summary), name: "Renamed" });
    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
    expect(constraintIn(echoed.body.shape as Summary, "width")).toMatchObject({ valueMm: 3, expression: "w" });

    const store = directoryProjectStore(projectsRoot);
    const written = JSON.stringify((await store.read(projectId))!.shapes);
    const current = echoed.body.shape as Summary;
    const contradiction = await patchProfile(projectId, shape.id, { sketchProfile: withConstraint(current, "depth", { valueMm: 5, expression: "w" }) });
    expect(contradiction).toMatchObject({ status: 400, body: { code: "invalid_request", shapeId: shape.id, constraintId: "depth" } });
    const resizeAndBind = await patchProfile(projectId, shape.id, { width: 7, sketchProfile: withConstraint(current, "depth", { expression: "w" }) });
    expect(resizeAndBind).toMatchObject({ status: 400, body: { code: "invalid_request", shapeId: shape.id, field: "width", constraintId: "depth" } });
    const edited = await patchProfile(projectId, shape.id, {
      sketchConstraints: (current.sketchConstraints as Constraint[]).map((entry) => (entry.id === "depth" ? { ...entry, value: 9 } : entry)),
    });
    expect(edited).toMatchObject({ status: 400, body: { code: "invalid_request", shapeId: shape.id, field: "sketchConstraints" } });
    expect(JSON.stringify((await store.read(projectId))!.shapes)).toBe(written);

    expect((await patchProfile(projectId, shape.id, { locked: true })).status).toBe(200);
    const locked = await patchProfile(projectId, shape.id, { sketchProfile: withConstraint(current, "depth", { expression: "unknown" }) });
    expect(locked).toMatchObject({ status: 409, body: { code: "shape_locked" } });
  });

  it("rebuilds from an edited profile sent in a whole summary, without its echoed size undoing the edit", async () => {
    // Sweep: bind the width constraint, and separately widen it by hand. Both send width: 2 back.
    for (const edit of ["bind", "literal"] as const) {
      const { projectId, shape } = await sweepProject();
      const summary = (await call(getShapes, `/api/v1/shapes?projectId=${projectId}`)).body.shapes as Summary[];
      const read = summary[0]!;
      const sketchProfile = edit === "bind"
        ? withConstraint(read, "width", { expression: "w" })
        : {
          ...withConstraint(read, "width", { valueMm: 3 }),
          points: (read.sketchProfile as unknown as { points: Json[] }).points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: 2 } : point)),
        };
      const changed = await patchProfile(projectId, shape.id, { ...read, sketchProfile });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body.shape).toMatchObject({ width: 3, depth: 2, height: 10 });
      const solid = await volumeAndCentre(projectId, shape.id);
      expect(solid.volume, edit).toBeCloseTo(60, 2);
      // The echoed x, z and elevation keep the 3 x 2 section, swept 10 mm up, centred where it was read: (0, 5, 0).
      expect(solid.centre.x, edit).toBeCloseTo(0, 4);
      expect(solid.centre.y, edit).toBeCloseTo(5, 4);
      expect(solid.centre.z, edit).toBeCloseTo(0, 4);
    }

    // Extrusion: the same two edits on a 2 x 2 x 3 sketch extrusion, whose summary carries no profile.
    for (const edit of ["bind", "literal"] as const) {
      const { projectId } = await sweepProject();
      const store = directoryProjectStore(projectsRoot);
      const boxes = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, {
        method: "POST", body: JSON.stringify({ kind: "box", width: 2, depth: 2, height: 3, x: 0, z: 0 }),
      });
      const boxId = (boxes.body.shapes as Summary[])[0]!.id;
      const document = (await store.read(projectId))!;
      const flat = { ...sweepProfile(), points: sweepProfile().points.filter((point) => point.sweepRole === "section").map(({ sweepRole: _role, ...point }) => point) };
      flat.segments = flat.segments.filter((segment) => segment.id !== "spine");
      await store.write(projectId, document, document.shapes.filter((stored) => stored.id === boxId).map((stored) => ({
        ...stored,
        sketchOperation: "extrude" as const,
        sketchProfile: flat as never,
        sketchSourceId: `sketch/${boxId}`,
        cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
      })));
      const read = ((await call(getShapes, `/api/v1/shapes?projectId=${projectId}`)).body.shapes as Summary[])[0]!;
      expect(read).toMatchObject({ id: boxId, width: 2 });
      const profile = { ...flat, constraints: flat.constraints.map((constraint) => (constraint.id === "width"
        ? (edit === "bind" ? { ...constraint, expression: "w * 2" } : { ...constraint, valueMm: 4 })
        : constraint)) };
      if (edit === "literal") profile.points = profile.points.map((point) => (point.id === "b" || point.id === "c" ? { ...point, x: 3 } : point));
      const changed = await patchProfile(projectId, boxId, { ...read, sketchProfile: profile });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const wide = edit === "bind" ? 6 : 4;
      expect(changed.body.shape, edit).toMatchObject({ width: wide, depth: 2, height: 3 });
      const solid = await volumeAndCentre(projectId, boxId);
      expect(solid.volume, edit).toBeCloseTo(wide * 2 * 3, 2);
      // The echoed x keeps the centre at 0. A profile-only PATCH holds corner `a` instead (engine tests).
      expect(solid.centre.x, edit).toBeCloseTo(0, 4);
      expect(solid.centre.y, edit).toBeCloseTo(1.5, 4);
      expect(solid.centre.z, edit).toBeCloseTo(0, 4);
    }
  });

  it("keeps a stale constraint binding when the whole summary is sent back", async () => {
    const { projectId, shape } = await sweepProject();
    const store = directoryProjectStore(projectsRoot);
    const document = (await store.read(projectId))!;
    const [stored] = document.shapes;
    await store.write(projectId, document, [{
      ...stored!,
      sketchProfile: {
        ...stored!.sketchProfile!,
        constraints: stored!.sketchProfile!.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, expression: "gone" } : constraint)),
      },
    }]);
    const listed = await call(getShapes, `/api/v1/shapes?projectId=${projectId}`);
    const summary = (listed.body.shapes as Summary[])[0]!;
    expect(summary.sketchConstraints).toEqual([{ id: "width", kind: "distance", value: 2, expression: "gone" }, { id: "depth", kind: "distance", value: 2 }]);

    const echoed = await patchProfile(projectId, shape.id, { ...summary, name: "Renamed" });

    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
    expect(constraintIn(echoed.body.shape as Summary, "width")).toMatchObject({ valueMm: 2, expression: "gone" });
    expect((await volumeAndCentre(projectId, shape.id)).volume).toBeCloseTo(40, 2);
  });

  it("lists stale constraint bindings next to the shape binding issues", async () => {
    const { projectId, shape } = await sweepProject();
    const store = directoryProjectStore(projectsRoot);
    const document = (await store.read(projectId))!;
    const [stored] = document.shapes;
    await store.write(projectId, document, [{
      ...stored!,
      sketchProfile: {
        ...stored!.sketchProfile!,
        constraints: stored!.sketchProfile!.constraints!.map((constraint) => (constraint.id === "width" ? { ...constraint, expression: "gone" } : constraint)),
      },
    }]);

    const listed = await call(listParameters, `/api/v1/parameters?projectId=${projectId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.constraintBindingIssues).toEqual([
      expect.objectContaining({ shapeId: shape.id, constraintId: "width", code: "invalidExpression" }),
    ]);
  });
});
