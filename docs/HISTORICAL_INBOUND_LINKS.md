---
slug: "/docs/HISTORICAL_INBOUND_LINKS"
title: "Documentation inbound-link inventory"
audience: "Contributors"
owner: "Contributors"
---

# Documentation inbound-link inventory

This inventory records repository-controlled links into public documentation and
the documentation paths that were published during the VitePress migration. It
is based on the current `README.md`, package READMEs, staged-site generation,
route generator/tests, and history of `docs/.vitepress/config.mts` and the
redirect implementation. It does not claim to enumerate links from external
websites, registry metadata snapshots, browser bookmarks, or analytics.

## Canonical Pages and Historical Paths

| Inbound link or historical path | Source/evidence | Canonical destination | Published behavior |
| --- | --- | --- | --- |
| `docs/REST_API.md` | Root `README.md`; TypeScript and Python package READMEs; current docs links | `/docs/REST_API` | The repo-relative link opens the Markdown source in GitHub. In the Pages landing/package pages, the same relative link resolves to the staged VitePress page. The `.md` source is staged at its original path; VitePress `cleanUrls` publishes the clean route. |
| `docs/TRANSLATIONS.md` | Root `README.md` | `/docs/TRANSLATIONS` | Same source-versus-Pages behavior as above. No redirect is needed because the source path is retained. |
| `../../docs/PUBLISHING_CLIENTS.md` | TypeScript and Python package READMEs | `/docs/PUBLISHING_CLIENTS` | Opens the repository source from the package README on GitHub and the corresponding staged VitePress page from the published package README page. |
| `https://github.com/constructorfleet/SketchForge-3D/blob/main/packages/{sketchforge-client,sketchforge-py}/README.md` | `docs/guides/package-examples.md` | The corresponding package README source on GitHub | These are deliberate source links for registry-facing package prose; they do not route through Pages. |
| `/docs/rest-api` | PR #134 (`20480ee`) legacy-route generator and built-site test | `/docs/REST_API` | A generated static compatibility page loads a page-specific script that calls `location.replace()` to the canonical path; a normal fallback link remains in the page. |
| `/docs/skf-project-format` | PR #134 | `/docs/SKF_PROJECT_FORMAT` | Generated static compatibility page with automatic client-side redirect and fallback link. |
| `/docs/publishing-clients` | PR #134 | `/docs/PUBLISHING_CLIENTS` | Generated static compatibility page with automatic client-side redirect and fallback link. |
| `/docs/shape-request-reference` | PR #134 | `/docs/SHAPE_REQUEST_REFERENCE` | Generated static compatibility page with automatic client-side redirect and fallback link. |
| `/packages/sketchforge-client/README` | Published by initial site setup (PR #116, `5579290`); initially linked in the VitePress Packages sidebar | `/docs/packages/typescript-client` | The sidebar moved in PR #118 (`a48f923`), but the original README path remains staged because the generator copies tracked Markdown at its repository-relative path. It is a retained content page, not a redirect. The canonical package guide includes that same README as its source. |
| `/packages/sketchforge-engine/README` | PR #116 sidebar; engine README also links to current Pages references | `/docs/packages/engine` | Original README path remains staged as a content page; the canonical package guide includes the README. |
| `/packages/sketchforge-py/README` | PR #116 sidebar | `/docs/packages/python-client` | Original README path remains staged as a content page; the canonical package guide includes the README. |
| `https://constructorfleet.github.io/SketchForge-3D/docs/reference/typescript-engine` | Published engine package README | Same URL | Current public engine README links to the generated API reference using the stable Pages base path. The package guide and related REST/project/client pages are separately linked from that README. |

## Notes on Resolution

- The Pages base is derived from the repository name (`/SketchForge-3D/`), and
  VitePress uses `cleanUrls: true`. In-source `/docs/...` links are therefore
  interpreted under the project-site base when rendered by Pages. On GitHub,
  repository-relative links continue to open the source files.
- The site generator stages tracked Markdown at its repository-relative path.
  This preserves the three old package README URLs even though navigation now
  points to the dedicated `docs/packages/*.md` guides.
- Lower-case compatibility pages are generated into the temporary VitePress
  tree by `scripts/docs/generate-legacy-redirects.mjs`; they are not separately
  committed HTML redirects. `tests/docs/legacy-redirects.test.mjs` verifies the
  built files, fallback links, revision/source metadata, and redirect scripts.
- History identifies the three package README paths as published Pages routes
  from the initial site sidebar. No repository history evidence establishes
  additional pre-VitePress public documentation URL schemes. Older README
  documentation links are repository-relative paths, not evidence of a
  separately hosted documentation site. External backlinks remain unknown.

## Evidence

- PR #116 / commit `5579290`: first VitePress build and package README sidebar
  routes.
- PR #118 / commit `a48f923`: moved package navigation to
  `/docs/packages/{typescript-client,engine,python-client}` while retaining
  source READMEs.
- PR #134 / commit `20480ee`: generated four lower-case compatibility routes
  and added built-site coverage.
- Current links: root `README.md`, `packages/sketchforge-client/README.md`,
  `packages/sketchforge-py/README.md`, `packages/sketchforge-engine/README.md`,
  and `docs/guides/package-examples.md`.
