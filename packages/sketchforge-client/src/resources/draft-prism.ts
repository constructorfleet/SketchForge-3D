import type { Transport } from "../http.js";
import type { TreatmentResult } from "../types.js";

export class DraftPrism {
  constructor(private readonly transport: Transport) {}

  apply(projectId: string, shapeId: string, angle: number): Promise<TreatmentResult> {
    return this.transport.send<TreatmentResult>({
      method: "POST",
      path: "/draft-prism",
      query: { projectId, shapeId },
      body: { angle },
      retryable: true,
    });
  }
}
