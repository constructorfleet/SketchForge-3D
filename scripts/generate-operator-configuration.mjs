import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'packages/sketchforge-engine/src/support/lib/operator-configuration.json');
const outputPath = path.join(root, 'docs/OPERATOR_CONFIGURATION.md');
const { settings } = JSON.parse(await readFile(registryPath, 'utf8'));
const rows = settings.map((setting) => `| \`${setting.name}\` | ${escapeCell(setting.default)} | ${setting.required ? 'Yes' : 'No'} | ${escapeCell(setting.validation)} | ${setting.sensitive ? 'Yes' : 'No'} | ${escapeCell(setting.subsystem)} | ${ownerLinks(setting)} | ${sourceLinks(setting)} |`);
const markdown = [
  '---',
  'slug: /docs/OPERATOR_CONFIGURATION',
  'title: Public runtime configuration',
  'audience: Operators',
  'owner: Operations',
  'sources:',
  '  - apps/desktop/**',
  '  - packages/sketchforge-engine/src/support/**',
  '  - packages/sketchforge-client/src/**',
  '  - packages/sketchforge-client/mcp/**',
  '  - packages/sketchforge-py/src/**',
  '---',
  '',
  '# Public runtime configuration',
  '',
  'This reference covers supported public runtime settings for server/container deployments, the desktop app, TypeScript and Python API clients, and the local MCP bridge. Build-only, test-only, CI workflow, launcher handoff, and pass-through environment values are intentionally classified separately and are not presented as supported application runtime settings. The registry is maintained in `packages/sketchforge-engine/src/support/lib/operator-configuration.json`; regenerate this page with `node scripts/generate-operator-configuration.mjs`.',
  '',
  '`required` means required to enable the described optional feature; no setting is required for the application to start with its default behavior.',
  '',
  '| Name | Default | Required | Validation and behavior | Sensitive | Owning subsystem | Owner guide(s) | Source reader(s) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  '## Desktop settings',
  '',
  '`SKETCHFORGE_DESKTOP_PORT` selects the loopback port used by the packaged desktop app. Browser storage is scoped to the full origin, including its port; changing this value makes projects saved under the previous port appear in a different storage origin. The desktop development launcher injects `SKETCHFORGE_DESKTOP_DEV_URL` as an internal handoff to its temporary web server; it is not a user setting. `NODE_PATH` is forwarded to the packaged child process and is not a SketchForge desktop setting.',
  '',
  '## Update settings',
  '',
  'The update status and update settings are read by [`apps/web/src/app/api/app-update/route.ts`](../apps/web/src/app/api/app-update/route.ts). The version, manifest URL, and guide URL customize update information. The privileged update action has two modes. Server mode posts to the trigger URL and needs both the trigger URL and the admin key; the trigger token authenticates SketchForge to that endpoint. Local mode applies when the server runs from a git checkout and the request is addressed to `localhost`: it runs `git fetch`, `git merge --ff-only`, and `npm install` in the checkout and restarts the dev server. Local mode needs `SKETCHFORGE_LOCAL_UPDATE=1` or the admin key, and refuses with 403 when neither is set. The route cannot see the caller\'s address, and the `localhost` test reads the client-controlled Host header, so set `SKETCHFORGE_LOCAL_UPDATE` only on a server that listens on loopback alone. Keep both credentials in deployment secrets and only configure a trigger endpoint you control. The packaged desktop app uses its own updater and none of these settings affect it.',
  '',
  '## Scope and limitations',
  '',
  'Compose uses `SKETCHFORGE_PORT` to choose the host port published to container port 3000. The Docker launcher currently validates `PORT` and `SKETCHFORGE_LEGACY_PORT`; invalid values fall back to their listed defaults. Other path and URL settings are validated or interpreted by their owning subsystem at runtime as described above. Keep secrets in the deployment secret store and avoid printing them in logs.',
  '',
  'The registry and documentation tests track supported server/container, desktop, client, and local MCP runtime settings against their implementation readers. Each row links to all assigned owner pages and its authoritative reader or deployment declaration. Adding a supported runtime setting requires a registry row with a source and an owning guide; the docs verification fails when a setting in the tracked runtime reader surfaces has no row.',
  '',
  '## Environment values outside the supported runtime inventory',
  '',
  'Repository environment values also include build switches (such as `STATIC_EXPORT`, `SKETCHFORGE_DOCKER_BUILD`, and `NEXT_PUBLIC_STATIC_EXPORT`), test and performance inputs, CI workflow values, and values forwarded to child processes. These are build-only, test-only, CI-owned, launcher handoff, or pass-through inputs; they are not supported application settings in this inventory.',
  '',
].join('\n');

if (process.argv.includes('--stdout')) {
  process.stdout.write(markdown);
} else if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== markdown) {
    console.error(`${path.relative(root, outputPath)} is stale; run node scripts/generate-operator-configuration.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`${path.relative(root, outputPath)} is current`);
  }
} else {
  await writeFile(outputPath, markdown);
  console.log(`Generated ${path.relative(root, outputPath)}`);
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function ownerLinks(setting) {
  return [setting.ownerPage, ...(setting.additionalOwnerPages ?? [])]
    .map((page, index) => `[${index === 0 ? `${setting.subsystem} guide` : 'additional guide'}](${page})`)
    .join('<br>');
}

function sourceLinks(setting) {
  return [setting.source, ...(setting.additionalSources ?? [])]
    .map((source) => `[${source}](${sourceUrl(source)})`)
    .join('<br>');
}

function sourceUrl(relativePath) {
  return `https://github.com/constructorfleet/SketchForge-3D/blob/main/${relativePath.replace(/^\.\.\//, '')}`;
}
