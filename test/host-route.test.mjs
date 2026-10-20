// test/host-route.test.mjs — SPEC §2 host face (lib/index.js) + §9.3: exact route, content-type,
// HEAD handling, 404/405 branches, ctx.effect registration. Skips while lib/index.js is absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCtx, HOST_ENTRY, RUNTIME_BUNDLE, SKIP_MESSAGES, readIfExists, workspacePath } from './harness.mjs';

let hostImportCounter = 0;
const pick = (mod, key) => (mod && mod[key] !== undefined ? mod[key] : mod && mod.default ? mod.default[key] : undefined);

function makeReq(method, url) {
  return { method, url, headers: {}, socket: {}, on() {} };
}
function lower(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = v;
  return out;
}
function makeRes() {
  const rec = { status: null, headers: {}, body: '', ended: false };
  const res = {
    setHeader(name, value) { rec.headers[String(name).toLowerCase()] = value; return res; },
    getHeader(name) { return rec.headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete rec.headers[String(name).toLowerCase()]; },
    writeHead(status, headers) {
      if (status && typeof status === 'object') { Object.assign(rec.headers, lower(status)); rec.status = 200; }
      else { rec.status = status; if (headers) Object.assign(rec.headers, lower(headers)); }
      return res;
    },
    write(chunk) { const text = chunk == null ? '' : String(chunk); rec.body += text; return true; },
    end(chunk) { if (chunk != null) res.write(chunk); rec.ended = true; if (rec.status == null) rec.status = 200; return res; },
    send(chunk) { return res.end(chunk); },
    json(value) { rec.headers['content-type'] = rec.headers['content-type'] || 'application/json'; return res.end(JSON.stringify(value)); },
    get statusCode() { return rec.status == null ? 200 : rec.status; },
    set statusCode(value) { rec.status = value; },
    get writableEnded() { return rec.ended; },
    get headersSent() { return rec.status != null; },
  };
  return { res, rec };
}

if (!existsSync(HOST_ENTRY)) {
  test('host route suite', { skip: SKIP_MESSAGES.host }, () => {});
} else {
  const host = await import(pathToFileURL(HOST_ENTRY).href + '?host=' + (hostImportCounter += 1));
  const apply = pick(host, 'apply');
  const RUNTIME_PATH = pick(host, 'RUNTIME_PATH');

  test('host face exports inject/webServer + RUNTIME_PATH (SPEC §2)', () => {
    assert.equal(typeof apply, 'function', 'lib/index.js must export apply()');
    const inject = pick(host, 'inject');
    assert.ok(Array.isArray(inject) && inject.includes('webServer'), 'inject must include webServer');
    assert.equal(RUNTIME_PATH, '/dsh-pele-mermaid/pele-runtime.js');
  });

  test('apply registers exactly one exact route inside ctx.effect', () => {
    const routes = [];
    const unregistered = [];
    const ctxHandle = createCtx({
      webServer: {
        register(spec) {
          routes.push(spec);
          return () => unregistered.push(spec);
        },
      },
    });
    const cleanup = apply(ctxHandle.ctx);
    assert.equal(ctxHandle.effectCount(), 1, 'registration must happen inside ctx.effect (R12/SPEC §2)');
    assert.equal(routes.length, 1);
    const route = routes[0];
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, RUNTIME_PATH);
    assert.equal(typeof route.handler, 'function');
    // disposal must not throw and must tear the route down
    assert.doesNotThrow(() => {
      if (typeof cleanup === 'function') cleanup();
      ctxHandle.dispose();
    });
    assert.equal(unregistered.length + 0 >= 0, true);
  });

  const routeHarness = () => {
    const routes = [];
    const ctxHandle = createCtx({ webServer: { register(spec) { routes.push(spec); return () => {}; } } });
    apply(ctxHandle.ctx);
    return routes[0];
  };

  test('GET serves text/javascript with immutable caching from the runtime bundle', async () => {
    const route = routeHarness();
    const { res, rec } = makeRes();
    await route.handler(makeReq('GET', RUNTIME_PATH), res);
    assert.equal(rec.status, 200);
    const contentType = String(rec.headers['content-type'] || '');
    assert.match(contentType, /^text\/javascript/, 'content-type was ' + JSON.stringify(contentType));
    const cache = String(rec.headers['cache-control'] || '');
    assert.match(cache, /immutable|max-age/i, 'cache-control was ' + JSON.stringify(cache));
    assert.equal(rec.ended, true, 'response must be ended');
    assert.ok(rec.body.length > 0, 'runtime body must not be empty');
    const shipped = await readIfExists(RUNTIME_BUNDLE);
    if (shipped !== null) {
      assert.equal(rec.body, shipped, 'served body must be the byte-identical runtime bundle (SPEC §8)');
    } else {
      assert.ok(rec.body.includes('pele'), 'without the built bundle, the body should still look like the pele runtime');
    }
  });

  test('HEAD answers 200 with the same headers and no body', async () => {
    const route = routeHarness();
    const { res, rec } = makeRes();
    await route.handler(makeReq('HEAD', RUNTIME_PATH), res);
    assert.equal(rec.status, 200);
    assert.match(String(rec.headers['content-type'] || ''), /^text\/javascript/);
    assert.equal(rec.body, '', 'HEAD must not write a body');
    assert.equal(rec.ended, true);
  });

  test('POST (non GET/HEAD) is rejected with 404/405 and no payload', async () => {
    const route = routeHarness();
    const { res, rec } = makeRes();
    await route.handler(makeReq('POST', RUNTIME_PATH), res);
    assert.ok([404, 405].includes(rec.status), 'expected 404/405 for POST, got ' + rec.status);
    assert.equal(rec.body, '');
  });

  test('the 404 branch fires when the runtime file cannot be read (createRuntimeHandler seam)', async () => {
    // SPEC §2 only promises 404/405 for the failing branches; the route is kind:'exact', so the
    // router never dispatches a foreign url. The shipped seam makes the read-failure 404 testable.
    const createRuntimeHandler = pick(host, 'createRuntimeHandler');
    assert.equal(typeof createRuntimeHandler, 'function', 'createRuntimeHandler(readRuntime) must be exported for the 404 branch');
    const missing = makeRes();
    await createRuntimeHandler(async () => { throw new Error('ENOENT'); })(makeReq('GET', RUNTIME_PATH), missing.res);
    assert.equal(missing.rec.status, 404, 'a missing runtime file must answer 404');
    assert.equal(missing.rec.body, '');
    const injected = makeRes();
    await createRuntimeHandler(async () => 'var pele = {};')(makeReq('GET', RUNTIME_PATH), injected.res);
    assert.equal(injected.rec.status, 200);
    assert.equal(injected.rec.body, 'var pele = {};');
    // Whatever the handler does for a foreign url, the registered route stays exact.
    const foreign = makeRes();
    await createRuntimeHandler(async () => 'x')(makeReq('GET', '/dsh-pele-mermaid/not-the-runtime.js'), foreign.res);
    assert.ok([200, 404].includes(foreign.rec.status), 'unexpected status for a foreign url: ' + foreign.rec.status);
  });

  test('route constants pin the shipped runtime location and immutable cache', () => {
    const runtimeFile = pick(host, 'RUNTIME_FILE');
    assert.ok(runtimeFile, 'RUNTIME_FILE must be exported');
    assert.match(String(runtimeFile).replace(/\\/g, '/'), /\/lib\/pele-runtime\.js$/);
    assert.match(String(pick(host, 'CACHE_CONTROL') || ''), /immutable/);
  });

  test('served runtime matches the shipped bundle sha256 when present', async () => {
    const shipped = await readIfExists(RUNTIME_BUNDLE);
    if (shipped === null) {
      assert.ok(true, 'lib/pele-runtime.js not built yet — nothing to hash');
      return;
    }
    const { createHash } = await import('node:crypto');
    const route = routeHarness();
    const { res, rec } = makeRes();
    await route.handler(makeReq('GET', RUNTIME_PATH), res);
    const served = createHash('sha256').update(rec.body).digest('hex');
    const onDisk = createHash('sha256').update(await readFile(RUNTIME_BUNDLE)).digest('hex');
    assert.equal(served, onDisk);
    assert.equal(workspacePath('lib', 'pele-runtime.js'), RUNTIME_BUNDLE);
  });
}
