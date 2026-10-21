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
  '| Name | Default | Required | Validation and behavior | Sensitive | Owning subsystem | Owner guide | Source reader |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...settings.map((setting, index) => `${rows[index]} [${setting.subsystem} guide](${setting.ownerPage}) | [${setting.source}](${sourceUrl(setting.source)}) |`),
  '',
  '## Update settings',
  '',
  'The update status and server-triggered update settings are read by [`apps/web/src/app/api/app-update/route.ts`](../apps/web/src/app/api/app-update/route.ts). The version, manifest URL, and guide URL customize update information. Trigger URL, admin key, and trigger token enable the privileged update action; keep both credentials in deployment secrets and only configure a trigger endpoint you control.',
  '',
  '## Scope and limitations',
  '',
  'Compose uses `SKETCHFORGE_PORT` to choose the host port published to container port 3000. The Docker launcher currently validates `PORT` and `SKETCHFORGE_LEGACY_PORT`; invalid values fall back to their listed defaults. Other path and URL settings are validated or interpreted by their owning subsystem at runtime as described above. Keep secrets in the deployment secret store and avoid printing them in logs.',
  '',
  'This table covers supported public server/container settings represented by the operator registry. Each row links to the user guide that owns the setting and to its implementation reader or deployment declaration. The current inventory does not claim that every environment value read anywhere in the repository is supported configuration.',
  '',
  '## Configuration outside this registry',
  '',
  'The JavaScript and Python macro clients also read `SKETCHFORGE_URL`, `SKETCHFORGE_API_TOKEN`, and `SKETCHFORGE_PROJECT_ID`; their command-line behavior is described in the [CLI reference](./CLI_REFERENCE.md) and package guides. Local MCP mode reads `SKETCHFORGE_PROJECTS_DIR`, while macro execution reads `SKETCHFORGE_MACRO_DIR`; see the [MCP tool reference](./mcp/TOOLS_REFERENCE.md) and client package guides. Those client settings have not yet been joined to this registry or checked for complete page ownership.',
  '',
  'Desktop development/packaging, build and deployment switches, test-only settings, and compile-time browser flags are separate operational inputs. For example, `apps/desktop/dev.mjs`, `apps/web/next.config.ts`, and `apps/web/src/components/SketchForgeEditor.tsx` read environment values outside this operator registry. They are not presented as supported operator settings here. A repository-wide reader inventory and source-to-page ownership check remain open work.',
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

function sourceUrl(relativePath) {
  return `https://github.com/constructorfleet/SketchForge-3D/blob/main/${relativePath.replace(/^\.\.\//, '')}`;
}
