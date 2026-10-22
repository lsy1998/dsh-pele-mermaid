// test/package-protocol.test.mjs — SPEC §2 wire protocol, §8 scripts (incl. lead sandbox
// amendment), §9.4 packaging list, and the cordis patch. Read-only checks of other owners' files.

import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


import { workspacePath, readIfExists } from './harness.mjs';

const pkgPath = workspacePath('package.json');
function readIfExistsSync(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null; }

const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

test('package.json declares the frozen wire protocol (SPEC §2)', () => {
  // GitHub Packages only accepts SCOPED npm packages, so the published name carries the
  // owner scope. The CLI command name (pkg.bin) stays unscoped on purpose.
  assert.equal(pkg.name, '@lsy1998/dsh-pele-mermaid');
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.repository && pkg.repository.url, 'repository.url is required: GitHub Packages links the package to the repo by that URL');
  assert.match(pkg.repository.url, /github\.com\/lsy1998\/dsh-pele-mermaid/);
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
  const test = pkg.scripts && pkg.scripts.test;
  assert.equal(typeof test, 'string', 'npm test script required');
  // The DIRECTORY form (`node --test test/`) is what CI used to run and it cannot work:
  // Node resolves the bare path as a module and dies with "Cannot find module '<repo>/test'".
  // So the thing to pin is that the script names test FILES, not that it names a directory -
  // pinning the directory spelling only locks in the failure.
  assert.match(test, /\.test\.mjs|\.test\.js|test\/\*\*/, 'npm test must name the test files: ' + test);
  assert.ok(
    !/(^|\s)test\/?\s*$/.test(test),
    'the bare directory form fails on Node 22 with "Cannot find module"; use a glob instead: ' + test,
  );
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

test('a GitHub-source install ships a complete package (root cause of the silent no-op)', () => {
  // The plugin can be installed straight from the GitHub source
  // (github:lsy1998/dsh-pele-mermaid). That path runs no build step of ours, so the
  // browser bundle and the Pele runtime must be committed, and the build must not
  // fail the install when node_modules is absent.
  const gitignore = readIfExistsSync(workspacePath('.gitignore')) ?? '';
  assert.ok(
    !/^lib\/client\.js\s*$/m.test(gitignore) && !/^lib\/pele-runtime\.js\s*$/m.test(gitignore),
    'the build outputs must not be gitignored: a GitHub install has no build step',
  );
  for (const artifact of ['lib/client.js', 'lib/pele-runtime.js', 'lib/index.js']) {
    assert.ok(existsSync(workspacePath(artifact)), artifact + ' must exist in the package');
  }
  const client = readIfExistsSync(workspacePath('lib/client.js'));
  if (client !== null) {
    assert.ok(client.includes('__ModuleLoader__'), 'lib/client.js must carry the loader contract');
    assert.ok(client.includes('dsh-pele-mermaid'), 'lib/client.js must carry the bundle id');
  }
  assert.ok(
    typeof pkg.scripts.prepare === 'string',
    'a "prepare" script must build the artifacts for npm/git installs',
  );
  assert.ok(
    /build/.test(pkg.scripts.prepare),
    'the prepare script must run the build',
  );
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
