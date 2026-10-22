import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

const pages = Object.fromEntries(await Promise.all([
  'packages/sketchforge-client/README.md',
  'docs/index.md',
  'docs/REST_API.md',
  'docs/CLI_REFERENCE.md',
  'docs/SKF_PROJECT_FORMAT.md',
  'docs/SKF_FORMAT_REFERENCE.md',
  'docs/SHAPE_REQUEST_REFERENCE.md',
  'docs/guides/package-examples.md',
  'docs/mcp/EXAMPLES.md',
].map(async (path) => [path, await read(path)])))

test('TypeScript client README documents REST sketch-sweep profile updates', () => {
  const readme = pages['packages/sketchforge-client/README.md']
  assert.match(readme, /REST API accepts profile updates that rebuild persisted sketch sweeps/i)
  assert.doesNotMatch(readme, /REST API does not yet accept profile updates that trigger a sweep rebuild/i)
  assert.match(readme, /same shape and source-sketch IDs/i)
})

test('documentation gives API readers paths to contracts, shape fields, clients, and runnable examples', () => {
  const api = pages['docs/REST_API.md']
  assert.match(api, /\]\(\.\/openapi-v1\.json\)/)
  assert.match(api, /\]\(\.\/SHAPE_REQUEST_REFERENCE\.md\)/)
  assert.match(api, /\]\(\.\/CLI_REFERENCE\.md\)/)
  assert.match(api, /\]\(\.\/guides\/package-examples\.md\)/)
  assert.match(api, /\]\(\.\/reference\/typescript-client\.md\)/)
  assert.match(api, /\]\(\.\/reference\/python-client\.md\)/)
  assert.match(pages['docs/SHAPE_REQUEST_REFERENCE.md'], /\]\(\.\/REST_API\.md#describing-a-shape\)/)
  assert.match(pages['docs/SHAPE_REQUEST_REFERENCE.md'], /\]\(\.\/openapi-v1\.json\)/)
})

test('documentation connects task examples to the API, package references, and project format semantics', () => {
  assert.match(pages['docs/guides/package-examples.md'], /\]\(\.\.\/REST_API\.md\)/)
  assert.match(pages['docs/guides/package-examples.md'], /\]\(\.\.\/reference\/typescript-client\.md\)/)
  assert.match(pages['docs/guides/package-examples.md'], /\]\(\.\.\/reference\/python-client\.md\)/)
  assert.match(pages['docs/CLI_REFERENCE.md'], /\]\(\.\/REST_API\.md\)/)
  assert.match(pages['docs/CLI_REFERENCE.md'], /\]\(\.\/guides\/package-examples\.md\)/)
  assert.match(pages['docs/mcp/EXAMPLES.md'], /\]\(\.\.\/SKF_PROJECT_FORMAT\.md\)/)
})

test('project format guide and generated format reference link to each other and REST export', () => {
  assert.match(pages['docs/SKF_PROJECT_FORMAT.md'], /\]\(\.\/SKF_FORMAT_REFERENCE\.md\)/)
  assert.match(pages['docs/SKF_PROJECT_FORMAT.md'], /\]\(\.\/REST_API\.md#endpoints/)
  assert.match(pages['docs/SKF_FORMAT_REFERENCE.md'], /\]\(\.\/SKF_PROJECT_FORMAT\.md\)/)
  assert.match(pages['docs/SKF_FORMAT_REFERENCE.md'], /\]\(\.\/REST_API\.md#endpoints\)/)
})

test('documentation home provides task-oriented entry points beyond the README', () => {
  const home = pages['docs/index.md']
  assert.match(home, /\]\(\/docs\/REST_API\.md\)/)
  assert.match(home, /\]\(\/docs\/SKF_PROJECT_FORMAT\.md\)/)
  assert.match(home, /\]\(\/docs\/CLI_REFERENCE\.md\)/)
  assert.match(home, /\]\(\/docs\/mcp\/EXAMPLES\.md\)/)
})
