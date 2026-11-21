import type { Transport } from "../http.js";
import type {
  ConfigurationActivateResult,
  ConfigurationDeleteResult,
  ConfigurationList,
  ConfigurationRequest,
  ConfigurationWriteResult,
} from "../types.js";

const PATH = "/parameter-configurations";

/** Owns named rows of parameter overrides. A write that changes the active table rebuilds bound shapes. */
export class Configurations {
  constructor(private readonly transport: Transport) {}

  list(projectId: string): Promise<ConfigurationList> {
    return this.transport.send<ConfigurationList>({ method: "GET", path: PATH, query: { projectId } });
  }

  /** Creates a configuration without activating it. */
  create(projectId: string, configuration: ConfigurationRequest): Promise<ConfigurationWriteResult> {
    return this.transport.send<ConfigurationWriteResult>({
      method: "POST",
      path: PATH,
      query: { projectId },
      body: { name: configuration.name, ...(configuration.overrides === undefined ? {} : { overrides: configuration.overrides }) },
      retryable: true,
    });
  }

  /** The active configuration keeps its place under the new name. */
  rename(projectId: string, name: string, newName: string): Promise<ConfigurationWriteResult> {
    return this.change(projectId, name, { name: newName });
  }

  setOverride(projectId: string, name: string, parameter: string, expression: string): Promise<ConfigurationWriteResult> {
    return this.change(projectId, name, { parameter, expression });
  }

  /** The parameter takes its base expression in that configuration again. */
  clearOverride(projectId: string, name: string, parameter: string): Promise<ConfigurationWriteResult> {
    return this.change(projectId, name, { parameter, expression: null });
  }

  /** Deleting the active configuration switches to the base table. */
  delete(projectId: string, name: string): Promise<ConfigurationDeleteResult> {
    return this.transport.send<ConfigurationDeleteResult>({ method: "DELETE", path: PATH, query: { projectId, name }, retryable: true });
  }

  /** `null` switches to the base table. */
  activate(projectId: string, name: string | null): Promise<ConfigurationActivateResult> {
    return this.transport.send<ConfigurationActivateResult>({ method: "POST", path: `${PATH}/activate`, query: { projectId }, body: { name }, retryable: true });
  }

  private change(projectId: string, name: string, body: Record<string, unknown>) {
    return this.transport.send<ConfigurationWriteResult>({ method: "PATCH", path: PATH, query: { projectId, name }, body, retryable: true });
  }
}
