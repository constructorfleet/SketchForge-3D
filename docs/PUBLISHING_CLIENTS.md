---
slug: "/docs/PUBLISHING_CLIENTS"
title: "Publishing the client libraries"
audience: "Contributors"
owner: "Packages"
sources:
  - ".release-please-manifest.json"
  - "packages/sketchforge-client/package.json"
  - "packages/sketchforge-engine/package.json"
  - "packages/sketchforge-py/pyproject.toml"
---

# Publishing the client libraries

Three packages are published from this repository, independently of the app's own version:

All three are published by `.github/workflows/release.yml`, from the same `v<version>` tag that releases the app itself:

| Package | Registry | Version |
| --- | --- | --- |
<!-- publishing-version-table:start -->
| `@constructorfleet/sketchforge3d` | npm | `1.29.1` | <!-- x-release-please-version -->
| `@constructorfleet/sketchforge-engine` | npm | `1.29.1` | <!-- x-release-please-version -->
| `sketchforge3d` | PyPI | `1.29.1` | <!-- x-release-please-version -->
<!-- publishing-version-table:end -->

The table is generated from `.release-please-manifest.json`, the release-please source of truth, after verifying that the app, engine, TypeScript client, and Python package manifests all match it. Release Please updates its marked version rows in each release pull request; regenerate locally with `node scripts/docs/generate-publishing-clients.mjs`. `npm run docs:check` detects stale versions.

The packages carry the app's version rather than their own. The npm job publishes `@constructorfleet/sketchforge-engine` before `@constructorfleet/sketchforge3d`, whose local MCP mode depends on that exact engine version. The workflow also runs from the Actions tab (`workflow_dispatch`) with the version typed in, and has switches there to publish only some artifacts -- which is how to recover from a release where one registry upload failed after the Docker image succeeded.

## How a release happens

Releases are driven from `main` by **release-please**, not by a tag typed by hand.

1. Every merge to `main` updates a standing **release pull request**, which carries the next version number -- worked out from the commit prefixes, so a `feat:` since the last release means a minor bump and a `fix:` a patch -- and the release notes for it. It bumps the root, engine, TypeScript client, and Python package versions together, along with the TypeScript client's exact engine dependency.
2. **Merging that pull request is the release.** release-please tags the merge commit `v<version>` and creates the GitHub release.
3. The same workflow then publishes what the release consists of: it dispatches `release.yml` (Docker image, npm, PyPI) and `desktop-release.yml` (installers, attached to the release), passing the version to each.

The publishing is driven from `release-please.yml` rather than from the tag, and that is not a preference. **A tag pushed by a workflow using `GITHUB_TOKEN` does not start another workflow run** -- GitHub suppresses that to avoid recursion -- so no amount of tag-trigger tuning would have worked. `workflow_run` would also bridge the gap, since it fires on another workflow finishing whoever started it, but a listener would have to re-derive the version and whether a release happened from an artifact or the API and filter out every run that released nothing, where a dispatch simply passes both.

Both are **dispatched**, not called with `uses:`. `release.yml` was a reusable workflow at first, and the PyPI publish failed on every release: PyPI's trusted publishing verifies the OIDC claim of the **top-level** workflow, so the upload arrived identifying itself as `release-please.yml` and was rejected -- "Invalid attestations supplied during upload ... does not match expected Trusted Publisher (release.yml @ ...)". PyPI [does not support reusable workflows](https://docs.pypi.org/trusted-publishers/troubleshooting/#reusable-workflows-on-github) for trusted publishing at all. A dispatched run is its own top-level run, so the claim matches what is registered on PyPI, and `release.yml` deliberately carries no `workflow_call` trigger so this cannot come back by accident.

The cost of dispatching is that `release-please.yml` finishes without knowing whether the publishing succeeded -- the runs are separate, and the Actions tab is where their results are. The draft release is the gate that matters: it is not published until the artifacts are attached and checked.

So the version number lives in the tree, committed by the release pull request, and the tag only points at it. `release.yml` checks all four package manifests and the engine dependency equal the tag and **stops before publishing if any disagree** -- which can only happen if a tag was made by hand or a manifest was edited after the release pull request merged.

The clients carry the app's version rather than their own, so a user can tell which client matches which server without a compatibility table.

### Merging the release pull request on a schedule

Nobody has to remember to merge the release pull request. `.github/workflows/release-auto-merge.yml` runs every four hours (at 17 minutes past) and merges it when it is safe to, using the release app's token. A merge made with `GITHUB_TOKEN` would start no workflow run, so `release-please.yml` would never run on the merge commit and nothing would be tagged or published. The merge is a squash merge pinned to the head commit that was checked, and it goes through the `main` ruleset like any other merge; it never uses `--admin`.

`scripts/release/auto-merge-release-pr.mjs` makes the decision. It merges only when all of these hold, and otherwise writes the reason to the run summary and stops without failing:

- there is exactly one open, non-draft pull request labelled `autorelease: pending`, opened by the release app from a `release-please--` branch into `main`;
- the release is not on hold (see below);
- the pull request is not behind `main`, so release-please has refreshed it since the latest merge;
- every check run and commit status on its head commit has finished as success, skipped or neutral, and every check the `main` ruleset requires is among them (the list is read from the ruleset, or from a built-in copy if the ruleset cannot be read);
- nothing has merged to `main` in the last 30 minutes, so a burst of merges goes out as one release;
- no `release-please.yml`, `release.yml` or `desktop-release.yml` run is queued or in progress.

To hold releases:

- for one release, add the `release: hold` label to the release pull request, and remove it to let the next run merge;
- for all releases, set the repository variable `RELEASE_AUTO_MERGE` to `false` (**Settings -> Secrets and variables -> Actions -> Variables**). Delete the variable, or set it to anything else, to resume.

Merging the release pull request by hand still works and is still the release.

To run the check now rather than wait, start the workflow from the Actions tab, or:

<!-- runnable-exempt: Dispatching this can merge the release pull request, which publishes a release; it is a maintainer command, not a repository example. -->
```sh
gh workflow run release-auto-merge.yml --repo constructorfleet/SketchForge-3D -f dry_run=true
```

With `dry_run=true` it reports what it would do and merges nothing; leave it out to merge. Locally, `node scripts/release/auto-merge-release-pr.mjs --dry-run` makes the same decision with your own `gh` login. It only reads, and never merges.

### Why this way round

Before this, a `v*.*.*` tag built only the desktop installers, and the draft release was created by the *desktop* workflow -- so the release existed as a side effect of packaging an Electron app, and a code-signing failure on one platform meant no release at all. The Docker image was published from `main` with no version tag, and the clients had their own separate tags.

Inverting it makes the version change the cause and the artifacts the effect. The release pull request is also a better gate than a tag: it shows the version and the notes before anything is irreversible, and it is reviewable.

### The release is not a draft

It was, in the first version of this, and that was a mistake worth recording: **GitHub does not create the git tag for a draft release.** The tag appears only when the release is published, so a draft release leaves nothing for anything downstream to key on -- `git ls-remote --tags` comes back empty. Combined with the component-prefixed tag name release-please produces when a `package-name` is set without `include-component-in-tag: false`, the first 1.1.0 release produced a draft called `sketchforge-v1.1.0`, no tag at all, and no artifacts.

The release pull request is the gate instead, which is the better place for one: it is reviewable, and nothing is irreversible until it merges.

### Conventional commits are required

release-please works out the next version from commit subjects, so they have to be conventional: `feat:` for a minor bump, `fix:` for a patch, `feat!:` or a `BREAKING CHANGE:` footer for a major. Types it does not recognise -- `release:`, which upstream uses -- contribute nothing, and a release with only `chore:` and `refactor:` commits produces no release pull request at all. That is the expected behaviour, not a fault.

Because this repository squash-merges with the **pull request title** as the commit subject (`squash_merge_commit_title: PR_TITLE`, with the commit messages kept as the body), the title is what release-please ends up reading. `.github/workflows/pr-title.yml` fails a pull request whose title is not conventional, for exactly that reason -- the failure it prevents is silent, since a title release-please cannot parse does not error anywhere, it just releases nothing.

Note also that this repository has **no release tags on the remote**. release-please takes the last released version from `.release-please-manifest.json`, which is why that file matters and why a hand-edited version there would misdirect the next release.

### Changelog

release-please is configured with `skip-changelog`, so it does **not** write `docs/CHANGELOG.md`. That file stays hand-written, because an entry that explains why a change was made is worth more than a list of commit subjects -- and the generated notes on the GitHub release cover the "what changed" need.

## What the owner has to configure

Neither of these can be set up from the repository; both need an account action.

### npm

1. Sign in to npmjs.com as an owner of the `@constructorfleet` scope.
2. **Access Tokens** -> **Generate New Token** -> **Granular Access Token** (classic "Automation" also works). Give it **Read and write** on packages in the `@constructorfleet` scope, and an expiry you are willing to rotate.
3. In GitHub, **Settings -> Secrets and variables -> Actions -> New repository secret**:
   - Name: `NPM_TOKEN`
   - Value: the token from step 2.

The package already carries `"publishConfig": { "access": "public" }`, which a scoped package needs or the first publish is refused as private. The workflow also passes `--access public` so the intent is visible in the log.

**The token has to be one that does not need a one-time password.** A classic *Publish* token on an account with two-factor authentication enforced for writes fails the publish with `npm error code EOTP -- This operation requires a one-time password from your authenticator`, which is what happened on the 1.2.0 release: the tarball was built, the provenance statement was signed and logged, and only the upload was refused. A **Granular Access Token** or a classic **Automation** token is exempt from the one-time password, which is the whole point of that type. Regenerate `NPM_TOKEN` as one of those if you see `EOTP`.

Provenance (`--provenance`) needs `id-token: write`, which the workflow has, and a public repository. On a private repository npm rejects the provenance flag; drop that flag to publish without it.

### PyPI (trusted publishing, no secret)

1. Sign in to pypi.org as the owner.
2. **Your projects** (or **Publishing** for a name not yet registered) -> **Add a pending publisher**, and enter exactly:
   - **PyPI project name**: `sketchforge3d`
   - **Owner**: `constructorfleet`
   - **Repository name**: `SketchForge-3D`
   - **Workflow name**: `release.yml`
   - **Environment name**: `pypi`
3. In GitHub, **Settings -> Environments -> New environment**, named `pypi`. Nothing needs to go in it; the workflow declares `environment: pypi` so the name must exist and so a reviewer can be required later if you want one.

No API token is involved: PyPI verifies the workflow's OIDC identity at publish time. All five fields must match exactly -- a mismatch in any of them is rejected as an untrusted publisher.

PyPI normalises a project name by collapsing runs of `-`, `_` and `.`, but it does not remove them, so `sketchforge3d` and `sketchforge-3d` are different projects. The name is `sketchforge3d`, with no separator. (`sketchforge` alone is taken by an unrelated project.)

## What is verified, and what is not

Verified locally: both packages build, their unit tests pass with the same commands the workflow runs, the release notes are extracted from the changelog's Unreleased section as expected, and the npm publish step was checked with `npm publish --dry-run`, which packs the tarball and reports its contents without contacting the registry.

**Not verified, and unverifiable from here**: the publishes themselves. A real publish is irreversible, the `NPM_TOKEN` secret does not exist yet, and the PyPI trusted publisher has not been created -- so the first run of each workflow is the first time its credentials are exercised. Expect to debug the first release, and prefer a `workflow_dispatch` run of a patch version over a tag for it.

## What `release.yml` does, in order

1. **Verify.** Resolves the version from the tag, runs `npm run ci` and the static export build, and checks all four package manifests and the client engine dependency equal it. Nothing is published from a tree that does not pass its own checks: a bad release can only be superseded on npm and PyPI, never withdrawn.

2. **Docker image** to `ghcr.io`, tagged `v<version>`, `<version>`, `<major>.<minor>` and `latest`, for `linux/amd64` and `linux/arm64`. A release is now the only thing that moves `latest`. `docker.yml` still builds every push to `main`, but publishes it only as the `main` tag and by short SHA -- previously it moved `latest` too, so two workflows fought over that tag and `latest` meant "newest commit" for Docker while meaning "newest release" everywhere else.

3. **npm and PyPI**, in parallel. The npm job publishes the engine first and the MCP client second; dispatch inputs can skip either upload when recovering from a partial publish.

The Actions tab can run this workflow by hand with the version typed in, and has switches to publish only some of the three artifacts -- which is how to recover from a release where, say, npm failed and the Docker image succeeded.
