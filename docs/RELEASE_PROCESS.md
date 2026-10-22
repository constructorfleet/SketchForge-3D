---
slug: "/docs/RELEASE_PROCESS"
title: "Release process"
audience: "Contributors"
owner: "Contributors"
---

# Release process

SketchForge uses Conventional Commit pull request titles to drive releases.
The title is checked before merge because squash merging turns it into the
commit subject consumed by release-please. Use `feat:`, `fix:`, or another type
listed in `release-please-config.json`; a `!` or `BREAKING CHANGE:` footer marks
a breaking change.

## Version and release pull request

The root `package.json` version is the release authority. The engine, TypeScript
client, Python package, and `.release-please-manifest.json` must carry the same
version. Release Please reads `release-please-config.json` and opens or updates
a release pull request on `main`. It updates the publishing-client version table
in that pull request as part of its version bump. Review its version changes and
generated release notes, then merge that release pull request to publish the
release.

Release Please authenticates as the repository's release GitHub App, using the
`APP_ID` and `APP_KEY` secrets, rather than with the default workflow token.
GitHub starts no workflow run for an event created by its own token, so with
the default token the release pull request carried no check results and had to
be approved by hand before any ran. The app is installed on this repository
alone and holds write access only to contents and pull requests.

Because the tag is pushed by that app, it would also start any workflow with a
tag trigger. `release.yml` and `desktop-release.yml` are dispatched by
`release-please.yml` and therefore declare no tag trigger; adding one back
would publish every release twice.

`docs/CHANGELOG.md` is maintained separately from the generated GitHub release
notes. Add user-visible changes there as part of their feature or fix pull
request.

## Publishing

After Release Please creates the tag and GitHub release, the release workflow
dispatches the Docker and Python publishing workflow and the desktop installers
workflow. Dispatch is the only path that starts them. The Python package uses PyPI trusted publishing; the Docker image is
published for the release version. Desktop installers require the signing and
notarization secrets described in [repository setup](../.github/SETUP.md).
Check all three workflow runs and the release assets before announcing a
release. A GitHub release can exist while an artifact workflow is still failing.

The desktop workflow can also be run manually with a version, but this is for
recovery or explicitly requested desktop rebuilds. Normal application releases
start by merging the Release Please pull request.
