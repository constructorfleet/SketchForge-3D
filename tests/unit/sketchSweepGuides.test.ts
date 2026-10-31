import { describe, expect, it } from "vitest";
import { centerSweepSection, formatSweepAxis, projectSweepSectionPoint, sketchSweepGuideRoles, sketchSweepStage, sketchToolForSweepStage, snapInitialSweepSpineEndpoint, sweepFramesForSectionWorkplane, sweepProfileStatus, sweepSectionOffset, sweepSpineStartPointId, tagSweepProfile, withSweepSpineStart } from "@/lib/sketchSweepGuides";

describe("sweep construction guide roles", () => {
  it("returns to selection mode when editing the section and drawing mode for the spine", () => {
    expect(sketchToolForSweepStage("section")).toBe("select");
    expect(sketchToolForSweepStage("spine")).toBe("line");
  });

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

  it("reports section and spine progress and only calls a completed sweep ready", () => {
    const section = {
      closed: true,
      points: [{ id: "a" }, { id: "b" }, { id: "c" }],
      steps: [{ segment: { id: "ab" } }, { segment: { id: "bc" } }, { segment: { id: "ca" } }],
    };
    const spine = {
      closed: false,
      points: [{ id: "start" }, { id: "end" }],
      steps: [{ segment: { id: "spine" } }],
    };
    const secondSpine = {
      closed: false,
      points: [{ id: "start-2" }, { id: "end-2" }],
      steps: [{ segment: { id: "spine-2" } }],
    };

    expect(sweepProfileStatus([])).toEqual({
      hasSection: false, hasSpine: false, sectionCount: 0, spineCount: 0, ready: false,
    });
    expect(sweepProfileStatus([section])).toEqual({
      hasSection: true, hasSpine: false, sectionCount: 1, spineCount: 0, ready: false,
    });
    expect(sweepProfileStatus([section, spine])).toEqual({
      hasSection: true, hasSpine: true, sectionCount: 1, spineCount: 1, ready: true,
    });
    expect(sweepProfileStatus([section, spine, secondSpine])).toMatchObject({ spineCount: 2, ready: false });
    // A start point on its own is not a spine yet.
    expect(sweepProfileStatus([section, { closed: false, points: [{ id: "start" }], steps: [] }])).toMatchObject({
      hasSpine: false, ready: false,
    });
  });

  it("finds the sweep start at the section origin even when the path is ordered from the other end", () => {
    const profile = {
      points: [
        { id: "section-a", x: -1, z: -1, sweepRole: "section" as const },
        { id: "section-b", x: 1, z: -1, sweepRole: "section" as const },
        { id: "section-c", x: 1, z: 1, sweepRole: "section" as const },
        { id: "spine-start", x: 0, z: 0, sweepRole: "spine" as const },
        { id: "spine-end", x: 10, z: 0, sweepRole: "spine" as const },
      ],
      segments: [
        { id: "section-ab", startId: "section-a", endId: "section-b" },
        { id: "section-bc", startId: "section-b", endId: "section-c" },
        { id: "section-ca", startId: "section-c", endId: "section-a" },
        // Stored back to front: the ordered path begins at spine-end.
        { id: "spine", startId: "spine-end", endId: "spine-start" },
      ],
    };

    expect(sweepSpineStartPointId(profile)).toBe("spine-start");
    expect(sweepSpineStartPointId({ ...profile, points: profile.points.filter((point) => point.sweepRole === "section") })).toBeNull();
    expect(sweepSpineStartPointId({
      points: [
        { id: "legacy-start", x: 5, z: 0, sweepRole: "spine" as const },
        { id: "legacy-end", x: 15, z: 0, sweepRole: "spine" as const },
      ],
      segments: [{ id: "legacy", startId: "legacy-start", endId: "legacy-end" }],
    })).toBe("legacy-start");
  });

  it("adds a start point at the section origin only when a sweep has no spine yet", () => {
    const sectionProfile = {
      points: [
        { id: "section-a", x: -1, z: -1, sweepRole: "section" as const },
        { id: "section-b", x: 1, z: -1, sweepRole: "section" as const },
        { id: "section-c", x: 1, z: 1, sweepRole: "section" as const },
        { id: "section-d", x: -1, z: 1, sweepRole: "section" as const },
      ],
      segments: [
        { id: "ab", startId: "section-a", endId: "section-b" },
        { id: "bc", startId: "section-b", endId: "section-c" },
        { id: "cd", startId: "section-c", endId: "section-d" },
        { id: "da", startId: "section-d", endId: "section-a" },
      ],
    };

    const ensured = withSweepSpineStart(sectionProfile, "start-id");
    expect(ensured.created).toBe(true);
    expect(ensured.pointId).toBe("start-id");
    expect(ensured.profile.points.at(-1)).toEqual({
      id: "start-id", x: 0, z: 0, sweepRole: "spine", mode: "corner",
    });

    const again = withSweepSpineStart(ensured.profile, "other-id");
    expect(again.created).toBe(false);
    expect(again.pointId).toBe("start-id");
    expect(again.profile).toBe(ensured.profile);

    const legacy = {
      points: [{ id: "legacy", x: 5, z: 0, sweepRole: "spine" as const }],
      segments: [],
    };
    const kept = withSweepSpineStart(legacy, "start-id");
    expect(kept.created).toBe(false);
    expect(kept.pointId).toBe("legacy");
    expect(kept.profile).toBe(legacy);
  });

  it("centres an off-origin section on the sweep origin and leaves the spine untouched", () => {
    const profile = {
      points: [
        { id: "a", x: 9, z: -1, sweepRole: "section" as const, handleOut: { x: 10, z: -1 } },
        { id: "b", x: 11, z: 1, sweepRole: "section" as const },
        { id: "start", x: 0, z: 0, sweepRole: "spine" as const },
        { id: "end", x: 10, z: 0, sweepRole: "spine" as const, sweepDepth: 3 },
      ],
      segments: [],
      constraints: [{ id: "fix", kind: "fixed" as const, pointId: "a", xMm: 9, zMm: -1 }],
    };

    expect(sweepSectionOffset(profile)).toEqual({ x: 10, z: 0 });
    const centred = centerSweepSection(profile);
    expect(centred.points).toEqual([
      { id: "a", x: -1, z: -1, sweepRole: "section", handleOut: { x: 0, z: -1 } },
      { id: "b", x: 1, z: 1, sweepRole: "section" },
      { id: "start", x: 0, z: 0, sweepRole: "spine" },
      { id: "end", x: 10, z: 0, sweepRole: "spine", sweepDepth: 3 },
    ]);
    expect(centred.constraints).toEqual([{ id: "fix", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 }]);
    expect(centerSweepSection(centred)).toBe(centred);

    expect(sweepSectionOffset({ points: [{ id: "start", x: 0, z: 0, sweepRole: "spine" as const }], segments: [] })).toBeNull();
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
