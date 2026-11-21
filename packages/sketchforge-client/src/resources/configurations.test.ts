import { describe, expect, expectTypeOf, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { SketchForgeApiError } from "../errors.js";
import { fakeServer, type FakeServer } from "../testing.js";
import type { Configurations } from "./configurations.js";
import type { ConfigurationActivateResult, ConfigurationWriteResult, ParameterConfiguration } from "../types.js";

function client(server: FakeServer) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch });
}

const wall = { name: "wall", expression: "2 mm", dimension: "length", value: 4 };
const large = { name: "Large", overrides: { wall: "4" } };
const boundBox = {
  id: "s1", name: "Box", kind: "box", color: "#fff", hole: false, locked: false, hidden: false,
  x: 40, z: 0, elevation: 0, width: 20, depth: 10, height: 10, rotation: 0, rotationX: 0, rotationZ: 0,
  expressions: { width: "wall * 5", x: "wall * 10" },
};
const state = { configurations: [large], activeConfiguration: "Large", parameters: [wall], issues: [] };
const written = { configuration: large, ...state, shapes: [boundBox], revision: 6 };
const base = "http://localhost:3100/api/v1/parameter-configurations";

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SketchForgeApiError) return error;
    throw error;
  }
  throw new Error("Expected the request to be refused.");
}

describe("parameter configurations", () => {
  it("lists configurations, the active one, the resolved table and stale overrides", async () => {
    const issue = { configuration: "Old", parameter: "gone", code: "unknownParameter", message: "No parameter gone." };
    const server = fakeServer({ body: { ...state, issues: [issue], revision: 5 } });

    const listed = await client(server).configurations.list("p1");

    expect(server.calls[0]).toMatchObject({ method: "GET", url: `${base}?projectId=p1`, body: undefined });
    expect(listed.configurations).toEqual([large]);
    expect(listed.activeConfiguration).toBe("Large");
    expect(listed.parameters[0]?.value).toBe(4);
    expect(listed.issues).toEqual([issue]);
    expect(listed.revision).toBe(5);
  });

  it("creates a configuration with its name and overrides in the body", async () => {
    const server = fakeServer({ status: 201, body: { ...written, activeConfiguration: null, shapes: [] } });

    const result = await client(server).configurations.create("p1", { name: "Large", overrides: { wall: "4" } });

    expect(server.calls[0]).toMatchObject({ method: "POST", url: `${base}?projectId=p1`, body: { name: "Large", overrides: { wall: "4" } } });
    expect(result.configuration).toEqual(large);
    expect(result.activeConfiguration).toBeNull();
  });

  it("creates a configuration without overrides by sending the name alone", async () => {
    const server = fakeServer({ status: 201, body: written });
    await client(server).configurations.create("p1", { name: "Small" });
    expect(server.calls[0]?.body).toEqual({ name: "Small" });
  });

  it("renames, sets and clears an override by configuration name in the query", async () => {
    const server = fakeServer({ body: written }, { body: written }, { body: written });
    const api = client(server);

    await api.configurations.rename("p1", "Large", "Big");
    await api.configurations.setOverride("p1", "Large", "wall", "3");
    await api.configurations.clearOverride("p1", "Large", "wall");

    expect(server.calls.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["PATCH", `${base}?projectId=p1&name=Large`, { name: "Big" }],
      ["PATCH", `${base}?projectId=p1&name=Large`, { parameter: "wall", expression: "3" }],
      ["PATCH", `${base}?projectId=p1&name=Large`, { parameter: "wall", expression: null }],
    ]);
  });

  it("deletes a configuration and returns the rebuilt shapes", async () => {
    const { configuration: _configuration, ...rest } = written;
    const server = fakeServer({ body: { deleted: true, name: "Large", ...rest, activeConfiguration: null } });

    const result = await client(server).configurations.delete("p1", "Large");

    expect(server.calls[0]).toMatchObject({ method: "DELETE", url: `${base}?projectId=p1&name=Large`, body: undefined });
    expect(result).toMatchObject({ deleted: true, name: "Large", activeConfiguration: null, shapes: [boundBox] });
  });

  it("activates a configuration by name, or the base table with null", async () => {
    const { configuration: _configuration, ...activated } = written;
    const server = fakeServer({ body: activated }, { body: { ...activated, activeConfiguration: null } });
    const api = client(server);

    const result = await api.configurations.activate("p1", "Large");
    await api.configurations.activate("p1", null);

    expect(server.calls.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["POST", `${base}/activate?projectId=p1`, { name: "Large" }],
      ["POST", `${base}/activate?projectId=p1`, { name: null }],
    ]);
    expect(result.shapes[0]).toMatchObject({ id: "s1", width: 20, x: 40 });
  });

  it("escapes a configuration name rather than splicing it into the query", async () => {
    const server = fakeServer({ body: written });
    await client(server).configurations.rename("p1", "Extra Large & Co", "XL");
    expect(new URL(server.calls[0]!.url).searchParams.get("name")).toBe("Extra Large & Co");
  });

  it("binds the project id through a handle", async () => {
    const server = fakeServer(
      { body: { ...state, revision: 5 } },
      { status: 201, body: written },
      { body: written },
      { body: written },
      { body: written },
      { body: written },
      { body: { deleted: true, name: "Big", ...state, shapes: [], revision: 9 } },
    );
    const project = client(server).project("p1");

    await project.configurations();
    await project.addConfiguration({ name: "Large", overrides: { wall: "4" } });
    await project.setConfigurationOverride("Large", "wall", "3");
    await project.clearConfigurationOverride("Large", "wall");
    await project.renameConfiguration("Large", "Big");
    await project.activateConfiguration("Big");
    await project.deleteConfiguration("Big");

    expect(server.calls.map(({ method, url }) => [method, new URL(url).pathname, new URL(url).search])).toEqual([
      ["GET", "/api/v1/parameter-configurations", "?projectId=p1"],
      ["POST", "/api/v1/parameter-configurations", "?projectId=p1"],
      ["PATCH", "/api/v1/parameter-configurations", "?projectId=p1&name=Large"],
      ["PATCH", "/api/v1/parameter-configurations", "?projectId=p1&name=Large"],
      ["PATCH", "/api/v1/parameter-configurations", "?projectId=p1&name=Large"],
      ["POST", "/api/v1/parameter-configurations/activate", "?projectId=p1"],
      ["DELETE", "/api/v1/parameter-configurations", "?projectId=p1&name=Big"],
    ]);
  });

  it("reads the active configuration from the parameter list", async () => {
    const server = fakeServer({ body: { parameters: [wall], activeConfiguration: "Large", bindingIssues: [], revision: 3 } });
    expect((await client(server).parameters.list("p1")).activeConfiguration).toBe("Large");
  });

  it("tells a missing configuration from a taken name", async () => {
    const missing = await refusal(client(fakeServer({ status: 404, body: { error: "No configuration.", code: "configuration_not_found", configuration: "XL" } })).configurations.activate("p1", "XL"));
    expect(missing.isConfigurationMissing).toBe(true);
    expect(missing.isConfigurationDuplicate).toBe(false);
    expect(missing.configuration).toBe("XL");

    const taken = await refusal(client(fakeServer({ status: 409, body: { error: "Taken.", code: "configuration_exists", configuration: "Large" } })).configurations.create("p1", { name: "Large" }));
    expect(taken.isConfigurationDuplicate).toBe(true);
    expect(taken.isConfigurationMissing).toBe(false);
    expect(taken.isProjectBusy).toBe(false);
  });
});

describe("configuration result types", () => {
  it("names the configuration on a create, rename or override result, but not after an activation", () => {
    expectTypeOf<ConfigurationWriteResult["configuration"]>().toEqualTypeOf<ParameterConfiguration>();
    expectTypeOf<"configuration" extends keyof ConfigurationActivateResult ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Configurations["create"]>().returns.resolves.toEqualTypeOf<ConfigurationWriteResult>();
    expectTypeOf<Configurations["setOverride"]>().returns.resolves.toEqualTypeOf<ConfigurationWriteResult>();
    expectTypeOf<Configurations["activate"]>().returns.resolves.toEqualTypeOf<ConfigurationActivateResult>();
  });
});
