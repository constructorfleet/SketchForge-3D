# Agent Instructions

These instructions apply to all work in this repository. Follow more specific instructions in a subdirectory when present, provided they do not conflict with these requirements.

## Feature and bug work

- All work should be performed on an appropriately named branch.
- Build features and fix bugs with test-driven development: first add or update a focused test that demonstrates the expected behavior or reproduces the defect, run it and confirm the expected red result, then implement the smallest change that makes it pass, and refactor with the test still passing. Do not defer tests until after implementation. If a behavior cannot reasonably be automated, explain why and document the manual verification performed.
- Run the relevant tests and quality checks before committing. For this project, use the appropriate `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run typecheck`, and `npm run build` checks for the affected areas. Do not claim a check passed unless it was run and passed.
- Keep each commit an atomic unit of work: one coherent change, its tests, and the documentation needed for that change. Do not mix unrelated fixes, feature work, or formatting churn. Use a clear commit message that describes the outcome.

## Pull requests and follow-through

- Open pull requests for logical, reviewable chunks of work. Split independent features or fixes into separate PRs; keep inseparable prerequisites together and describe their dependency. A PR should be small enough to review as one coherent change and include its tests, docs, roadmap updates, and verification results.
- Before opening a PR, inspect the branch diff and confirm the branch is based on current target-branch work. Include a clear summary, relevant issue links, test and manual verification results, and screenshots or recordings for UI changes when useful.
- After opening a PR, monitor it through merge or an explicit handoff. Check for merge conflicts, review feedback, and all required CI/check results. Resolve conflicts and failing checks, push the correction, and recheck the updated PR. Do not report the work as complete while checks are pending or failing; state any blocker plainly if it cannot be resolved.
- Do not hand-rebase a PR only because `main` moved or because `docs/CHANGELOG.md` conflicts. `.github/workflows/pr-auto-rebase.yml` rebases conflicting same-repository PRs after each merge; a PR it cannot rebase gets a comment naming the files, and only then does it need you. The bot force-pushes, so fetch and reset to the remote branch before adding commits. Locally, `node scripts/rebase-pr.mjs --branch <branch>` rebases the same way.
- Do not merge a PR unless the user or repository workflow has authorized merging.
- Always include screenshots when your change involves the UI.

## Roadmap and documentation

- Update the relevant roadmap whenever a feature is added, changed, deferred, or completed. Keep roadmap status consistent with the shipped or merged state, and do not invent commitments. If no roadmap exists, create or propose a concise one when feature work needs a durable record of planned and completed work.
- Update the relevant user, developer, API, configuration, or workflow documentation whenever a feature or change affects it. Include migration, compatibility, and behavior details where applicable. Update `docs/CHANGELOG.md` for user-visible changes according to its existing format.
- Author diagrams as ```mermaid fences. The documentation site renders them, so there is no reason to fall back to ASCII art.
- Treat tests and documentation as part of the work, not optional follow-up. Include those changes in the same logical commit and PR as the behavior they describe.

## Project conventions

- Read `.github/CONTRIBUTING.md` and relevant package documentation before changing project workflows or public interfaces.
- Prefer existing project patterns and keep changes focused. Preserve unrelated working-tree changes.
- For editor/UI changes, manually verify the affected workflow and include visual evidence in the PR when useful. Call out effects on storage, import/export, grouping, and undo/redo behavior.
- Pull requests and commits must follow conventional commit format.

## Subagents

`.claude/agents/` defines this repository's own agents, so a session here does
not fall back on generic ones that know none of its gates: `implementer`
(test-first change work), `quality-gates` (runs the real verification and
reports what did not run), and `change-reviewer` (reviews a diff against the
failure modes this repository has actually produced). They record the cost of
getting things wrong here, not a restatement of the rules above.
`tests/docs/agent-definitions.test.mjs` fails if one names a script or a path
that no longer exists.

## Agent skills

### Issue tracker

GitHub Issues on `constructorfleet/SketchForge-3D` via the `gh` CLI, always with
an explicit `--repo` so nothing files against the `Formsmith746` upstream. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` and `docs/adr/`, both created lazily. See
`docs/agents/domain.md`.
