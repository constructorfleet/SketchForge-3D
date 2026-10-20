# Publishing the client libraries

Two packages are published from this repository, independently of the app's own version:

| Package | Registry | Workflow | Tag |
| --- | --- | --- | --- |
| `@constructorfleet/sketchforge3d` | npm | `.github/workflows/client-npm-release.yml` | `client-js-v<version>` |
| `sketchforge3d` | PyPI | `.github/workflows/client-pypi-release.yml` | `client-py-v<version>` |

Both workflows also run from the Actions tab (`workflow_dispatch`) with the version typed in, for a release that does not start from a tag.

## Where the version comes from

**The manifest is the version of record** -- `packages/sketchforge-client/package.json` and `packages/sketchforge-py/pyproject.toml`. The tag is only a pointer at it. Each workflow reads the manifest, strips the prefix from the tag (or the dispatch input), and **fails before publishing if the two disagree**, rather than shipping a version nobody asked for.

The manifest was chosen over the tag because it is what actually gets published, what `npm view` and PyPI display, and what a developer reading the repository sees. Deriving the version from the tag would mean the file in the tree is wrong until a release rewrites it.

To release: bump the manifest, commit, then tag that commit `client-js-v0.1.1` (or `client-py-v0.1.1`) and push the tag.

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
   - **Workflow name**: `client-pypi-release.yml`
   - **Environment name**: `pypi`
3. In GitHub, **Settings -> Environments -> New environment**, named `pypi`. Nothing needs to go in it; the workflow declares `environment: pypi` so the name must exist and so a reviewer can be required later if you want one.

No API token is involved: PyPI verifies the workflow's OIDC identity at publish time. All five fields must match exactly -- a mismatch in any of them is rejected as an untrusted publisher.

PyPI normalises a project name by collapsing runs of `-`, `_` and `.`, but it does not remove them, so `sketchforge3d` and `sketchforge-3d` are different projects. The name is `sketchforge3d`, with no separator. (`sketchforge` alone is taken by an unrelated project.)

## What is verified, and what is not

Verified locally: both packages build, their unit tests pass with the same commands the workflows run, and the YAML parses. The npm workflow's publish step was checked with `npm publish --dry-run`, which packs the tarball and reports its contents without contacting the registry.

**Not verified, and unverifiable from here**: the publishes themselves. A real publish is irreversible, the `NPM_TOKEN` secret does not exist yet, and the PyPI trusted publisher has not been created -- so the first run of each workflow is the first time its credentials are exercised. Expect to debug the first release, and prefer a `workflow_dispatch` run of a patch version over a tag for it.
