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

test('public configuration registry agrees with server, container, client, MCP, and desktop readers', async () => {
  const registry = JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json'));
  const readers = [
    await source('deploy/docker/start-server.mjs'),
    await source('packages/sketchforge-engine/src/support/lib/serverProjectStore.ts'),
    await source('apps/web/src/lib/apiTokens.ts'),
    await source('apps/web/src/app/api/shared-projects/route.ts'),
    await source('apps/web/src/app/api/app-update/route.ts'),
    await source('deploy/docker/Dockerfile'),
    await source('deploy/docker/compose.yaml'),
    await source('packages/sketchforge-client/src/environment.ts'),
    await source('packages/sketchforge-py/src/sketchforge3d/environment.py'),
    await source('packages/sketchforge-client/mcp/localEngine.mjs'),
    await source('packages/sketchforge-client/mcp/localMacroRunner.mjs'),
    await source('packages/sketchforge-client/mcp/macroTools.mjs'),
    await source('packages/sketchforge-client/mcp/server.mjs'),
    await source('apps/desktop/main.cjs'),
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
    assert.equal(typeof setting.source, 'string', `${setting.name} needs a source reader path`);
    assert.equal(typeof setting.ownerPage, 'string', `${setting.name} needs an owning documentation page`);
    for (const readerPath of [setting.source, ...(setting.additionalSources ?? [])]) {
      assert.ok(await exists(`docs/${readerPath}`), `${setting.name} source reader docs/${readerPath} must exist`);
      assert.ok((await source(`docs/${readerPath}`)).includes(setting.name), `${setting.name} must appear in its declared authoritative reader ${readerPath}`);
    }
    for (const ownerPage of [setting.ownerPage, ...(setting.additionalOwnerPages ?? [])]) {
      assert.ok(await exists(`docs/${ownerPage.split('#')[0]}`), `${setting.name} owner page docs/${ownerPage} must exist`);
      const [ownerFile, ownerAnchor] = ownerPage.split('#');
      if (ownerAnchor) {
        const ownerContent = await source(`docs/${ownerFile}`);
        assert.ok(ownerContent.split('\n').some((line) => line.startsWith('#') && line.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-') === ownerAnchor), `${setting.name} owner anchor #${ownerAnchor} must exist`);
      }
    }
  }
  assert.match(await source('packages/sketchforge-engine/src/support/lib/serverProjectStore.ts'), /operatorSettingName\("SKETCHFORGE_PROJECTS_DIR"\)/);
  assert.match(await source('apps/web/src/lib/apiTokens.ts'), /operatorSettingName\("SKETCHFORGE_API_TOKEN"\)/);
  assert.match(await source('apps/web/src/app/api/shared-projects/route.ts'), /operatorSettingName\("SKETCHFORGE_SHARED_PROJECTS_DIR"\)/);
});

test('public client and MCP runtime settings have an owner and appear in the inventory', async () => {
  const registry = JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json'));
  const byName = new Map(registry.settings.map((setting) => [setting.name, setting]));
  const runtimeReaders = [
    'packages/sketchforge-client/src/environment.ts',
    'packages/sketchforge-py/src/sketchforge3d/environment.py',
    'packages/sketchforge-client/mcp/localEngine.mjs',
    'packages/sketchforge-client/mcp/localMacroRunner.mjs',
    'packages/sketchforge-client/mcp/macroTools.mjs',
    'packages/sketchforge-client/mcp/server.mjs',
  ];
  const readerText = (await Promise.all(runtimeReaders.map(source))).join('\n');
  const discovered = [...new Set(readerText.match(/SKETCHFORGE_[A-Z0-9_]+/g) ?? [])].sort();
  const declared = [...byName.keys()].filter((name) => discovered.includes(name)).sort();
  assert.deepEqual(declared, discovered, 'every public client and MCP runtime setting must have a registry row');

  for (const name of [
    'SKETCHFORGE_URL',
    'SKETCHFORGE_API_TOKEN',
    'SKETCHFORGE_PROJECT_ID',
    'SKETCHFORGE_PROJECTS_DIR',
    'SKETCHFORGE_MACRO_DIR',
    'SKETCHFORGE_MACRO_TIMEOUT_MS',
    'SKETCHFORGE_MACRO_PYTHON',
    'SKETCHFORGE_MACRO_RUNNER_JS',
  ]) {
    const setting = byName.get(name);
    assert.ok(setting, `${name} must be present in the public configuration inventory`);
    assert.ok(setting.ownerPage, `${name} needs an owning guide`);
    assert.ok(setting.source, `${name} needs an authoritative reader`);
  }
});

test('desktop runtime settings have explicit ownership while the development URL stays an internal handoff', async () => {
  const registry = JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json'));
  const byName = new Map(registry.settings.map((setting) => [setting.name, setting]));
  const main = await source('apps/desktop/main.cjs');
  const devLauncher = await source('apps/desktop/dev.mjs');
  const desktopReaders = `${main}\n${devLauncher}`;
  const discovered = [...new Set(desktopReaders.match(/process\.env\.([A-Z][A-Z0-9_]*)/g) ?? [])]
    .map((reference) => reference.slice('process.env.'.length))
    .sort();

  assert.deepEqual(discovered, ['NODE_PATH', 'SKETCHFORGE_DESKTOP_DEV_URL', 'SKETCHFORGE_DESKTOP_PORT']);
  assert.ok(main.includes('process.env.NODE_PATH'), 'NODE_PATH is only forwarded to the packaged child process');
  assert.ok(devLauncher.includes('SKETCHFORGE_DESKTOP_DEV_URL: url'), 'development URL must remain a launcher-injected internal handoff');

  const supported = ['SKETCHFORGE_DESKTOP_PORT', 'SKETCHFORGE_LOCAL_DOWNLOAD_ROOT'];
  for (const name of supported) {
    const setting = byName.get(name);
    assert.ok(setting, `${name} must have a desktop configuration registry row`);
    assert.equal(setting.ownerPage, 'OPERATOR_CONFIGURATION.md#desktop-settings', `${name} must link the desktop settings guide`);
  }
  assert.equal(byName.get('SKETCHFORGE_DESKTOP_PORT').default, '62158', 'desktop port default must stay documented');
  assert.equal(byName.get('SKETCHFORGE_DESKTOP_PORT').source, '../apps/desktop/main.cjs');
  assert.equal(byName.get('SKETCHFORGE_LOCAL_DOWNLOAD_ROOT').source, '../apps/web/src/app/api/local-download/route.ts');
  assert.deepEqual(byName.get('SKETCHFORGE_LOCAL_DOWNLOAD_ROOT').additionalSources, ['../apps/desktop/main.cjs']);
  assert.equal(byName.has('SKETCHFORGE_DESKTOP_DEV_URL'), false, 'internal development handoffs are not supported user configuration');
});

test('the tracked server, container, client, MCP, and desktop reader set has no unowned settings', async () => {
  const registry = JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json'));
  const readerPaths = [
    'deploy/docker/start-server.mjs',
    'deploy/docker/Dockerfile',
    'deploy/docker/compose.yaml',
    'apps/web/src/lib/serverProjectStore.ts',
    'apps/web/src/lib/apiTokens.ts',
    'apps/web/src/app/api/shared-projects/route.ts',
    'apps/web/src/app/api/app-update/route.ts',
    'apps/web/src/app/api/local-download/route.ts',
    'packages/sketchforge-client/src/environment.ts',
    'packages/sketchforge-py/src/sketchforge3d/environment.py',
    'packages/sketchforge-client/mcp/localEngine.mjs',
    'packages/sketchforge-client/mcp/localMacroRunner.mjs',
    'packages/sketchforge-client/mcp/macroTools.mjs',
    'packages/sketchforge-client/mcp/server.mjs',
    'apps/desktop/main.cjs',
  ];
  const contents = (await Promise.all(readerPaths.map(source))).join('\n');
  const discovered = [...new Set(contents.match(/\b(?:SKETCHFORGE_[A-Z0-9_]+|PORT|HOSTNAME)\b/g) ?? [])]
    .filter((name) => ![
      'SKETCHFORGE_DOCKER_BUILD',
      'SKETCHFORGE_DESKTOP',
      'SKETCHFORGE_DESKTOP_DEV_URL',
      'SKETCHFORGE_DESKTOP_VERSION',
    ].includes(name))
    .sort();
  const declared = registry.settings.map((setting) => setting.name).sort();
  assert.deepEqual(declared, discovered, 'every runtime setting in the owned reader set must have exactly one registry row');
});

async function exists(relativePath) {
  try {
    await source(relativePath);
    return true;
  } catch {
    return false;
  }
}

test('generated configuration reference links each setting to its implementation and owning guide', async () => {
  const reference = await source('docs/OPERATOR_CONFIGURATION.md');
  for (const setting of JSON.parse(await source('packages/sketchforge-engine/src/support/lib/operator-configuration.json')).settings) {
    for (const readerPath of [setting.source, ...(setting.additionalSources ?? [])]) {
      assert.ok(reference.includes(`](https://github.com/constructorfleet/SketchForge-3D/blob/main/${readerPath.replace(/^\.\.\//, '')})`), `${setting.name} must link source reader ${readerPath}`);
    }
    assert.ok(reference.includes(`](${setting.ownerPage})`), `${setting.name} must link its owner page`);
    for (const ownerPage of setting.additionalOwnerPages ?? []) {
      assert.ok(reference.includes(`](${ownerPage})`), `${setting.name} must link additional owner page ${ownerPage}`);
    }
  }
});
