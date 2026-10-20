import { beforeAll, describe, expect, it } from "vitest";
import manifoldModule, { type ManifoldToplevel } from "manifold-3d";
import {
  MAX_PROFILE_POINTS,
  metricThreadOutline,
  parseRevolveRequest,
  profileFromOutline,
  revolvedShapeFromRequest,
} from "@/lib/revolveRequests";

describe("revolve requests", () => {
  it("turns an outline into a closed sketch profile", () => {
    const profile = profileFromOutline([[4, 0], [5, 1], [4, 2]]);

    expect(profile.points).toHaveLength(3);
    expect(profile.segments).toHaveLength(3);
    // Closed: the last segment returns to the first point.
    expect(profile.segments[2].endId).toBe(profile.points[0].id);
  });

  it("accepts distances written as positive numbers", () => {
    // The editor revolves what lies on one side of the axis. "From 4mm out to
    // 5mm out" is the natural way to ask, and must not come back empty.
    const profile = profileFromOutline([[4, 0], [5, 1], [4, 2]]);

    expect(profile.points.map((point) => point.x)).toEqual([-4, -5, -4]);
  });

  it("leaves an outline already on the revolve side alone", () => {
    const profile = profileFromOutline([[-4, 0], [-5, 1], [-4, 2]]);

    expect(profile.points.map((point) => point.x)).toEqual([-4, -5, -4]);
  });

  it("reads pitch and turns from the request, flat or nested", () => {
    const flat = parseRevolveRequest({ profile: [[4, 0], [5, 1], [4, 2]], pitch: 1.5, turns: 4 });
    const nested = parseRevolveRequest({ profile: [[4, 0], [5, 1], [4, 2]], revolve: { pitch: 1.5, turns: 4 } });

    expect(flat.ok && flat.settings.pitch).toBe(1.5);
    expect(flat.ok && flat.settings.turns).toBe(4);
    expect(nested.ok && nested.settings.pitch).toBe(1.5);
  });

  it("says what is wrong with an outline it cannot use", () => {
    expect(parseRevolveRequest({})).toMatchObject({ ok: false, error: expect.stringContaining("profile") });
    expect(parseRevolveRequest({ profile: [[0, 0], [1, 1]] })).toMatchObject({ ok: false, error: expect.stringContaining("at least 3") });
    expect(parseRevolveRequest({ profile: [[0, 0], [1, 1], ["a", 2]] })).toMatchObject({ ok: false, error: expect.stringContaining("Point 2") });
    expect(parseRevolveRequest({ profile: Array.from({ length: MAX_PROFILE_POINTS + 1 }, () => [1, 1]) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most") });
  });

  it("derives an ISO metric thread outline from diameter and pitch", () => {
    const outline = metricThreadOutline(8, 1.25);

    // A V whose crest is at the major radius and whose depth is 0.613 of pitch.
    expect(outline[1][0]).toBeCloseTo(4, 6);
    expect(outline[0][0]).toBeCloseTo(4 - 0.613 * 1.25, 6);
    expect(outline[2][1]).toBeCloseTo(1.25, 6);
  });
});

describe("building a revolve request", () => {
  let runtime: ManifoldToplevel;

  beforeAll(async () => {
    runtime = await manifoldModule();
    runtime.setup();
  });

  it("builds an M8 thread that keeps its profile and settings", () => {
    const parsed = parseRevolveRequest({ profile: metricThreadOutline(8, 1.25), pitch: 1.25, turns: 6 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shape = revolvedShapeFromRequest(runtime, parsed, { name: "M8", x: 10 });

    expect(shape.kind).toBe("mesh");
    expect(shape.width).toBeCloseTo(8, 0);
    // Six turns of rise plus the one-pitch-tall profile.
    expect(shape.height).toBeCloseTo(1.25 * 7, 1);
    expect(shape.x).toBe(10);
    // The shape stays editable as a revolve: the inspector reads these back.
    expect(shape.sketchOperation).toBe("revolve");
    expect(shape.sketchRevolve).toMatchObject({ pitch: 1.25, turns: 6 });
    expect(shape.sketchProfile?.points).toHaveLength(3);
    expect(shape.importedMesh?.triangleCount).toBeGreaterThan(100);
  });

  it("names a plain revolve differently from a thread", () => {
    const plain = parseRevolveRequest({ profile: [[4, 0], [6, 0], [6, 3], [4, 3]], pitch: 0 });
    const thread = parseRevolveRequest({ profile: metricThreadOutline(6, 1), pitch: 1, turns: 3 });
    if (!plain.ok || !thread.ok) throw new Error("expected both to parse");

    expect(revolvedShapeFromRequest(runtime, plain, {}).name).toBe("Revolve");
    expect(revolvedShapeFromRequest(runtime, thread, {}).name).toBe("Thread");
  });
});
