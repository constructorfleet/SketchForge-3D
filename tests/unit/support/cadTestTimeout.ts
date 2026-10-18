/**
 * How long a test that touches the OCCT kernel may take.
 *
 * The kernel is a 22 MB WebAssembly module, loaded once per test process, and
 * the solid modelling after it is genuine computation -- a fillet on a loft is
 * not a millisecond's work. The default 5s budget is met comfortably on a warm
 * developer machine and missed intermittently on a cold CI runner, which makes
 * these tests flaky rather than slow.
 *
 * Deliberately generous: the point is to stop measuring the runner's mood. A
 * real hang still fails, just a minute later.
 */
export const CAD_TEST_TIMEOUT_MS = 120_000;
