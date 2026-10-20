/** Errors the API answers with, kept distinguishable so a macro can react to them. */

export type ApiErrorContext = {
  method: string;
  url: string;
  status: number;
  /** The server's `error` string, when it sent one. */
  detail?: string;
  body?: unknown;
};

export class SketchForgeApiError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly body: unknown;

  constructor(context: ApiErrorContext) {
    super(`${context.method} ${context.url} failed with ${context.status}: ${context.detail ?? "no detail"}`);
    this.name = "SketchForgeApiError";
    this.method = context.method;
    this.url = context.url;
    this.status = context.status;
    this.detail = context.detail;
    this.body = context.body;
  }

  /**
   * The API answers 404 for every route when `SKETCHFORGE_API_TOKEN` is unset,
   * which is indistinguishable from a missing project by status alone -- so a
   * 404 on the project list is the one that means "the API is switched off".
   */
  get looksDisabled() {
    return this.status === 404 && /disabled/i.test(this.detail ?? "");
  }

  /** The server has a token but no project directory, so it can store nothing. */
  get needsStorage() {
    return this.status === 503;
  }

  /** Another write holds the project's lock. Retrying is the right response. */
  get isProjectBusy() {
    return this.status === 409 && /being changed/i.test(this.detail ?? "");
  }
}

/** The request never reached the server, or never came back. */
export class SketchForgeTransportError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, cause: unknown) {
    super(`${method} ${url} could not be completed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SketchForgeTransportError";
    this.method = method;
    this.url = url;
    this.cause = cause;
  }
}
