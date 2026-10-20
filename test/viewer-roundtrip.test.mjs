// test/viewer-roundtrip.test.mjs - the lossless round trip between the inline pane and the
// fullscreen overlay (SPEC R9):
//   open -> zoom -> close -> the inline pane keeps its position and stays visible
//   -> the focus is back on the Fullscreen trigger; re-opening starts from the
//   inline zoom instead of always fitting to the window.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  CLIENT_BUNDLE, SKIP_MESSAGES, setupClient, flushAsync, installWatchdog, accessibleName, buttonsIn,
} from './harness.mjs';

const clientAvailable = existsSync(CLIENT_BUNDLE);
const clearWatchdog = clientAvailable ? installWatchdog('viewer-roundtrip') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

if (!clientAvailable) {
  test('viewer round trip suite', { skip: SKIP_MESSAGES.client }, () => {});
} else {
  const click = (handle, el) => el.dispatchEvent(new handle.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (handle, target, keyName, init = {}) =>
    target.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));

  // happy-dom's WheelEvent does not initialise the MouseEvent modifier fields.
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

  /** Boot the built client with one rendered diagram. */
  async function boot() {
    const handle = await setupClient({ lang: 'en', autoApply: false });
    const block = handle.addBlock('flowchart LR\n  A-->B');
    const cleanup = handle.apply();
    await handle.settle(1);
    await handle.waitForRenders(1);
    await handle.waitForPaneState(handle.containers()[0], 'ready');
    const container = handle.containerFor(block.pre);
    const pane = container.querySelector('.dsh-pm-pane');
    const trigger = buttonsIn(container).find((b) =>
      /full|screen|expand|view|全屏|放大|大图/i.test(accessibleName(b)) && !b.hasAttribute('aria-pressed'));
    return {
      handle, block, container, pane, trigger,
      teardown() {
        try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
        handle.env.uninstall();
        handle.env.close();
      },
    };
  }

  const zoomOf = (pane) => Number(pane.getAttribute('data-zoom')) || 100;

  test('round trip: open -> zoom -> close keeps the inline position and the focus on the trigger', async () => {
    const { handle, container, pane, trigger, teardown } = await boot();
    try {
      assert.ok(trigger, 'the Fullscreen trigger must exist');
      // The user zooms the inline diagram and scrolls it.
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const zoomed = zoomOf(pane);
      assert.ok(zoomed > 100, 'precondition: the inline diagram is zoomed');
      pane.scrollLeft = 37;
      pane.scrollTop = 11;

      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must be open');
      assert.ok(overlay.contains(handle.doc.activeElement), 'the focus must move into the overlay');

      key(handle, handle.doc, 'Escape');
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'the overlay must be closed');
      assert.equal(handle.doc.activeElement, trigger, 'the focus must return to the Fullscreen trigger');
      assert.equal(zoomOf(pane), zoomed, 'the inline zoom must be restored');
      assert.equal(pane.scrollLeft, 37, 'the inline scroll position must be restored');
      assert.equal(pane.scrollTop, 11, 'the inline scroll position must be restored');
      // The inline diagram is still on screen, not scrolled out of view.
      assert.ok(container.isConnected, 'the block must stay in the document');
      const svg = pane.querySelector('svg');
      assert.ok(svg, 'the inline diagram must still be there');
      assert.ok(svg.getAttribute('width') || svg.style.width, 'the inline diagram keeps its size');
    } finally { teardown(); }
  });

  test('round trip: re-opening the overlay starts from the inline zoom, not from fit-to-window', async () => {
    const { handle, pane, trigger, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const zoomed = zoomOf(pane);
      assert.ok(zoomed > 100, 'precondition: the inline diagram is zoomed');

      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must be open');
      const stage = overlay.querySelector('.dsh-pm-stage');
      const transform = stage.style.transform || '';
      const scaleMatch = /scale\(([\d.]+)\)/.exec(transform);
      assert.ok(scaleMatch, 'the stage must carry a scale transform, got ' + JSON.stringify(transform));
      const scale = Number(scaleMatch[1]);
      // The overlay continues from the inline zoom, so the effective scale is
      // the inline one rather than the fit-to-window scale. (The inline fit
      // scale is 1 in the test DOM, where the pane has no layout.)
      assert.ok(Math.abs(scale - zoomed / 100) < 0.01,
        'the overlay must start from the inline zoom (' + zoomed + '%), got scale ' + scale);
      // The overlay is NOT reset to a plain fit-to-window scale.
      assert.ok(Math.abs(scale - 1) > 0.001, 'the overlay must not fall back to 100%');
    } finally { teardown(); }
  });

  test('round trip: closing the overlay with the close button also restores the inline pane', async () => {
    const { handle, pane, trigger, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const zoomed = zoomOf(pane);
      pane.scrollLeft = 21;
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      const closeButton = [...overlay.querySelectorAll('button')].find((b) =>
        /close|dismiss|关闭|닫기/i.test(accessibleName(b)));
      assert.ok(closeButton, 'the overlay must have a close control');
      click(handle, closeButton);
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'the overlay must be closed');
      assert.equal(handle.doc.activeElement, trigger, 'the focus must return to the trigger');
      assert.equal(zoomOf(pane), zoomed, 'the inline zoom must be restored');
      assert.equal(pane.scrollLeft, 21, 'the inline scroll position must be restored');
    } finally { teardown(); }
  });

  test('round trip: an unzoomed inline pane still opens the overlay and closes cleanly', async () => {
    const { handle, pane, trigger, teardown } = await boot();
    try {
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must be open');
      const stage = overlay.querySelector('.dsh-pm-stage');
      assert.ok(/scale\(/.test(stage.style.transform || ''), 'the overlay fits the diagram to the window');
      key(handle, handle.doc, 'Escape');
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null);
      assert.equal(handle.doc.activeElement, trigger, 'the focus must return to the trigger');
      assert.equal(zoomOf(pane), 100, 'the inline zoom is untouched');
    } finally { teardown(); }
  });
}
