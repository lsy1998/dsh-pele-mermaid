// test/unit-svg.test.mjs — SPEC §4 src/svg.js, R10 (standalone SVG export, filename, download).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, tryImportSource, importRealPele } from './harness.mjs';

const loaded = await tryImportSource('src/svg.js');
const svg = loaded ? loaded.mod : null;

if (!svg) {
  test('unit-svg suite', { skip: 'src/svg.js not present yet (task-1 in flight) — rerun after it lands' }, () => {});
} else {
  const withEnv = async (fn) => {
    const env = await createDomEnv();
    env.install();
    try { return await fn(env); } finally { env.uninstall(); env.close(); }
  };
  const parseSvg = (env, text) => {
    const host = env.doc.createElement('div');
    host.innerHTML = text;
    return host.querySelector('svg');
  };

  test('svgFileName matches pele-<type>-YYYYMMDD-HHmmss.svg', () => {
    const at = new Date(2026, 9, 19, 17, 32, 2); // local time, month is 0-based
    assert.equal(svg.svgFileName('flowchart', at), 'pele-flowchart-20261019-173202.svg');
    assert.match(svg.svgFileName('sequence'), /^pele-sequence-\d{8}-\d{6}\.svg$/);
    assert.match(svg.svgFileName('gitGraph'), /^pele-gitgraph-\d{8}-\d{6}\.svg$/i, 'type case is normalized, not frozen');
  });

  test('ensureStandaloneSvg produces parseable SVG with one xmlns and correct root', async () => {
    await withEnv(async (env) => {
      const source = '<svg class="pele pele-flowchart" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
      const out = svg.ensureStandaloneSvg(source);
      assert.equal(typeof out, 'string');
      assert.ok(out.trimStart().startsWith('<svg'), 'must stay an <svg> root');
      assert.ok(out.includes('xmlns="http://www.w3.org/2000/svg"'), 'standalone SVG needs the SVG namespace');
      assert.equal((out.match(/xmlns=/g) || []).length, 1, 'xmlns must not be duplicated');
      const twice = svg.ensureStandaloneSvg(out);
      assert.equal((twice.match(/xmlns=/g) || []).length, 1, 'ensureStandaloneSvg must be idempotent');
      const root = parseSvg(env, out);
      assert.ok(root, 'output must parse back to an <svg> element');
      assert.ok((root.getAttribute('class') || '').includes('pele'), 'pele class must survive');
    });
  });

  test('ensureStandaloneSvg applies the requested background', async () => {
    const source = '<svg class="pele pele-pie" viewBox="0 0 10 10"></svg>';
    const out = svg.ensureStandaloneSvg(source, { background: '#123456' });
    assert.ok(out.includes('123456'), 'background colour must appear in the standalone svg');
  });

  test('ensureStandaloneSvg keeps real Pele output renderable (#R10)', async () => {
    const pele = await importRealPele();
    if (!pele) {
      assert.ok(true, 'pele not installed — skipped real-output check');
      return;
    }
    const { svg: rendered } = pele.render('flowchart LR\n  A[Start] --> B[Done]');
    const out = svg.ensureStandaloneSvg(rendered, { background: '#ffffff' });
    assert.ok(out.includes('class="pele'), 'pele classes must survive standalone conversion');
    assert.equal((out.match(/xmlns=/g) || []).length, 1);
    await withEnv(async (env) => {
      const root = parseSvg(env, out);
      assert.ok(root);
      assert.equal(root.tagName.toLowerCase(), 'svg');
    });
  });

  test('downloadSvg clicks a named download link carrying the svg payload', async () => {
    await withEnv(async (env) => {
      const doc = env.doc;
      const win = env.win;
      const content = '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart"><rect/></svg>';
      const filename = 'pele-flowchart-20261019-173202.svg';

      const blobs = [];
      let clicked = null;
      const originalClick = win.HTMLAnchorElement.prototype.click;
      const originalWinCreate = win.URL && win.URL.createObjectURL;
      const originalGlobalCreate = URL.createObjectURL;
      const capture = (blob) => { blobs.push(blob); return 'blob:dsh-test-' + blobs.length; };
      win.HTMLAnchorElement.prototype.click = function () { clicked = this; };
      try {
        try { if (win.URL) win.URL.createObjectURL = capture; } catch { /* happy-dom may freeze it */ }
        try { URL.createObjectURL = capture; } catch { /* Node URL statics are usually writable */ }
        svg.downloadSvg(content, filename, doc);
        svg.downloadSvg(content, filename, doc);
      } finally {
        win.HTMLAnchorElement.prototype.click = originalClick;
        try { if (win.URL && originalWinCreate) win.URL.createObjectURL = originalWinCreate; } catch {}
        try { if (typeof originalGlobalCreate === 'function') URL.createObjectURL = originalGlobalCreate; } catch {}
      }

      assert.ok(clicked, 'downloadSvg must click an <a> element');
      assert.equal(clicked.getAttribute('download'), filename);
      const href = clicked.getAttribute('href') || clicked.href || '';
      assert.ok(href.length > 0, 'the download link needs an href');

      let payload = null;
      if (blobs.length > 0) payload = await blobs[0].text();
      else if (href.startsWith('data:')) {
        const comma = href.indexOf(',');
        payload = href.includes(';base64,')
          ? Buffer.from(href.slice(comma + 1), 'base64').toString('utf8')
          : decodeURIComponent(href.slice(comma + 1));
      }
      if (payload !== null) {
        assert.ok(payload.includes('pele'), 'payload must contain the svg markup, got: ' + payload.slice(0, 80));
      }
      const leftovers = doc.querySelectorAll('a[download]');
      assert.ok(leftovers.length <= 1, 'download anchors must not accumulate in the DOM, found ' + leftovers.length);
    });
  });

  test('downloadSvg does not throw without a document argument', async () => {
    await withEnv(async (env) => {
      assert.doesNotThrow(() => svg.downloadSvg('<svg class="pele"></svg>', 'x.svg'));
    });
  });
}
