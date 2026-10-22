import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'packages/sketchforge-engine/src/support/lib/operator-configuration.json');
const outputPath = path.join(root, 'docs/OPERATOR_CONFIGURATION.md');
const { settings } = JSON.parse(await readFile(registryPath, 'utf8'));
const rows = settings.map((setting) => `| \`${setting.name}\` | ${escapeCell(setting.default)} | ${setting.required ? 'Yes' : 'No'} | ${escapeCell(setting.validation)} | ${setting.sensitive ? 'Yes' : 'No'} | ${escapeCell(setting.subsystem)} | ${ownerLinks(setting)} | ${sourceLinks(setting)} |`);
const markdown = [
  '# Public runtime configuration',
  '',
  'This reference covers supported public runtime settings for server/container deployments, TypeScript and Python API clients, and the local MCP bridge. Build-only, test-only, CI workflow, desktop development, and pass-through environment values are intentionally classified separately and are not presented as supported application runtime settings. The registry is maintained in `packages/sketchforge-engine/src/support/lib/operator-configuration.json`; regenerate this page with `node scripts/generate-operator-configuration.mjs`.',
  '',
  '`required` means required to enable the described optional feature; no setting is required for the application to start with its default behavior.',
  '',
  '| Name | Default | Required | Validation and behavior | Sensitive | Owning subsystem | Owner guide(s) | Source reader(s) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  '## Update settings',
  '',
  'The update status and server-triggered update settings are read by [`apps/web/src/app/api/app-update/route.ts`](../apps/web/src/app/api/app-update/route.ts). The version, manifest URL, and guide URL customize update information. Trigger URL, admin key, and trigger token enable the privileged update action; keep both credentials in deployment secrets and only configure a trigger endpoint you control.',
  '',
  '## Scope and limitations',
  '',
  'Compose uses `SKETCHFORGE_PORT` to choose the host port published to container port 3000. The Docker launcher currently validates `PORT` and `SKETCHFORGE_LEGACY_PORT`; invalid values fall back to their listed defaults. Other path and URL settings are validated or interpreted by their owning subsystem at runtime as described above. Keep secrets in the deployment secret store and avoid printing them in logs.',
  '',
  'The registry and documentation tests track the supported server/container, client, and local MCP runtime settings against their implementation readers. Each row links to all assigned owner pages and its authoritative reader or deployment declaration. Adding a supported runtime setting requires a registry row with a source and an owning guide; the docs verification fails when a setting in the tracked runtime reader surfaces has no row.',
  '',
  '## Environment values outside the supported runtime inventory',
  '',
  'Repository environment values also include build switches (such as `STATIC_EXPORT`, `SKETCHFORGE_DOCKER_BUILD`, and `NEXT_PUBLIC_STATIC_EXPORT`), test and performance inputs, CI workflow values, and values forwarded to child processes. These are build-only, test-only, CI-owned, or pass-through inputs; they are not application runtime settings in this supported inventory. Desktop shell configuration is an adjacent surface: `SKETCHFORGE_DESKTOP_PORT` is read by [`apps/desktop/main.cjs`](https://github.com/constructorfleet/SketchForge-3D/blob/main/apps/desktop/main.cjs), while `SKETCHFORGE_DESKTOP_DEV_URL` is injected by the development launcher. The current inventory covers server/container, client, and local MCP settings; a complete desktop configuration reference remains outside this slice.',
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
