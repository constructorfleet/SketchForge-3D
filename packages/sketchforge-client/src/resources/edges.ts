import type { Transport } from "../http.js";
import type { EdgeSummary } from "../types.js";

export class Edges {
  constructor(private readonly transport: Transport) {}

  /** Every edge, numbered as a treatment request refers to them. */
  async list(projectId: string, shapeId: string): Promise<EdgeSummary[]> {
    const payload = await this.transport.send<{ edges: EdgeSummary[] }>({
      method: "GET",
      path: "/edges",
      query: { projectId, shapeId },
    });
    return payload.edges;
  }

  /** The indexes a fillet or chamfer can act on, which is what most callers want. */
  async filletableIndexes(projectId: string, shapeId: string): Promise<number[]> {
    const edges = await this.list(projectId, shapeId);
    return edges.filter((edge) => edge.filletable).map((edge) => edge.index);
  }
}
