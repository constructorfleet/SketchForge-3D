import type { Transport } from "../http.js";
import type { ShapeWriteResult } from "../types.js";

export class Parts {
  constructor(private readonly transport: Transport) {}

  /**
   * Split a shape into the separate bodies it is made of.
   *
   * A cut often leaves several pieces -- a bar cut through the middle is two
   * bars -- and until they are separate shapes none can be moved or exported
   * alone. A plain group is restored to its members.
   */
  separate(projectId: string, shapeId: string): Promise<ShapeWriteResult> {
    return this.transport.send<ShapeWriteResult>({
      method: "POST",
      path: "/parts",
      query: { projectId, shapeId },
      retryable: true,
    });
  }
}
