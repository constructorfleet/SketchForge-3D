import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('generated operator configuration reference is current', async () => {
  const expected = execFileSync(process.execPath, ['scripts/generate-operator-configuration.mjs', '--stdout'], { cwd: root, encoding: 'utf8' });
  assert.equal(await source('docs/OPERATOR_CONFIGURATION.md'), expected);
});

test('public configuration registry agrees with the server and container readers', async () => {
  const registry = JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json'));
  const readers = [
    await source('deploy/docker/start-server.mjs'),
    await source('packages/sketchforge-engine/src/support/lib/serverProjectStore.ts'),
    await source('apps/web/src/lib/apiTokens.ts'),
    await source('apps/web/src/app/api/shared-projects/route.ts'),
    await source('apps/web/src/app/api/app-update/route.ts'),
    await source('deploy/docker/Dockerfile'),
    await source('deploy/docker/compose.yaml'),
  ].join('\n');
  const names = registry.settings.map((setting) => setting.name);
  assert.equal(new Set(names).size, names.length, 'setting names must be unique');
  for (const setting of registry.settings) {
    assert.equal(typeof setting.default, 'string', `${setting.name} needs a default description`);
    assert.equal(typeof setting.required, 'boolean', `${setting.name} needs required state`);
    assert.equal(typeof setting.validation, 'string', `${setting.name} needs validation details`);
    assert.equal(typeof setting.sensitive, 'boolean', `${setting.name} needs sensitivity state`);
    assert.equal(typeof setting.subsystem, 'string', `${setting.name} needs an owning subsystem`);
    assert.ok(readers.includes(setting.name), `${setting.name} is not found in an authoritative reader or deployment example`);
  }
  assert.match(await source('packages/sketchforge-engine/src/support/lib/serverProjectStore.ts'), /operatorSettingName\("SKETCHFORGE_PROJECTS_DIR"\)/);
  assert.match(await source('apps/web/src/lib/apiTokens.ts'), /operatorSettingName\("SKETCHFORGE_API_TOKEN"\)/);
  assert.match(await source('apps/web/src/app/api/shared-projects/route.ts'), /operatorSettingName\("SKETCHFORGE_SHARED_PROJECTS_DIR"\)/);
});
