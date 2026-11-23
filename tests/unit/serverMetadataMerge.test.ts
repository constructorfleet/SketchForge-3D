import { describe, expect, it } from "vitest";
import { mergeMetadataFields } from "@/lib/serverMetadataMerge";

// Issue #650: a client whose list is stale must not revert fields another client changed.
describe("merging project metadata after a conflict", () => {
  const synced = { name: "Bracket", workspace: { units: "mm" }, thumbnailVersion: 1, shapes: 1 };

  it("keeps this client's changes and the other client's changes", () => {
    const local = { ...synced, thumbnailVersion: 2, shapes: 2 };
    const server = { ...synced, name: "Renamed elsewhere", workspace: { units: "in" } };
    expect(mergeMetadataFields(synced, local, server)).toEqual({
      name: "Renamed elsewhere",
      workspace: { units: "in" },
      thumbnailVersion: 2,
      shapes: 2,
    });
  });

  it("lets this client win a field both changed", () => {
    const local = { ...synced, name: "Mine" };
    const server = { ...synced, name: "Theirs" };
    expect(mergeMetadataFields(synced, local, server).name).toBe("Mine");
  });

  it("takes a field only the server has", () => {
    expect(mergeMetadataFields(synced, synced, { ...synced, accent: "rose" })).toMatchObject({ accent: "rose" });
  });

  it("treats every local field as changed when nothing was synced", () => {
    expect(mergeMetadataFields(undefined, { name: "Mine" }, { name: "Theirs", accent: "rose" })).toEqual({ name: "Mine", accent: "rose" });
  });
});
