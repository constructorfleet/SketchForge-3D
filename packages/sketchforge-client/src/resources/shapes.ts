import type { Transport } from "../http.js";
import {
  MAX_SHAPES_PER_REQUEST,
  type DeleteResult,
  type ShapePatch,
  type ShapePatchResult,
  type ShapeRequest,
  type ShapeSummary,
  type ShapeWriteResult,
} from "../types.js";

/**
 * The fields of a summary that describe a shape rather than set anything on it.
 *
 * The server accepts and ignores these, so sending a summary straight back is
 * not an error -- but dropping them keeps a patch to what it actually changes,
 * which is what a caller reads in a log.
 */
const DESCRIPTION_FIELDS = ["id", "kind", "requestKind", "sketchOperation", "groupedCount"] as const;

/**
 * A summary turned back into the change that would reproduce it.
 *
 * The round trip the API promises, written once: read a shape, hand it to this,
 * override the one field in question, and send it. A revolve's sweep comes back
 * nested under `revolve`, which is where the server also accepts it.
 */
export function shapePatchFromSummary(summary: ShapeSummary, changes: ShapePatch = {}): ShapePatch {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(summary)) {
    if ((DESCRIPTION_FIELDS as readonly string[]).includes(field)) continue;
    if (value !== undefined) patch[field] = value;
  }
  return { ...(patch as ShapePatch), ...changes };
}

/** Lists split into runs no longer than the server accepts in one write. */
export function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  if (size < 1) throw new Error("A chunk size must be at least 1.");
  const chunks: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class Shapes {
  constructor(private readonly transport: Transport) {}

  async list(projectId: string): Promise<ShapeSummary[]> {
    const payload = await this.transport.send<{ shapes: ShapeSummary[] }>({
      method: "GET",
      path: "/shapes",
      query: { projectId },
    });
    return payload.shapes;
  }

  /** One shape. The created shape comes back with the id later calls need. */
  async create(projectId: string, shape: ShapeRequest): Promise<ShapeSummary> {
    const payload = await this.transport.send<ShapeWriteResult>({
      method: "POST",
      path: "/shapes",
      query: { projectId },
      body: shape,
      retryable: true,
    });
    const created = payload.shapes[0];
    if (!created) throw new Error("The server accepted the shape but returned none.");
    return created;
  }

  /**
   * A batch, in request order.
   *
   * One request is one write of the project package, so a row of forty holes
   * should be one call rather than forty. Lists longer than the server's limit
   * are split, which means a long list is no longer atomic -- a later chunk can
   * fail with earlier ones already written.
   */
  async createMany(projectId: string, shapes: readonly ShapeRequest[]): Promise<ShapeWriteResult> {
    if (shapes.length === 0) return { shapes: [], revision: 0 };
    const created: ShapeSummary[] = [];
    let revision = 0;
    for (const batch of chunk(shapes, MAX_SHAPES_PER_REQUEST)) {
      const payload = await this.transport.send<ShapeWriteResult>({
        method: "POST",
        path: "/shapes",
        query: { projectId },
        body: { shapes: batch },
        retryable: true,
      });
      created.push(...payload.shapes);
      revision = payload.revision;
    }
    return { shapes: created, revision };
  }

  /** Changes the fields given and leaves the rest. A locked shape needs `locked: false`. */
  async update(projectId: string, shapeId: string, changes: ShapePatch): Promise<ShapePatchResult> {
    return this.transport.send<ShapePatchResult>({
      method: "PATCH",
      path: "/shapes",
      query: { projectId, shapeId },
      body: changes,
      retryable: true,
    });
  }

  async delete(projectId: string, shapeId: string): Promise<DeleteResult> {
    return this.transport.send<DeleteResult>({
      method: "DELETE",
      path: "/shapes",
      query: { projectId, shapeId },
      retryable: true,
    });
  }

  /**
   * Empties the project, one delete at a time.
   *
   * There is no bulk delete, and each call rewrites the package, so this is
   * slow by nature -- which is exactly why a macro that wants a clean slate
   * should usually make a fresh project instead.
   */
  async deleteAll(projectId: string): Promise<number> {
    const shapes = await this.list(projectId);
    for (const shape of shapes) {
      if (shape.locked) await this.update(projectId, shape.id, { locked: false });
      await this.delete(projectId, shape.id);
    }
    return shapes.length;
  }
}
