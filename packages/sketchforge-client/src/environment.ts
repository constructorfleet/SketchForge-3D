/**
 * Connecting from the environment, which is how a macro is meant to be run.
 *
 * The token is a password for every project on the server, so it belongs in the
 * environment rather than in a macro's source or on a command line where it
 * lands in shell history and in `ps`.
 */

import { SketchForgeClient, type SketchForgeClientOptions } from "./client.js";

export const BASE_URL_ENV = "SKETCHFORGE_URL";
export const TOKEN_ENV = "SKETCHFORGE_API_TOKEN";
export const PROJECT_ENV = "SKETCHFORGE_PROJECT_ID";

export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

export type Environment = Record<string, string | undefined>;

export class MissingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingConfigurationError";
  }
}

export function clientFromEnvironment(
  environment: Environment = process.env,
  overrides: Partial<SketchForgeClientOptions> = {},
): SketchForgeClient {
  const token = overrides.token ?? environment[TOKEN_ENV];
  if (!token) {
    throw new MissingConfigurationError(
      `${TOKEN_ENV} is not set. It is the same token the server was started with; without it every route answers 404.`,
    );
  }
  const baseUrl = overrides.baseUrl ?? environment[BASE_URL_ENV] ?? DEFAULT_BASE_URL;
  return new SketchForgeClient({ ...overrides, baseUrl, token });
}

/** The project an operator named for a `target` macro, if any. */
export function targetProjectFromEnvironment(environment: Environment = process.env) {
  return environment[PROJECT_ENV] || undefined;
}
