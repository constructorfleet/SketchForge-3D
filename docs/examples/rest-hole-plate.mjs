import { pathToFileURL } from "node:url";

/**
 * Create a plate, cut five holes through it, and remove the temporary project.
 *
 * This example uses the REST API directly. Set SKETCHFORGE_API_TOKEN to the
 * test token accepted by the local server and optionally set SKETCHFORGE_URL.
 */
/**
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function runHolePlateWalkthrough({
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
      body: { name: "REST hole plate example" },
    });
    projectId = project?.id;
    if (!projectId) throw new Error("Project creation did not return a project id.");
    const projectQuery = `?projectId=${encodeURIComponent(projectId)}`;

    const shapes = [
      { kind: "box", width: 120, depth: 40, height: 6, name: "Plate" },
      ...Array.from({ length: 5 }, (_, index) => ({
        kind: "cylinder",
        width: 8,
        depth: 8,
        height: 12,
        x: -40 + index * 20,
        elevation: -1,
        hole: true,
        name: `Hole ${index + 1}`,
      })),
    ];
    const added = await request(`/shapes${projectQuery}`, {
      method: "POST",
      body: { shapes },
    });
    const plate = added.shapes.find((shape) => shape.name === "Plate");
    const holes = added.shapes.filter((shape) => shape.hole);
    if (!plate || holes.length !== 5) throw new Error("Expected one plate and five hole cutters.");

    const before = await request(`/properties${projectQuery}&shapeId=${encodeURIComponent(plate.id)}`);
    const cut = await request(`/booleans${projectQuery}`, {
      method: "POST",
      body: { solidIds: [plate.id], holeIds: holes.map((hole) => hole.id) },
    });
    const finalShapes = await request(`/shapes${projectQuery}`);
    const after = await request(`/properties${projectQuery}&shapeId=${encodeURIComponent(cut.shape.id)}`);

    return {
      createdShapeCount: added.shapes.length,
      holeCount: holes.length,
      resultingShapeCount: finalShapes.shapes.length,
      groupedShapeCount: cut.shape.groupedCount,
      plateVolume: before.properties.volume,
      cutVolume: after.properties.volume,
    };
  } finally {
    if (projectId) {
      await request(`/projects?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHolePlateWalkthrough()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
