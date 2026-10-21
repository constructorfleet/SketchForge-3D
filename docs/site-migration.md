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
  workflow. The repository Pages publishing setting still needs to be set to
  **GitHub Actions** by a repository maintainer; the Pages API returned 404
  during this implementation, so the current setting could not be confirmed.
- Existing README, `docs/*.md`, package README, and other tracked Markdown
  pages are staged from their canonical files without hand-copying facts.
- README images hosted on the application website are shown as their alt text
  in the offline site; the tracked logo and site favicon are served locally.

## Deferred phases

- **Phase 2:** generate TypeScript, engine, and Python package references and
  execute source-included client examples.
- **Phase 3:** establish the typed REST operation contract, generate OpenAPI,
  and verify route parity.
- **Phase 4:** extract project-format, configuration, CLI, and MCP registries
  and add their generated references and smoke examples.
- **Phase 5:** close coverage for all public symbols and claims, add source
  revision stamps and release checks, and assess redirects and screenshot
  acceptance coverage.

The site currently imports existing prose and source files; it does not claim
the API, package, configuration, CLI, or format references are generated yet.
