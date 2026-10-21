# Documentation site migration map

This phase establishes the static site shell and publishes canonical Markdown
sources as pages. The repository files remain the maintained sources; the
build assembles a temporary VitePress tree and expands the landing page's
README include. Existing repository paths are retained in the site where
possible, and the navigation points to the maintained API, project-format,
client, translation, and capability documents.

## Phase 1 delivered

- VitePress 1.6.4 static build with a repository-derived project-site base path.
- Built-in local search, navigation, source includes, local link and include
  checks, and a local preview command.
- Pull-request build artifact and default-branch GitHub Pages deployment
  workflow. The first GitHub Pages deployment after PR #116 merged succeeded.
- Existing README, `docs/*.md`, package README, and other tracked Markdown
  pages are staged from their canonical files without hand-copying facts.
- README images hosted on the application website are shown as their alt text
  in the offline site; the tracked logo and site favicon are served locally.

## Follow-up phases

- **Phase 2:** package references and executable examples merged in PR #118.
- **Python client:** reference type checks and source links (#136) and stable-
  face identity parity (#145) have merged. The latter adds stable face IDs,
  face colors, and a source-backed example; package examples run against the
  local API.
- **Phase 3:** the initial typed REST operation inventory and route parity
  check merged in PR #112; `GET /faces` and `PATCH /shapes` stable face color
  contracts merged in PRs #120 and #125. PR #144 added generated OpenAPI for
  six schema-backed CRUD operations and records the 26 registered operations
  still omitted; full route schemas and live-handler parity remain outstanding.
- **Phase 4:** parameterized shape reference (#115), published CLI (#117),
  operator configuration (#121), `.skf` format (#123), and MCP schema/navigation
  (#122) references have merged. Deterministic generator-hook wiring merged in
  PR #128. STEP color guidance merged in PR #119, and STEP component-color
  import support merged in PR #147. An editor quick-start from first sketch
  through save/export is implemented on branch `docs/editor-quickstart` and
  not yet merged; broader task guides remain outstanding.
- **Phase 5:** site version/revision stamps and pinned source links merged in
  PR #126, lower-case compatibility routes in PR #134, and the release-process
  guide/check in PR #132. Built-site browser smoke checks merged in PR #141;
  the scheduled non-blocking external-link report merged in PR #143. Coverage
  rules and a complete accessibility audit remain outstanding.

The merged site includes generated package, example, shape, CLI, operator
configuration, `.skf`, and MCP references. Deterministic reference-generator
checks merged in PR #128; STEP color guidance merged in PR #119.
