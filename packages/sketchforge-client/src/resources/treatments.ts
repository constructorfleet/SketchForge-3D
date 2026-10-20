import type { Transport } from "../http.js";
import type { EdgeTreatment, TreatmentResult } from "../types.js";

export class Treatments {
  constructor(private readonly transport: Transport) {}

  /**
   * Rounds or cuts edges on the server, with OCCT.
   *
   * Treat every edge you want in one request where you can: OCCT refuses a
   * second treatment on edges adjacent to the first, because the surfaces there
   * are already tangent.
   */
  async apply(projectId: string, shapeId: string, treatment: EdgeTreatment): Promise<TreatmentResult> {
    return this.transport.send<TreatmentResult>({
      method: "POST",
      path: "/treatments",
      query: { projectId, shapeId },
      body: {
        kind: treatment.kind,
        amount: treatment.amount,
        ...(treatment.angle === undefined ? {} : { angle: treatment.angle }),
        ...(treatment.edges === undefined ? {} : { edges: [...treatment.edges] }),
      },
      retryable: true,
    });
  }

  fillet(projectId: string, shapeId: string, radius: number, edges?: readonly number[]) {
    return this.apply(projectId, shapeId, { kind: "fillet", amount: radius, ...(edges ? { edges } : {}) });
  }

  chamfer(
    projectId: string,
    shapeId: string,
    distance: number,
    options: { angle?: number; edges?: readonly number[] } = {},
  ) {
    return this.apply(projectId, shapeId, {
      kind: "chamfer",
      amount: distance,
      ...(options.angle === undefined ? {} : { angle: options.angle }),
      ...(options.edges ? { edges: options.edges } : {}),
    });
  }
}
