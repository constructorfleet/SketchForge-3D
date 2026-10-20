import type { Transport } from "../http.js";
import type { MeasurementEnd, MeasurementPair, MeasurementSummary } from "../types.js";

/**
 * One end of a between-entities request, as the server wants it.
 *
 * An absent `entity` and an absent `index` are left out rather than sent as
 * null: the server reads a missing `entity` as the whole shape, and refuses an
 * `index` alongside it.
 */
function endBody(end: MeasurementEnd) {
  return {
    shapeId: end.shapeId,
    ...(end.entity === undefined ? {} : { entity: end.entity }),
    ...(end.index === undefined ? {} : { index: end.index }),
  };
}

export class Measurements {
  constructor(private readonly transport: Transport) {}

  /** Every edge and face, measured, numbered as the edge and face listings number them. */
  async list(projectId: string, shapeId: string): Promise<MeasurementSummary[]> {
    const payload = await this.transport.send<{ measurements: MeasurementSummary[] }>({
      method: "GET",
      path: "/measurements",
      query: { projectId, shapeId },
    });
    return payload.measurements;
  }

  /**
   * The distance between two entities, and the angle if both are flat faces.
   *
   * The ends may be on different shapes, and either may be a whole shape, so
   * this answers both "how deep is that pocket" and "how far apart are those
   * two parts". The distance is measured between the real surfaces, so two
   * cylinders 5mm apart at their nearest walls read 5.
   */
  async between(projectId: string, from: MeasurementEnd, to: MeasurementEnd): Promise<MeasurementPair> {
    return this.transport.send<MeasurementPair>({
      method: "POST",
      path: "/measurements",
      query: { projectId },
      body: { from: endBody(from), to: endBody(to) },
    });
  }

  /**
   * The entries that carry a radius, which is how a caller finds the bores.
   *
   * Most entities of a shape have none -- a flat face and a straight edge both
   * answer with a reason instead -- so filtering on the reported radius is what
   * a caller wanting the round features has to do anyway.
   */
  async withRadius(projectId: string, shapeId: string): Promise<MeasurementSummary[]> {
    const measurements = await this.list(projectId, shapeId);
    return measurements.filter((measurement) => measurement.radius !== null);
  }
}
