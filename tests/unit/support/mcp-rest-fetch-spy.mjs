globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  process.stderr.write(`SKETCHFORGE_TEST_REQUEST ${JSON.stringify({ method: init.method ?? "GET", pathname: url.pathname })}\n`);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
