// test/inline-zoom.test.mjs — the INLINE pane zoom/pan (SPEC R9 parity for the non-fullscreen
// diagram): Ctrl/Meta + wheel zooms at the pointer, a plain wheel is NOT swallowed, drag pans,
// the state is per block and resets on re-render, and the pane is keyboard accessible.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  CLIENT_BUNDLE, SKIP_MESSAGES, setupClient, flushAsync, installWatchdog,
} from './harness.mjs';

const clientAvailable = existsSync(CLIENT_BUNDLE);
const clearWatchdog = clientAvailable ? installWatchdog('inline-zoom') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

if (!clientAvailable) {
  test('inline zoom suite', { skip: SKIP_MESSAGES.client }, () => {});
} else {
  /** Boot the built client with one rendered diagram and return the handy pieces. */
  async function boot(source = 'flowchart LR\n  A-->B') {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    const block = handle.addBlock(source);
    const cleanup = handle.apply();
    await handle.settle(1);
    await handle.waitForRenders(1);
    await handle.waitForPaneState(handle.containers()[0], 'ready');
    const container = handle.containerFor(block.pre);
    const pane = container.querySelector('.dsh-pm-pane');
    return {
      handle, block, container, pane, cleanup,
      teardown() {
        try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
        handle.env.uninstall();
        handle.env.close();
      },
    };
  }

  const zoomOf = (pane) => Number(pane.getAttribute('data-zoom')) || 100;

  // happy-dom's WheelEvent does not initialise the MouseEvent modifier fields
  // (ctrlKey/metaKey), so they are assigned explicitly after construction.
  const wheel = (handle, pane, init = {}) => {
    const { ctrlKey = false, metaKey = false, ...rest } = init;
    const event = new handle.win.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: -120, clientX: 0, clientY: 0, ...rest,
    });
    event.ctrlKey = ctrlKey;
    event.metaKey = metaKey;
    pane.dispatchEvent(event);
    return event;
  };

  const pointer = (handle, target, type, init) => {
    const event = new handle.win.PointerEvent(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  const key = (handle, target, keyName, init = {}) =>
    target.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));

  test('inline pane: Ctrl + wheel zooms in at the pointer', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      assert.equal(zoomOf(pane), 100, 'the diagram starts at 100%');
      const event = wheel(handle, pane, { ctrlKey: true, deltaY: -120, clientX: 40, clientY: 20 });
      assert.equal(event.defaultPrevented, true, 'Ctrl + wheel must be consumed (the page must not scroll)');
      assert.ok(zoomOf(pane) > 100, 'Ctrl + wheel must zoom in, got ' + zoomOf(pane) + '%');
      const zoomed = zoomOf(pane);
      wheel(handle, pane, { ctrlKey: true, deltaY: 120, clientX: 40, clientY: 20 });
      assert.ok(zoomOf(pane) < zoomed, 'Ctrl + wheel down must zoom out');
    } finally { teardown(); }
  });

  test('inline pane: Meta + wheel zooms too (macOS)', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      const event = wheel(handle, pane, { metaKey: true, deltaY: -120 });
      assert.equal(event.defaultPrevented, true);
      assert.ok(zoomOf(pane) > 100, 'Meta + wheel must zoom in');
    } finally { teardown(); }
  });

  test('inline pane: a PLAIN wheel does not zoom and is not swallowed', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      const event = wheel(handle, pane, { deltaY: -120 });
      assert.equal(event.defaultPrevented, false, 'a plain wheel must scroll the page normally');
      assert.equal(zoomOf(pane), 100, 'a plain wheel must not zoom');
      const down = wheel(handle, pane, { deltaY: 120 });
      assert.equal(down.defaultPrevented, false);
      assert.equal(zoomOf(pane), 100, 'a plain wheel must not zoom in either');
    } finally { teardown(); }
  });

  test('inline pane: drag pans the diagram', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      pointer(handle, pane, 'pointerdown', { clientX: 100, clientY: 100, button: 0 });
      pointer(handle, pane, 'pointermove', { clientX: 60, clientY: 40 });
      pointer(handle, pane, 'pointerup', { clientX: 60, clientY: 40 });
      const svg = pane.querySelector('svg');
      assert.ok(svg, 'the rendered svg must be present');
      const panX = Number(pane.getAttribute('data-pan-x'));
      const panY = Number(pane.getAttribute('data-pan-y'));
      assert.ok(Number.isFinite(panX) && Number.isFinite(panY), 'the pan offsets must be recorded');
      assert.notEqual(panX === 0 && panY === 0, true, 'the drag must have panned the diagram');
      const transform = svg.style.transform || '';
      assert.ok(/translate\(/.test(transform), 'the pan must be applied to the svg, transform=' + JSON.stringify(transform));
    } finally { teardown(); }
  });

  test('inline pane: the zoom state is per block', async () => {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    try {
      const a = handle.addBlock('flowchart LR\n  A-->B');
      const b = handle.addBlock('sequenceDiagram\n  A->>B: x');
      const cleanup = handle.apply();
      await handle.settle(2);
      await handle.waitForRenders(2);
      const paneA = handle.containerFor(a.pre).querySelector('.dsh-pm-pane');
      const paneB = handle.containerFor(b.pre).querySelector('.dsh-pm-pane');
      wheel(handle, paneA, { ctrlKey: true, deltaY: -120 });
      assert.ok(zoomOf(paneA) > 100, 'the first block zoomed');
      assert.equal(zoomOf(paneB), 100, 'the second block must keep its own zoom state');
      if (typeof cleanup === 'function') cleanup();
    } finally { handle.ctxHandle.dispose(); handle.env.uninstall(); handle.env.close(); }
  });

  test('inline pane: the zoom state resets when the diagram re-renders', async () => {
    const { handle, block, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      assert.ok(zoomOf(pane) > 100, 'precondition: the block is zoomed');
      // The source changes -> the block re-renders into a fresh SVG.
      block.code.textContent = 'flowchart LR\n  A-->C';
      await handle.waitFor(() => {
        const container = handle.containerFor(block.pre);
        const current = container && container.querySelector('.dsh-pm-pane');
        return current && current.getAttribute('data-zoom') === '100';
      }, { label: 'the zoom state to reset on re-render' });
      const container = handle.containerFor(block.pre);
      const current = container.querySelector('.dsh-pm-pane');
      assert.equal(zoomOf(current), 100, 'the zoom must reset to 100% after a re-render');
    } finally { teardown(); }
  });

  test('inline pane: focusable, keyboard operable and exposes the zoom to assistive tech', async () => {
    const { handle, pane, container, teardown } = await boot();
    try {
      assert.equal(pane.getAttribute('tabindex'), '0', 'the pane must be focusable');
      assert.ok(pane.getAttribute('aria-label'), 'the pane needs an accessible name');
      pane.focus();
      assert.equal(handle.doc.activeElement, pane, 'the pane must take the focus');
      key(handle, pane, '+');
      assert.ok(zoomOf(pane) > 100, 'the + key must zoom in');
      const zoomed = zoomOf(pane);
      key(handle, pane, '-');
      assert.ok(zoomOf(pane) < zoomed, 'the - key must zoom out');
      key(handle, pane, '0');
      assert.equal(zoomOf(pane), 100, 'the 0 key must reset the zoom');
      key(handle, pane, 'ArrowRight');
      const status = container.querySelector('.dsh-pm-sr-only[aria-live]');
      assert.ok(status, 'a live region must expose the current zoom');
      assert.match(status.textContent, /%/, 'the zoom must be readable by assistive tech, got ' + JSON.stringify(status.textContent));
    } finally { teardown(); }
  });

  test('inline pane: the zoomed svg keeps its size in the scroll container and does not overflow it', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const svg = pane.querySelector('svg');
      assert.ok(svg, 'svg missing');
      assert.equal(svg.style.maxWidth, 'none', 'a zoomed svg must not be clamped to the column width');
      assert.ok(/px$/.test(svg.style.width), 'the zoomed svg must have an explicit width, got ' + JSON.stringify(svg.style.width));
      const natural = 320;
      const width = parseFloat(svg.style.width);
      assert.ok(width > natural, 'the zoomed svg must be larger than the natural size, got ' + width);
      // The pane is the scroll container, so the enlarged content stays inside it.
      const paneOverflow = pane.style.overflow;
      assert.ok(paneOverflow === '' || paneOverflow === 'auto' || paneOverflow === 'scroll', 'unexpected overflow: ' + paneOverflow);
    } finally { teardown(); }
  });
}
