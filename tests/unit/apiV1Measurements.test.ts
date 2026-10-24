import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes } from "@/app/api/v1/shapes/route";
import { GET as measurements, POST as measureBetween } from "@/app/api/v1/measurements/route";
import { GET as edges } from "@/app/api/v1/edges/route";
import { GET as faces } from "@/app/api/v1/faces/route";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

/**
 * `GET`/`POST /api/v1/measurements` against the real OCCT kernel.
 *
 * Every expected number here is a closed form worked from the shape's own
 * dimensions -- a circumference, a rectangle's area, a gap between two spans --
 * and never a figure read back off the kernel and pasted in. Nothing sits at the
 * origin and no fixture is square: a 40x25 plate distinguishes its own two
 * in-plane edge lengths from each other, which a 40x40 one cannot, and a shape
 * moved to x=31 would catch a measurement that had quietly become a coordinate.
 */

const TOKEN = "measurement-test-token";

type Measurement = {
  entity: "edge" | "face";
  index: number;
  geometryType: string;
  length: number | null;
  area: number | null;
  radius: number | null;
  diameter: number | null;
  sweepDegrees: number | null;
  radiusUnavailable: string | null;
};

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function project() {
  const response = await createProject(
    authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Measured" }) }),
  );
  const payload = (await response.json()) as { project: { id: string } };
  return payload.project.id;
}

async function addShape(projectId: string, shape: Record<string, unknown>) {
  const response = await createShapes(
    authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify(shape) }),
  );
  const payload = (await response.json()) as { shapes: Array<{ id: string }> };
  expect(response.status, JSON.stringify(payload)).toBe(201);
  return payload.shapes[0].id;
}

async function measure(projectId: string, shapeId: string) {
  const response = await measurements(authorized(`/api/v1/measurements?projectId=${projectId}&shapeId=${shapeId}`));
  const payload = (await response.json()) as { measurements?: Measurement[]; error?: string; code?: string };
  return { status: response.status, payload };
}

/** The existing listings, so a measurement's index can be checked against the one a fillet would use. */
function listEdges(projectId: string, shapeId: string) {
  return edges(authorized(`/api/v1/edges?projectId=${projectId}&shapeId=${shapeId}`));
}

function listFaces(projectId: string, shapeId: string) {
  return faces(authorized(`/api/v1/faces?projectId=${projectId}&shapeId=${shapeId}`));
}

async function between(projectId: string, body: Record<string, unknown>) {
  const response = await measureBetween(
    authorized(`/api/v1/measurements?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body) }),
  );
  return {
    status: response.status,
    payload: (await response.json()) as {
      distance?: number;
      angleDegrees?: number | null;
      angleUnavailable?: string | null;
      error?: string;
      code?: string;
    },
  };
}

/** How many measurements report a length, area or radius within a whisker of `value`. */
function countNear(entries: Measurement[], field: "length" | "area" | "radius", value: number) {
  return entries.filter((entry) => entry[field] !== null && Math.abs((entry[field] as number) - value) < 1e-6).length;
}

describe("REST API v1 measurements", () => {
  beforeEach(async () => {
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-measure-"));
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

  /** A 40x25x10 plate, moved off the origin and asymmetric in every axis. */
  const PLATE = { kind: "box", width: 40, depth: 25, height: 10, x: 31, z: -17, elevation: 6, name: "Plate" };
  /** A true round post of radius 7.5: width and depth equal, so OCCT builds a cylinder. */
  const POST = { kind: "cylinder", width: 15, depth: 15, height: 22, x: -23, z: 9, elevation: 4, name: "Post" };

  it("measures a plate's twelve edges against its three dimensions", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, PLATE);

    const { status, payload } = await measure(projectId, shapeId);
    expect(status, JSON.stringify(payload)).toBe(200);
    const edges = payload.measurements!.filter((entry) => entry.entity === "edge");

    // A box has twelve edges: four of each dimension, all straight lines.
    expect(edges).toHaveLength(12);
    expect(countNear(edges, "length", 40)).toBe(4);
    expect(countNear(edges, "length", 25)).toBe(4);
    expect(countNear(edges, "length", 10)).toBe(4);
    expect(edges.every((edge) => edge.geometryType === "line")).toBe(true);
    // Total edge length is 4(40 + 25 + 10) = 300, so no edge is double-counted
    // and none has been measured as a coordinate.
    expect(edges.reduce((total, edge) => total + (edge.length ?? 0), 0)).toBeCloseTo(300, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures a plate's six face areas, and refuses them a radius", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, PLATE);

    const faces = (await measure(projectId, shapeId)).payload.measurements!.filter((entry) => entry.entity === "face");

    expect(faces).toHaveLength(6);
    // 40x25 top and bottom, 40x10 front and back, 25x10 left and right.
    expect(countNear(faces, "area", 1000)).toBe(2);
    expect(countNear(faces, "area", 400)).toBe(2);
    expect(countNear(faces, "area", 250)).toBe(2);
    // Surface area of the whole box: 2(1000 + 400 + 250) = 3300.
    expect(faces.reduce((total, face) => total + (face.area ?? 0), 0)).toBeCloseTo(3300, 6);
    // A plane has no radius, and says which reason rather than reporting one.
    expect(faces.every((face) => face.radius === null && face.radiusUnavailable === "notCurved")).toBe(true);
    expect(faces.every((face) => face.length === null)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures a round post's radius from the curve, not from a facet", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, POST);

    const entries = (await measure(projectId, shapeId)).payload.measurements!;
    const circles = entries.filter((entry) => entry.entity === "edge" && entry.geometryType === "circle");

    // The rim at each end. A tessellated cylinder would report straight edges
    // here -- as many as it had facets -- and no radius at all.
    expect(circles).toHaveLength(2);
    for (const circle of circles) {
      // Circumference of a 7.5 mm radius circle: 2pi(7.5) = 47.1238898038469.
      expect(circle.length).toBeCloseTo(2 * Math.PI * 7.5, 6);
      expect(circle.radius).toBeCloseTo(7.5, 6);
      expect(circle.diameter).toBeCloseTo(15, 6);
      expect(circle.sweepDegrees).toBeCloseTo(360, 6);
      expect(circle.radiusUnavailable).toBeNull();
    }

    const wall = entries.find((entry) => entry.entity === "face" && entry.geometryType === "cylinder");
    expect(wall).toBeDefined();
    expect(wall!.radius).toBeCloseTo(7.5, 6);
    expect(wall!.diameter).toBeCloseTo(15, 6);
    // Lateral area of a cylinder: 2pi(7.5)(22) = 1036.7255756846319.
    expect(wall!.area).toBeCloseTo(2 * Math.PI * 7.5 * 22, 5);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures an arc that is not a full circle, from a range that does not start at zero", async () => {
    const projectId = await project();
    // A 26 mm ball: equal radii, so the kernel builds a true sphere of radius 13.
    const shapeId = await addShape(projectId, {
      kind: "sphere", width: 26, depth: 26, height: 26, x: -23, z: 9, elevation: 4, name: "Ball",
    });

    const entries = (await measure(projectId, shapeId)).payload.measurements!;
    const seam = entries.find((entry) => entry.entity === "edge" && entry.geometryType === "circle");
    expect(seam).toBeDefined();

    // The sphere's seam is a meridian: a half circle, not a whole one, and this
    // kernel parameterises it from 3pi/2 to 5pi/2 rather than from 0. Its length
    // is pi(13) = 40.840704496667314, and the radius is that over the pi it
    // sweeps. Reading `last` as the sweep would give 13pi/(5pi/2) = 5.2.
    expect(seam!.length).toBeCloseTo(Math.PI * 13, 6);
    expect(seam!.radius).toBeCloseTo(13, 6);
    expect(seam!.diameter).toBeCloseTo(26, 6);
    expect(seam!.sweepDegrees).toBeCloseTo(180, 6);

    // The spherical face has a radius the geometry knows and this kernel will
    // not report; it says so rather than deriving a wrong one from curvature.
    const skin = entries.find((entry) => entry.entity === "face" && entry.geometryType === "sphere");
    expect(skin).toBeDefined();
    expect(skin!.radius).toBeNull();
    expect(skin!.radiusUnavailable).toBe("radiusNotReportedByKernel");
    // Its area is still exact: 4pi(13^2) = 2123.7166338267.
    expect(skin!.area).toBeCloseTo(4 * Math.PI * 169, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a radius for an elliptical rim rather than averaging its axes", async () => {
    const projectId = await project();
    // Wider than it is deep, so the kernel builds a true ellipse rather than a
    // circle. Semi-axes 13 and 7.5: there is no single radius to report.
    const shapeId = await addShape(projectId, { ...POST, width: 26, depth: 15, name: "Oval post" });

    const entries = (await measure(projectId, shapeId)).payload.measurements!;
    const ellipses = entries.filter((entry) => entry.entity === "edge" && entry.geometryType === "ellipse");

    expect(ellipses.length).toBeGreaterThan(0);
    for (const rim of ellipses) {
      expect(rim.radius).toBeNull();
      expect(rim.diameter).toBeNull();
      expect(rim.radiusUnavailable).toBe("ellipseHasNoSingleRadius");
      // The length is still exact and still worth having.
      expect(rim.length).toBeGreaterThan(0);
    }
  }, CAD_TEST_TIMEOUT_MS);

  /**
   * A tapered post: a wide rim, a slant, and a narrow rim. Deliberately not the
   * plain cylinder, whose edges are a circle, a line and an *identical* circle --
   * reversing that list leaves every index reporting the same length, so it
   * cannot tell a parity test anything. This one's two rims differ.
   */
  const TAPERED = {
    kind: "cone", width: 20, depth: 20, height: 18, topRadius: 4, baseRadius: 10,
    x: 44, z: -31, elevation: 3, name: "Tapered post",
  };

  it.each([
    ["a plate, whose twelve edges are three different lengths", PLATE],
    ["a tapered post, whose two rims differ", TAPERED],
  ])("numbers %s exactly as the edge and face listings do", async (_name, fixture) => {
    const projectId = await project();
    // The documentation promises a measurement index names the same entity a
    // fillet request would, which is only true while all three build the shape
    // the same way. Both fixtures are asymmetric in their entity lists, so a
    // listing that came back in a different order would show here.
    const shapeId = await addShape(projectId, fixture);

    const measured = (await measure(projectId, shapeId)).payload.measurements!;
    const listedEdges = ((await (await listEdges(projectId, shapeId)).json()) as {
      edges: Array<{ index: number; length: number; curveType: string }>;
    }).edges;
    const listedFaces = ((await (await listFaces(projectId, shapeId)).json()) as {
      faces: Array<{ index: number; area: number; surfaceType: string }>;
    }).faces;

    const measuredEdges = measured.filter((entry) => entry.entity === "edge");
    const measuredFaces = measured.filter((entry) => entry.entity === "face");
    expect(measuredEdges).toHaveLength(listedEdges.length);
    expect(measuredFaces).toHaveLength(listedFaces.length);

    for (const listed of listedEdges) {
      const match = measuredEdges.find((entry) => entry.index === listed.index)!;
      expect(match.geometryType, `edge ${listed.index}`).toBe(listed.curveType);
      expect(match.length, `edge ${listed.index}`).toBeCloseTo(listed.length, 6);
    }
    for (const listed of listedFaces) {
      const match = measuredFaces.find((entry) => entry.index === listed.index)!;
      expect(match.geometryType, `face ${listed.index}`).toBe(listed.surfaceType);
      expect(match.area, `face ${listed.index}`).toBeCloseTo(listed.area, 6);
    }
  }, CAD_TEST_TIMEOUT_MS);

  it("measures the gap between two solids at their nearest walls", async () => {
    const projectId = await project();
    // Each box is 40 wide, so one at x=31 spans 11..51 and one at x=91 spans
    // 71..111: a 20 mm gap between their facing walls. The distance between
    // their centres is 60, and the sum of their half-widths is 40 -- so a
    // measurement taken between centroids, or between bounding-box centres,
    // would be three times the answer.
    const left = await addShape(projectId, { kind: "box", width: 40, depth: 25, height: 10, x: 31, z: -17, name: "Left" });
    const right = await addShape(projectId, { kind: "box", width: 40, depth: 25, height: 10, x: 91, z: -17, name: "Right" });

    const { status, payload } = await between(projectId, {
      from: { shapeId: left, entity: "shape" },
      to: { shapeId: right, entity: "shape" },
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.distance).toBeCloseTo(20, 6);
    // Two whole solids are not two planes; there is no one angle between them.
    expect(payload.angleDegrees).toBeNull();
    expect(payload.angleUnavailable).toBe("notPlanar");
  }, CAD_TEST_TIMEOUT_MS);

  it("reads zero where two solids touch, rather than a small positive number", async () => {
    const projectId = await project();
    // Centres 40 apart and each box 40 wide: 11..51 and 51..91, so the right
    // one's left wall *is* the left one's right wall.
    const left = await addShape(projectId, { kind: "box", width: 40, depth: 25, height: 10, x: 31, z: -17, name: "Left" });
    const right = await addShape(projectId, { kind: "box", width: 40, depth: 25, height: 10, x: 71, z: -17, name: "Right" });

    const { payload } = await between(projectId, {
      from: { shapeId: left, entity: "shape" },
      to: { shapeId: right, entity: "shape" },
    });
    expect(payload.distance).toBeCloseTo(0, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures the distance and angle between two named faces of one shape", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, PLATE);

    const faces = (await measure(projectId, shapeId)).payload.measurements!
      .filter((entry) => entry.entity === "face");
    // The two 40x25 faces are the top and the bottom: 10 mm apart, facing opposite ways.
    const parallelPair = faces.filter((face) => Math.abs((face.area ?? 0) - 1000) < 1e-6).map((face) => face.index);
    expect(parallelPair).toHaveLength(2);

    const opposed = await between(projectId, {
      from: { shapeId, entity: "face", index: parallelPair[0] },
      to: { shapeId, entity: "face", index: parallelPair[1] },
    });
    expect(opposed.status, JSON.stringify(opposed.payload)).toBe(200);
    // The plate is 10 mm thick, and these are the faces that bound that thickness.
    expect(opposed.payload.distance).toBeCloseTo(10, 6);
    // Outward normals of opposite faces point away from each other.
    expect(opposed.payload.angleDegrees).toBeCloseTo(180, 6);
    expect(opposed.payload.angleUnavailable).toBeNull();

    // A 40x25 face against a 40x10 one is a square corner.
    const sideIndex = faces.find((face) => Math.abs((face.area ?? 0) - 400) < 1e-6)!.index;
    const corner = await between(projectId, {
      from: { shapeId, entity: "face", index: parallelPair[0] },
      to: { shapeId, entity: "face", index: sideIndex },
    });
    expect(corner.payload.angleDegrees).toBeCloseTo(90, 6);
    // Adjacent faces share an edge, so the minimum distance between them is zero.
    expect(corner.payload.distance).toBeCloseTo(0, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures revolve edges using the indexes returned by the exact edge listing", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, {
      kind: "revolve",
      name: "Four point measurement probe",
      profile: [[5, -4], [10, -4], [10, 4], [5, 4]],
      sides: 24,
    });
    const listingResponse = await listEdges(projectId, shapeId);
    const listing = (await listingResponse.json()) as {
      edges?: Array<{ index: number; curveType: string; length: number }>;
      error?: string;
    };
    expect(listingResponse.status, JSON.stringify(listing)).toBe(200);
    const outerCircles = listing.edges!.filter((edge) =>
      edge.curveType === "circle" && Math.abs(edge.length - 20 * Math.PI) < 1e-6,
    );
    expect(outerCircles).toHaveLength(2);

    const { status, payload } = await between(projectId, {
      from: { shapeId, entity: "edge", index: outerCircles[0].index },
      to: { shapeId, entity: "edge", index: outerCircles[1].index },
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.distance).toBeCloseTo(8, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures an edge of one shape against a face of another", async () => {
    const projectId = await project();
    // A post whose base sits 12 mm above a plate whose top face is at y=16.
    const plate = await addShape(projectId, PLATE);
    const post = await addShape(projectId, { ...POST, x: 31, z: -17, elevation: 28 });

    const plateFaces = (await measure(projectId, plate)).payload.measurements!
      .filter((entry) => entry.entity === "face" && Math.abs((entry.area ?? 0) - 1000) < 1e-6);
    const postRims = (await measure(projectId, post)).payload.measurements!
      .filter((entry) => entry.entity === "edge" && entry.geometryType === "circle");
    expect(plateFaces).toHaveLength(2);
    expect(postRims).toHaveLength(2);

    // Measured to each of the plate's two big faces in turn: the nearer is the
    // top at y=16, so the post's lower rim at y=28 is 12 mm off it, and the
    // further is the bottom at y=6, which is 22 mm off.
    const gaps: number[] = [];
    for (const face of plateFaces) {
      for (const rim of postRims) {
        const { payload } = await between(projectId, {
          from: { shapeId: post, entity: "edge", index: rim.index },
          to: { shapeId: plate, entity: "face", index: face.index },
        });
        gaps.push(Number(payload.distance?.toFixed(6)));
      }
    }
    // Rims at y=28 and y=50 against faces at y=16 and y=6: 12, 22, 34, 44.
    expect([...new Set(gaps)].sort((a, b) => a - b)).toEqual([12, 22, 34, 44]);
  }, CAD_TEST_TIMEOUT_MS);

  it("names the index that does not exist rather than measuring nothing", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId, PLATE);

    const { status, payload } = await between(projectId, {
      from: { shapeId, entity: "face", index: 0 },
      to: { shapeId, entity: "face", index: 99 },
    });

    expect(status).toBe(422);
    expect(payload.code).toBe("cad_failed");
    expect(payload.error).toContain("6 faces");
    expect(payload.error).toContain("face 99");
  }, CAD_TEST_TIMEOUT_MS);

  describe("request validation", () => {
    it("refuses an end with no shapeId, saying which end", async () => {
      const projectId = await project();
      const shapeId = await addShape(projectId, PLATE);

      const { status, payload } = await between(projectId, {
        from: { shapeId, entity: "shape" },
        to: { entity: "shape" },
      });
      expect(status).toBe(400);
      expect(payload.code).toBe("invalid_request");
      expect(payload.error).toContain('"to"');
    }, CAD_TEST_TIMEOUT_MS);

    it("refuses an entity it does not measure", async () => {
      const projectId = await project();
      const shapeId = await addShape(projectId, PLATE);

      const { status, payload } = await between(projectId, {
        from: { shapeId, entity: "vertex" },
        to: { shapeId, entity: "shape" },
      });
      expect(status).toBe(400);
      expect(payload.error).toContain("edge, face, shape");
    }, CAD_TEST_TIMEOUT_MS);

    it("refuses an edge or face with no index, since it cannot guess which", async () => {
      const projectId = await project();
      const shapeId = await addShape(projectId, PLATE);

      const missing = await between(projectId, {
        from: { shapeId, entity: "face" },
        to: { shapeId, entity: "shape" },
      });
      expect(missing.status).toBe(400);
      expect(missing.payload.error).toContain("index");

      const fractional = await between(projectId, {
        from: { shapeId, entity: "face", index: 1.5 },
        to: { shapeId, entity: "shape" },
      });
      expect(fractional.status).toBe(400);

      const negative = await between(projectId, {
        from: { shapeId, entity: "face", index: -1 },
        to: { shapeId, entity: "shape" },
      });
      expect(negative.status).toBe(400);
    }, CAD_TEST_TIMEOUT_MS);

    it("says which shape is not in the project", async () => {
      const projectId = await project();
      const shapeId = await addShape(projectId, PLATE);

      const { status, payload } = await between(projectId, {
        from: { shapeId, entity: "shape" },
        to: { shapeId: "not-a-shape", entity: "shape" },
      });
      expect(status).toBe(404);
      expect(payload.code).toBe("shape_not_found");
      expect(payload.error).toContain("not-a-shape");
    }, CAD_TEST_TIMEOUT_MS);

    it("refuses a GET with no shape, and a missing project", async () => {
      const projectId = await project();

      const noShape = await measurements(authorized(`/api/v1/measurements?projectId=${projectId}`));
      expect(noShape.status).toBe(400);
      expect(((await noShape.json()) as { code: string }).code).toBe("invalid_shape_id");

      const noProject = await measure("not-a-project", "whatever");
      expect(noProject.status).toBe(404);
      expect(noProject.payload.code).toBe("project_not_found");
    });

    it("refuses an unauthorized caller", async () => {
      const projectId = await project();
      const response = await measurements(new Request(`http://localhost/api/v1/measurements?projectId=${projectId}&shapeId=x`));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("unauthorized");
    });
  });
});
