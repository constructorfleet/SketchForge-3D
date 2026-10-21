import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'packages/sketchforge-engine/src/support/lib/operator-configuration.json');
const outputPath = path.join(root, 'docs/OPERATOR_CONFIGURATION.md');
const { settings } = JSON.parse(await readFile(registryPath, 'utf8'));
const rows = settings.map((setting) => `| \`${setting.name}\` | ${escapeCell(setting.default)} | ${setting.required ? 'Yes' : 'No'} | ${escapeCell(setting.validation)} | ${setting.sensitive ? 'Yes' : 'No'} | ${escapeCell(setting.subsystem)} |`);
const markdown = [
  '# Operator configuration',
  '',
  'This reference covers public settings for server and container operators. Build, test, development, and internal runtime flags are intentionally excluded. The registry is maintained in `packages/sketchforge-engine/src/support/lib/operator-configuration.json`; regenerate this page with `node scripts/generate-operator-configuration.mjs`.',
  '',
  '`required` means required to enable the described optional feature; no setting is required for the application to start with its default behavior.',
  '',
  '| Name | Default | Required | Validation and behavior | Sensitive | Owning subsystem |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  '## Scope and limitations',
  '',
  'Compose uses `SKETCHFORGE_PORT` to choose the host port published to container port 3000. The Docker launcher currently validates `PORT` and `SKETCHFORGE_LEGACY_PORT`; invalid values fall back to their listed defaults. Other path and URL settings are validated or interpreted by their owning subsystem at runtime as described above. Keep secrets in the deployment secret store and avoid printing them in logs.',
  '',
  'The reference covers supported public server/container configuration found in the current readers and deployment examples. It does not claim to inventory every environment variable used by build tooling, tests, desktop development, or the browser editor.',
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
