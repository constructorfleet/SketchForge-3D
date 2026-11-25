import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProjectWrite,
  planProjectWrite,
  projectWriteRefusal,
  type ProjectWriteRequest,
  type StoredProject,
} from "@constructorfleet/sketchforge-engine/projectWritePolicy";

const stored = { id: "p1", name: "Stored", revision: 20, updatedAt: 20, metadataRevision: 3 };
const nothing: StoredProject = { metadata: null, tombstone: null, packageExists: false };
const held: StoredProject = { metadata: stored, tombstone: null, packageExists: true };
const tombstone = { deletedAt: 1, revision: 33, metadataRevision: 4 };

// The dashboard's options; each test overrides what it needs.
function dashboard(request: Partial<ProjectWriteRequest>): ProjectWriteRequest {
  return { refuseDeleted: true, refuseOlderClock: true, revisionRule: { kind: "package" }, ...request };
}

describe("project write policy refusals", () => {
  it("refuses a write to a deleted project, naming the deleted revision", () => {
    for (const request of [{ metadata: stored }, { package: { revision: 40 } }, { metadata: stored, package: {} }]) {
      expect(planProjectWrite({ ...held, tombstone }, dashboard(request))).toEqual({ accepted: false, refusal: { reason: "deleted", deletedRevision: 33 } });
    }
  });

  it("ignores a delete record when the request does not refuse deleted projects", () => {
    expect(projectWriteRefusal({ ...held, tombstone }, { ...dashboard({ metadata: stored }), refuseDeleted: false })).toBeNull();
  });

  it("refuses a based metadata-only write when nothing is stored, without a deleted revision", () => {
    expect(projectWriteRefusal(nothing, dashboard({ metadata: stored, baseMetadataRevision: 0 }))).toEqual({ reason: "deleted" });
  });

  it("accepts that write when the package alone is stored, the base is not a number, or a package rides along", () => {
    expect(projectWriteRefusal({ ...nothing, packageExists: true }, dashboard({ metadata: stored, baseMetadataRevision: 0 }))).toBeNull();
    expect(projectWriteRefusal(nothing, dashboard({ metadata: stored, baseMetadataRevision: Number.NaN }))).toBeNull();
    expect(projectWriteRefusal(nothing, dashboard({ metadata: stored, package: {}, baseMetadataRevision: 0 }))).toBeNull();
    expect(projectWriteRefusal(nothing, dashboard({ metadata: stored }))).toBeNull();
  });

  it("refuses a package with a stale base as newerRevision, even with a newer clock", () => {
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 99 }, baseRevision: 19 }))).toEqual({ reason: "newerRevision", storedRevision: 20 });
  });

  it("accepts a package based on the stored revision or on no base", () => {
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 21 }, baseRevision: 20 }))).toBeNull();
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 21 }, baseRevision: Number.NaN }))).toBeNull();
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 21 } }))).toBeNull();
  });

  it("does not apply the package base to a metadata-only write", () => {
    expect(projectWriteRefusal(held, dashboard({ metadata: stored, baseRevision: 1 }))).toBeNull();
  });

  it("refuses an older clock revision as staleRevision, after the base check", () => {
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 19 } }))).toEqual({ reason: "staleRevision" });
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 5 }, baseRevision: 19 }))).toEqual({ reason: "newerRevision", storedRevision: 20 });
  });

  it("takes a combined write's clock revision from its metadata", () => {
    expect(projectWriteRefusal(held, dashboard({ metadata: { ...stored, revision: 19 }, package: { revision: 99 } }))).toEqual({ reason: "staleRevision" });
    expect(projectWriteRefusal(held, dashboard({ metadata: { ...stored, revision: 99 }, package: { revision: 1 } }))).toBeNull();
  });

  it("treats a missing or zero clock revision as a first save", () => {
    expect(projectWriteRefusal(held, dashboard({ package: {} }))).toBeNull();
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 0 } }))).toBeNull();
    expect(projectWriteRefusal(held, dashboard({ package: { revision: Number.NaN } }))).toBeNull();
  });

  it("skips the clock check when the request does not refuse older clocks", () => {
    expect(projectWriteRefusal(held, dashboard({ package: { revision: 19 }, refuseOlderClock: false }))).toBeNull();
  });

  it("refuses a metadata write with a stale metadata base as newerMetadata, after the clock check", () => {
    expect(projectWriteRefusal(held, dashboard({ metadata: stored, baseMetadataRevision: 2 }))).toEqual({ reason: "newerMetadata", storedMetadataRevision: 3 });
    expect(projectWriteRefusal(held, dashboard({ metadata: stored, baseMetadataRevision: 3 }))).toBeNull();
    expect(projectWriteRefusal(held, dashboard({ metadata: { ...stored, revision: 19 }, package: {}, baseMetadataRevision: 2 }))).toEqual({ reason: "staleRevision" });
  });

  it("refuses an If-Match that does not name the stored revision", () => {
    const rest = { revisionRule: { kind: "advance", now: 0 } } as const;
    expect(projectWriteRefusal(held, { ...rest, ifMatch: "19" })).toEqual({ reason: "revisionMismatch", currentRevision: 20 });
    expect(projectWriteRefusal(held, { ...rest, ifMatch: "20" })).toBeNull();
    expect(projectWriteRefusal(held, { ...rest, ifMatch: "*" })).toBeNull();
    expect(projectWriteRefusal(held, rest)).toBeNull();
    expect(projectWriteRefusal(nothing, { ...rest, ifMatch: "19" })).toBeNull();
    expect(projectWriteRefusal({ metadata: { revision: "20" } }, { ...rest, ifMatch: "20" })).toEqual({ reason: "revisionMismatch", currentRevision: 0 });
  });
});

describe("project write policy revision rules", () => {
  it("counts a metadata write and keeps the stored package revision", () => {
    expect(planProjectWrite(held, dashboard({ metadata: { ...stored, name: "Renamed", revision: 50 } }))).toEqual({
      accepted: true,
      next: {
        writesPackage: false,
        metadata: { ...stored, name: "Renamed", revision: 20, metadataRevision: 4 },
        reported: { ...stored, name: "Renamed", revision: 20, metadataRevision: 4 },
        revision: 20,
        created: false,
      },
    });
  });

  it("keeps the sent revision when the stored one is not positive, and counts from zero on a create", () => {
    const plan = planProjectWrite({ ...held, metadata: { ...stored, revision: 0 } }, dashboard({ metadata: { ...stored, revision: 50 } }));
    expect(plan.accepted && plan.next.metadata).toEqual({ ...stored, revision: 50, metadataRevision: 4 });
    const created = planProjectWrite(nothing, dashboard({ metadata: { id: "p1", revision: 7 } }));
    expect(created.accepted && created.next).toMatchObject({ metadata: { id: "p1", revision: 7, metadataRevision: 1 }, created: true, revision: 7 });
  });

  it("writes a combined write's metadata revision as sent", () => {
    const plan = planProjectWrite(held, dashboard({ metadata: { ...stored, revision: 40 }, package: { revision: 99 } }));
    expect(plan.accepted && plan.next).toEqual({
      writesPackage: true,
      metadata: { ...stored, revision: 40, metadataRevision: 4 },
      reported: { ...stored, revision: 40, metadataRevision: 4 },
      revision: 40,
      created: false,
    });
  });

  it("raises the sidecar to a newer package revision and reports the sidecar as it was", () => {
    const plan = planProjectWrite(held, dashboard({ package: { revision: 30 } }));
    expect(plan.accepted && plan.next).toEqual({ writesPackage: true, metadata: { ...stored, revision: 30 }, reported: stored, revision: 30, created: false });
  });

  it("leaves the sidecar alone for a package at or below the stored revision", () => {
    for (const revision of [20, 0]) {
      const plan = planProjectWrite(held, dashboard({ package: { revision } }));
      expect(plan.accepted && plan.next).toEqual({ writesPackage: true, metadata: null, reported: stored, revision: 20, created: false });
    }
  });

  it("raises a negative stored revision to 0 for a non-numeric package revision, but not for a missing one", () => {
    const negative = { ...held, metadata: { ...stored, revision: -5 } };
    const nonNumeric = planProjectWrite(negative, dashboard({ package: { revision: Number.NaN } }));
    expect(nonNumeric.accepted && nonNumeric.next.metadata).toEqual({ ...stored, revision: 0 });
    const missing = planProjectWrite(negative, dashboard({ package: {} }));
    expect(missing.accepted && missing.next.metadata).toBeNull();
  });

  it("writes no sidecar for a package with none stored", () => {
    const plan = planProjectWrite(nothing, dashboard({ package: { revision: 30 } }));
    expect(plan.accepted && plan.next).toEqual({ writesPackage: true, metadata: null, reported: null, revision: 0, created: true });
  });

  it("advances the revision past both the stored one and the clock", () => {
    const rest = (now: number): ProjectWriteRequest => ({ metadata: { ...stored, name: "Renamed", shapes: 1 }, package: {}, revisionRule: { kind: "advance", now } });
    const ahead = planProjectWrite(held, rest(1_000));
    expect(ahead.accepted && ahead.next).toEqual({
      writesPackage: true,
      metadata: { ...stored, name: "Renamed", shapes: 1, revision: 1_000, updatedAt: 1_000, metadataRevision: 4 },
      reported: { ...stored, name: "Renamed", shapes: 1, revision: 1_000, updatedAt: 1_000, metadataRevision: 4 },
      revision: 1_000,
      created: false,
    });
    const behind = planProjectWrite(held, rest(10));
    expect(behind.accepted && behind.next.revision).toBe(21);
    const uncounted = planProjectWrite({ metadata: { ...stored, metadataRevision: "x" } }, rest(10));
    expect(uncounted.accepted && uncounted.next.metadata?.metadataRevision).toBe(1);
  });

  it("refuses before planning, so a refused write plans nothing", () => {
    expect(planProjectWrite(held, dashboard({ package: { revision: 19 } }))).toEqual({ accepted: false, refusal: { reason: "staleRevision" } });
  });
});

describe("applying a dashboard write to a project directory", () => {
  let root = "";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-write-policy-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const read = (name: string) => fs.readFile(path.join(root, name), "utf8").catch(() => null);

  it("reads the delete record and refuses without touching the directory", async () => {
    await fs.mkdir(path.join(root, ".deleted"));
    await fs.writeFile(path.join(root, ".deleted", "p1.json"), JSON.stringify(tombstone));

    expect(await applyProjectWrite(root, "p1", dashboard({ metadata: stored }), null)).toEqual({ accepted: false, refusal: { reason: "deleted", deletedRevision: 33 } });
    expect(await fs.readdir(root)).toEqual([".deleted"]);
  });

  it("sees a package stored without a sidecar", async () => {
    await fs.writeFile(path.join(root, "p1.skf"), new Uint8Array([1]));

    const plan = await applyProjectWrite(root, "p1", dashboard({ metadata: stored, baseMetadataRevision: 0 }), null);

    expect(plan.accepted).toBe(true);
    expect(JSON.parse((await read("p1.json"))!)).toEqual({ ...stored, metadataRevision: 1 });
  });

  it("writes the package and then the raised sidecar", async () => {
    await fs.writeFile(path.join(root, "p1.json"), JSON.stringify(stored));

    await applyProjectWrite(root, "p1", dashboard({ package: { revision: 30 } }), new Uint8Array([4, 5]));

    expect([...await fs.readFile(path.join(root, "p1.skf"))]).toEqual([4, 5]);
    expect(JSON.parse((await read("p1.json"))!)).toEqual({ ...stored, revision: 30 });
  });

  it("leaves the stored files alone on a refusal", async () => {
    await fs.writeFile(path.join(root, "p1.json"), JSON.stringify(stored));
    await fs.writeFile(path.join(root, "p1.skf"), new Uint8Array([1]));

    await applyProjectWrite(root, "p1", dashboard({ package: { revision: 99 }, baseRevision: 1 }), new Uint8Array([9]));

    expect([...await fs.readFile(path.join(root, "p1.skf"))]).toEqual([1]);
    expect(JSON.parse((await read("p1.json"))!)).toEqual(stored);
  });
});
