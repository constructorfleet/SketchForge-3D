/**
 * Why the read-only routes of `/api/v1` answer OPTIONS.
 *
 * Not for CORS, and not politeness. A route handler that exports **only** GET
 * and touches no API Next recognises as dynamic is prerendered at build time,
 * and a production server then answers it from the full route cache -- for
 * ever, to every caller, with whatever the build produced. The build has no
 * `SKETCHFORGE_API_TOKEN`, so what it produces is
 * `404 {"code":"api_disabled"}`, and that is what a deployed server serves for
 * a route like `/api/v1/edges` no matter how it is configured at runtime. The
 * response carries `x-nextjs-cache: HIT`, which is how to recognise it.
 *
 * Every other route in `/api/v1` escapes this by accident: they export POST,
 * PATCH or DELETE as well, and a route with a non-GET handler is never
 * prerendered. The read-only ones had nothing to make them dynamic.
 *
 * Declaring it instead does not work. `output: export` -- the static build,
 * which runs in CI -- refuses `dynamic = "force-dynamic"` outright, refuses
 * `revalidate = 0`, and fails the prerender if the handler awaits
 * `connection()`; on a GET-only route it positively *requires* a static
 * declaration. All four combinations were built both ways to establish that.
 * So the only lever left is not being GET-only, and OPTIONS is the one method
 * that costs nothing and says something true.
 *
 * Deleting these exports silently breaks the route in production builds while
 * leaving every `next dev` test passing. `tests/e2e/productionApi.e2e.ts`
 * builds and starts a real server to catch that.
 */

/** The allowed methods of a read-only `/api/v1` route. */
export function apiReadOnlyOptions() {
  return new Response(null, {
    status: 204,
    headers: { allow: "GET, OPTIONS", "Cache-Control": "no-store" },
  });
}
