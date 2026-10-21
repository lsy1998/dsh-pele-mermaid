// test/regression-inline-pan.test.mjs — regression tests for the inline pane's pan model (Defect B).
//
// B: after ctrl+wheel zoom the pane must never write a NEGATIVE scroll offset (a browser clamps
//    it to 0, which silently broke the anchored-zoom maths and pushed the diagram out of view);
//    the drag must always move the diagram with the pointer; a diagram wider than the pane must
//    be fully reachable by dragging; a diagram smaller than the pane must not scroll at all; and
//    the pane must not apply a transform while it can scroll (ONE pan model, not two).
//
// happy-dom has NO layout engine: clientWidth/clientHeight are 0 and getBoundingClientRect
// returns zeros. giveLayout() stubs those on the pane and the svg, the way the lead's probe did,
// so the zoom/pan maths runs against real numbers. Everything below is offline.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  CLIENT_BUNDLE, SKIP_MESSAGES, setupClient, flushAsync, installWatchdog,
  accessibleName, buttonsIn,
} from './harness.mjs';

const clientAvailable = existsSync(CLIENT_BUNDLE);
const clearWatchdog = clientAvailable ? installWatchdog('regression-inline-pan') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

if (!clientAvailable) {
  test('regression suite', { skip: SKIP_MESSAGES.client }, () => {});
} else {
  const NATURAL_WIDTH = 1200;
  const NATURAL_HEIGHT = 500;
  const PANE_WIDTH = 400;
  const PANE_HEIGHT = 300;

  const PRISTINE = '<svg class="pele pele-flowchart" xmlns="http://www.w3.org/2000/svg" ' +
    'width="' + NATURAL_WIDTH + '" height="' + NATURAL_HEIGHT + '" role="img" aria-label="flowchart diagram">' +
    '<title>flowchart</title><g><rect width="10" height="10"/></g></svg>';

  const pointer = (handle, target, type, init) =>
    target.dispatchEvent(new handle.win.PointerEvent(type, { bubbles: true, cancelable: true, ...init }));

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

  const click = (handle, el) => el.dispatchEvent(new handle.win.MouseEvent('click', { bubbles: true, cancelable: true }));

  const zoomOf = (pane) => Number(pane.getAttribute('data-zoom')) || 100;

  /**
   * happy-dom has no layout engine. Give the pane and the svg a fake layout so
   * clientWidth/clientHeight and getBoundingClientRect return real numbers.
   */
  function giveLayout(handle, pane) {
    const patch = (element, key, value) => {
      Object.defineProperty(element, key, { configurable: true, get: () => value });
    };
    patch(pane, 'clientWidth', PANE_WIDTH);
    patch(pane, 'clientHeight', PANE_HEIGHT);
    pane.getBoundingClientRect = () => ({
      left: 0, top: 0, width: PANE_WIDTH, height: PANE_HEIGHT,
      right: PANE_WIDTH, bottom: PANE_HEIGHT, x: 0, y: 0,
    });
    const svg = pane.querySelector('svg');
    if (svg) {
      patch(svg, 'clientWidth', NATURAL_WIDTH);
      patch(svg, 'clientHeight', NATURAL_HEIGHT);
      svg.getBoundingClientRect = () => ({
        left: 0, top: 0, width: NATURAL_WIDTH, height: NATURAL_HEIGHT,
        right: NATURAL_WIDTH, bottom: NATURAL_HEIGHT, x: 0, y: 0,
      });
    }
  }

  /**
   * A scroll container whose extent tracks what was written, like a browser's: the offset is
   * clamped to [0, scrollSize - clientSize] and scrollWidth/scrollHeight are derived from the
   * STAGE's inline size.
   *
   * The stage, not the svg: Pele rewrites the whole style attribute of the svg it mounted
   * whenever the pane resizes, so the zoom is written onto the stage we own (see inlineStage
   * in src/client.js). Reading the svg here would report 0 and every extent assertion below
   * would be vacuous.
   */
  function makeScrollPane(pane) {
    let left = 0;
    let top = 0;
    const stage = () => pane.querySelector('.dsh-pm-inline-stage') || pane.querySelector('svg');
    const extentX = () => {
      const element = stage();
      const width = element ? parseFloat(element.style.width) || 0 : 0;
      return Math.max(width, PANE_WIDTH);
    };
    const extentY = () => {
      const element = stage();
      const height = element ? parseFloat(element.style.height) || 0 : 0;
      return Math.max(height, PANE_HEIGHT);
    };
    Object.defineProperty(pane, 'scrollLeft', {
      configurable: true, get: () => left,
      set: (value) => { left = Math.min(Math.max(0, Number(value) || 0), Math.max(0, extentX() - PANE_WIDTH)); },
    });
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true, get: () => top,
      set: (value) => { top = Math.min(Math.max(0, Number(value) || 0), Math.max(0, extentY() - PANE_HEIGHT)); },
    });
    Object.defineProperty(pane, 'scrollWidth', { configurable: true, get: () => extentX() });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => extentY() });
    return pane;
  }

  /** Boot one rendered 1200x500 diagram inside a 400x300 pane, with a fake layout. */
  async function boot() {
    const handle = await setupClient({
      lang: 'en',
      autoApply: false,
      peleOptions: { svgFor: () => PRISTINE },
    });
    const block = handle.addBlock('flowchart LR\n  A-->B');
    const cleanup = handle.apply();
    await handle.settle(1);
    await handle.waitForRenders(1);
    await handle.waitForPaneState(handle.containers()[0], 'ready');
    const container = handle.containerFor(block.pre);
    const pane = container.querySelector('.dsh-pm-pane');
    makeScrollPane(pane);
    giveLayout(handle, pane);
    return {
      handle, block, container, pane, cleanup,
      teardown() {
        try { if (typeof cleanup === 'function') cleanup(); } finally { handle.ctxHandle.dispose(); }
        handle.env.uninstall();
        handle.env.close();
      },
    };
  }

  /** Capture the payload the Download action produces. */
  async function captureDownload(handle, container) {
    const blobs = [];
    const clicked = [];
    const originalClick = handle.win.HTMLAnchorElement.prototype.click;
    const originalCreate = handle.win.URL.createObjectURL.bind(handle.win.URL);
    handle.win.HTMLAnchorElement.prototype.click = function () { clicked.push(this); };
    handle.win.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:regression-' + blobs.length; };
    try {
      for (const button of buttonsIn(container)) {
        if (!/download/i.test(accessibleName(button))) continue;
        click(handle, button);
        await flushAsync(2);
        if (clicked.length) break;
      }
    } finally {
      handle.win.HTMLAnchorElement.prototype.click = originalClick;
      handle.win.URL.createObjectURL = originalCreate;
    }
    const anchor = clicked[0] || null;
    const payload = blobs.length ? await blobs[0].text() : null;
    return { anchor, payload };
  }


  /* ---------------------------------------------------------------- *
   * Defect B — no negative scroll, and the pan always moves the diagram
   * ---------------------------------------------------------------- */

  test('B: ctrl+wheel never writes a negative scroll, at any pointer position', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      // Zoom in repeatedly at the extreme top-left corner: the anchored maths wants a
      // negative scrollLeft/scrollTop here, which is exactly the measured -57.33 / -237.33 /
      // -540.18 regression.
      for (const point of [[0, 0], [1, 1], [5, 5], [0, 0], [399, 299], [0, 0]]) {
        wheel(handle, pane, { ctrlKey: true, deltaY: -200, clientX: point[0], clientY: point[1] });
        assert.ok(pane.scrollLeft >= 0,
          'scrollLeft must never be negative, got ' + pane.scrollLeft + ' at ' + point.join(','));
        assert.ok(pane.scrollTop >= 0,
          'scrollTop must never be negative, got ' + pane.scrollTop + ' at ' + point.join(','));
      }
      // And zooming back out never goes negative either.
      for (let i = 0; i < 12; i += 1) {
        wheel(handle, pane, { ctrlKey: true, deltaY: 200, clientX: 0, clientY: 0 });
        assert.ok(pane.scrollLeft >= 0 && pane.scrollTop >= 0, 'zooming out must stay >= 0');
      }
    } finally { teardown(); }
  });

  test('B: a diagram wider than the pane is fully reachable by dragging', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -240 });
      const extent = pane.scrollWidth - PANE_WIDTH;
      assert.ok(extent > 0, 'precondition: the zoomed diagram is wider than the pane');
      // Drag left: the content follows the pointer and the scroll offset grows.
      pointer(handle, pane, "pointerdown", { clientX: 380, clientY: 150, button: 0 });
      pointer(handle, handle.doc, "pointermove", { clientX: 20, clientY: 150 });
      await flushAsync(4);
      assert.ok(pane.scrollLeft > 0, 'dragging left must scroll the pane, got ' + pane.scrollLeft);
      // Drag right past the origin: the offset must clamp to 0, never go negative.
      pointer(handle, handle.doc, "pointermove", { clientX: 900, clientY: 150 });
      await flushAsync(4);
      assert.equal(pane.scrollLeft, 0, 'dragging right must clamp at the origin, got ' + pane.scrollLeft);
      pointer(handle, handle.doc, "pointerup", { clientX: 900, clientY: 150 });
      // The far end of the diagram is reachable.
      pointer(handle, pane, "pointerdown", { clientX: 20, clientY: 150, button: 0 });
      pointer(handle, handle.doc, "pointermove", { clientX: -900, clientY: 150 });
      await flushAsync(4);
      assert.ok(pane.scrollLeft >= extent - 1,
        'the whole width must be reachable, got ' + pane.scrollLeft + ' of ' + extent);
      pointer(handle, handle.doc, "pointerup", { clientX: -900, clientY: 150 });
    } finally { teardown(); }
  });

  test('B: a diagram smaller than the pane is not scrolled at all', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      // Zoom out below the fit scale: 1200x500 into a 400x300 pane fits to 400x166, so the
      // diagram is narrower than the pane in both axes and there is nothing to scroll.
      wheel(handle, pane, { ctrlKey: true, deltaY: 240 });
      wheel(handle, pane, { ctrlKey: true, deltaY: 240 });
      pointer(handle, pane, "pointerdown", { clientX: 200, clientY: 150, button: 0 });
      pointer(handle, handle.doc, "pointermove", { clientX: 40, clientY: 40 });
      await flushAsync(4);
      const width = parseFloat(pane.querySelector('svg').style.width) || 0;
      if (width <= PANE_WIDTH) {
        assert.equal(pane.scrollLeft, 0, 'a diagram narrower than the pane must not scroll horizontally');
        assert.equal(pane.scrollTop, 0, 'a diagram shorter than the pane must not scroll vertically');
      }
      pointer(handle, handle.doc, "pointerup", { clientX: 40, clientY: 40 });
    } finally { teardown(); }
  });

  test('B: the pane never applies a transform while it can scroll', async () => {
    const { handle, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -240, clientX: 200, clientY: 150 });
      pointer(handle, pane, "pointerdown", { clientX: 200, clientY: 150, button: 0 });
      pointer(handle, handle.doc, "pointermove", { clientX: 60, clientY: 60 });
      await flushAsync(4);
      const transform = pane.querySelector('svg').style.transform || '';
      assert.equal(transform, '', 'a scrollable pane must not translate the svg, got ' + JSON.stringify(transform));
      pointer(handle, handle.doc, "pointerup", { clientX: 60, clientY: 60 });
    } finally { teardown(); }
  });
}
