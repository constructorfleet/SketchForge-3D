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

`docs/CHANGELOG.md` is maintained separately from the generated GitHub release
notes. Add user-visible changes there as part of their feature or fix pull
request.

## Publishing

After Release Please creates the tag and GitHub release, the release workflow
dispatches the Docker and Python publishing workflow and the desktop installers
workflow. The Python package uses PyPI trusted publishing; the Docker image is
published for the release version. Desktop installers require the signing and
notarization secrets described in [repository setup](../.github/SETUP.md).
Check all three workflow runs and the release assets before announcing a
release. A GitHub release can exist while an artifact workflow is still failing.

The desktop workflow can also be run manually with a version, but this is for
recovery or explicitly requested desktop rebuilds. Normal application releases
start by merging the Release Please pull request.
