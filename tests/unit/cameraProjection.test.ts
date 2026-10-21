import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_PROJECTION,
  normalizeCameraProjection,
  orthographicHalfHeightAtDistance,
  orthographicVisibleHalfHeight,
  perspectiveDistanceForHalfHeight,
  toggledCameraProjection,
} from "@/lib/cameraProjection";
import { DEFAULT_WORKPLANE_WORKSPACE, normalizeWorkspaceSettings } from "@constructorfleet/sketchforge-engine/workplaneSettings";

const FOV = 38;

describe("camera projection preference", () => {
  it("defaults to perspective", () => {
    expect(DEFAULT_CAMERA_PROJECTION).toBe("perspective");
    expect(DEFAULT_WORKPLANE_WORKSPACE.cameraProjection).toBe("perspective");
  });

  it("accepts both projections", () => {
    expect(normalizeCameraProjection("orthographic")).toBe("orthographic");
    expect(normalizeCameraProjection("perspective")).toBe("perspective");
  });

  // A project saved before the setting existed, or by a build that spelled it
  // some other way, must not leave the viewport with a projection the camera
  // code cannot build.
  it("falls back for a missing or unknown value", () => {
    expect(normalizeCameraProjection(undefined)).toBe("perspective");
    expect(normalizeCameraProjection(null)).toBe("perspective");
    expect(normalizeCameraProjection("isometric")).toBe("perspective");
    expect(normalizeCameraProjection(3)).toBe("perspective");
    expect(normalizeCameraProjection({ mode: "orthographic" })).toBe("perspective");
  });

  it("falls back to the caller's current projection, not blindly to the default", () => {
    expect(normalizeCameraProjection("wat", "orthographic")).toBe("orthographic");
    expect(normalizeCameraProjection(undefined, "orthographic")).toBe("orthographic");
  });

  it("toggles between the two", () => {
    expect(toggledCameraProjection("perspective")).toBe("orthographic");
    expect(toggledCameraProjection("orthographic")).toBe("perspective");
  });
});

describe("workspace settings carry the projection", () => {
  it("round-trips a stored orthographic preference through the normalizer", () => {
    const stored = JSON.parse(JSON.stringify({ ...DEFAULT_WORKPLANE_WORKSPACE, cameraProjection: "orthographic" }));

    expect(normalizeWorkspaceSettings(stored).cameraProjection).toBe("orthographic");
  });

  it("opens a project saved without the setting on the default projection", () => {
    const legacy = { ...DEFAULT_WORKPLANE_WORKSPACE } as Record<string, unknown>;
    delete legacy.cameraProjection;

    expect(normalizeWorkspaceSettings(legacy).cameraProjection).toBe("perspective");
  });

  it("refuses a broken value instead of producing a workspace the camera cannot build", () => {
    const corrupt = { ...DEFAULT_WORKPLANE_WORKSPACE, cameraProjection: "ortho-ish" };

    expect(normalizeWorkspaceSettings(corrupt).cameraProjection).toBe("perspective");
  });

  it("keeps the current projection when hydrating a partial payload", () => {
    const current = { ...DEFAULT_WORKPLANE_WORKSPACE, cameraProjection: "orthographic" as const };

    expect(normalizeWorkspaceSettings({ gridBlockSize: 8 }, current).cameraProjection).toBe("orthographic");
  });
});

describe("workspace settings carry a saved camera view", () => {
  const cameraView = {
    position: { x: 83, y: 62, z: 91 },
    target: { x: 14, y: 8, z: -6 },
    zoom: 1.75,
  };

  it("preserves a valid pose and framing", () => {
    expect(normalizeWorkspaceSettings({ ...DEFAULT_WORKPLANE_WORKSPACE, cameraView }).cameraView).toEqual(cameraView);
  });

  it("keeps projects without a saved view on the viewport default", () => {
    const legacy = { ...DEFAULT_WORKPLANE_WORKSPACE } as Record<string, unknown>;
    delete legacy.cameraView;

    expect(normalizeWorkspaceSettings(legacy).cameraView).toBeUndefined();
  });

  it("clamps zoom and refuses a camera at its own target", () => {
    expect(normalizeWorkspaceSettings({
      ...DEFAULT_WORKPLANE_WORKSPACE,
      cameraView: { ...cameraView, zoom: 1000 },
    }).cameraView?.zoom).toBe(100);
    expect(normalizeWorkspaceSettings({
      ...DEFAULT_WORKPLANE_WORKSPACE,
      cameraView: { ...cameraView, position: cameraView.target },
    }).cameraView).toBeUndefined();
  });

  it("discards incomplete or non-finite saved views", () => {
    for (const cameraView of [
      { position: { x: 1, y: 2 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 },
      { position: { x: Number.NaN, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 },
      { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: Number.POSITIVE_INFINITY },
    ]) {
      expect(normalizeWorkspaceSettings({ ...DEFAULT_WORKPLANE_WORKSPACE, cameraView }).cameraView).toBeUndefined();
    }
  });
});

describe("switching projection without moving the view", () => {
  it("builds a frustum as tall as the perspective camera already saw", () => {
    const distance = 200;
    const halfHeight = orthographicHalfHeightAtDistance(distance, FOV);

    expect(halfHeight).toBeCloseTo(distance * Math.tan((FOV / 2) * (Math.PI / 180)), 10);
  });

  it("comes back to the distance it left from", () => {
    for (const distance of [22, 60, 187.5, 4200]) {
      const halfHeight = orthographicHalfHeightAtDistance(distance, FOV);
      expect(perspectiveDistanceForHalfHeight(halfHeight, FOV)).toBeCloseTo(distance, 6);
    }
  });

  it("frames a wider view the further back the camera was", () => {
    expect(orthographicHalfHeightAtDistance(400, FOV)).toBeGreaterThan(orthographicHalfHeightAtDistance(200, FOV));
  });

  it("refuses to hand the camera a zero or infinite frustum", () => {
    expect(orthographicHalfHeightAtDistance(0, FOV)).toBeGreaterThan(0);
    expect(orthographicHalfHeightAtDistance(Number.NaN, FOV)).toBeGreaterThan(0);
    expect(Number.isFinite(orthographicHalfHeightAtDistance(200, 180))).toBe(true);
    expect(Number.isFinite(orthographicHalfHeightAtDistance(200, 0))).toBe(true);
    expect(Number.isFinite(perspectiveDistanceForHalfHeight(100, 0))).toBe(true);
  });
});

describe("orthographic zoom is frustum size, not distance", () => {
  // The whole point of the distinction: moving an orthographic camera along its
  // own axis changes nothing on screen, so zooming has to shrink the frustum.
  // Reading that back is what lets a zoomed-in orthographic view return to the
  // matching perspective distance rather than to where the camera happens to sit.
  it("reads the visible half height back out of a zoomed frustum", () => {
    expect(orthographicVisibleHalfHeight(200, 1)).toBeCloseTo(100, 10);
    expect(orthographicVisibleHalfHeight(200, 4)).toBeCloseTo(25, 10);
    expect(orthographicVisibleHalfHeight(200, 0.5)).toBeCloseTo(200, 10);
  });

  it("maps a zoomed-in orthographic view to a nearer perspective camera", () => {
    const frustumHeight = 2 * orthographicHalfHeightAtDistance(200, FOV);
    const zoomedIn = perspectiveDistanceForHalfHeight(orthographicVisibleHalfHeight(frustumHeight, 4), FOV);
    const unzoomed = perspectiveDistanceForHalfHeight(orthographicVisibleHalfHeight(frustumHeight, 1), FOV);

    expect(unzoomed).toBeCloseTo(200, 6);
    expect(zoomedIn).toBeCloseTo(50, 6);
    expect(zoomedIn).toBeLessThan(unzoomed);
  });

  it("treats a missing or nonsensical zoom as unzoomed rather than dividing by it", () => {
    expect(orthographicVisibleHalfHeight(200, 0)).toBeCloseTo(100, 10);
    expect(orthographicVisibleHalfHeight(200, -2)).toBeCloseTo(100, 10);
    expect(orthographicVisibleHalfHeight(200, Number.NaN)).toBeCloseTo(100, 10);
    expect(orthographicVisibleHalfHeight(Number.NaN, 2)).toBeGreaterThan(0);
  });
});
