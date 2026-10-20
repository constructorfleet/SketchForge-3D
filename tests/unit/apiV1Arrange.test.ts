import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as alignShapesRoute } from "@/app/api/v1/align/route";
import { POST as distributeShapesRoute } from "@/app/api/v1/distribute/route";
import { POST as patternShapesRoute } from "@/app/api/v1/patterns/route";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import type { WorkplaneShape } from "@/types/sketchforge";

const TOKEN = "test-token-value";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-arrange-"));
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

function authorized(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeProject() {
  const response = await createProject(authorized("/api/v1/projects", { name: "Arranged" }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function addShapes(projectId: string, shapes: Record<string, unknown>[]) {
  const response = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, { shapes }));
  const payload = await response.json() as { shapes?: Array<{ id: string }>; error?: string };
  if (!payload.shapes) throw new Error(`shape creation failed: ${payload.error}`);
  return payload.shapes.map((shape) => shape.id);
}

async function storedShapes(projectId: string) {
  const document = await readProjectDocument(projectsRoot, projectId);
  if (!document) throw new Error("project missing");
  return document.shapes;
}

/** A stored shape by id, so an assertion names what it is looking at. */
async function stored(projectId: string, id: string) {
  const shape = (await storedShapes(projectId)).find((candidate) => candidate.id === id);
  if (!shape) throw new Error(`no shape ${id}`);
  return shape;
}

/**
 * Three boxes of three different sizes, at three different places, none of them
 * centred on the origin and none of them square.
 *
 * Every number here is load-bearing. Equal widths would make `gaps` and
 * `centers` give the same answer; a span centred on zero would make a shift
 * computed from the wrong edge land in the right place; and a square footprint
 * would let the X and Z axes be confused for each other. The three heights and
 * elevations differ so that a `y` alignment has something to say as well.
 */
async function row() {
  const projectId = await makeProject();
  const [wide, narrow, tall] = await addShapes(projectId, [
    { kind: "box", width: 20, depth: 14, height: 10, x: 0, z: 3, elevation: 0, name: "Wide" },
    { kind: "box", width: 6, depth: 9, height: 25, x: 25, z: -4, elevation: 7, name: "Narrow" },
    { kind: "box", width: 30, depth: 11, height: 4, x: 100, z: 8, elevation: 31, name: "Tall" },
  ]);
  return { projectId, wide, narrow, tall };
}

function align(projectId: string, body: Record<string, unknown>) {
  return alignShapesRoute(authorized(`/api/v1/align?projectId=${projectId}`, body));
}

function distribute(projectId: string, body: Record<string, unknown>) {
  return distributeShapesRoute(authorized(`/api/v1/distribute?projectId=${projectId}`, body));
}

function pattern(projectId: string, body: Record<string, unknown>) {
  return patternShapesRoute(authorized(`/api/v1/patterns?projectId=${projectId}`, body));
}

describe("POST /align", () => {
  it("brings every left edge onto the leftmost one", async () => {
    const { projectId, wide, narrow, tall } = await row();

    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "x", target: "min" });
    const payload = await response.json() as { moved: number; anchorId: string | null; revision: number };

    expect(response.status).toBe(200);
    expect(payload.moved).toBe(2);
    expect(payload.anchorId).toBeNull();
    // The selection's left edge is `wide`'s, at 0 - 20/2 = -10. Each box keeps
    // its own width, so its centre lands half a width to the right of that.
    expect((await stored(projectId, wide)).x).toBe(0);
    expect((await stored(projectId, narrow)).x).toBe(-7);
    expect((await stored(projectId, tall)).x).toBe(5);
  });

  it("aligns tops along y, which is the elevation plus the height", async () => {
    const { projectId, wide, narrow, tall } = await row();

    // Tops sit at 10, 32 and 35, so the highest is `tall`'s. An implementation
    // that read `elevation` as the top rather than the underside would align
    // to 31 and move `tall` as well.
    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "y", target: "max" });
    const payload = await response.json() as { moved: number };

    expect(payload.moved).toBe(2);
    expect((await stored(projectId, wide)).elevation).toBe(25);
    expect((await stored(projectId, narrow)).elevation).toBe(10);
    expect((await stored(projectId, tall)).elevation).toBe(31);
  });

  it("aligns mid-heights along y, which needs both ends of each box", async () => {
    const { projectId, wide, narrow, tall } = await row();

    // Undersides at 0, 7 and 31; tops at 10, 32 and 35. So the selection spans
    // 0..35 and its mid-height is 17.5, while each box's own mid-height is 5,
    // 19.5 and 33. A `center` that read only one end of either box would land
    // somewhere else for all three.
    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "y", target: "center" });
    const payload = await response.json() as { moved: number };

    expect(payload.moved).toBe(3);
    expect((await stored(projectId, wide)).elevation).toBe(12.5);
    expect((await stored(projectId, narrow)).elevation).toBe(5);
    expect((await stored(projectId, tall)).elevation).toBe(15.5);
  });

  it("keeps the anchor where it is and moves everything else to it", async () => {
    const { projectId, wide, narrow, tall } = await row();

    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "z", target: "center", anchorId: narrow });
    const payload = await response.json() as { moved: number; anchorId: string | null };

    expect(payload.anchorId).toBe(narrow);
    expect(payload.moved).toBe(2);
    expect((await stored(projectId, narrow)).z).toBe(-4);
    expect((await stored(projectId, wide)).z).toBe(-4);
    expect((await stored(projectId, tall)).z).toBe(-4);
  });

  it("anchors on a locked shape rather than the one the caller named", async () => {
    const { projectId, wide, narrow, tall } = await row();
    await patchShape(new Request(`http://localhost/api/v1/shapes?projectId=${projectId}&shapeId=${tall}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true }),
    }));

    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "x", target: "min", anchorId: narrow });
    const payload = await response.json() as { moved: number; anchorId: string | null };

    expect(payload.anchorId).toBe(tall);
    expect(payload.moved).toBe(2);
    // `tall` spans 85..115, so its left edge is 85 and nothing moves it.
    expect((await stored(projectId, tall)).x).toBe(100);
    expect((await stored(projectId, wide)).x).toBe(95);
    expect((await stored(projectId, narrow)).x).toBe(88);
  });

  it("reports nothing moved, and writes nothing, when the selection is already flush", async () => {
    const { projectId, wide, narrow, tall } = await row();
    await align(projectId, { ids: [wide, narrow, tall], axis: "x", target: "min" });
    const settled = await readProjectDocument(projectsRoot, projectId);

    const response = await align(projectId, { ids: [wide, narrow, tall], axis: "x", target: "min" });
    const payload = await response.json() as { moved: number; revision: number };

    expect(payload.moved).toBe(0);
    // The same revision rather than a fresh one: a write would push an undo
    // entry and tell every open dashboard to reload, to say nothing happened.
    expect(payload.revision).toBe(settled!.metadata.revision);
  });

  it("refuses one shape, an unknown axis, and an unknown target", async () => {
    const { projectId, wide, narrow } = await row();

    const alone = await align(projectId, { ids: [wide], axis: "x", target: "min" });
    expect(alone.status).toBe(422);
    expect(await alone.json()).toMatchObject({ code: "invalid_request" });

    const axis = await align(projectId, { ids: [wide, narrow], axis: "w", target: "min" });
    expect(axis.status).toBe(400);

    const target = await align(projectId, { ids: [wide, narrow], axis: "x", target: "middle" });
    expect(target.status).toBe(400);
  });
});

describe("POST /distribute", () => {
  it("leaves equal clear space between neighbours", async () => {
    const { projectId, wide, narrow, tall } = await row();

    const response = await distribute(projectId, { ids: [wide, narrow, tall], spacing: "gaps" });
    const payload = await response.json() as { moved: number; axis: string; spacing: string };

    expect(response.status).toBe(200);
    // The span is -10..115 = 125; the three widths take 20 + 6 + 30 = 56; so
    // each of the two gaps is 34.5 and the middle box's centre lands at 47.5.
    expect(payload).toMatchObject({ moved: 1, axis: "x", spacing: "gaps" });
    expect((await stored(projectId, narrow)).x).toBe(47.5);
    expect((await stored(projectId, wide)).x).toBe(0);
    expect((await stored(projectId, tall)).x).toBe(100);
  });

  it("puts the centres at equal intervals instead, which is a different answer", async () => {
    const { projectId, wide, narrow, tall } = await row();

    const response = await distribute(projectId, { ids: [wide, narrow, tall], spacing: "centers" });
    await response.json();

    // Centres span 0..100, so the middle one goes to 50 -- not the 47.5 that
    // equal gaps gave. Boxes of equal width would make the two agree and the
    // difference between the modes untestable.
    expect((await stored(projectId, narrow)).x).toBe(50);
  });

  it("spreads along whichever axis the shapes are already most spread along", async () => {
    const projectId = await makeProject();
    const [near, middle, far] = await addShapes(projectId, [
      { kind: "box", width: 8, depth: 20, height: 10, x: 4, z: -30 },
      { kind: "box", width: 8, depth: 6, height: 10, x: 4, z: 5 },
      { kind: "box", width: 8, depth: 12, height: 10, x: 4, z: 60 },
    ]);

    const response = await distribute(projectId, { ids: [near, middle, far], spacing: "centers" });
    const payload = await response.json() as { axis: string };

    // Spread along Z is 90 and along X is 0, so Z is the row someone meant.
    expect(payload.axis).toBe("z");
    expect((await stored(projectId, middle)).z).toBe(15);
    expect((await stored(projectId, middle)).x).toBe(4);
  });

  it("refuses two shapes, and refuses a selection with nothing to spread", async () => {
    const { projectId, wide, narrow } = await row();

    const pair = await distribute(projectId, { ids: [wide, narrow] });
    expect(pair.status).toBe(422);

    const stacked = await makeProject();
    const ids = await addShapes(stacked, [
      { kind: "box", width: 10, depth: 10, height: 10, x: 7, z: -2 },
      { kind: "box", width: 10, depth: 10, height: 10, x: 7, z: -2 },
      { kind: "box", width: 10, depth: 10, height: 10, x: 7, z: -2 },
    ]);
    const nowhere = await distribute(stacked, { ids });
    expect(nowhere.status).toBe(422);
    expect(await nowhere.json()).toMatchObject({ code: "invalid_request" });
  });
});

/** Volume and centre of mass of a set of boxes, treating each as its stored footprint. */
function boxesCenterOfMass(shapes: readonly WorkplaneShape[]) {
  let volume = 0;
  let x = 0;
  let z = 0;
  shapes.forEach((shape) => {
    const own = (shape.width ?? 0) * (shape.depth ?? 0) * shape.height;
    volume += own;
    x += own * shape.x;
    z += own * shape.z;
  });
  return { volume, x: x / volume, z: z / volume };
}

describe("POST /patterns", () => {
  it("repeats a shape along a row at a centre-to-centre pitch", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [
      { kind: "box", width: 12, depth: 7, height: 4, x: 13, z: -7, name: "Boss" },
    ]);

    const response = await pattern(projectId, { ids: [source], kind: "linear", count: 3, stepX: 20 });
    const payload = await response.json() as { created: number; shapes: Array<{ id: string; x: number; z: number }> };

    expect(response.status).toBe(201);
    // Three copies including the original, so two are added -- and the step is
    // a pitch rather than a gap, so they land 20 apart whatever the box's own
    // width. A gap reading would put them at 45 and 77.
    expect(payload.created).toBe(2);
    expect(payload.shapes.map((shape) => shape.x)).toEqual([33, 53]);
    expect(payload.shapes.map((shape) => shape.z)).toEqual([-7, -7]);
    expect(await storedShapes(projectId)).toHaveLength(3);
  });

  it("repeats a shape around a ring, turning each copy to follow it", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [
      { kind: "box", width: 6, depth: 4, height: 3, x: 30, z: 0, name: "Spoke" },
    ]);

    const response = await pattern(projectId, {
      ids: [source],
      kind: "circular",
      count: 4,
      centerX: 0,
      centerZ: 0,
    });
    const payload = await response.json() as { created: number; shapes: Array<{ x: number; z: number; rotation: number }> };

    expect(payload.created).toBe(3);
    // A full turn divides by the count, so four land every 90 degrees and the
    // last does not sit on the first. The signs are the whole point: a negated
    // sine would put the first copy at z = -30 and the ring would wind the
    // other way, which no extent or count can see.
    expect(payload.shapes.map((shape) => [shape.x, shape.z])).toEqual([[0, 30], [-30, 0], [0, -30]]);
    expect(payload.shapes.map((shape) => shape.rotation)).toEqual([270, 180, 90]);

    // And the ring as a whole: four equal boxes evenly spaced about the origin
    // have their centre of mass at the origin. One copy misplaced moves it.
    const centre = boxesCenterOfMass(await storedShapes(projectId));
    expect(centre.volume).toBeCloseTo(4 * 6 * 4 * 3, 6);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("spreads a partial sweep between its two ends rather than dividing by the count", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [
      { kind: "box", width: 6, depth: 4, height: 3, x: 40, z: 0 },
    ]);

    const response = await pattern(projectId, {
      ids: [source],
      kind: "circular",
      count: 3,
      centerX: 0,
      centerZ: 0,
      sweepAngle: 90,
      rotateCopies: false,
    });
    const payload = await response.json() as { shapes: Array<{ x: number; z: number; rotation: number }> };

    // Three across 90 degrees puts one at each end and one in the middle, so
    // the copies are at 45 and 90 degrees. Dividing by the count instead would
    // give 30 and 60 and leave the quarter arc unfinished.
    expect(payload.shapes[0].x).toBeCloseTo(40 * Math.cos(Math.PI / 4), 4);
    expect(payload.shapes[0].z).toBeCloseTo(40 * Math.sin(Math.PI / 4), 4);
    expect(payload.shapes[1].x).toBeCloseTo(0, 4);
    expect(payload.shapes[1].z).toBeCloseTo(40, 4);
    // rotateCopies: false leaves each copy pointing the way the original did.
    expect(payload.shapes.map((shape) => shape.rotation)).toEqual([0, 0]);
  });

  it("turns a ring about the selection's own centre when no centre is given", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [
      { kind: "box", width: 6, depth: 4, height: 3, x: 18, z: -9 },
    ]);

    // Centre defaults to the origin, and the shape's distance from it is what
    // the copies keep: 18 and -9 rotated by 180 degrees is -18 and 9.
    const response = await pattern(projectId, { ids: [source], kind: "circular", count: 2 });
    const payload = await response.json() as { shapes: Array<{ x: number; z: number }> };

    expect(payload.shapes[0].x).toBeCloseTo(-18, 4);
    expect(payload.shapes[0].z).toBeCloseTo(9, 4);
  });

  it("refuses a row with no step and a ring with no sweep", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [{ kind: "box", width: 6, depth: 4, height: 3, x: 5, z: 5 }]);

    const noStep = await pattern(projectId, { ids: [source], kind: "linear", count: 4 });
    expect(noStep.status).toBe(422);
    expect(await noStep.json()).toMatchObject({ code: "invalid_request" });

    const noSweep = await pattern(projectId, { ids: [source], kind: "circular", count: 4, sweepAngle: 0 });
    expect(noSweep.status).toBe(422);

    // And nothing was written either time: a refused pattern leaves the
    // project as it was rather than adding the copies it could place.
    expect(await storedShapes(projectId)).toHaveLength(1);
  });

  it("refuses a count outside the range the editor's own panel allows", async () => {
    const projectId = await makeProject();
    const [source] = await addShapes(projectId, [{ kind: "box", width: 6, depth: 4, height: 3, x: 5, z: 5 }]);

    expect((await pattern(projectId, { ids: [source], count: 1, stepX: 10 })).status).toBe(400);
    expect((await pattern(projectId, { ids: [source], count: 500, stepX: 10 })).status).toBe(400);
  });
});

describe("arranging shapes that are not there", () => {
  it("names the ids that are missing", async () => {
    const { projectId, wide, narrow } = await row();

    const response = await align(projectId, { ids: [wide, narrow, "ghost"], axis: "x", target: "min" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "shape_not_found" });
  });
});
