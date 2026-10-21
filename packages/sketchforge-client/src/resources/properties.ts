import type { Transport } from "../http.js";
import type { ShapeProperties } from "../types.js";

export class Properties {
  constructor(private readonly transport: Transport) {}

  /** Exact mass properties and geometry provenance for one shape. */
  async get(projectId: string, shapeId: string): Promise<ShapeProperties> {
    const payload = await this.transport.send<{ properties: ShapeProperties }>({
      method: "GET",
      path: "/properties",
      query: { projectId, shapeId },
    });
    return payload.properties;
  }
}
