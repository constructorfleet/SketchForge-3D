# Publishing the client libraries

Two packages are published from this repository, independently of the app's own version:

Both are published by `.github/workflows/release.yml`, from the same `v<version>` tag that releases the app itself:

| Package | Registry | Version |
| --- | --- | --- |
| `@constructorfleet/sketchforge3d` | npm | the release version |
| `sketchforge3d` | PyPI | the release version |

The clients carry the app's version rather than their own, so a user can reason about which client matches which server without a compatibility table. The workflow also runs from the Actions tab (`workflow_dispatch`) with the version typed in, and has switches there to publish only some of the three artifacts -- which is how to recover from a release where, say, the npm publish failed and the Docker image succeeded.

## How a release happens

Releases are driven from `main` by **release-please**, not by a tag typed by hand.

1. Every merge to `main` updates a standing **release pull request**, which carries the next version number -- worked out from the commit prefixes, so a `feat:` since the last release means a minor bump and a `fix:` a patch -- and the release notes for it. It bumps all three manifests together: the root `package.json`, the TypeScript client's, and the Python client's.
2. **Merging that pull request is the release.** release-please tags the merge commit `v<version>` and creates the GitHub release as a **draft**.
3. That tag triggers `release.yml` (Docker image, npm, PyPI) and `desktop-release.yml` (installers, attached to the same draft).
4. Publishing the draft is a human decision, and the last point at which a release can be reconsidered without burning a version number.

So the version number lives in the tree, committed by the release pull request, and the tag only points at it. `release.yml` checks all three manifests equal the tag and **stops before publishing if any disagree** -- which can only happen if a tag was made by hand or a manifest was edited after the release pull request merged.

The clients carry the app's version rather than their own, so a user can tell which client matches which server without a compatibility table.

### Why this way round

Before this, a `v*.*.*` tag built only the desktop installers, and the draft release was created by the *desktop* workflow -- so the release existed as a side effect of packaging an Electron app, and a code-signing failure on one platform meant no release at all. The Docker image was published from `main` with no version tag, and the clients had their own separate tags.

Inverting it makes the version change the cause and the artifacts the effect. The release pull request is also a better gate than a tag: it shows the version and the notes before anything is irreversible, and it is reviewable.

### Changelog

release-please is configured with `skip-changelog`, so it does **not** write `docs/CHANGELOG.md`. That file stays hand-written, because an entry that explains why a change was made is worth more than a list of commit subjects -- and the generated notes on the GitHub release cover the "what changed" need.

## What the owner has to configure

Neither of these can be set up from the repository; both need an account action.

### npm

1. Sign in to npmjs.com as the owner of the `@constructorfleet` scope.
2. **Access Tokens** -> **Generate New Token** -> **Granular Access Token** (classic "Automation" also works). Give it **Read and write** on packages in the `@constructorfleet` scope, and an expiry you are willing to rotate.
3. In GitHub, **Settings -> Secrets and variables -> Actions -> New repository secret**:
   - Name: `NPM_TOKEN`
   - Value: the token from step 2.

The package already carries `"publishConfig": { "access": "public" }`, which a scoped package needs or the first publish is refused as private. The workflow also passes `--access public` so the intent is visible in the log.

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

1. **Verify.** Resolves the version from the tag, runs `npm run ci` and the static export build, and checks all three manifests equal it. Nothing is published from a tree that does not pass its own checks: a bad release can only be superseded on npm and PyPI, never withdrawn.

2. **Docker image** to `ghcr.io`, tagged `v<version>`, `<version>`, `<major>.<minor>` and `latest`, for `linux/amd64` and `linux/arm64`. Pushes to `main` also move `latest`, which is pre-existing behaviour and left alone -- a deployment should pin a version tag.

3. **npm and PyPI**, in parallel.

The Actions tab can run this workflow by hand with the version typed in, and has switches to publish only some of the three artifacts -- which is how to recover from a release where, say, npm failed and the Docker image succeeded.
