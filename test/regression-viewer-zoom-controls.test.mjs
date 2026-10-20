// test/regression-viewer-zoom-controls.test.mjs — regression tests for the fullscreen exit
// affordance (Defect C) and the inline zoom controls (Defect D).
//
// C: the fullscreen overlay must offer an unmistakable exit: a labelled TEXT button (not just a
//    ✕ glyph), a backdrop click, and Escape - while a click on the diagram or the bar must NOT
//    close it.
// D: the inline toolbar must expose labelled zoom in / zoom out / reset controls, and a click must
//    ALWAYS change the zoom state even when the pane has no layout yet (the "zoom buttons do not
//    respond" symptom).
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
const clearWatchdog = clientAvailable ? installWatchdog('regression-viewer-zoom-controls') : null;
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
   * svg's inline size. This is what makes the negative-scroll assertion meaningful.
   */
  function makeScrollPane(pane) {
    let left = 0;
    let top = 0;
    const svg = () => pane.querySelector('svg');
    const extentX = () => {
      const element = svg();
      const width = element ? parseFloat(element.style.width) || 0 : 0;
      return Math.max(width, PANE_WIDTH);
    };
    const extentY = () => {
      const element = svg();
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
   * Defect C — an unmistakable way out of the fullscreen overlay
   * ---------------------------------------------------------------- */

  test('C: the overlay offers a labelled text exit button, a backdrop click and Escape', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      assert.ok(trigger, 'the Fullscreen trigger must exist');

      // 1) the labelled text button
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      const exitButton = [...overlay.querySelectorAll('button')].find((b) => {
        const name = accessibleName(b);
        return /exit|close|dismiss/i.test(name);
      });
      assert.ok(exitButton, 'the overlay must have an exit control');
      // Not just a glyph: the button carries VISIBLE text.
      const visibleText = (exitButton.textContent || '').trim();
      assert.ok(visibleText.length > 1,
        'the exit control must show a visible label, got ' + JSON.stringify(visibleText));
      assert.ok(/exit|close|dismiss|退出|关闭/i.test(visibleText),
        'the visible label must say exit/close, got ' + JSON.stringify(visibleText));
      // The overlay really closes with it.
      click(handle, exitButton);
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'the exit button must close the overlay');

      // 2) a backdrop click
      click(handle, trigger);
      await flushAsync(2);
      const reopened = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(reopened, 'the overlay must re-open');
      const backdrop = reopened.querySelector('.dsh-pm-viewer-backdrop');
      assert.ok(backdrop, 'the overlay must have a backdrop');
      click(handle, backdrop);
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null,
        'a backdrop click must close the overlay');

      // 3) Escape still works
      click(handle, trigger);
      await flushAsync(2);
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'the overlay must open again');
      handle.doc.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'Escape must still close the overlay');
    } finally { teardown(); }
  });

  test('C: a click on the diagram or the bar does NOT close the overlay', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      click(handle, overlay.querySelector('.dsh-pm-viewer-bar'));
      await flushAsync(2);
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'a click on the bar must not close the overlay');
      click(handle, overlay.querySelector('.dsh-pm-viewport'));
      await flushAsync(2);
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'a click on the diagram must not close the overlay');
    } finally { teardown(); }
  });

  /* ---------------------------------------------------------------- *
   * Defect D — visible, reliable zoom controls on the inline diagram
   * ---------------------------------------------------------------- */

  test('D: the inline toolbar exposes labelled zoom in / zoom out / reset controls', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const buttons = buttonsIn(container);
      const names = buttons.map(accessibleName);
      const zoomIn = buttons.find((b) => /^zoom in$/i.test(accessibleName(b)));
      const zoomOut = buttons.find((b) => /^zoom out$/i.test(accessibleName(b)));
      const reset = buttons.find((b) => /reset/i.test(accessibleName(b)));
      assert.ok(zoomIn, 'the inline toolbar must have a Zoom in button, got ' + JSON.stringify(names));
      assert.ok(zoomOut, 'the inline toolbar must have a Zoom out button');
      assert.ok(reset, 'the inline toolbar must have a zoom reset button');
      // Every control is labelled (R13).
      for (const button of buttons) assert.ok(accessibleName(button).length > 0, 'every control needs a name');
      // They are localized (R11).
      handle.doc.documentElement.setAttribute('lang', 'zh-CN');
      await flushAsync(2);
      const zhNames = buttonsIn(container).map(accessibleName);
      assert.ok(zhNames.some((n) => /放大/.test(n)), 'the zoom controls must be localized, got ' + JSON.stringify(zhNames));
    } finally { teardown(); }
  });

  test('D: clicking the zoom buttons always changes the zoom, even with no layout', async () => {
    const { handle, container, pane, teardown } = await boot();
    try {
      // happy-dom reports clientWidth 0; restore that to prove the click path does not
      // depend on layout.
      Object.defineProperty(pane, 'clientWidth', { configurable: true, get: () => 0 });
      Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 0 });
      const before = zoomOf(pane);
      assert.equal(before, 100, 'the diagram starts at 100%');

      const zoomIn = buttonsIn(container).find((b) => /^zoom in$/i.test(accessibleName(b)));
      click(handle, zoomIn);
      await flushAsync(2);
      const zoomed = zoomOf(pane);
      assert.ok(zoomed > before, 'the Zoom in click must change the state, got ' + zoomed);
      assert.ok(/px$/.test(pane.querySelector('svg').style.width || ''),
        'the zoomed svg must get an explicit width even without layout');

      const zoomOut = buttonsIn(container).find((b) => /^zoom out$/i.test(accessibleName(b)));
      click(handle, zoomOut);
      click(handle, zoomOut);
      await flushAsync(2);
      assert.ok(zoomOf(pane) < zoomed, 'the Zoom out clicks must zoom back, got ' + zoomOf(pane));

      const reset = buttonsIn(container).find((b) => /reset/i.test(accessibleName(b)));
      click(handle, reset);
      await flushAsync(2);
      assert.equal(zoomOf(pane), 100, 'the reset button must return to 100%');
      assert.equal(pane.querySelector('svg').style.width || '', '', 'reset must clear the explicit width');
    } finally { teardown(); }
  });

  test('D: the zoom buttons clamp at the limits and never break', async () => {
    const { handle, container, pane, teardown } = await boot();
    try {
      const zoomIn = buttonsIn(container).find((b) => /^zoom in$/i.test(accessibleName(b)));
      for (let i = 0; i < 12; i += 1) click(handle, zoomIn);
      await flushAsync(2);
      assert.ok(zoomOf(pane) <= 800, 'the zoom must clamp at 800%, got ' + zoomOf(pane));
      const zoomOut = buttonsIn(container).find((b) => /^zoom out$/i.test(accessibleName(b)));
      for (let i = 0; i < 20; i += 1) click(handle, zoomOut);
      await flushAsync(2);
      assert.ok(zoomOf(pane) >= 10, 'the zoom must clamp at 10%, got ' + zoomOf(pane));
      // Still usable afterwards.
      click(handle, zoomIn);
      await flushAsync(2);
      assert.ok(zoomOf(pane) > 10, 'zooming back in must work after clamping');
    } finally { teardown(); }
  });

  test('D: the zoom buttons work when the pane HAS a layout', async () => {
    const { handle, container, pane, teardown } = await boot();
    try {
      const zoomIn = buttonsIn(container).find((b) => /^zoom in$/i.test(accessibleName(b)));
      click(handle, zoomIn);
      await flushAsync(2);
      assert.ok(zoomOf(pane) > 100, 'the click must zoom with a real layout too');
      const svg = pane.querySelector('svg');
      const width = parseFloat(svg.style.width) || 0;
      // The pane is 400px wide, so the fit scale is 400/1200 and the on-screen width after
      // one zoom step is 1200 * (1/3) * 1.25 = 500px - i.e. bigger than the pane.
      assert.ok(width > PANE_WIDTH, 'the svg must grow past the pane, got ' + width);
      assert.equal(svg.style.maxWidth, 'none', 'a zoomed svg must not be clamped by max-width');
    } finally { teardown(); }
  });
}
