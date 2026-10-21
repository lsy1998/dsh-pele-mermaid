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
  /* ---------------------------------------------------------------- *
   * Defect E — "the three buttons do nothing" in the FULLSCREEN viewer
   *
   * The report: in the fullscreen viewer the zoom/fit controls look dead and the diagram
   * cannot be dragged, while the inline pane is fine. Both are the same failure - nothing
   * reaches the overlay's own handlers - so the tests below drive a REAL pointer sequence
   * (pointerdown, pointermove, pointerup, click) with hit testing that respects z-order,
   * which happy-dom's dispatchEvent cannot see.
   * ---------------------------------------------------------------- */

  const overlayButton = (overlay, name) =>
    [...overlay.querySelectorAll('button')].find((b) => accessibleName(b) === name);

  const overlayRect = (overlay) => {
    const rect = overlay.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };

  /**
   * A viewport-sized box for any element, so the overlay's own geometry can be measured.
   * happy-dom has no layout engine and every rect is a zero box.
   */
  function giveViewerLayout(handle, overlay) {
    const win = handle.win;
    const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    const patch = (element, key, value) => {
      if (!element) return;
      Object.defineProperty(element, key, { configurable: true, get: () => value });
    };
    win.document.body.getBoundingClientRect = () => box(0, 0, 1280, 728);
    overlay.getBoundingClientRect = () => box(0, 0, 1280, 728);
    const bar = overlay.querySelector('.dsh-pm-viewer-bar');
    if (bar) bar.getBoundingClientRect = () => box(0, 0, 1280, 48);
    const viewport = overlay.querySelector('.dsh-pm-viewport');
    if (viewport) {
      patch(viewport, 'clientWidth', 1280);
      patch(viewport, 'clientHeight', 680);
      viewport.getBoundingClientRect = () => box(0, 48, 1280, 680);
    }
    return { bar, viewport };
  }

  /**
   * Hit test the way a browser does: walk the overlay's children from the LAST (painted on
   * top) to the first and return the first one whose box contains the point. Elements that
   * are hidden or have pointer-events:none are never hit. This is what shows whether a
   * control is really in front of the backdrop/bar it sits under.
   */
  function hitTest(handle, overlay, x, y) {
    const win = handle.win;
    const children = [...overlay.children];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const style = win.getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.pointerEvents === 'none') continue;
      const rect = child.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { element: child, className: child.className, zIndex: style.zIndex, position: style.position };
      }
    }
    return null;
  }

  /** Dispatch a click at the window point the way a browser does: to the hit-tested element. */
  function pointerClick(handle, overlay, x, y) {
    const hit = hitTest(handle, overlay, x, y);
    if (!hit) return null;
    hit.element.dispatchEvent(new handle.win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return hit;
  }

  test('E: a control press keeps the overlay bar in front and the diagram mounted', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      giveViewerLayout(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      for (const name of ['Zoom in', 'Zoom out', 'Fit to window', 'Reset zoom to 100%']) {
        const control = overlayButton(overlay, name);
        assert.ok(control, 'the viewer must offer a ' + name + ' control');
        // The bar is the first child and the backdrop is appended last, but the bar is
        // position: relative, so it still paints (and hit-tests) above the backdrop.
        const barHit = hitTest(handle, overlay, 640, 24);
        assert.ok(barHit && barHit.element.classList.contains('dsh-pm-viewer-bar'),
          name + ' blocker: the point over the bar hits ' + JSON.stringify(barHit));
        click(handle, control);
        await flushAsync(2);
        assert.ok(overlay.querySelector('.dsh-pm-stage') === stage, name + ' must not replace the stage');
        assert.ok(stage.firstChild, name + ' must leave the diagram mounted');
        assert.ok(stage.style.transform, name + ' must leave the zoom transform applied');
      }
    } finally { teardown(); }
  });

  test('E: the viewer never scrolls the document behind it', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const scrolled = [];
      const targets = [handle.win, handle.doc.documentElement, handle.doc.body, handle.doc.scrollingElement];
      for (const element of targets) {
        if (!element) continue;
        for (const key of ['scrollTop', 'scrollLeft', 'scrollX', 'scrollY', 'pageYOffset']) {
          let descriptor;
          try { descriptor = Object.getOwnPropertyDescriptor(element, key); } catch { descriptor = undefined; }
          const get = descriptor && descriptor.get ? descriptor.get : () => 0;
          const set = descriptor && descriptor.set ? descriptor.set : () => {};
          Object.defineProperty(element, key, {
            configurable: true,
            get() { return get.call(this); },
            set(value) { scrolled.push(key); set.call(this, value); },
          });
        }
      }
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      giveViewerLayout(handle, overlay);
      for (const name of ['Zoom in', 'Zoom out', 'Fit to window', 'Reset zoom to 100%']) {
        click(handle, overlayButton(overlay, name));
        await flushAsync(2);
      }
      assert.deepEqual(scrolled, [], 'the viewer must not scroll the document, scrolled: ' + JSON.stringify(scrolled));
    } finally { teardown(); }
  });

  /**
   * The drag path, end to end, with a real pointer sequence: a press inside the viewport, a
   * move, and a release. The stage must follow the pointer by the same distance, and the
   * overlay must stay open (a drag is not a click on the backdrop).
   */
  test('E: dragging inside the viewport pans the diagram', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      const { viewport } = giveViewerLayout(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      const translate = () => {
        const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(stage.style.transform || '');
        return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
      };
      const before = translate();
      const hit = hitTest(handle, overlay, 640, 400);
      assert.ok(hit && hit.element.classList.contains('dsh-pm-viewport'),
        'the point inside the viewport must hit the viewport, got ' + JSON.stringify(hit));
      viewport.dispatchEvent(new handle.win.PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: 640, clientY: 400 }));
      handle.doc.dispatchEvent(new handle.win.PointerEvent('pointermove',
        { bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: 700, clientY: 430 }));
      handle.doc.dispatchEvent(new handle.win.PointerEvent('pointerup',
        { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 0, clientX: 700, clientY: 430 }));
      await flushAsync(2);
      const after = translate();
      assert.equal(after.x - before.x, 60, 'the drag must pan the diagram horizontally');
      assert.equal(after.y - before.y, 30, 'the drag must pan the diagram vertically');
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'a drag must not close the overlay');
    } finally { teardown(); }
  });
}
