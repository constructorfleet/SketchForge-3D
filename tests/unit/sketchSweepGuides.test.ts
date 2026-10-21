import { describe, expect, it } from "vitest";
import { formatSweepAxis, projectSweepSectionPoint, sketchSweepGuideRoles, sketchSweepStage, snapInitialSweepSpineEndpoint, sweepFramesForSectionWorkplane, tagSweepProfile } from "@/lib/sketchSweepGuides";

describe("sweep construction guide roles", () => {
  it("advances from section to spine after a closed section exists", () => {
    expect(sketchSweepStage([], "sweep")).toBe("section");
    expect(sketchSweepStage([{ closed: false, points: [{ id: "a" }, { id: "b" }], steps: [{ segment: { id: "ab" } }] }], "sweep")).toBe("section");
    expect(sketchSweepStage([{ closed: true, points: [{ id: "a" }, { id: "b" }, { id: "c" }], steps: [] }], "sweep")).toBe("spine");
    expect(sketchSweepStage([{ closed: true, points: [{ id: "a" }, { id: "b" }, { id: "c" }], steps: [] }], "extrude")).toBeNull();
  });

  it("derives an orthogonal spine frame from the selected section workplane", () => {
    const section = {
      origin: { x: 5, y: 6, z: 7 },
      normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
      xAxis: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
    const frames = sweepFramesForSectionWorkplane(section);
    expect(frames.section).toEqual(section);
    expect(frames.spine.origin).toEqual(section.origin);
    expect(frames.spine.normal.x).toBeCloseTo(section.zAxis.x);
    expect(frames.spine.normal.y).toBeCloseTo(section.zAxis.y);
    expect(frames.spine.normal.z).toBeCloseTo(section.zAxis.z);
    expect(frames.spine.xAxis).toEqual(section.normal);
    expect(frames.spine.zAxis).toEqual(section.xAxis);
    expect(formatSweepAxis(frames.spine.xAxis)).toBe("(0.71, 0.71, 0.00)");
  });

  it("persists section and spine roles on profile points", () => {
    const tagged = tagSweepProfile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 10, z: 10 },
        { id: "spine-start", x: 0, z: 0 }, { id: "spine-end", x: 0, z: 20 },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
        { id: "ca", startId: "c", endId: "a" }, { id: "spine", startId: "spine-start", endId: "spine-end" },
      ],
    }, sweepFramesForSectionWorkplane({
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    }));

    expect(tagged.points.map(({ id, sweepRole }) => [id, sweepRole])).toEqual([
      ["a", "section"], ["b", "section"], ["c", "section"], ["spine-start", "spine"], ["spine-end", "spine"],
    ]);
  });

  it("snaps only the first spine endpoint to screen-right and leaves later bends free", () => {
    const profile = {
      points: [
        { id: "section-a", x: -5, z: -5, sweepRole: "section" as const },
        { id: "section-b", x: 5, z: -5, sweepRole: "section" as const },
        { id: "section-c", x: 5, z: 5, sweepRole: "section" as const },
        { id: "section-d", x: -5, z: 5, sweepRole: "section" as const },
        { id: "spine-start", x: 0, z: 0, sweepRole: "spine" as const },
      ],
      segments: [
        { id: "section-ab", startId: "section-a", endId: "section-b" },
        { id: "section-bc", startId: "section-b", endId: "section-c" },
        { id: "section-cd", startId: "section-c", endId: "section-d" },
        { id: "section-da", startId: "section-d", endId: "section-a" },
      ],
    };

    const beforeSpineStart = { ...profile, points: profile.points.filter((point) => point.id !== "spine-start") };
    expect(snapInitialSweepSpineEndpoint(beforeSpineStart, null, { x: 12, z: 4 })).toEqual({ x: 0, z: 0 });
    expect(snapInitialSweepSpineEndpoint(profile, "spine-start", { x: 12, z: 4 })).toEqual({ x: 12, z: 0 });
    const bent = {
      ...profile,
      points: [...profile.points, { id: "spine-end", x: 12, z: 0, sweepRole: "spine" as const }],
      segments: [...profile.segments, { id: "spine-first", startId: "spine-start", endId: "spine-end" }],
    };
    expect(snapInitialSweepSpineEndpoint(bent, "spine-end", { x: 20, z: 7 })).toEqual({ x: 20, z: 7 });
  });

  it("projects the section edge-on into the spine plane along screen-up", () => {
    expect(projectSweepSectionPoint({
      id: "section-point", x: 12, z: -8,
      handleIn: { x: 10, z: -8 }, handleOut: { x: 14, z: -8 },
    })).toEqual({
      id: "section-point", x: 0, z: 12,
      handleIn: { x: 0, z: 10 }, handleOut: { x: 0, z: 14 },
    });
  });

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
