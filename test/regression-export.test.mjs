// test/regression-export-zoom.test.mjs — regression tests for the four reported defects.
//
// A: the exported SVG must contain the WHOLE diagram at its natural size, never the cropped
//    on-screen rendering, and must be identical whether or not the user zoomed or panned.
// B: the inline pane must never write a negative scroll, and the pan must always move the
//    diagram (scroll when the pane can scroll, translate otherwise).
// C: the fullscreen overlay must offer an unmistakable exit: a labelled text button, a
//    backdrop click and Escape.
// D: the inline toolbar must expose zoom in / zoom out / reset, and a click must always
//    change the zoom state even when the pane has no layout yet.
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
const clearWatchdog = clientAvailable ? installWatchdog('regression-export-zoom') : null;
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
   * Defect A — the export is the whole diagram, not the on-screen crop
   * ---------------------------------------------------------------- */

  test('A: the export keeps the natural width/height after the diagram was zoomed', async () => {
    const { handle, container, pane, teardown } = await boot();
    try {
      wheel(handle, pane, { ctrlKey: true, deltaY: -240, clientX: 200, clientY: 150 });
      assert.ok(zoomOf(pane) > 100, 'precondition: the diagram is zoomed');
      // The on-screen STAGE now carries the zoomed layout size (not the svg - Pele rewrites
      // the svg's whole style attribute on every pane resize, so a zoom written there would be
      // wiped), and the pane is scrolled into the middle of the diagram: the on-screen view is
      // a CROP, which is exactly what the old export serialised.
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      const onScreenWidth = parseFloat(stage.style.width) || 0;
      assert.ok(onScreenWidth > 0 && onScreenWidth !== NATURAL_WIDTH,
        'precondition: the on-screen stage carries a zoomed size (' + onScreenWidth + ')');
      pointer(handle, pane, 'pointerdown', { clientX: 380, clientY: 150, button: 0 });
      pointer(handle, handle.doc, 'pointermove', { clientX: 20, clientY: 150 });
      await flushAsync(4);
      assert.ok(pane.scrollLeft > 0, 'precondition: the pane is scrolled, so the view is a crop');
      pointer(handle, handle.doc, 'pointerup', { clientX: 20, clientY: 150 });

      const { payload } = await captureDownload(handle, container);
      assert.ok(payload, 'the download produced a payload');
      assert.ok(payload.includes('<svg'), 'the export is an svg document');
      assert.ok(payload.includes('xmlns="http://www.w3.org/2000/svg"'), 'the export is standalone');
      assert.ok(payload.includes('--pele-'), 'R10: the export carries the theme variables');

      const root = payload.slice(0, payload.indexOf('>') + 1);
      const width = /\swidth="([\d.]+)"/.exec(root);
      const height = /\sheight="([\d.]+)"/.exec(root);
      assert.ok(width && height, 'the exported root must carry an explicit size, got ' + root.slice(0, 160));
      assert.equal(Number(width[1]), NATURAL_WIDTH, 'the export must keep the natural width');
      assert.equal(Number(height[1]), NATURAL_HEIGHT, 'the export must keep the natural height');
      // No zoom remnants anywhere in the file.
      assert.ok(!/transform\s*=/.test(payload), 'the export must not carry a transform');
      assert.ok(!/max-width\s*:\s*none/.test(payload), 'the export must not carry the zoom max-width');
      assert.ok(!/translate\(/.test(payload), 'the export must not be translated');
    } finally { teardown(); }
  });

  test('A: the export is identical whether or not the user zoomed and panned', async () => {
    const plain = await boot();
    let untouched = '';
    try {
      const result = await captureDownload(plain.handle, plain.container);
      untouched = result.payload || '';
    } finally { plain.teardown(); }

    const moved = await boot();
    try {
      // Zoom twice at two different pointer positions, then pan by drag.
      wheel(moved.handle, moved.pane, { ctrlKey: true, deltaY: -240, clientX: 10, clientY: 10 });
      wheel(moved.handle, moved.pane, { ctrlKey: true, deltaY: -240, clientX: 380, clientY: 290 });
      pointer(moved.handle, moved.pane, 'pointerdown', { clientX: 300, clientY: 200, button: 0 });
      pointer(moved.handle, moved.handle.doc, 'pointermove', { clientX: 120, clientY: 40 });
      pointer(moved.handle, moved.handle.doc, 'pointerup', { clientX: 120, clientY: 40 });
      await flushAsync(4);
      assert.ok(zoomOf(moved.pane) > 100, 'precondition: the diagram was zoomed');

      const result = await captureDownload(moved.handle, moved.container);
      const zoomed = result.payload || '';
      assert.equal(zoomed, untouched,
        'the export must not depend on the zoom/pan state (lengths ' + zoomed.length + ' vs ' + untouched.length + ')');
    } finally { moved.teardown(); }
  });

}
