// SKETCHFORGE_TEST_RESPONSES maps "METHOD /path" to { status, body }; the rest answer 200 {}.
const responses = JSON.parse(process.env.SKETCHFORGE_TEST_RESPONSES || "{}");

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  process.stderr.write(`SKETCHFORGE_TEST_REQUEST ${JSON.stringify({ method, pathname: url.pathname })}\n`);
  const answer = responses[`${method} ${url.pathname}`] ?? { status: 200, body: {} };
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};
