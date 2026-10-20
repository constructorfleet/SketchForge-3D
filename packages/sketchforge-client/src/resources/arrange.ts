/**
 * The three operations that move shapes that already exist.
 *
 * One file rather than three, because they are one idea read three ways --
 * align puts shapes on a line, distribute spaces them along one, pattern makes
 * the copies in the first place -- and a caller reaching for one of them is
 * usually about to reach for another.
 *
 * Every `ids` list is required. There is no selection on a server, which is
 * the one thing the editor has and the API does not.
 */

import type { Transport } from "../http.js";
import type {
  AlignRequest,
  AlignResult,
  AlignTarget,
  DistributeRequest,
  DistributeResult,
  PatternRequest,
  PatternResult,
} from "../types.js";

export class Align {
  constructor(private readonly transport: Transport) {}

  /**
   * Puts one edge or one centre of every shape on the same coordinate.
   *
   * `moved` is the answer to "did anything happen": a selection that was
   * already flush reports zero and the project is not written, so the revision
   * comes back where it was.
   */
  async apply(projectId: string, request: AlignRequest): Promise<AlignResult> {
    return this.transport.send<AlignResult>({
      method: "POST",
      path: "/align",
      query: { projectId },
      body: {
        ids: [...request.ids],
        axis: request.axis,
        target: request.target,
        ...(request.anchorId === undefined ? {} : { anchorId: request.anchorId }),
      },
      retryable: true,
    });
  }

  /** Flush tops, which is the alignment a row of parts on a plate usually wants. */
  tops(projectId: string, ids: readonly string[], anchorId?: string) {
    return this.apply(projectId, { ids, axis: "y", target: "max", anchorId });
  }

  /** Seated on one plane: every underside at the same elevation. */
  bottoms(projectId: string, ids: readonly string[], anchorId?: string) {
    return this.apply(projectId, { ids, axis: "y", target: "min", anchorId });
  }

  /** Centred on one another along an axis. */
  centers(projectId: string, ids: readonly string[], axis: AlignRequest["axis"], anchorId?: string) {
    return this.apply(projectId, { ids, axis, target: "center" as AlignTarget, anchorId });
  }
}

export class Distribute {
  constructor(private readonly transport: Transport) {}

  /**
   * Spreads three or more shapes evenly along an axis.
   *
   * The outermost two never move -- they define the span -- so a selection of
   * three has exactly one shape to place. Leave `axis` out and it is whichever
   * axis the shapes are already most spread along.
   */
  async apply(projectId: string, request: DistributeRequest): Promise<DistributeResult> {
    return this.transport.send<DistributeResult>({
      method: "POST",
      path: "/distribute",
      query: { projectId },
      body: {
        ids: [...request.ids],
        ...(request.axis === undefined ? {} : { axis: request.axis }),
        ...(request.spacing === undefined ? {} : { spacing: request.spacing }),
      },
      retryable: true,
    });
  }

  /** Equal clear space between neighbours: the one for parts of different sizes. */
  gaps(projectId: string, ids: readonly string[], axis?: DistributeRequest["axis"]) {
    return this.apply(projectId, { ids, axis, spacing: "gaps" });
  }

  /** Equal centre-to-centre pitch: the one a row of holes wants. */
  pitch(projectId: string, ids: readonly string[], axis?: DistributeRequest["axis"]) {
    return this.apply(projectId, { ids, axis, spacing: "centers" });
  }
}

export class Patterns {
  constructor(private readonly transport: Transport) {}

  /** Repeats shapes in a row or around a ring, adding the copies to the project. */
  async apply(projectId: string, request: PatternRequest): Promise<PatternResult> {
    return this.transport.send<PatternResult>({
      method: "POST",
      path: "/patterns",
      query: { projectId },
      body: {
        ids: [...request.ids],
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.count === undefined ? {} : { count: request.count }),
        ...(request.stepX === undefined ? {} : { stepX: request.stepX }),
        ...(request.stepZ === undefined ? {} : { stepZ: request.stepZ }),
        ...(request.centerX === undefined ? {} : { centerX: request.centerX }),
        ...(request.centerZ === undefined ? {} : { centerZ: request.centerZ }),
        ...(request.sweepAngle === undefined ? {} : { sweepAngle: request.sweepAngle }),
        ...(request.rotateCopies === undefined ? {} : { rotateCopies: request.rotateCopies }),
      },
      retryable: true,
    });
  }

  /**
   * A row at a centre-to-centre pitch.
   *
   * `count` includes the original, so `row(p, [id], 4, 25)` adds three copies
   * at 25, 50 and 75mm along X. The step is a pitch rather than a gap, because
   * "four at 25mm" is unambiguous and "four with 25mm between them" is not.
   */
  row(projectId: string, ids: readonly string[], count: number, stepX: number, stepZ?: number) {
    return this.apply(projectId, { ids, kind: "linear", count, stepX, stepZ });
  }

  /**
   * A ring about a point, which is how a bolt circle is made.
   *
   * A full turn divides by the count, so six land every 60 degrees and the
   * last does not sit on the first.
   */
  ring(
    projectId: string,
    ids: readonly string[],
    count: number,
    center: { x: number; z: number },
    options: { sweepAngle?: number; rotateCopies?: boolean } = {},
  ) {
    return this.apply(projectId, {
      ids,
      kind: "circular",
      count,
      centerX: center.x,
      centerZ: center.z,
      ...options,
    });
  }
}
