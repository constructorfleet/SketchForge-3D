# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

**Always pass `--repo constructorfleet/SketchForge-3D`.** This clone has two
remotes — `origin` (`constructorfleet/SketchForge-3D`) and `upstream`
(`Formsmith746/SketchForge-3D`) — so `gh`'s automatic repo inference is not
reliable here. An issue filed against the upstream fork cannot be quietly
withdrawn. For `gh api` calls, spell the owner and repo out in the path.

## Conventions

- **Create an issue**: `gh issue create --repo constructorfleet/SketchForge-3D --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo constructorfleet/SketchForge-3D --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --repo constructorfleet/SketchForge-3D --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards. Verified available: `gh` 2.96.0, and `repos/constructorfleet/SketchForge-3D/issues/<n>/sub_issues` responds.
- **Comment on an issue**: `gh issue comment <number> --repo constructorfleet/SketchForge-3D --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo constructorfleet/SketchForge-3D --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo constructorfleet/SketchForge-3D --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/constructorfleet/SketchForge-3D/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`. In this repo most low numbers are PRs.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope body. `gh issue create --repo constructorfleet/SketchForge-3D --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with:

  ```sh
  gh api --method POST \
    repos/constructorfleet/SketchForge-3D/issues/<child>/dependencies/blocked_by \
    -F issue_id=<blocker-db-id>
  ```

  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/constructorfleet/SketchForge-3D/issues/<n> --jq .id`), _not_ the
  `#number` or `node_id`. Verified available on this repo.

- **Frontier query**: list the map's open children, then for each, read its blockers directly:

  ```sh
  gh api repos/constructorfleet/SketchForge-3D/issues/<n>/dependencies/blocked_by \
    --jq '[.[] | select(.state == "open")] | length'
  ```

  A ticket is on the frontier when that count is `0` and it has no assignee.
  First in map order wins.

  Do **not** filter on `issue_dependencies_summary.blocked_by`: that field is
  absent from the issue payload when an issue has no dependencies (confirmed on
  #124), so treating its absence as a value misreads blocked and unblocked
  tickets alike.

- **Claim**: `gh issue edit <n> --repo constructorfleet/SketchForge-3D --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

### Label prerequisites

`wayfinder:` labels are created on demand, not pre-seeded:
`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, `wayfinder:task`. Create one with
`gh label create "<name>" --repo constructorfleet/SketchForge-3D` before first
use; `gh issue create --label` fails on a label that does not exist.
