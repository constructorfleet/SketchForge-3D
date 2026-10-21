import type { Transport } from "../http.js";
import type { InterferenceReport, InterferenceRequest } from "../types.js";

export class Interference {
  constructor(private readonly transport: Transport) {}

  /** Exact gaps and overlap volumes; the server refuses requests above its work caps. */
  async check(projectId: string, request: InterferenceRequest = {}): Promise<InterferenceReport> {
    return this.transport.send<InterferenceReport>({
      method: "POST",
      path: "/interference",
      query: { projectId },
      body: { ...(request.ids === undefined ? {} : { ids: request.ids }), ...(request.clearance === undefined ? {} : { clearance: request.clearance }) },
    });
  }
}
