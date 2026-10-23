// test/client-dom.test.mjs — integration of the built lib/client.js under happy-dom with a
// deterministic fake Pele runtime. Covers SPEC R1-R8, R11, R13 (R9/R10/R12 live in
// client-lifecycle.test.mjs). Skips with a visible message while lib/client.js is absent.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  CLIENT_BUNDLE, SKIP_MESSAGES, setupClient, createFakePele, createCtx, flushAsync,
  accessibleName, buttonsIn, chromeTexts, installWatchdog, matchMessage, resolveMessages,
  workspacePath,
} from './harness.mjs';

/** The published package name is the only valid client-module registration id. */
const pkgName = JSON.parse(readFileSync(workspacePath('package.json'), 'utf8')).name;

const clientAvailable = existsSync(CLIENT_BUNDLE);
const clearWatchdog = clientAvailable ? installWatchdog('client-dom') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

if (!clientAvailable) {
  test('client DOM integration suite', { skip: SKIP_MESSAGES.client }, () => {});
} else {
  /** Boot happy-dom + bundle, add blocks, then apply() so the initial scan sees them. */
  async function boot({ lang = 'en', dark = false, pele, peleOptions, beforeApply, blocks, expected } = {}) {
    const handle = await setupClient({ lang, dark, pele, peleOptions, autoApply: false });
    if (beforeApply) beforeApply(handle);
    const created = (blocks ? blocks(handle) : []) || [];
    const cleanup = handle.apply();
    const want = typeof expected === 'number' ? expected : (Array.isArray(created) ? created.length : 1);
    await handle.settle(want);
    return {
      handle,
      created,
      teardown() {
        try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
        handle.env.uninstall();
        handle.env.close();
      },
    };
  }
  const click = (handle, el) => el.dispatchEvent(new handle.win.MouseEvent('click', { bubbles: true, cancelable: true }));

  test('bundle contract: id, inject, single loader call, no bundled pele require (SPEC §2/§8)', async () => {
    const handle = await setupClient({ lang: 'en' });
    try {
      // The id must be the published package name: the host builds each boot-graph row's
      // id from package.json#name and asserts factories.has(row.id) after executing the
      // bundle. Pinning the unscoped literal here is what hid that mismatch — the plugin
      // loaded its host half fine while the browser half never registered.
      assert.equal(handle.bundle.id, pkgName);
      assert.deepEqual(handle.plugin.inject, []);
      assert.deepEqual(handle.bundle.requires, [], 'the factory must not require() anything at runtime');
      assert.ok(handle.bundle.source.length < 1_500_000, 'lib/client.js must not embed the 682 KB pele runtime');
      assert.equal(typeof handle.plugin.setPeleRuntimeForTesting, 'function');
      assert.ok(handle.internals && typeof handle.internals.enhance === 'function', '__internals.enhance must exist (SPEC §4)');
    } finally { handle.teardown(); }
  });

  test('R1: enhances language-mermaid / mermaidjs / mmd and the plain Shiki fallback', async () => {
    const rows = [
      { source: 'flowchart LR\n  A-->B', lang: 'mermaid' },
      { source: 'sequenceDiagram\n  A->>B: hi', lang: 'mermaidjs' },
      { source: 'pie title P\n  "a": 1', lang: 'mmd' },
      { source: 'classDiagram\n  class A', codeClass: 'language-Mermaid' },
      { source: 'flowchart LR\n  A-->B', codeClass: 'hljs' },
      { source: 'graph TD\n  A-->B', codeClass: '' },
      { source: 'not a diagram at all', lang: 'mermaid' },
    ];
    const { handle, created, teardown } = await boot({ blocks: (h) => rows.map((row) => h.addBlock(row.source, row)), expected: rows.length });
    try {
      assert.equal(handle.containers().length, rows.length, 'every mermaid fence must be enhanced');
      for (const block of created) {
        assert.ok(handle.containerFor(block.pre), 'expected container for code class ' + JSON.stringify(block.code.className));
        assert.ok(handle.containerFor(block.pre).querySelector('.dsh-pm-bar'), 'toolbar expected');
      }
    } finally { teardown(); }
  });

  test('R1: never enhances foreign languages, non-diagram plain blocks or inline code', async () => {
    const rows = [
      { source: 'flowchart LR\n  A-->B', lang: 'js' },
      { source: 'graph TD\n  A-->B', lang: 'json' },
      { source: 'flowchart LR\n  A-->B', lang: 'python' },
      { source: 'flowchart LR\n  A-->B', codeClass: 'language-mermaid language-js' },
      { source: 'flowchart LR\n  A-->B', lang: 'mermaidx' },
      { source: 'just some text', codeClass: 'hljs' },
      { source: 'const x = 1;', codeClass: '' },
    ];
    const { handle, created, teardown } = await boot({ blocks: (h) => rows.map((row) => h.addBlock(row.source, row)), expected: 0 });
    try {
      assert.equal(handle.containers().length, 0, 'no block in this matrix may be enhanced');
      for (const block of created) assert.equal(handle.containerFor(block.pre), null);
      const inline = handle.doc.createElement('code');
      inline.className = 'language-mermaid';
      inline.textContent = 'flowchart LR\n  A-->B';
      handle.doc.body.appendChild(inline);
      await flushAsync();
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'inline <code> must never be enhanced');
      assert.equal(inline.parentElement, handle.doc.body);
    } finally { teardown(); }
  });

  test('R2: marks the pre, wraps it once, and a repeated enhance is a no-op', async () => {
    const { handle, created, teardown } = await boot({ blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')] });
    try {
      const { pre } = created[0];
      const container = handle.containerFor(pre);
      assert.ok(container, 'container missing');
      assert.ok(container.classList.contains('dsh-pm'), 'container must carry .dsh-pm');
      assert.equal(container.getAttribute('data-view'), 'diagram', 'diagram view is the default (R3)');
      assert.ok(pre.hasAttribute('data-dsh-pele-mermaid-block'), 'the pre must be marked with data-dsh-pele-mermaid-block (R2)');
      assert.equal(pre.hasAttribute('data-dsh-pele-mermaid'), false, 'only the container carries data-dsh-pele-mermaid (R2 counting rule)');
      assert.equal(handle.doc.querySelectorAll('[data-dsh-pele-mermaid]').length, 1, 'container count must equal the block count');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1);
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-bar').length, 1);
      handle.internals.enhance(handle.doc.documentElement);
      handle.internals.enhance(handle.doc.body);
      await flushAsync();
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1, 'idempotent enhance');
      assert.equal(handle.doc.querySelectorAll('.dsh-pm-bar').length, 1);
      await handle.waitForRenders(1);
      assert.equal(handle.fake.state.mounts.length, 1, 'must not re-mount an already enhanced block');
    } finally { teardown(); }
  });

  test('R2: coexists with foreign diagram containers', async () => {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    try {
      const foreignA = handle.doc.createElement('div');
      foreignA.className = 'dsh-mmd';
      const a = handle.addBlock('flowchart LR\n  A-->B', { parent: foreignA });
      const foreignB = handle.doc.createElement('div');
      foreignB.setAttribute('data-dsh-mermaid', '');
      const b = handle.addBlock('flowchart LR\n  A-->B', { parent: foreignB });
      const ours = handle.addBlock('flowchart LR\n  A-->B');
      handle.doc.body.append(foreignA, foreignB);
      const cleanup = handle.apply();
      try {
        await handle.settle(1);
        assert.equal(handle.containers().length, 1, 'only our own block may be enhanced');
        assert.equal(handle.containerFor(a.pre), null);
        assert.equal(handle.containerFor(b.pre), null);
        assert.ok(handle.containerFor(ours.pre));
      } finally { if (typeof cleanup === 'function') cleanup(); }
    } finally { handle.ctxHandle.dispose(); handle.env.uninstall(); handle.env.close(); }
  });

  test('R3: toolbar = badge(type + Pele) + Code/Diagram aria-pressed toggle + actions, pre preserved', async () => {
    const { handle, created, teardown } = await boot({ lang: 'en', blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')] });
    try {
      const container = handle.containers()[0];
      const badge = container.querySelector('.dsh-pm-badge');
      assert.ok(badge, '.dsh-pm-badge missing');
      assert.match(badge.textContent, /flowchart/);
      assert.match(badge.textContent, /pele/i, 'badge must mention Pele');
      const buttons = buttonsIn(container);
      assert.ok(buttons.length >= 4, 'expected code/diagram/fullscreen/download, got ' + buttons.length);
      const toggles = buttons.filter((b) => b.hasAttribute('aria-pressed'));
      assert.equal(toggles.length, 2, 'exactly two aria-pressed toggles (Code/Diagram)');
      assert.equal(toggles.filter((b) => b.getAttribute('aria-pressed') === 'true').length, 1, 'exactly one pressed by default');
      assert.equal(container.getAttribute('data-view'), 'diagram', 'diagram view is the default');
      const codeButton = toggles.find((b) => b.getAttribute('aria-pressed') === 'false');
      const diagramButton = toggles.find((b) => b.getAttribute('aria-pressed') === 'true');
      click(handle, codeButton);
      await flushAsync(2);
      assert.equal(container.getAttribute('data-view'), 'code');
      assert.equal(codeButton.getAttribute('aria-pressed'), 'true');
      assert.equal(diagramButton.getAttribute('aria-pressed'), 'false');
      click(handle, diagramButton);
      await flushAsync(2);
      assert.equal(container.getAttribute('data-view'), 'diagram');
      assert.equal(diagramButton.getAttribute('aria-pressed'), 'true');
      assert.equal(container.querySelector('pre'), created[0].pre, 'the original pre must be preserved in code view');
      assert.ok(buttons.filter((b) => !b.hasAttribute('aria-pressed')).length >= 2, 'fullscreen + download actions required');
    } finally { teardown(); }
  });

  test('R4: renders through pele.mount(element, source, options) with the frozen options', async () => {
    const { handle, teardown } = await boot({ blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')] });
    try {
      await handle.waitForRenders(1);
      const mounts = handle.fake.state.mounts;
      assert.equal(mounts.length, 1, 'exactly one mount for one block');
      const mount = mounts[0];
      assert.equal(mount.source, 'flowchart LR\n  A-->B');
      const options = mount.options;
      assert.ok(options && typeof options === 'object', 'mount options missing');
      assert.equal(typeof options.icons, 'function', 'icons option required (R4)');
      assert.equal(options.icons(), null, 'icons must yield null');
      assert.equal(options.links, true);
      assert.equal(options.linkRel, 'noopener');
      assert.equal(typeof options.onError, 'function', 'onError required (R4/R6)');
      assert.equal(typeof options.onRender, 'function', 'onRender required (R4)');
      assert.ok('maxWidth' in options, 'maxWidth required (R4)');
      if (options.maxWidth !== undefined) assert.ok(Number.isFinite(options.maxWidth) && options.maxWidth >= 0);
      if ('autoDirection' in options) assert.equal(typeof options.autoDirection, 'boolean');
      if ('padding' in options) assert.equal(typeof options.padding, 'number');
      assert.ok(mount.element.closest('[data-dsh-pele-mermaid]'), 'mount must target our container');
      const pane = handle.containers()[0].querySelector('.dsh-pm-pane');
      assert.ok(pane, '.dsh-pm-pane missing');
      assert.equal(pane.getAttribute('data-state'), 'ready');
      assert.ok(pane.querySelector('svg.pele'), 'rendered pele svg expected in the pane');
    } finally { teardown(); }
  });

  test('R5: container carries mapped --pele-* vars and re-applies on data-ds-dark-theme', async () => {
    const { handle, teardown } = await boot({
      beforeApply: (h) => h.env.setTokens({ '--dsw-alias-bg-layer-2': 'rgb(11, 15, 20)', '--dsw-alias-label-primary': 'rgb(221, 221, 221)' }),
      blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')],
    });
    try {
      const container = handle.containers()[0];
      const value = (prop) => container.style.getPropertyValue(prop) || handle.win.getComputedStyle(container).getPropertyValue(prop);
      assert.equal(value('--pele-bg'), 'rgb(11, 15, 20)', '--pele-bg must come from --dsw-alias-bg-layer-2');
      assert.equal(value('--pele-fg'), 'rgb(221, 221, 221)', '--pele-fg must come from --dsw-alias-label-primary');
      // dark theme: change the token values and flip body[data-ds-dark-theme]
      handle.env.setTokens({ '--dsw-alias-bg-layer-2': 'rgb(1, 2, 3)', '--dsw-alias-label-primary': 'rgb(4, 5, 6)' });
      handle.env.setDark(true);
      await flushAsync();
      assert.equal(value('--pele-bg'), 'rgb(1, 2, 3)', 'theme must re-apply after body[data-ds-dark-theme] mutation (R5)');
      assert.equal(value('--pele-fg'), 'rgb(4, 5, 6)');
      assert.equal(container.style.getPropertyValue('--pele-muted'), '', 'unset tokens must not be emitted');
    } finally { teardown(); }
  });

  test('R6: PeleError fallback shows message + source as text, never as HTML', async () => {
    const xss = '<img src=x onerror="globalThis.__dshXss=1">BOOM';
    const { handle, teardown } = await boot({
      peleOptions: {
        fail: (source, _element, PeleError) =>
          source.includes('BOOM') ? new PeleError(xss, { code: 'syntax', type: 'flowchart', line: 3, column: 7 }) : null,
      },
      blocks: (h) => [h.addBlock('flowchart LR\n  A-->BOOM')],
    });
    try {
      const container = handle.containers()[0];
      await handle.waitForPaneState(container, 'error');
      const pane = container.querySelector('.dsh-pm-pane');
      assert.ok(pane, 'pane missing');
      assert.equal(pane.getAttribute('data-state'), 'error', 'error state expected');
      const errorEl = container.querySelector('.dsh-pm-error') || pane;
      assert.ok(errorEl.textContent.includes('BOOM'), 'error message must be visible: ' + errorEl.textContent);
      assert.equal(errorEl.querySelector('img'), null, 'error text must never be injected as HTML');
      assert.equal(globalThis.__dshXss, undefined, 'no inline handler may have run');
      assert.ok(container.textContent.includes('flowchart LR'), 'the source must stay visible');
      assert.match(errorEl.textContent, /3/, 'line number must be included when available (R6)');
      assert.match(errorEl.textContent, /7/, 'column must be included when available (R6)');
      assert.equal(handle.fake.state.mounts.length >= 1, true);
    } finally { teardown(); }
  });

  test('R6: a throwing mount() also falls back to the text error pane', async () => {
    const { handle, teardown } = await boot({
      peleOptions: { throwOn: (source) => source.includes('THROW') },
      blocks: (h) => [h.addBlock('flowchart LR\n  A-->THROW')],
    });
    try {
      const container = handle.containers()[0];
      await handle.waitForPaneState(container, 'error');
      const pane = container.querySelector('.dsh-pm-pane');
      assert.ok(pane, 'pane missing');
      assert.equal(pane.getAttribute('data-state'), 'error');
      assert.ok(container.querySelector('.dsh-pm-error'), '.dsh-pm-error expected');
      assert.ok(container.textContent.includes('THROW') || container.textContent.includes('throw'), 'some diagnostic must be shown');
      assert.ok(container.textContent.includes('flowchart LR'), 'source must stay visible after a throw');
    } finally { teardown(); }
  });

  test('R7: over-limit blocks stay as source with a localized notice and never render', async () => {
    const overChars = 'flowchart LR\n' + 'A-->B\n'.repeat(12000); // > 50 000 chars
    const overLines = Array.from({ length: 2100 }, (_, i) => 'flowchart LR\n  A' + i + '-->B').join('\n');
    const { handle, created, teardown } = await boot({ blocks: (h) => [h.addBlock(overChars), h.addBlock(overLines)], expected: 2 });
    try {
      await handle.waitFor(() => created.every((block) => {
        const container = handle.containerFor(block.pre);
        const notice = container && container.querySelector('.dsh-pm-error, .dsh-pm-status');
        return !!notice && notice.textContent.trim().length > 0;
      }), { label: 'limit notices' });
      assert.equal(handle.fake.state.mounts.length, 0, 'over-limit blocks must never reach pele.mount');
      for (const block of created) {
        const container = handle.containerFor(block.pre);
        assert.ok(container, 'still wrapped so the notice is visible');
        assert.ok(container.textContent.includes('flowchart LR'), 'source must remain visible');
        const notice = container.querySelector('.dsh-pm-error, .dsh-pm-status');
        assert.ok(notice && notice.textContent.trim().length > 0, 'localized notice expected');
        const state = container.querySelector('.dsh-pm-pane')?.getAttribute('data-state');
        assert.ok(container.getAttribute('data-view') === 'code' || state === 'error', 'over-limit block must stay in source view');
      }
    } finally { teardown(); }
  });

  test('R8: a source change before the async render discards the stale render', async () => {
    const handle = await setupClient({ lang: 'en' });
    try {
      const { code } = handle.addBlock('flowchart LR\n  A-->STALE');
      code.textContent = 'flowchart LR\n  A-->FRESH';
      await handle.settle(1);
      await handle.waitFor(() => handle.fake.state.mounts.some((m) => m.source.includes('FRESH')), { label: 'fresh render' });
      const rendered = handle.fake.state.mounts.map((m) => m.source);
      assert.ok(!rendered.some((s) => s.includes('STALE')), 'stale source must never render: ' + JSON.stringify(rendered));
      assert.ok(rendered.some((s) => s.includes('FRESH')), 'latest source must render: ' + JSON.stringify(rendered));
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 1, 'exactly one container');
    } finally { handle.teardown(); }
  });

  test('R8: a detached block is not left half-enhanced', async () => {
    const handle = await setupClient({ lang: 'en' });
    try {
      const { pre } = handle.addBlock('flowchart LR\n  A-->GONE');
      pre.remove();
      await flushAsync();
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'no container may exist for a detached block');
    } finally { handle.teardown(); }
  });

  test('R8: removing the wrapper must not resurrect the block (verifier regression)', async () => {
    const { handle, created, teardown } = await boot({ blocks: (h) => [h.addBlock('flowchart LR\n  A-->REAP')], expected: 1 });
    try {
      const pre = created[0].pre;
      await handle.waitForRenders(1);
      await handle.waitForPaneState(handle.containers()[0], 'ready');
      const wrapper = handle.containerFor(pre);
      assert.ok(wrapper && wrapper.isConnected, 'precondition: the block is enhanced and mounted');
      const mountsBefore = handle.fake.state.mounts.length;
      const destroyedBefore = handle.fake.state.destroyed.length;
      // A framework removes the enhanced wrapper node (message re-render / virtualization).
      wrapper.remove();
      await handle.waitFor(() => handle.fake.state.destroyed.length > destroyedBefore, { label: 'gc disposal of the removed wrapper' });
      const snapshot = () => ({
        containers: handle.doc.querySelectorAll('.dsh-pm').length,
        markers: handle.doc.querySelectorAll('[data-dsh-pele-mermaid-block]').length,
        connected: handle.doc.documentElement.contains(pre),
        mounts: handle.fake.state.mounts.length,
      });
      await handle.waitForStable(() => {
        const s = snapshot();
        return s.containers === 0 && s.markers === 0 && !s.connected && s.mounts === mountsBefore;
      }, { label: 'the removed block stays removed', stableFor: 200, timeout: 2000 });
      const state = snapshot();
      assert.equal(state.containers, 0, 'the removed block must not come back as a .dsh-pm container');
      assert.equal(state.markers, 0, 'the detached pre must not be re-inserted with its block marker');
      assert.equal(state.connected, false, 'the pre of a removed wrapper must stay out of the document');
      assert.equal(state.mounts, mountsBefore, 'gc must not render a block the app deleted');
    } finally { teardown(); }
  });

  test('R8: removing only the pre must not leave a live container behind (verifier regression)', async () => {
    const { handle, created, teardown } = await boot({ blocks: (h) => [h.addBlock('flowchart LR\n  A-->GONE')], expected: 1 });
    try {
      const pre = created[0].pre;
      await handle.waitForRenders(1);
      await handle.waitForPaneState(handle.containers()[0], 'ready');
      const wrapper = handle.containerFor(pre);
      assert.ok(wrapper && wrapper.isConnected, 'precondition: the block is enhanced and mounted');
      const mountsBefore = handle.fake.state.mounts.length;
      const destroyedBefore = handle.fake.state.destroyed.length;
      // Only the source node goes away; the wrapper is still in the document.
      pre.remove();
      await handle.waitFor(() => handle.fake.state.destroyed.length > destroyedBefore, { label: 'gc disposal after pre removal' });
      await handle.waitForStable(() => {
        return handle.doc.querySelectorAll('.dsh-pm').length === 0
          && handle.doc.querySelectorAll('[data-dsh-pele-mermaid-block]').length === 0
          && !handle.doc.documentElement.contains(pre)
          && handle.fake.state.mounts.length === mountsBefore;
      }, { label: 'no container outlives its pre', stableFor: 200, timeout: 2000 });
      assert.equal(handle.doc.querySelectorAll('.dsh-pm').length, 0, 'the container must not outlive its pre');
      assert.equal(handle.doc.querySelectorAll('[data-dsh-pele-mermaid-block]').length, 0, 'no block marker may remain');
      assert.equal(handle.doc.documentElement.contains(pre), false, 'the removed pre must not be re-inserted');
      assert.equal(handle.fake.state.mounts.length, mountsBefore, 'gc must not re-render the removed block');
      assert.equal(handle.doc.documentElement.contains(wrapper), false, 'the orphaned wrapper must be removed too');
    } finally { teardown(); }
  });

  test('R8: many blocks render serially, in document order, one ready pane each', async () => {
    const sources = ['flowchart LR\n  A-->1', 'sequenceDiagram\n  A->>B: 2', 'pie title P\n  "3": 1'];
    const { handle, created, teardown } = await boot({ blocks: (h) => sources.map((s) => h.addBlock(s)), expected: sources.length });
    try {
      await handle.waitForRenders(sources.length);
      assert.deepEqual(handle.fake.state.mounts.map((m) => m.source), sources, 'mounts must follow document order (serial queue)');
      for (const block of created) {
        const container = handle.containerFor(block.pre);
        assert.equal(container.querySelector('.dsh-pm-pane').getAttribute('data-state'), 'ready');
        assert.ok(container.querySelector('svg.pele'));
      }
    } finally { teardown(); }
  });

  test('R11: chrome strings come from MESSAGES and follow a live lang switch', async () => {
    const { handle, teardown } = await boot({ lang: 'en', blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')] });
    try {
      const container = handle.containers()[0];
      const messages = await resolveMessages(handle);
      const enTexts = chromeTexts(container);
      assert.ok(enTexts.length >= 3, 'expected badge + button labels, got ' + JSON.stringify(enTexts));
      if (messages) {
        const unmatchedEn = enTexts.filter((text) => !matchMessage(text, messages.en));
        assert.deepEqual(unmatchedEn, [], 'every en chrome string must match a MESSAGES.en template: ' + JSON.stringify(unmatchedEn));
        handle.doc.documentElement.setAttribute('lang', 'zh-CN');
        await flushAsync();
        const zhTexts = chromeTexts(handle.containerFor(handle.doc.querySelector('pre')) || handle.containers()[0]);
        assert.ok(zhTexts.length >= 3);
        const unmatchedZh = zhTexts.filter((text) => !matchMessage(text, messages['zh-CN']));
        assert.deepEqual(unmatchedZh, [], 'every zh chrome string must match a MESSAGES.zh-CN template: ' + JSON.stringify(unmatchedZh));
      } else {
        assert.ok(true, 'MESSAGES not reachable from the bundle — falling back to label-difference assertions');
      }
      // live switch must actually change the visible labels (R11)
      const before = chromeTexts(handle.containers()[0]);
      handle.doc.documentElement.setAttribute('lang', 'en');
      await flushAsync();
      const after = chromeTexts(handle.containers()[0]);
      assert.notDeepEqual(after, before, 'lang change must re-render the localized labels');
      if (!messages) assert.ok(after.length >= 3, 'without MESSAGES the labels must still be present');
    } finally { teardown(); }
  });

  test('R13: controls are labelled, status announces politely, diagram has an accessible name', async () => {
    const { handle, teardown } = await boot({ blocks: (h) => [h.addBlock('flowchart LR\n  A-->B')] });
    try {
      const container = handle.containers()[0];
      const buttons = buttonsIn(container);
      assert.ok(buttons.length >= 4);
      for (const button of buttons) assert.ok(accessibleName(button).length > 0, 'every toolbar control needs an accessible name');
      const status = container.querySelector('.dsh-pm-status[aria-live]');
      assert.ok(status, '.dsh-pm-status must carry aria-live');
      assert.equal(status.getAttribute('aria-live'), 'polite');
      await handle.waitForRenders(1);
      const rendered = container.querySelector('.dsh-pm-pane svg') || container.querySelector('svg');
      assert.ok(rendered, 'rendered svg missing');
      const named = rendered.getAttribute('aria-label') || rendered.getAttribute('role') || rendered.querySelector('title');
      assert.ok(named, 'the rendered diagram must expose an accessible name (R13)');
    } finally { teardown(); }
  });
}
