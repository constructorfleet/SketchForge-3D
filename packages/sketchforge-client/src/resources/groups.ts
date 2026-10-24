import type { Transport } from "../http.js";
import type { GroupResult, ShapeWriteResult } from "../types.js";

export class Groups {
  constructor(private readonly transport: Transport) {}

  /**
   * Group two or more shapes into one.
   *
   * Grouping is also how the editor subtracts: members marked `hole: true` are
   * cut from the rest, exactly as the editor's Group button does.
   */
  group(projectId: string, ids: readonly string[]): Promise<GroupResult> {
    return this.transport.send<GroupResult>({
      method: "POST",
      path: "/groups",
      query: { projectId },
      body: { ids: [...ids] },
      retryable: true,
    });
  }

  /** Take a group apart; its members come back carrying the group's move, turn and resize. */
  ungroup(projectId: string, shapeId: string): Promise<ShapeWriteResult> {
    return this.transport.send<ShapeWriteResult>({
      method: "DELETE",
      path: "/groups",
      query: { projectId, shapeId },
      retryable: true,
    });
  }
}
