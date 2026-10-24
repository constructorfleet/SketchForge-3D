import type { Transport } from "../http.js";
import type { BooleanCutRequest, BooleanCutResult } from "../types.js";

export class Booleans {
  constructor(private readonly transport: Transport) {}

  /**
   * Subtract the `holeIds` shapes from the `solidIds` shapes, as exact geometry.
   *
   * The operands are named rather than marked, so a cutter need not be patched
   * to `hole: true` first. Every operand is replaced by the one result.
   */
  cut(projectId: string, request: BooleanCutRequest): Promise<BooleanCutResult> {
    return this.transport.send<BooleanCutResult>({
      method: "POST",
      path: "/booleans",
      query: { projectId },
      body: { solidIds: [...request.solidIds], holeIds: [...request.holeIds] },
      retryable: true,
    });
  }
}
