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

- **Phase 2:** package references and executable examples are in PR #118
  (open; all CI checks green, not merged).
- **Phase 3:** the initial typed REST operation inventory and route parity
  check merged in PR #112. Full schemas, OpenAPI generation, and broader route
  contract coverage remain outstanding.
- **Phase 4:** parameterized shape reference PR #115 and published CLI
  reference PR #117 have merged. Project-format, operator configuration, and
  MCP references are in separate open PRs and are not shipped; broader
  workflow guides and smoke examples remain outstanding.
- **Phase 5:** close coverage for all public symbols and claims, add source
  revision stamps and release checks, and assess redirects and screenshot
  acceptance coverage.

The merged site includes the generated shape and CLI references. Package and
example references plus configuration, MCP, and `.skf` reference work remain
under review in their separate open PRs and are not yet part of the deployed
site.
