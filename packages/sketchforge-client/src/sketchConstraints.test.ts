import { expect, it } from "vitest";
import type { SketchSweepProfile } from "./types.js";

it("accepts equal-length constraints in public sketch profiles", () => {
  const constraint = {
    id: "equal-length",
    kind: "equalLength",
    segmentIds: ["first", "second"],
  } satisfies NonNullable<SketchSweepProfile["constraints"]>[number];

  expect(constraint.kind).toBe("equalLength");
});

it("accepts angle constraints in public sketch profiles", () => {
  const constraint = {
    id: "angle",
    kind: "angle",
    segmentIds: ["first", "second"],
    valueDeg: 45,
  } satisfies NonNullable<SketchSweepProfile["constraints"]>[number];

  expect(constraint.valueDeg).toBe(45);
});

it("accepts symmetry constraints in public sketch profiles", () => {
  const constraint = {
    id: "symmetry",
    kind: "symmetry",
    pointIds: ["first", "second"],
    segmentId: "axis",
  } satisfies NonNullable<SketchSweepProfile["constraints"]>[number];

  expect(constraint.segmentId).toBe("axis");
});
