import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  openableProjectIds,
  safeServerProjectId,
  serverProjectRevision,
  serverProjectWriteIsStale,
  sortedServerProjects,
  type ServerProjectRecord,
} from "@/lib/serverProjectStore";

function record(projectId: string, updatedAt: number): ServerProjectRecord {
  return { projectId, updatedAt, packageBytes: 0, metadata: {} };
}

describe("server project ids", () => {
  it("accepts the ids the dashboard generates", () => {
    expect(safeServerProjectId("project-ad54d031-c13e-42ec-b278-1c7946e03647")).toBe("project-ad54d031-c13e-42ec-b278-1c7946e03647");
  });

  it("refuses anything that could escape the project directory", () => {
    expect(safeServerProjectId("../etc/passwd")).toBeNull();
    expect(safeServerProjectId("nested/project")).toBeNull();
    expect(safeServerProjectId("..")).toBeNull();
    expect(safeServerProjectId(".hidden")).toBeNull();
    expect(safeServerProjectId("")).toBeNull();
    expect(safeServerProjectId("   ")).toBeNull();
    expect(safeServerProjectId("a".repeat(121))).toBeNull();
  });
});

describe("server project staleness", () => {
  it("reads the dashboard revision out of stored metadata", () => {
    expect(serverProjectRevision({ revision: 42 })).toBe(42);
    expect(serverProjectRevision({ revision: Number.NaN })).toBe(0);
    expect(serverProjectRevision(null)).toBe(0);
    expect(serverProjectRevision("not metadata")).toBe(0);
  });

  it("refuses a write that carries an older revision than the server holds", () => {
    expect(serverProjectWriteIsStale({ revision: 20 }, { revision: 10 })).toBe(true);
  });

  it("accepts the same revision, so a retried save is not lost", () => {
    expect(serverProjectWriteIsStale({ revision: 20 }, { revision: 20 })).toBe(false);
  });

  it("accepts a write with no revision, which is a first save", () => {
    expect(serverProjectWriteIsStale({ revision: 20 }, {})).toBe(false);
    expect(serverProjectWriteIsStale(null, { revision: 5 })).toBe(false);
  });
});

describe("server project listing order", () => {
  it("lists the most recently updated project first", () => {
    const projects = [record("older", 100), record("newest", 300), record("middle", 200)];
    expect(sortedServerProjects(projects).map((entry) => entry.projectId)).toEqual(["newest", "middle", "older"]);
  });

  it("leaves the caller's array alone", () => {
    const projects = [record("older", 100), record("newest", 300)];
    sortedServerProjects(projects);
    expect(projects.map((entry) => entry.projectId)).toEqual(["older", "newest"]);
  });
});

describe("which list says a project exists", () => {
  const stored = [{ id: "browser-only" }];
  const live = [{ id: "server-only" }];

  it("asks localStorage in browser mode", () => {
    const openable = openableProjectIds("browser", { stored, live });

    expect(openable.has("browser-only")).toBe(true);
    expect(openable.has("server-only")).toBe(false);
  });

  it("asks the live list in server mode", () => {
    // The regression this exists for: in server mode localStorage is empty by
    // design, so a check against it called every project missing -- which
    // emptied the dashboard every time one was clicked.
    const openable = openableProjectIds("server", { stored: [], live });

    expect(openable.has("server-only")).toBe(true);
    expect(openable.size).toBe(1);
  });

  it("does not fall back to localStorage in server mode", () => {
    const openable = openableProjectIds("server", { stored, live });

    expect(openable.has("browser-only")).toBe(false);
  });
});

describe("server project store imports", () => {
  it("does not reach React, so the API route can import it", async () => {
    // `/api/projects` imports this module for the names and limits it shares
    // with the dashboard. Importing "@/i18n" here pulls in the React store and
    // the route fails to compile as a server module.
    const source = await readFile(new URL("../../apps/web/src/lib/serverProjectStore.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .*? from "(.+?)";$/gm)].map((match) => match[1]);

    expect(imports).not.toContain("@/i18n");
    expect(imports.filter((specifier) => specifier.startsWith("react"))).toEqual([]);
  });
});
