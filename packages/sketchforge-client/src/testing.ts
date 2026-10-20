/**
 * A recording fetch, for tests and for anyone writing a macro they want to run
 * dry before it touches a project.
 */

import type { FetchLike } from "./http.js";

export type RecordedCall = {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
};

export type StubResponse = { status?: number; body?: unknown };

export type FakeServer = {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Answers in order; the last answer repeats once the queue runs dry. */
  queue: (...responses: StubResponse[]) => void;
};

export function fakeServer(...initial: StubResponse[]): FakeServer {
  const calls: RecordedCall[] = [];
  const responses: StubResponse[] = [...initial];

  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers,
    });
    const next = responses.length > 1 ? responses.shift()! : (responses[0] ?? { status: 200, body: {} });
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    fetch: fetchImpl,
    calls,
    queue: (...next) => {
      responses.length = 0;
      responses.push(...next);
    },
  };
}
