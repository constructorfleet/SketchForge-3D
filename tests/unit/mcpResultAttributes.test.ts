import { afterEach, describe, expect, it } from "vitest";
import { shapeFromRequest, withResultAttributes } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { callTool, listTools, localProjects } from "./support/localMcp";

/**
 * Issue #505: a part should not need follow-up calls just to set attributes.
 * `create_shape` marks any kind as a hole, and `group_objects` and
 * `boolean_cut` name and colour the shape they leave behind.
 */

const projects = localProjects("sketchforge-result-attributes-");
afterEach(() => projects.cleanup());

/**
 * The radius-3 cutter goes all the way through the 20x20x10 plate it sits in.
 * The cut result is a meshed solid, so it removes a faceted bore a little
 * under the exact pi * 9 * 10; the tolerance below allows for that, and is
 * still far smaller than the bore itself.
 */
const REMOVED = Math.PI * 3 * 3 * 10;
const PLATE = 20 * 20 * 10;

function tool(projectsDir: string, name: string) {
  return listTools(projectsDir).find((entry) => entry.name === name)!;
}

/** A 20x20x10 plate at the origin and a radius-3 cylinder through it at x = 5. */
function plateAndCutter(projectsDir: string, cutter: Record<string, unknown>) {
  const plate = callTool(projectsDir, "sketchforge_create_shape", { projectId: "case", kind: "box", width: 20, depth: 20, height: 10 }).shapes[0];
  const bore = callTool(projectsDir, "sketchforge_create_shape", {
    projectId: "case", kind: "cylinder", width: 6, depth: 6, height: 20, x: 5, elevation: -5, ...cutter,
  }).shapes[0];
  return { plate, bore };
}

/** The plate with the cutter taken out: volume, and the centre of mass pulled away from the bore. */
function expectBoredPlate(projectsDir: string, shapeId: string) {
  const properties = callTool(projectsDir, "sketchforge_shape_properties", { projectId: "case", shapeId });
  expect(Math.abs(properties.volume - (PLATE - REMOVED))).toBeLessThan(REMOVED * 0.02);
  const centre = properties.centerOfMass ?? properties.centroid;
  const [cx, cy, cz] = Array.isArray(centre) ? centre : [centre.x, centre.y, centre.z];
  expect(cx).toBeCloseTo((-REMOVED * 5) / (PLATE - REMOVED), 1);
  expect(cy).toBeCloseTo(5, 1);
  expect(cz).toBeCloseTo(0, 1);
}

describe("result attributes on create, group and cut", () => {
  it("advertises hole for every create_shape kind and name/color on group and cut", () => {
    const projectsDir = projects.create();
    const hole = tool(projectsDir, "sketchforge_create_shape").inputSchema.properties.hole.description;
    expect(hole).toMatch(/any kind/i);
    expect(hole).toMatch(/thread.*clearance/i);
    for (const name of ["sketchforge_group_objects", "sketchforge_boolean_cut"]) {
      const { properties } = tool(projectsDir, name).inputSchema;
      expect(properties.name?.description, name).toMatch(/result/i);
      expect(properties.color?.description, name).toMatch(/result/i);
      // The colour is stored as given, as create_shape and update_object store
      // theirs; only faceColors is checked against a hex pattern, so the schema
      // must not promise one here.
      expect(properties.color?.description, name).not.toMatch(/hex/i);
      expect(properties.color?.description, name).toMatch(/stored as given/i);
    }
  });

  it("creates a cylinder as a hole, and groups it with a solid into a named, coloured cut", () => {
    const projectsDir = projects.create();
    const { plate, bore } = plateAndCutter(projectsDir, { hole: true });
    expect(bore.hole).toBe(true);

    const grouped = callTool(projectsDir, "sketchforge_group_objects", {
      projectId: "case", ids: [plate.id, bore.id], name: "Socket plate", color: "#2a9d8f",
    }).shape;
    expect(grouped).toMatchObject({ name: "Socket plate", color: "#2a9d8f" });
    const stored = callTool(projectsDir, "sketchforge_read_scene", { projectId: "case" }).objects;
    expect(stored).toEqual([expect.objectContaining({ id: grouped.id, name: "Socket plate", color: "#2a9d8f" })]);
    expectBoredPlate(projectsDir, grouped.id);
  }, 120_000);

  it("names and colours the result of boolean_cut", () => {
    const projectsDir = projects.create();
    const { plate, bore } = plateAndCutter(projectsDir, {});
    const cut = callTool(projectsDir, "sketchforge_boolean_cut", {
      projectId: "case", solidIds: [plate.id], holeIds: [bore.id], name: "Bored plate", color: "#264653",
    }).shape;
    expect(cut).toMatchObject({ name: "Bored plate", color: "#264653" });
    expectBoredPlate(projectsDir, cut.id);
  }, 120_000);

  it("keeps the default name and colour when group is given none", () => {
    const projectsDir = projects.create();
    const { plate, bore } = plateAndCutter(projectsDir, { hole: true });
    const grouped = callTool(projectsDir, "sketchforge_group_objects", { projectId: "case", ids: [plate.id, bore.id] }).shape;
    expect(grouped).toMatchObject({ name: "Group", color: plate.color });
  }, 120_000);
});

describe("withResultAttributes", () => {
  const box = shapeFromRequest({ kind: "box", name: "Box", color: "#d41721" })!;

  it("applies a non-empty name and colour", () => {
    expect(withResultAttributes(box, { name: "Lid", color: "#123456" })).toMatchObject({ name: "Lid", color: "#123456" });
  });

  it("ignores missing, blank and non-string values", () => {
    expect(withResultAttributes(box, {})).toEqual(box);
    expect(withResultAttributes(box, { name: "  ", color: 7 })).toEqual(box);
  });
});
