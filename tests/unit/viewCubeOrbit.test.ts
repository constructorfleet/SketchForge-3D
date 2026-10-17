import { describe, expect, it } from "vitest";
import {
  MAX_ORBIT_PITCH_DEGREES,
  ORBIT_DEGREES_PER_PIXEL,
  orbitDirection,
  orbitFromDrag,
  type CameraOrbit,
} from "@/lib/viewCubeOrbit";

// How the viewport reads an orbit back off the camera, so a direction can be
// round-tripped through the same maths the view cube and arrow keys use.
function orbitOfDirection([x, y, z]: [number, number, number]): CameraOrbit {
  const horizontal = Math.max(1e-9, Math.hypot(x, z));
  return {
    yawDegrees: (Math.atan2(x, z) * 180) / Math.PI,
    pitchDegrees: (Math.atan2(y, horizontal) * 180) / Math.PI,
  };
}

const home: CameraOrbit = { yawDegrees: 45, pitchDegrees: 35 };

describe("orbitFromDrag", () => {
  it("turns the scene the way the drag goes", () => {
    // Dragging right pushes the cube's right face away, so the camera moves left.
    expect(orbitFromDrag(home, 10, 0).yawDegrees).toBeCloseTo(45 - 10 * ORBIT_DEGREES_PER_PIXEL, 9);
    expect(orbitFromDrag(home, -10, 0).yawDegrees).toBeCloseTo(45 + 10 * ORBIT_DEGREES_PER_PIXEL, 9);
  });

  it("raises the camera when the drag goes down", () => {
    expect(orbitFromDrag(home, 0, 10).pitchDegrees).toBeCloseTo(35 + 10 * ORBIT_DEGREES_PER_PIXEL, 9);
  });

  it("stops short of the poles, where yaw has no meaning", () => {
    expect(orbitFromDrag(home, 0, 10000).pitchDegrees).toBe(MAX_ORBIT_PITCH_DEGREES);
    expect(orbitFromDrag(home, 0, -10000).pitchDegrees).toBe(-MAX_ORBIT_PITCH_DEGREES);
  });

  it("lets yaw run freely, so dragging never hits a wall sideways", () => {
    const spun = orbitFromDrag(home, -100000, 0);
    expect(Number.isFinite(spun.yawDegrees)).toBe(true);
    expect(Math.abs(spun.yawDegrees)).toBeGreaterThan(360);
  });

  it("does nothing for a drag that did not move", () => {
    expect(orbitFromDrag(home, 0, 0)).toEqual(home);
  });

  it("is relative to where the drag started, so a gesture does not accumulate drift", () => {
    // The viewport passes the orbit captured at pointerdown plus the total
    // delta, so splitting a drag in two must land in the same place.
    const whole = orbitFromDrag(home, 40, 20);
    const halfway = orbitFromDrag(home, 20, 10);
    const rest = orbitFromDrag(halfway, 20, 10);
    expect(rest.yawDegrees).toBeCloseTo(whole.yawDegrees, 9);
    expect(rest.pitchDegrees).toBeCloseTo(whole.pitchDegrees, 9);
  });
});

describe("orbitDirection", () => {
  it("is a unit vector", () => {
    for (const yawDegrees of [0, 45, 90, 180, -135]) {
      for (const pitchDegrees of [-89, -30, 0, 35, 89]) {
        const [x, y, z] = orbitDirection({ yawDegrees, pitchDegrees });
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
      }
    }
  });

  it("round-trips through the reader the viewport uses", () => {
    for (const yawDegrees of [0, 30, 45, 120, -60]) {
      for (const pitchDegrees of [-45, 0, 35, 80]) {
        const back = orbitOfDirection(orbitDirection({ yawDegrees, pitchDegrees }));
        expect(back.yawDegrees).toBeCloseTo(yawDegrees, 6);
        expect(back.pitchDegrees).toBeCloseTo(pitchDegrees, 6);
      }
    }
  });

  it("points along +Z at the front view and +Y overhead", () => {
    const front = orbitDirection({ yawDegrees: 0, pitchDegrees: 0 });
    expect(front[0]).toBeCloseTo(0, 9);
    expect(front[2]).toBeCloseTo(1, 9);
    const overhead = orbitDirection({ yawDegrees: 0, pitchDegrees: 89 });
    expect(overhead[1]).toBeGreaterThan(0.999);
  });
});
