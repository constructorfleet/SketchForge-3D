import type { Transport } from "../http.js";
import type { BakedMirrorResult, MirrorAxis } from "../types.js";

/** Exact CAD mirrors for selected, parameter-built solids. */
export class Mirrors {
  constructor(private readonly transport: Transport) {}

  /**
   * Reflects each named solid across the selected bounds midpoint plane and
   * stores the exact reflected BREP. Imported meshes, groups, and previously
   * treated shapes are refused instead of being silently tessellated.
   */
  async bake(projectId: string, ids: readonly string[], axis: MirrorAxis): Promise<BakedMirrorResult> {
    return this.transport.send<BakedMirrorResult>({
      method: "POST",
      path: "/mirrors",
      query: { projectId },
      body: { ids: [...ids], axis },
      retryable: true,
    });
  }
}
