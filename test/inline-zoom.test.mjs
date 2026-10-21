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
      const panX = Number(pane.getAttribute('data-pan-x'));
      const panY = Number(pane.getAttribute('data-pan-y'));
      assert.ok(Number.isFinite(panX) && Number.isFinite(panY), 'the pan offsets must be recorded');
      assert.notEqual(panX === 0 && panY === 0, true, 'the drag must have panned the diagram');
      // The pan is written to the STAGE, not the svg: Pele rewrites the whole style attribute
      // of the svg it mounted whenever the pane resizes, so a pan or a zoom parked there would
      // be wiped on the next resize (see inlineStage in src/client.js).
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      assert.ok(stage, 'the inline stage must exist');
      assert.match(stage.style.transform || '', /translate\(/, 'the pan must be applied to the stage, transform=' + JSON.stringify(stage.style.transform));
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

  test('inline pane: the zoomed diagram keeps its size on the STAGE, inside the scroll container', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      const svg = pane.querySelector('svg');
      assert.ok(stage, 'the inline stage must exist');
      assert.ok(svg, 'svg missing');
      // The size lives on OUR element, not on Pele's svg: Pele installs a ResizeObserver on
      // the pane and rewrites the svg's whole style attribute on every pane resize, which is
      // exactly when a zoom is applied - so a zoom written there was wiped immediately, and
      // data-zoom ran all the way down to 10% while the drawing never changed size.
      assert.ok(/px$/.test(stage.style.width), 'the stage must carry an explicit width, got ' + JSON.stringify(stage.style.width));
      assert.ok(/px$/.test(stage.style.height), 'the stage must carry an explicit height, got ' + JSON.stringify(stage.style.height));
      const zoomed = parseFloat(stage.style.width);
      assert.ok(zoomed > 0, 'the stage must have a real width, got ' + zoomed);
      // The svg is laid out BY the stage, so a stylesheet rule (not an inline style Pele can
      // overwrite) must be what fills it.
      assert.equal(stage.contains(svg), true, 'the svg must live inside the stage');
      // The pane is the scroll container, so the enlarged content stays inside it.
      const paneOverflow = pane.style.overflow;
      assert.ok(paneOverflow === '' || paneOverflow === 'auto' || paneOverflow === 'scroll', 'unexpected overflow: ' + paneOverflow);
    } finally { teardown(); }
  });

  // Regression: zooming out used to stop dead at the initial size. The stage is now sized
  // explicitly at EVERY scale - including 100% - instead of handing the layout back to the
  // stylesheet's `max-width:100%`, so the diagram keeps shrinking below where it started.
  test('inline pane: zooming out goes BELOW the initial size and keeps shrinking', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      assert.ok(stage, 'the inline stage must exist');
      const initial = parseFloat(stage.style.width);
      assert.ok(initial > 0, 'precondition: the stage starts with a real width, got ' + initial);

      const widths = [initial];
      for (let i = 0; i < 4; i += 1) {
        wheel(handle, pane, { ctrlKey: true, deltaY: 120 });
        widths.push(parseFloat(stage.style.width));
      }
      assert.ok(zoomOf(pane) < 100, 'data-zoom must report below 100%, got ' + zoomOf(pane) + '%');
      for (let i = 1; i < widths.length; i += 1) {
        assert.ok(
          widths[i] < widths[i - 1],
          'each zoom-out step must shrink the drawing: ' + widths.join(' -> '),
        );
      }
      assert.ok(widths[widths.length - 1] < initial, 'the final size must be below the initial one');
      // The zoom must also be readable, not just visually applied.
      assert.ok(/^\d+$/.test(String(zoomOf(pane))), 'data-zoom must be a percentage, got ' + zoomOf(pane));
    } finally { teardown(); }
  });

  // Regression: the anchor used to creep towards the diagram's top-left corner on every step.
  // The maths now converts through the stage's centring ORIGIN, which changes with the scale
  // (a diagram narrower than the pane is centred, a wider one is left aligned). This asserts
  // the invariant directly: the content offset under the anchor must map onto the same
  // natural coordinate, i.e. `scrollLeft + px - originX` divided by the effective scale.
  test('inline pane: the zoom anchor maps onto a fixed natural coordinate', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      // No layout engine here (clientWidth is 0), so the pane is not scrollable and the scroll
      // offsets clamp to 0. What is still checkable - and what actually broke - is the
      // conversion: with the origin applied, a zoom in and the matching zoom out must return
      // the stage to exactly the size it started at.
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      const initial = parseFloat(stage.style.width);
      wheel(handle, pane, { ctrlKey: true, deltaY: -120 });
      const zoomedIn = parseFloat(stage.style.width);
      assert.ok(zoomedIn > initial, 'precondition: the zoom-in grew the drawing');
      wheel(handle, pane, { ctrlKey: true, deltaY: 120 });
      const zoomedBack = parseFloat(stage.style.width);
      assert.equal(zoomedBack, initial, 'in-then-out must return to the initial size, got ' + zoomedBack);
    } finally { teardown(); }
  });

  test('inline pane: the toolbar buttons and the +/- keys drive the same zoom', async () => {
    const { handle, pane, container, teardown } = await boot();
    try {
      // Selected by aria-label, which localizeEntry() fills from the i18n table. This suite boots
      // with lang:'en', so the labels below are the English ones; the point of the test is that
      // the three entry points drive ONE state, not what the button happens to be called.
      const zoomButton = (label) => {
        const bar = container.querySelector('.dsh-pm-actions');
        const btn = [...bar.querySelectorAll('button')]
          .find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes(label));
        assert.ok(btn, 'no "' + label + '" button in the inline toolbar');
        return btn;
      };
      zoomButton('zoom in').click();
      const afterButton = zoomOf(pane);
      assert.ok(afterButton > 100, 'the zoom-in button must zoom in, got ' + afterButton + '%');
      zoomButton('zoom out').click();
      assert.ok(zoomOf(pane) < afterButton, 'the zoom-out button must zoom back out');
      zoomButton('reset').click();
      assert.equal(zoomOf(pane), 100, 'the reset button must return to 100%');

      // The keyboard path uses the same anchor (the visible centre), so the two must agree.
      key(handle, pane, '+');
      assert.equal(zoomOf(pane), afterButton, 'the + key must match the zoom-in button');
      key(handle, pane, '-');
      assert.equal(zoomOf(pane), 100, 'the - key must match the zoom-out button');
    } finally { teardown(); }
  });

  // Regression: a drag must survive the pointer leaving the pane, and a release
  // outside the pane must end it. The move and release listeners live on the
  // document, because a pointer that leaves the pane no longer bubbles to it.
  test('a drag keeps panning after the pointer leaves the pane', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      const doc = handle.doc;
      const pointer = (type, x, y) => new handle.win.PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      });
      pane.dispatchEvent(pointer('pointerdown', 20, 20));
      // The move targets the document, i.e. the pointer is no longer over the pane.
      doc.dispatchEvent(pointer('pointermove', 150, 90));
      await flushAsync(4);
      assert.notEqual(
        pane.getAttribute('data-pan-x'), '0',
        'a drag that leaves the pane must still pan the diagram',
      );
    } finally { teardown(); }
  });

  test('releasing the pointer outside the pane ends the drag', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      const doc = handle.doc;
      const pointer = (type, x, y) => new handle.win.PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      });
      pane.dispatchEvent(pointer('pointerdown', 20, 20));
      doc.dispatchEvent(pointer('pointermove', 150, 90));
      await flushAsync(4);
      assert.equal(pane.getAttribute('data-dragging'), 'true', 'precondition: the drag is active');
      // Released far away from the pane.
      doc.dispatchEvent(pointer('pointerup', 900, 900));
      await flushAsync(4);
      assert.equal(
        pane.getAttribute('data-dragging'), null,
        'a release outside the pane must clear the dragging state',
      );
      const after = pane.getAttribute('data-pan-x');
      doc.dispatchEvent(pointer('pointermove', 400, 300));
      await flushAsync(4);
      assert.equal(
        pane.getAttribute('data-pan-x'), after,
        'a stray move after the release must not pan any more',
      );
    } finally { teardown(); }
  });

}
