import type { Transport } from "../http.js";
import type { SketchConstraintBindResult } from "../types.js";

/** Binds sketch dimensional constraints to parameter expressions. Each bind re-solves the sketch and rebuilds its output. */
export class SketchConstraints {
  constructor(private readonly transport: Transport) {}

  /** `shapeId` is the sketch output or its `sketchSourceId`. `null` removes the binding and keeps the value. */
  bind(projectId: string, shapeId: string, constraintId: string, expression: string | null): Promise<SketchConstraintBindResult> {
    if (expression !== null && !expression.trim()) {
      return Promise.reject(new Error("A constraint expression must be a non-empty string, or null to unbind."));
    }
    return this.transport.send<SketchConstraintBindResult>({
      method: "PATCH",
      path: "/sketch-constraints",
      query: { projectId, shapeId, constraintId },
      body: { expression },
      retryable: true,
    });
  }

  unbind(projectId: string, shapeId: string, constraintId: string): Promise<SketchConstraintBindResult> {
    return this.bind(projectId, shapeId, constraintId, null);
  }
}
