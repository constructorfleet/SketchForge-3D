import { describe, expect, it } from "vitest";
import { sketchSweepGuideRoles } from "@/lib/sketchSweepGuides";

describe("sweep construction guide roles", () => {
  it("marks a closed section and open spine separately once both exist", () => {
    const roles = sketchSweepGuideRoles([
      { closed: true, points: ["a", "b", "c"].map((id) => ({ id })), steps: ["ab", "bc", "ca"].map((id) => ({ segment: { id } })) },
      { closed: false, points: ["start", "end"].map((id) => ({ id })), steps: ["spine"].map((id) => ({ segment: { id } })) },
    ], "sweep");

    expect(Object.fromEntries(roles.segmentRoles)).toEqual({ ab: "section", bc: "section", ca: "section", spine: "spine" });
    expect(Object.fromEntries(roles.pointRoles)).toEqual({ a: "section", b: "section", c: "section", start: "spine", end: "spine" });
  });

  it("does not label the first in-progress open path as a spine", () => {
    const roles = sketchSweepGuideRoles([
      { closed: false, points: ["a", "b"].map((id) => ({ id })), steps: ["ab"].map((id) => ({ segment: { id } })) },
    ], "sweep");

    expect(roles.segmentRoles.size).toBe(0);
    expect(roles.pointRoles.size).toBe(0);
  });

  it("does not change ordinary extrusion sketch roles", () => {
    const roles = sketchSweepGuideRoles([
      { closed: true, points: ["a", "b", "c"].map((id) => ({ id })), steps: ["ab", "bc", "ca"].map((id) => ({ segment: { id } })) },
      { closed: false, points: ["start", "end"].map((id) => ({ id })), steps: ["spine"].map((id) => ({ segment: { id } })) },
    ], "extrude");

    expect(roles.segmentRoles.size).toBe(0);
    expect(roles.pointRoles.size).toBe(0);
  });
});
