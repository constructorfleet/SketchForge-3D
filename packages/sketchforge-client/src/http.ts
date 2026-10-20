/**
 * The one place that talks HTTP.
 *
 * Ids travel in the query string rather than the path, which is a constraint of
 * the server's static-export build rather than a style choice, so every call
 * goes through `query` and no resource builds a path by hand.
 */

import { SketchForgeApiError, SketchForgeTransportError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TransportOptions = {
  /** Where the app is served, with or without the `/api/v1` suffix. */
  baseUrl: string;
  /** `SKETCHFORGE_API_TOKEN`. Without it every route answers 404. */
  token: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout. Defaults to 60s, because a fillet runs OCCT. */
  timeoutMs?: number;
  /**
   * How many times to retry a write that lost the project lock.
   *
   * A project write is serialised and answers 409 when another write holds it,
   * which a macro that batches shapes will meet routinely. Only that one 409 is
   * retried -- a locked *shape* also answers 409 and must not be.
   */
  retryOnBusy?: number;
  /** Extra headers, for a reverse proxy that wants its own. */
  headers?: Record<string, string>;
};

export type RequestSpec = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Writes are retried when the project lock is busy; reads need no retry. */
  retryable?: boolean;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_ON_BUSY = 4;
const BUSY_RETRY_BASE_MS = 60;

/** `http://host:3000`, `http://host:3000/`, and `http://host:3000/api/v1` all mean the same server. */
export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("A baseUrl is required, for example http://localhost:3000.");
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

export function buildUrl(root: string, path: string, query?: Record<string, string | undefined>) {
  const url = new URL(`${root}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Transport {
  private readonly root: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryOnBusy: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: TransportOptions) {
    this.root = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new Error("No fetch is available; pass one in the client options.");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryOnBusy = options.retryOnBusy ?? DEFAULT_RETRY_ON_BUSY;
    this.extraHeaders = options.headers ?? {};
  }

  get apiRoot() {
    return this.root;
  }

  async send<Result>(spec: RequestSpec): Promise<Result> {
    const url = buildUrl(this.root, spec.path, spec.query);
    const attempts = spec.retryable ? this.retryOnBusy + 1 : 1;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendOnce<Result>(spec, url);
      } catch (error) {
        const busy = error instanceof SketchForgeApiError && error.isProjectBusy;
        if (!busy || attempt >= attempts) throw error;
        await sleep(BUSY_RETRY_BASE_MS * attempt);
      }
    }
  }

  private async sendOnce<Result>(spec: RequestSpec, url: string): Promise<Result> {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        signal: controller.signal,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      });
    } catch (error) {
      throw new SketchForgeTransportError(spec.method, url, error);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : typeof parsed === "string"
            ? parsed
            : undefined;
      const code = parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string"
        ? (parsed as { code: string }).code
        : undefined;
      throw new SketchForgeApiError({ method: spec.method, url, status: response.status, detail, code, body: parsed });
    }

    return parsed as Result;
  }
}
