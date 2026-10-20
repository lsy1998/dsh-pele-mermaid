// test/unit-runtime.test.mjs — SPEC §4 src/runtime.js + §2 lazy runtime script contract (R4/R8).
// loadPeleRuntime() state is module-level, so each test that exercises it uses a cache-busted
// module instance; the shared-instance tests exercise get/set/reset only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createDomEnv, tryImportSource, workspacePath, flushAsync } from './harness.mjs';

const loaded = await tryImportSource('src/runtime.js');
const runtime = loaded ? loaded.mod : null;
const RUNTIME_SRC = workspacePath('src', 'runtime.js');
let freshCounter = 0;
const freshRuntime = async () => await import(pathToFileURL(RUNTIME_SRC).href + '?fresh=' + (freshCounter += 1));

if (!runtime) {
  test('unit-runtime suite', { skip: 'src/runtime.js not present yet (task-1 in flight) — rerun after it lands' }, () => {});
} else {
  const withEnv = async (fn) => {
    const env = await createDomEnv();
    env.install();
    try { return await fn(env); } finally { runtime.resetPeleRuntimeForTesting?.(); env.uninstall(); env.close(); }
  };

  test('exports the frozen route constants (SPEC §2)', () => {
    assert.equal(runtime.RUNTIME_PATH, '/dsh-pele-mermaid/pele-runtime.js');
    assert.equal(runtime.RUNTIME_SCRIPT_ATTR, 'data-dsh-pele-runtime');
    assert.equal(typeof runtime.getPeleRuntime, 'function');
    assert.equal(typeof runtime.setPeleRuntimeForTesting, 'function');
    assert.equal(typeof runtime.loadPeleRuntime, 'function');
    assert.equal(typeof runtime.resetPeleRuntimeForTesting, 'function');
  });

  test('setPeleRuntimeForTesting overrides the loader; null and reset clear it', async () => {
    await withEnv(async (env) => {
      const fake = { mount() {}, __fake: true };
      runtime.resetPeleRuntimeForTesting();
      assert.equal(runtime.getPeleRuntime(), null, 'no window.pele and no override -> null');
      runtime.setPeleRuntimeForTesting(fake);
      assert.equal(runtime.getPeleRuntime(), fake);
      runtime.setPeleRuntimeForTesting(null);
      assert.equal(runtime.getPeleRuntime(), null);
      // window.pele is picked up when present
      env.win.pele = fake;
      assert.equal(runtime.getPeleRuntime(), fake, 'getPeleRuntime() returns window.pele');
      runtime.setPeleRuntimeForTesting({ other: true });
      assert.deepEqual(runtime.getPeleRuntime(), { other: true }, 'the test override must win over window.pele');
      delete env.win.pele;
      runtime.resetPeleRuntimeForTesting();
      assert.equal(runtime.getPeleRuntime(), null);
    });
  });

  test('loadPeleRuntime resolves immediately when window.pele already exists', async () => {
    const rt = await freshRuntime();
    await withEnv(async (env) => {
      const fake = { mount() {}, tag: 'window-pele' };
      env.win.pele = fake;
      const got = await rt.loadPeleRuntime(env.win);
      assert.equal(got, fake);
      assert.equal(env.doc.querySelectorAll('script[data-dsh-pele-runtime]').length, 0, 'must not inject a script when pele exists');
    });
  });

  test('loadPeleRuntime resolves through the testing override without injecting a script', async () => {
    const rt = await freshRuntime();
    const fake = { mount() {}, tag: 'override' };
    rt.setPeleRuntimeForTesting(fake);
    await withEnv(async (env) => {
      assert.equal(await rt.loadPeleRuntime(env.win), fake);
      assert.equal(await rt.loadPeleRuntime(), fake, 'default window argument must work');
      assert.equal(env.doc.querySelectorAll('script[data-dsh-pele-runtime]').length, 0);
    });
  });

  test('loadPeleRuntime injects one tagged script and dedupes concurrent calls', async () => {
    const rt = await freshRuntime();
    await withEnv(async (env) => {
      const p1 = rt.loadPeleRuntime(env.win);
      const p2 = rt.loadPeleRuntime(env.win);
      const p3 = rt.loadPeleRuntime(env.win);
      const scripts = env.doc.querySelectorAll('script[data-dsh-pele-runtime]');
      assert.equal(scripts.length, 1, 'concurrent loads must reuse one script element');
      assert.equal(scripts[0].getAttribute('src'), rt.RUNTIME_PATH);
      assert.ok(scripts[0].hasAttribute('data-dsh-pele-runtime'));
      assert.equal(p1, p2, 'concurrent calls must share one promise');
      assert.equal(p2, p3);
      p1.catch(() => {});
      p2.catch(() => {});
      p3.catch(() => {});
      await flushAsync(3);
    });
  });

  test('a pending runtime load does not block unrelated windows (module-level cache is per load)', async () => {
    const rt = await freshRuntime();
    const envA = await createDomEnv();
    const envB = await createDomEnv();
    envA.install();
    try {
      const fakeB = { mount() {}, tag: 'B' };
      const pA = rt.loadPeleRuntime(envA.win);
      pA.catch(() => {});
      // A new override must still be honoured (loader re-checked / overridable)
      rt.setPeleRuntimeForTesting(fakeB);
      const got = await rt.loadPeleRuntime(envB.win);
      assert.equal(got, fakeB);
      await flushAsync(2);
    } finally {
      envA.uninstall();
      envA.close();
      envB.close();
    }
  });
}
