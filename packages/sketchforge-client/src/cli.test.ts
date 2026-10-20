import { describe, expect, it } from "vitest";
import { describeReport, parseArguments } from "./cli.js";
import { clientFromEnvironment, MissingConfigurationError, targetProjectFromEnvironment } from "./environment.js";

describe("parseArguments", () => {
  it("takes the macro file and its parameters", () => {
    expect(parseArguments(["macros/plate.mjs", "--count=5", "--size=M8"])).toEqual({
      file: "macros/plate.mjs",
      params: { count: "5", size: "M8" },
      json: false,
      help: false,
    });
  });

  it("keeps --project out of the parameters, since it names the target project", () => {
    const parsed = parseArguments(["plate.mjs", "--project=p1"]);
    expect(parsed.projectId).toBe("p1");
    expect(parsed.params).toEqual({});
  });

  it("keeps an equals sign inside a value", () => {
    expect(parseArguments(["p.mjs", "--label=a=b"]).params).toEqual({ label: "a=b" });
  });

  it("refuses a flag with no value rather than passing an empty string", () => {
    expect(() => parseArguments(["p.mjs", "--count"])).toThrow(/--name=value/);
  });

  it("refuses a second macro file", () => {
    expect(() => parseArguments(["a.mjs", "b.mjs"])).toThrow(/one macro file/);
  });
});

describe("describeReport", () => {
  it("mentions clearing only when something was cleared", () => {
    const base = { macro: "Plate", projectId: "p1", projectCreated: false, shapeCount: 7, durationMs: 42, result: null };
    expect(describeReport({ ...base, shapesCleared: 0 })).not.toContain("cleared");
    expect(describeReport({ ...base, shapesCleared: 3 })).toContain("cleared    3");
  });
});

describe("clientFromEnvironment", () => {
  it("explains the missing token rather than letting every call 404", () => {
    expect(() => clientFromEnvironment({})).toThrow(MissingConfigurationError);
    expect(() => clientFromEnvironment({})).toThrow(/SKETCHFORGE_API_TOKEN/);
  });

  it("defaults the base url to the local dev server", () => {
    expect(clientFromEnvironment({ SKETCHFORGE_API_TOKEN: "t" }).apiRoot).toBe("http://127.0.0.1:3000/api/v1");
  });

  it("takes the base url from the environment", () => {
    const client = clientFromEnvironment({ SKETCHFORGE_API_TOKEN: "t", SKETCHFORGE_URL: "http://box:3100" });
    expect(client.apiRoot).toBe("http://box:3100/api/v1");
  });

  it("reads the target project, and treats an empty value as unset", () => {
    expect(targetProjectFromEnvironment({ SKETCHFORGE_PROJECT_ID: "p1" })).toBe("p1");
    expect(targetProjectFromEnvironment({ SKETCHFORGE_PROJECT_ID: "" })).toBeUndefined();
  });
});
