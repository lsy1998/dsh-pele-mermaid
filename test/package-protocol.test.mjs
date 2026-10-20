// test/package-protocol.test.mjs — SPEC §2 wire protocol, §8 scripts (incl. lead sandbox
// amendment), §9.4 packaging list, and the cordis patch. Read-only checks of other owners' files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { workspacePath, readIfExists } from './harness.mjs';

const pkgPath = workspacePath('package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

test('package.json declares the frozen wire protocol (SPEC §2)', () => {
  assert.equal(pkg.name, 'dsh-pele-mermaid');
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.deepEqual(pkg.exports, {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json',
  });
  assert.deepEqual(pkg.dsh, {
    bundle: { patch: './cordis.patch.yml' },
    client: { platform: 'web', inject: [] },
  });
});

test('package.json scripts match SPEC §8 and the lead sandbox amendment', () => {
  assert.equal(pkg.scripts && pkg.scripts.test, 'node --test test/', 'npm test must stay canonical');
  const offline = pkg.scripts && pkg.scripts['test:offline'];
  assert.equal(typeof offline, 'string', 'test:offline script required (lead amendment)');
  assert.match(offline, /--experimental-test-isolation=none/);
  assert.match(offline, /\.test\.mjs|\.test\.js|test\/\*/);
  assert.ok(
    !/--experimental-test-isolation=none\s+test\/?\s*$/.test(offline),
    'the bare directory form fails on Node 22.18 with ERR_UNSUPPORTED_DIR_IMPORT; use the glob instead: ' + offline,
  );
  if (pkg.scripts.check) assert.match(pkg.scripts.check, /test/, 'check should run the test suite (SPEC §8)');
});

test('package.json files[] ships the DoD artifact list (SPEC §9.4)', () => {
  const files = pkg.files;
  assert.ok(Array.isArray(files), 'package.json needs a files[] allowlist');
  // SPEC §9.4 pins the shipped artifact set, not the spelling of the allowlist: a directory
  // entry ("lib") and per-file entries ("lib/index.js", ...) are equivalent for npm pack.
  const covered = (rel) => files.some((entry) => {
    const normalized = String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
    return normalized === rel || rel.startsWith(normalized + '/');
  });
  for (const required of [
    'lib/index.js', 'lib/client.js', 'lib/pele-runtime.js', 'bin/dsh-pele-mermaid.mjs',
    'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE',
  ]) {
    assert.ok(covered(required), 'files[] must ship ' + required + ' (entries: ' + JSON.stringify(files) + ')');
  }
  for (const forbidden of ['test', 'src', 'scripts', '.recon', '.verify']) {
    assert.ok(!files.includes(forbidden), 'files[] must not ship ' + forbidden);
  }
  if (pkg.bin) {
    assert.equal(pkg.bin['dsh-pele-mermaid'], 'bin/dsh-pele-mermaid.mjs', 'bin mapping should match dsh-mermaid');
  }
});

test('cordis.patch.yml inserts the ui-pele-mermaid plugin id (SPEC §2)', async () => {
  const patch = await readIfExists(workspacePath('cordis.patch.yml'));
  if (patch === null) {
    assert.ok(true, 'cordis.patch.yml not written yet (task-1 in flight)');
    return;
  }
  assert.match(patch, /insert/);
  assert.match(patch, /id:\s*ui-pele-mermaid/);
  assert.match(patch, /name:\s*['"]?dsh-pele-mermaid['"]?/);
});

test('build outputs appear together once scripts/build.mjs has run (SPEC §8/§9.4)', () => {
  const built = ['lib/index.js', 'lib/client.js', 'lib/pele-runtime.js', 'bin/dsh-pele-mermaid.mjs', 'icon.svg', 'cordis.patch.yml'];
  if (!existsSync(workspacePath('lib', 'client.js'))) {
    assert.ok(true, 'lib/client.js not built yet — skipping artifact presence check');
    return;
  }
  const missing = built.filter((rel) => !existsSync(workspacePath(...rel.split('/'))));
  assert.deepEqual(missing, [], 'build must produce every shipped artifact');
});
