import { describe, expect, it } from "vitest";
import { updateFaceColor } from "@/lib/faceColorEditor";

describe("updateFaceColor", () => {
  it("sets a color for a non-negative integer CAD face index", () => {
    expect(updateFaceColor({ 1: "#112233" }, 4, "#aabbcc")).toEqual({ 1: "#112233", 4: "#aabbcc" });
  });

  it("removes the face entry when color is cleared", () => {
    expect(updateFaceColor({ 1: "#112233", 4: "#aabbcc" }, 4, null)).toEqual({ 1: "#112233" });
  });

  it("ignores invalid indexes", () => {
    expect(updateFaceColor({ 1: "#112233" }, -1, "#aabbcc")).toEqual({ 1: "#112233" });
    expect(updateFaceColor({ 1: "#112233" }, 1.5, "#aabbcc")).toEqual({ 1: "#112233" });
  });

  it("sets and removes colors by stable face ID", () => {
    expect(updateFaceColor({ face_old: "#112233" }, "face_new", "#aabbcc")).toEqual({
      face_old: "#112233",
      face_new: "#aabbcc",
    });
    expect(updateFaceColor({ face_new: "#aabbcc" }, "face_new", null)).toEqual({});
  });
});
