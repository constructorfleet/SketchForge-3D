import { pathToFileURL } from "node:url";

const tetrahedronStl = `solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 1 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 0 1
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 1 0 0
vertex 0 1 0
vertex 0 0 1
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 1 0
vertex 0 0 0
vertex 0 0 1
endloop
endfacet
endsolid tetrahedron
`;

/**
 * Import an STL, inspect its mass properties, export it, and remove the
 * temporary project. This example intentionally uses only local API servers.
 * Set SKETCHFORGE_API_TOKEN and optionally SKETCHFORGE_URL before running it.
 *
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function runImportInspectExportWalkthrough({
  baseUrl = process.env.SKETCHFORGE_URL ?? "http://127.0.0.1:3000",
  token = process.env.SKETCHFORGE_API_TOKEN,
  fetchImpl = fetch,
} = {}) {
  const serverUrl = new URL(baseUrl);
  if (
    serverUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(serverUrl.hostname)
  ) {
    throw new Error("This example only runs against a local server (localhost or loopback address).");
  }
  if (!token) throw new Error("Set SKETCHFORGE_API_TOKEN to the local server's test token.");
  const api = `${serverUrl.origin}/api/v1`;

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`);
    }
    return responseBody;
  }

  let projectId;
  try {
    const { project } = await request("/projects", {
      method: "POST",
      body: { name: "REST import inspect export example" },
    });
    projectId = project?.id;
    if (!projectId) throw new Error("Project creation did not return a project id.");
    const projectQuery = `?projectId=${encodeURIComponent(projectId)}`;

    const imported = await request(`/imports${projectQuery}`, {
      method: "POST",
      body: {
        fileName: "tetrahedron.stl",
        data: Buffer.from(tetrahedronStl, "utf8").toString("base64"),
      },
    });
    const shapeId = imported.shape?.id;
    if (!shapeId) throw new Error("STL import did not return a shape id.");

    const inspection = await request(
      `/properties${projectQuery}&shapeId=${encodeURIComponent(shapeId)}`,
    );
    const exported = await request(`/exports${projectQuery}`, {
      method: "POST",
      body: { format: "stl", shapeIds: [shapeId], name: "tetrahedron-roundtrip" },
    });
    if (typeof exported.base64 !== "string" || exported.base64.length === 0) {
      throw new Error("STL export did not return an encoded artifact.");
    }

    return {
      importFormat: "stl",
      triangles: imported.triangles,
      inspectedVolume: inspection.properties.volume,
      exportFormat: exported.format,
      exportedShapeCount: exported.shapeCount,
      exportedBytes: exported.bytes,
    };
  } finally {
    if (projectId) {
      await request(`/projects?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runImportInspectExportWalkthrough()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
