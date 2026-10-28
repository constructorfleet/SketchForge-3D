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
