# Contributing

Thanks for helping improve SketchForge.

## Local Setup

```bash
npm install
npm run dev
```

The app runs at `http://127.0.0.1:3000/` by default.

## Before Opening a Pull Request

- Keep changes focused.
- Avoid unrelated refactors.
- Follow test-driven development: add or update a focused test first, confirm it fails for the expected reason, implement the change, then rerun it.
- Run the relevant automated tests and quality checks, including `npm run typecheck`; use `npm run test`, `npm run test:e2e`, `npm run test:integration`, and `npm run build` as appropriate to the affected area.
- Manually test the editor workflow you changed.
- Include screenshots or short recordings for UI changes when possible.
- Call out changes to storage, import, export, grouping, or undo/redo behavior.
- Update the relevant roadmap and documentation for every feature or behavior change. Add user-visible changes to `docs/CHANGELOG.md` using its existing format.
- If a Markdown file declares `verified_delivery: contract` in its frontmatter, `npm run docs:verify` lints it as an acceptance contract. Structural problems fail the check; vague wording is reported as a warning without failing it. Unmarked documents are untouched.
- Commit each coherent unit of work atomically, including its tests and documentation. Open separate PRs for independent, reviewable chunks.
- Monitor each PR for merge conflicts, review feedback, and failing or pending checks through merge or explicit handoff. Resolve conflicts and failures, push fixes, and recheck the PR; report unresolved blockers and pending checks accurately.
- You do not need to rebase a PR just because `main` moved. After every merge, `.github/workflows/pr-auto-rebase.yml` rebases each same-repository PR that now conflicts and force-pushes it with a lease; fetch before pushing to that branch again. `docs/CHANGELOG.md` merges with git's union driver (`.gitattributes`), so two PRs adding entries under `## Unreleased` keep both instead of conflicting. A PR that also conflicts elsewhere gets a comment naming the files. To rebase locally the same way, run `node scripts/rebase-pr.mjs --branch <branch> [--push]`.
- Pushing to a PR cancels that PR's unfinished CI, docs, link-check and title runs for the older commit, and a newer trusted-checks dispatch cancels the older one. Merging or closing a PR cancels its remaining runs (`.github/workflows/cancel-closed-pr-runs.yml`). CI and docs runs on `main` are not cancelled, nor are the release and content-deploy workflows. A check on a superseded commit therefore shows as cancelled rather than failed; only the newest commit's checks count.
- Merging your PR does not publish a release by itself. The standing release-please pull request is merged every four hours by `.github/workflows/release-auto-merge.yml` once its checks pass and `main` has been quiet for 30 minutes, so a burst of merges ships as one release. Add the `release: hold` label to that pull request, or set the repository variable `RELEASE_AUTO_MERGE` to `false`, to hold it; see `docs/PUBLISHING_CLIENTS.md`.
- A PR that changes only documentation skips the code jobs in `ci.yml` and the Docker smoke test; they show as skipped, which satisfies required checks, and the docs workflow still runs. Files a code job's tests read (`README.md`, `docs/REST_API.md`, the generated references, `docs/packages/`, `docs/examples/`, `docs/openapi-v1.json`) count as code; `scripts/ci/classify-changes.mjs` holds the rule.

## Areas That Need Care

- STL import/export
- Imported mesh transforms
- Grouping, hole subtraction, and ungrouping
- Undo/redo history
- Project persistence and dashboard thumbnails
- Shape gizmos, snapping, and rotated-object dimensions

## Style

- Prefer existing project patterns before adding new abstractions.
- Keep UI behavior local to the relevant component unless the behavior is shared.
- Use TypeScript types instead of loose object shapes where practical.
- Keep comments short and useful.

## Contribution Licensing

Unless explicitly agreed otherwise in writing, by submitting a contribution you license it under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](../LICENSE).
