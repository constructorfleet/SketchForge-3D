import type { Transport } from "../http.js";
import {
  PARAMETER_DIMENSIONS,
  type ParameterChange,
  type ParameterDeleteResult,
  type ParameterList,
  type ParameterRequest,
  type ParameterWriteResult,
} from "../types.js";

function checkDimension(dimension: string) {
  if (!(PARAMETER_DIMENSIONS as readonly string[]).includes(dimension)) {
    throw new Error(`A parameter dimension must be one of: ${PARAMETER_DIMENSIONS.join(", ")}.`);
  }
}

/** Owns the project parameter table. Each write rebuilds the shapes bound to what changed. */
export class Parameters {
  constructor(private readonly transport: Transport) {}

  list(projectId: string): Promise<ParameterList> {
    return this.transport.send<ParameterList>({ method: "GET", path: "/parameters", query: { projectId } });
  }

  async create(projectId: string, parameter: ParameterRequest): Promise<ParameterWriteResult> {
    checkDimension(parameter.dimension);
    return this.transport.send<ParameterWriteResult>({
      method: "POST",
      path: "/parameters",
      query: { projectId },
      body: { name: parameter.name, expression: parameter.expression, dimension: parameter.dimension },
      retryable: true,
    });
  }

  /** Changes the expression, the dimension, or both. */
  async update(projectId: string, name: string, change: ParameterChange): Promise<ParameterWriteResult> {
    const body = {
      ...(change.expression === undefined ? {} : { expression: change.expression }),
      ...(change.dimension === undefined ? {} : { dimension: change.dimension }),
    };
    if (Object.keys(body).length === 0) throw new Error("A parameter change needs an expression or a dimension.");
    if (change.dimension !== undefined) checkDimension(change.dimension);
    return this.transport.send<ParameterWriteResult>({ method: "PATCH", path: "/parameters", query: { projectId, name }, body, retryable: true });
  }

  /** Rewrites every expression and binding that uses the old name. */
  rename(projectId: string, name: string, newName: string): Promise<ParameterWriteResult> {
    return this.transport.send<ParameterWriteResult>({
      method: "PATCH",
      path: "/parameters",
      query: { projectId, name },
      body: { name: newName },
      retryable: true,
    });
  }

  /** Refused with `parameter_in_use` while anything still uses the parameter. */
  delete(projectId: string, name: string): Promise<ParameterDeleteResult> {
    return this.transport.send<ParameterDeleteResult>({ method: "DELETE", path: "/parameters", query: { projectId, name }, retryable: true });
  }
}
