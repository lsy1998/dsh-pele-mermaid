// test/client-lifecycle.test.mjs — R9 (viewer integration), R10 (SVG export), R12 (disposal,
// repeated apply/cleanup/apply) against the built lib/client.js.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  CLIENT_BUNDLE, SKIP_MESSAGES, setupClient, createCtx, flushAsync,
  accessibleName, buttonsIn, installWatchdog,
} from './harness.mjs';

const clientAvailable = existsSync(CLIENT_BUNDLE);
const clearWatchdog = clientAvailable ? installWatchdog('client-lifecycle') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

// Event types the plugin itself is expected to own; happy-dom may add unrelated ones internally.
const PLUGIN_EVENT_TYPES = new Set(['keydown', 'keyup', 'resize', 'click', 'change', 'input', 'scroll', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'dblclick', 'touchstart', 'touchmove', 'touchend']);

if (!clientAvailable) {
  test('client lifecycle suite', { skip: SKIP_MESSAGES.client }, () => {});
} else {
  const click = (handle, el) => el.dispatchEvent(new handle.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (handle, target, keyName, init = {}) => target.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));

  async function bootOne({ lang = 'en' } = {}) {
    const handle = await setupClient({ lang, autoApply: false });
    const block = handle.addBlock('flowchart LR\n  A-->B');
    const cleanup = handle.apply();
    await handle.settle(1);
    await handle.waitForRenders(1);
    return {
      handle,
      block,
      cleanup,
      container: () => handle.containerFor(block.pre) || handle.containers()[0],
      teardown() {
        try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
        handle.env.uninstall();
        handle.env.close();
      },
    };
  }

  /** Neutralise real navigation and find the Fullscreen action by behaviour. */
  async function openViewer(handle, container) {
    const originalClick = handle.win.HTMLAnchorElement.prototype.click;
    handle.win.HTMLAnchorElement.prototype.click = function () {};
    try {
      const buttons = buttonsIn(container);
      const byName = buttons.find((b) => /full|screen|expand|view|全屏|放大|大图/i.test(accessibleName(b)) && !b.hasAttribute('aria-pressed'));
      const candidates = byName ? [byName, ...buttons.filter((b) => b !== byName)] : buttons;
      for (const button of candidates) {
        click(handle, button);
        await flushAsync(3);
        const overlay = handle.doc.querySelector('.dsh-pm-viewer');
        if (overlay) return { button, overlay };
      }
      return { button: null, overlay: null };
    } finally {
      handle.win.HTMLAnchorElement.prototype.click = originalClick;
    }
  }

  /** Find the Download action by observing which button triggers an anchor click. */
  async function clickDownload(handle, container) {
    const clicked = [];
    const originalClick = handle.win.HTMLAnchorElement.prototype.click;
    handle.win.HTMLAnchorElement.prototype.click = function () { clicked.push(this); };
    try {
      for (const button of buttonsIn(container)) {
        click(handle, button);
        await flushAsync(2);
        if (clicked.length) return { button, anchor: clicked[0] };
      }
      return { button: null, anchor: null };
    } finally {
      handle.win.HTMLAnchorElement.prototype.click = originalClick;
    }
  }

  test('R9: the Fullscreen action opens the viewer with the rendered SVG; Escape closes and restores focus', async () => {
    const { handle, container, teardown } = await bootOne();
    try {
      const dom = container();
      const { button, overlay } = await openViewer(handle, dom);
      assert.ok(overlay, 'a toolbar action must open .dsh-pm-viewer');
      assert.ok(button, 'the opening control must be a toolbar button');
      assert.equal(overlay.getAttribute('role'), 'dialog');
      assert.equal(overlay.getAttribute('aria-modal'), 'true');
      assert.ok(overlay.querySelector('.dsh-pm-viewport'), 'viewport required');
      assert.ok(overlay.querySelector('svg'), 'the rendered svg must be shown in the viewer');
      assert.ok(overlay.contains(handle.doc.activeElement), 'focus must move into the dialog');
      key(handle, handle.doc, 'Escape');
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'Escape must close the viewer');
      assert.equal(handle.doc.activeElement, button, 'focus must return to the opening control (R9)');
      // the toolbar itself must survive the viewer lifecycle
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1);
    } finally { teardown(); }
  });

  test('R9: the viewer is a singleton across repeated open/close cycles', async () => {
    const { handle, container, teardown } = await bootOne();
    try {
      const dom = container();
      const first = await openViewer(handle, dom);
      assert.ok(first.overlay);
      const closeButtons = [...first.overlay.querySelectorAll('button')].filter((b) => /close|dismiss|关闭|閉じ/i.test(accessibleName(b)));
      if (closeButtons.length) {
        click(handle, closeButtons[0]);
      } else {
        key(handle, handle.doc, 'Escape');
      }
      await flushAsync(2);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-viewer').length, 0, 'viewer must be removed after closing');
      const second = await openViewer(handle, dom);
      assert.ok(second.overlay, 'viewer must re-open');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-viewer').length, 1, 'never more than one overlay');
    } finally { teardown(); }
  });

  test('R10: the Download action saves a standalone pele-<type>-<stamp>.svg with theme vars', async () => {
    const { handle, container, teardown } = await bootOne();
    try {
      const blobs = [];
      const originalWinCreate = handle.win.URL && handle.win.URL.createObjectURL;
      const originalGlobalCreate = URL.createObjectURL;
      const capture = (blob) => { blobs.push(blob); return 'blob:dsh-lifecycle-' + blobs.length; };
      try { if (handle.win.URL) handle.win.URL.createObjectURL = capture; } catch { /* ignore */ }
      try { URL.createObjectURL = capture; } catch { /* ignore */ }
      let result;
      try {
        result = await clickDownload(handle, container());
      } finally {
        try { if (handle.win.URL && originalWinCreate) handle.win.URL.createObjectURL = originalWinCreate; } catch {}
        try { if (typeof originalGlobalCreate === 'function') URL.createObjectURL = originalGlobalCreate; } catch {}
      }
      assert.ok(result.anchor, 'a toolbar action must trigger an <a> download');
      const filename = result.anchor.getAttribute('download') || '';
      assert.match(filename, /^pele-[A-Za-z0-9]+-\d{8}-\d{6}\.svg$/, 'unexpected export filename: ' + filename);
      const href = result.anchor.getAttribute('href') || result.anchor.href || '';
      let payload = blobs.length ? await blobs[0].text() : null;
      if (payload === null && href.startsWith('data:')) {
        const comma = href.indexOf(',');
        payload = href.includes(';base64,')
          ? Buffer.from(href.slice(comma + 1), 'base64').toString('utf8')
          : decodeURIComponent(href.slice(comma + 1));
      }
      assert.ok(payload !== null, 'download payload could not be captured (href=' + href.slice(0, 40) + ', blobs=' + blobs.length + ')');
      assert.ok(payload.includes('<svg'), 'export must be an svg document');
      assert.ok(payload.includes('xmlns="http://www.w3.org/2000/svg"'), 'export must be standalone');
      assert.ok(payload.includes('--pele-'), 'R10: the exported root must carry the resolved theme variables');
      assert.ok(handle.doc.querySelectorAll('a[download]').length <= 1, 'export anchors must not accumulate');
    } finally { teardown(); }
  });

  test('R12: cleanup removes containers/viewer, disconnects observers and removes listeners', async () => {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    try {
      const a = handle.addBlock('flowchart LR\n  A-->1');
      const b = handle.addBlock('sequenceDiagram\n  A->>B: 2');
      const cleanup = handle.apply();
      await handle.settle(2);
      await handle.waitForRenders(2);
      const mountsBefore = handle.fake.state.mounts.length;
      await handle.waitFor(() => handle.doc.querySelectorAll('.dsh-pm-pane[data-state="ready"]').length === 2, { label: 'two ready panes' });
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 2, 'precondition: two containers');
      const observersBefore = handle.env.observers.filter((o) => !o.__dshDisconnected);
      assert.ok(observersBefore.length >= 1, 'R12: apply must register observers (inside ctx.effect)');
      // open the viewer too, so disposal must destroy it
      const opened = await openViewer(handle, handle.containers()[0]);
      assert.ok(opened.overlay, 'precondition: viewer open');
      assert.equal(handle.fake.state.mounts.length, 2);

      try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
      await flushAsync(4);

      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'containers must be removed and the pre restored');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-viewer').length, 0, 'viewer must be destroyed');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-bar').length, 0, 'no toolbar may survive disposal');
      assert.equal(handle.doc.body.contains(a.pre), true, 'the original pre nodes must be restored');
      assert.equal(handle.doc.body.contains(b.pre), true);
      assert.equal(handle.fake.state.mounts.length, mountsBefore, 'cleanup must cancel pending work (no render may land after disposal)');
      assert.equal(handle.fake.state.destroyed.length, mountsBefore, 'every mount instance must be destroyed');
      const observersAfter = handle.env.observers.filter((o) => !o.__dshDisconnected);
      assert.deepEqual(observersAfter, [], 'every MutationObserver must be disconnected (R12)');
      const leaks = handle.env.listenerLeaks().filter((l) => PLUGIN_EVENT_TYPES.has(l.type));
      assert.deepEqual(leaks.map((l) => l.target + ':' + l.type + ':' + (l.fn && l.fn.name)), [], 'plugin document/window listeners must be removed');
      // observers really are disconnected: a new block must not be enhanced anymore
      handle.addBlock('flowchart LR\n  A-->after');
      await flushAsync(4);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'detached observers must not enhance');
    } finally { handle.env.uninstall(); handle.env.close(); }
  });

  test('R12: apply -> cleanup -> apply leaves no duplicate toolbars or observers', async () => {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    try {
      const block = handle.addBlock('flowchart LR\n  A-->cycle');
      const first = handle.apply();
      await handle.settle(1);
      await handle.waitForRenders(1);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1);
      try { if (typeof first === 'function') first(); } finally { handle.ctxHandle.dispose(); }
      await flushAsync(3);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'cycle 1 must clean up');
      assert.ok(handle.env.observers.every((o) => o.__dshDisconnected), 'cycle 1 observers disconnected');

      const ctx2 = createCtx();
      const second = handle.plugin.apply(ctx2.ctx);
      await handle.settle(1);
      await handle.waitForRenders(2);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1, 'cycle 2 re-enhances exactly once');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-bar').length, 1, 'no duplicate toolbars');
      assert.equal(handle.fake.state.mounts.length, 2, 'cycle 2 mounts once (cycle 1 mounted once)');
      try { if (typeof second === 'function') second(); } finally { ctx2.dispose(); }
      await flushAsync(3);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'cycle 2 must clean up too');
      assert.equal(handle.doc.body.contains(block.pre), true);
      const leaks = handle.env.listenerLeaks().filter((l) => PLUGIN_EVENT_TYPES.has(l.type));
      assert.deepEqual(leaks.map((l) => l.target + ':' + l.type), [], 'no listener may survive two cycles');
      assert.ok(handle.env.observers.every((o) => o.__dshDisconnected), 'all observers disconnected after both cycles');
    } finally { handle.env.uninstall(); handle.env.close(); }
  });
}
