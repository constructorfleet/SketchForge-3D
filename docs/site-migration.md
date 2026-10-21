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
- **Phase 3:** the initial typed REST operation inventory and route parity
  check merged in PR #112; the stable-face `GET /faces` contract merged in
  PR #120. Full schemas, OpenAPI generation, and `PATCH faceColors` contract
  coverage (open PR #125) remain outstanding.
- **Phase 4:** parameterized shape reference (#115), published CLI (#117),
  operator configuration (#121), and `.skf` format reference (#123) have
  merged. STEP documentation PR #119 and MCP reference PR #122 remain open;
  broader workflow guides and smoke examples remain outstanding.
- **Phase 5:** close coverage for all public symbols and claims, add source
  revision stamps and release checks, and assess redirects and screenshot
  acceptance coverage.

The merged site includes generated package, example, shape, CLI, operator
configuration, and `.skf` references. The STEP documentation in PR #119 and MCP
reference in PR #122 are open and not yet deployed. The `PATCH faceColors`
contract in PR #125 is open.
