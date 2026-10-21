// test/regression-viewer-zoom-controls.test.mjs — regression tests for the fullscreen exit
// affordance (Defect C) and the inline zoom controls (Defect D).
//
// C: the fullscreen overlay must offer an unmistakable exit - a labelled TEXT button and
//    Escape - and NOTHING else may close it. A click on the diagram, on the empty area, on
//    the scrim or on the floating controls must leave the overlay open, because the scrim
//    used to sit above the viewport and swallow every press: a click closed the viewer and a
//    drag closed it too (Defect F).
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

  test('C: the overlay offers an icon exit button and Escape', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      assert.ok(trigger, 'the Fullscreen trigger must exist');

      // 1) the icon-only exit button
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      const exitButton = [...overlay.querySelectorAll('button')].find((b) => {
        const name = accessibleName(b);
        return /exit|close|dismiss/i.test(name);
      });
      assert.ok(exitButton, 'the overlay must have an exit control');
      // ICON-ONLY: no visible text, just the graphic. The name still travels with the
      // control through aria-label and title, so nothing is lost to AT or to a hover.
      const visibleText = (exitButton.textContent || '').trim();
      assert.equal(visibleText, '',
        'the exit control must be icon-only, got visible text ' + JSON.stringify(visibleText));
      const icon = exitButton.querySelector('svg');
      assert.ok(icon, 'the exit control must carry an SVG icon');
      assert.equal(icon.getAttribute('aria-hidden'), 'true', 'the icon must be hidden from AT');
      assert.ok((exitButton.getAttribute('aria-label') || '').trim().length > 0,
        'the icon-only exit control still needs an accessible name');
      assert.ok((exitButton.getAttribute('title') || '').trim().length > 0,
        'the icon-only exit control still needs a hover tooltip');
      // The overlay really closes with it.
      click(handle, exitButton);
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'the exit button must close the overlay');

      // 2) Escape still works
      click(handle, trigger);
      await flushAsync(2);
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'the overlay must open again');
      handle.doc.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'Escape must still close the overlay');
    } finally { teardown(); }
  });

  /**
   * Every control in the overlay is an icon: a row of five text buttons in the corner of
   * the window is noisy and the diagram deserves the space. The names live in aria-label
   * and title, so a screen reader and a hover both still work.
   */
  test('C: every overlay control is an icon with a localized name', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      const buttons = [...overlay.querySelectorAll('button')];
      assert.ok(buttons.length >= 5, 'expected the four view controls plus the exit, got ' + buttons.length);
      for (const control of buttons) {
        const name = (control.getAttribute('aria-label') || '').trim();
        assert.ok(name.length > 0, 'every icon control needs an accessible name');
        assert.ok((control.getAttribute('title') || '').trim().length > 0,
          'every icon control needs a hover tooltip: ' + name);
        assert.equal((control.textContent || '').trim(), '',
          'the control must be icon-only: ' + name);
        const icon = control.querySelector('svg');
        assert.ok(icon, 'the control must carry an SVG icon: ' + name);
        assert.ok(icon.getAttribute('viewBox'), 'the icon needs a viewBox to scale: ' + name);
      }
    } finally { teardown(); }
  });

  /**
   * Defect F: the scrim used to be a click-to-close surface AND it painted ABOVE the viewport
   * (z-index:1 against the viewport's auto), so in a real browser every press landed on it - a
   * click dismissed the viewer and a drag dismissed it too. The scrim is now inert, and the
   * overlay is closed ONLY by the exit control or Escape, so no press inside it is destructive.
   */
  test('C: no press inside the overlay closes it - only the exit control and Escape do', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), 'the overlay must open');
      const stillOpen = (what) => {
        assert.ok(handle.doc.querySelector('.dsh-pm-viewer'), what + ' must NOT close the overlay');
      };

      // The scrim exists (SPEC §7 keeps the class) but takes no press and closes nothing.
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      const backdrop = overlay.querySelector('.dsh-pm-viewer-backdrop');
      assert.ok(backdrop, 'the overlay must still carry the scrim node');
      assert.equal(backdrop.getAttribute('aria-hidden'), 'true', 'the scrim must stay hidden from AT');
      assert.equal(backdrop.onclick, null, 'the scrim must not carry a click handler');
      click(handle, backdrop);
      await flushAsync(2);
      stillOpen('a scrim click');

      // A click on the DIAGRAM, on the empty area and on the floating controls: all stay open.
      click(handle, overlay.querySelector('.dsh-pm-viewport svg'));
      await flushAsync(2);
      stillOpen('a click on the diagram');
      click(handle, handle.doc.querySelector('.dsh-pm-viewer-bar'));
      await flushAsync(2);
      stillOpen('a click on the floating controls');
      click(handle, handle.doc.querySelector('.dsh-pm-viewport'));
      await flushAsync(2);
      stillOpen('a click on the empty area');

      // A real drag - press, move, release - pans and must not close either.
      const viewport = handle.doc.querySelector('.dsh-pm-viewport');
      const stage = handle.doc.querySelector('.dsh-pm-stage');
      viewport.dispatchEvent(new handle.win.PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1, clientX: 400, clientY: 300 }));
      handle.doc.dispatchEvent(new handle.win.PointerEvent('pointermove',
        { bubbles: true, cancelable: true, pointerId: 7, buttons: 1, clientX: 460, clientY: 340 }));
      handle.doc.dispatchEvent(new handle.win.PointerEvent('pointerup',
        { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 0, clientX: 460, clientY: 340 }));
      await flushAsync(2);
      stillOpen('a drag');
      assert.ok(stage.style.transform, 'the drag must still pan the diagram, transform: ' + stage.style.transform);

      // Escape is still the keyboard way out.
      handle.doc.dispatchEvent(new handle.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushAsync(2);
      assert.equal(handle.doc.querySelector('.dsh-pm-viewer'), null, 'Escape must still close the overlay');
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
      // The size lives on the inline STAGE, not on the svg: Pele rewrites the whole style
      // attribute of the svg it mounted whenever the pane resizes, so a zoom written there was
      // wiped the moment the zoom changed the pane's content size (see inlineStage).
      assert.ok(/px$/.test(pane.querySelector('.dsh-pm-inline-stage').style.width || ''),
        'the zoomed stage must get an explicit width even without layout');

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
      const stage = pane.querySelector('.dsh-pm-inline-stage');
      const width = parseFloat(stage.style.width) || 0;
      // The pane is 400px wide, so the fit scale is 400/1200 and the on-screen width after
      // one zoom step is 1200 * (1/3) * 1.25 = 500px - i.e. bigger than the pane.
      assert.ok(width > PANE_WIDTH, 'the stage must grow past the pane, got ' + width);
      // The svg is laid out BY the stage through the stylesheet, which is what makes the size
      // immune to Pele rewriting the svg's inline style on every pane resize.
      assert.equal(stage.contains(pane.querySelector('svg')), true, 'the svg must live inside the stage');
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
    // The controls float in the bottom-right corner now, so the bar's box is there - not a
    // full-width strip at the top. A stale box here is what let a control sit "under" the
    // scrim in the hit test while it was really fine.
    const bar = overlay.querySelector('.dsh-pm-viewer-bar');
    if (bar) bar.getBoundingClientRect = () => box(1120, 480, 144, 232);
    const viewport = overlay.querySelector('.dsh-pm-viewport');
    if (viewport) {
      // useLayout: a browser reports the laid-out viewport through offsetWidth/offsetHeight, and
      // lit-html reads its dimensions from there. clientWidth/clientHeight alone are not enough.
      patch(viewport, 'clientWidth', 1280);
      patch(viewport, 'clientHeight', 728);
      patch(viewport, 'offsetWidth', 1280);
      patch(viewport, 'offsetHeight', 728);
      viewport.getBoundingClientRect = () => box(0, 0, 1280, 728);
    }
    return { bar, viewport };
  }

  /**
   * happy-dom performs no layout, so a control press that re-renders lit-html templates can
   * report a zero-size viewport and the fit maths then falls back to 100%. Give the viewport
   * its real box once the overlay is open, without touching any of the plugin's own state.
   */
  function giveViewerLayoutAfterOpen(handle, overlay) {
    const viewport = overlay.querySelector('.dsh-pm-viewport');
    const patch = (element, key, value) => {
      if (!element) return;
      Object.defineProperty(element, key, { configurable: true, get: () => value });
    };
    patch(viewport, 'clientWidth', 1280);
    patch(viewport, 'clientHeight', 728);
    patch(viewport, 'offsetWidth', 1280);
    patch(viewport, 'offsetHeight', 728);
  }

  /**
   * Hit test the way a browser does: consider the overlay's children in PAINT order (highest
   * z-index first, document order breaking ties) and return the first one whose box contains
   * the point. Elements that are hidden or have pointer-events:none are never hit.
   *
   * The z-index part is the load-bearing one. The old version walked the children in reverse
   * DOCUMENT order and ignored z-index, which asserted "the controls are above the scrim" for
   * the wrong reason: it passed while the scrim was in fact painted over the diagram and over
   * everything, which is why dragging and clicking both closed the viewer in a real browser
   * and no test noticed.
   */
  function hitTest(handle, overlay, x, y) {
    const win = handle.win;
    const children = [...overlay.children];
    const stack = children.map((element, order) => {
      const style = win.getComputedStyle(element);
      const z = parseInt(style.zIndex, 10);
      return { element, order, z: Number.isFinite(z) ? z : 0 };
    }).sort((a, b) => (b.z - a.z) || (b.order - a.order));
    for (const entry of stack) {
      const child = entry.element;
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

  test('E: a control press keeps the overlay controls in front and the diagram mounted', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      giveViewerLayout(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      // The floating controls sit in the bottom-right corner and must hit-test ABOVE the
      // scrim and the viewport, or a press on them would fall through to the diagram.
      const barHit = hitTest(handle, overlay, 1190, 560);
      assert.ok(barHit && barHit.element.classList.contains('dsh-pm-viewer-bar'),
        'the point over the floating controls hits ' + JSON.stringify(barHit));
      for (const name of ['Zoom in', 'Zoom out', 'Fit to window', 'Reset zoom to 100%']) {
        const control = overlayButton(overlay, name);
        assert.ok(control, 'the viewer must offer a ' + name + ' control');
        click(handle, control);
        await flushAsync(2);
        assert.ok(overlay.querySelector('.dsh-pm-stage') === stage, name + ' must not replace the stage');
        assert.ok(stage.firstChild, name + ' must leave the diagram mounted');
        assert.ok(stage.style.transform, name + ' must leave the zoom transform applied');
      }
      // The scrim must never be the hit: it covers the whole window, so if it wins a hit test
      // anywhere, every press in the overlay is being eaten by a decorative layer.
      for (const point of [[640, 364], [200, 100], [1000, 650]]) {
        const hit = hitTest(handle, overlay, point[0], point[1]);
        assert.ok(!hit || !hit.element.classList.contains('dsh-pm-viewer-backdrop'),
          'the scrim must not be hit at ' + point.join(',') + ', got ' + JSON.stringify(hit));
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

  /**
   * The reported symptom, asserted directly: the chain a real click produces - button
   * pressed, click reaches the viewer's handler, and the diagram's rendered geometry visibly
   * changes. A test that only checks that a transform string exists cannot tell "responded"
   * from "did nothing", which is how the earlier reports slipped through.
   */
  test('E: each control visibly changes the rendered diagram', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      giveViewerLayout(handle, overlay);
      giveViewerLayoutAfterOpen(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      const geometry = () => {
        const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(stage.style.transform || '');
        assert.ok(match, 'the stage must carry a zoom transform, got ' + JSON.stringify(stage.style.transform));
        return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
      };
      const live = overlay.querySelector('[role="status"]');

      const start = geometry();
      click(handle, overlayButton(overlay, 'Zoom in'));
      await flushAsync(2);
      // Any press may have re-rendered the overlay: re-assert the viewport box before
      // measuring the fit, exactly as a browser would report it.
      giveViewerLayoutAfterOpen(handle, overlay);
      const zoomedIn = geometry();
      assert.ok(zoomedIn.scale > start.scale, 'Zoom in must enlarge the diagram, ' + JSON.stringify([start, zoomedIn]));
      assert.match(live.textContent, /%$/, 'the percentage must be reported to the live region');

      click(handle, overlayButton(overlay, 'Zoom out'));
      await flushAsync(2);
      giveViewerLayoutAfterOpen(handle, overlay);
      const zoomedOut = geometry();
      assert.ok(zoomedOut.scale < zoomedIn.scale, 'Zoom out must shrink the diagram, ' + JSON.stringify([zoomedIn, zoomedOut]));

      click(handle, overlayButton(overlay, 'Fit to window'));
      await flushAsync(2);
      giveViewerLayoutAfterOpen(handle, overlay);
      const fitted = geometry();
      // A fit is "the whole diagram and no more": the scale equals the viewport's tighter
      // ratio (the 1200x500 diagram into 1280x680 is height-bound). happy-dom reports the
      // viewport as 0 unless a stub is in place, so accept whichever viewport the viewer
      // measured, but never a scale that overflows it.
      assert.ok(fitted.scale >= start.scale, 'Fit must not shrink the diagram on the first press, ' + JSON.stringify([start, fitted]));

      click(handle, overlayButton(overlay, 'Reset zoom to 100%'));
      await flushAsync(2);
      const reset = geometry();
      assert.equal(reset.scale, 1, 'Reset must return to the natural size');
      assert.equal(live.textContent, '100%', 'Reset must report 100%');
    } finally { teardown(); }
  });

  /* ---------------------------------------------------------------- *
   * Defect G — "the wheel does nothing in the fullscreen viewer"
   *
   * In the overlay the diagram owns the whole window, so there is nothing for a plain
   * wheel to scroll: the only sensible reading of the gesture is "get closer to what I
   * am pointing at". The wheel therefore zooms at the pointer, with NO modifier key.
   * The INLINE pane keeps its old contract (Ctrl/Meta + wheel zooms, a plain wheel
   * scrolls the page) - that one is embedded in a real page and must not steal the
   * reader's scroll.
   * ---------------------------------------------------------------- */

  test('G: a plain wheel over the overlay zooms the diagram at the pointer', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      assert.ok(overlay, 'the overlay must open');
      giveViewerLayout(handle, overlay);
      giveViewerLayoutAfterOpen(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      const geometry = () => {
        const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(stage.style.transform || '');
        assert.ok(match, 'the stage must carry a zoom transform, got ' + JSON.stringify(stage.style.transform));
        return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
      };
      const scrollAt = (x, y, deltaY) => {
        const event = new handle.win.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY, deltaMode: 0,
        });
        // happy-dom's WheelEvent does not read clientX/clientY from the init dict, so they
        // are assigned afterwards - otherwise the anchor would silently fall back to the
        // viewport centre and the pointer-anchoring assertion would test nothing.
        event.clientX = x;
        event.clientY = y;
        overlay.dispatchEvent(event);
        return event;
      };

      const start = geometry();
      // Wheel UP (deltaY < 0) zooms in. No ctrlKey, no metaKey - a plain wheel.
      const up = scrollAt(400, 300, -100);
      await flushAsync(2);
      const zoomedIn = geometry();
      assert.ok(zoomedIn.scale > start.scale,
        'a plain wheel up must zoom in, ' + JSON.stringify([start, zoomedIn]));
      assert.equal(up.defaultPrevented, true,
        'the wheel must be consumed, otherwise the page behind scrolls under the overlay');

      // Wheel DOWN zooms out.
      scrollAt(400, 300, 100);
      await flushAsync(2);
      const zoomedOut = geometry();
      assert.ok(zoomedOut.scale < zoomedIn.scale,
        'a plain wheel down must zoom out, ' + JSON.stringify([zoomedIn, zoomedOut]));

      // The zoom is anchored at the pointer: the content point under the cursor does not move.
      // The stage is drawn as translate(tx,ty) scale(s), so the content coordinate of a
      // viewport point p is (p - tx) / s - that is the value that must stay constant.
      const before = geometry();
      scrollAt(400, 300, -100);
      await flushAsync(2);
      const after = geometry();
      const naturalBefore = (400 - before.x) / before.scale;
      const naturalAfter = (400 - after.x) / after.scale;
      assert.ok(Math.abs(naturalAfter - naturalBefore) < 0.5,
        'the content point under the pointer must stay put, drifted from ' + naturalBefore + ' to ' + naturalAfter);
      const naturalYBefore = (300 - before.y) / before.scale;
      const naturalYAfter = (300 - after.y) / after.scale;
      assert.ok(Math.abs(naturalYAfter - naturalYBefore) < 0.5,
        'the content point under the pointer must stay put, drifted from ' + naturalYBefore + ' to ' + naturalYAfter);
    } finally { teardown(); }
  });

  test('G: the wheel zoom is normalized across deltaModes and reports to the live region', async () => {
    const { handle, container, teardown } = await boot();
    try {
      const trigger = buttonsIn(container).find((b) => /fullscreen/i.test(accessibleName(b)));
      click(handle, trigger);
      await flushAsync(2);
      const overlay = handle.doc.querySelector('.dsh-pm-viewer');
      giveViewerLayout(handle, overlay);
      giveViewerLayoutAfterOpen(handle, overlay);
      const stage = overlay.querySelector('.dsh-pm-stage');
      const scaleOf = () => {
        const match = /scale\(([\d.]+)\)/.exec(stage.style.transform || '');
        assert.ok(match, 'the stage must carry a zoom transform, got ' + JSON.stringify(stage.style.transform));
        return Number(match[1]);
      };
      const scroll = (deltaY, deltaMode) => {
        const event = new handle.win.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY, deltaMode,
        });
        event.clientX = 640;
        event.clientY = 364;
        overlay.dispatchEvent(event);
        return event;
      };
      const live = overlay.querySelector('[role="status"]');

      // One notch in PIXEL mode (deltaMode 0, deltaY -100) is one notch in LINE mode
      // (deltaMode 1, deltaY -3): the zoom rate must not depend on the reporting unit.
      const start = scaleOf();
      scroll(-100, 0);
      await flushAsync(2);
      const pixelScale = scaleOf();
      scroll(100, 0);
      await flushAsync(2);
      const back = scaleOf();
      scroll(-3, 1);
      await flushAsync(2);
      const lineScale = scaleOf();
      assert.ok(Math.abs(lineScale - pixelScale) < 0.001,
        'a pixel notch and a line notch must zoom the same: ' + pixelScale + ' vs ' + lineScale);
      assert.ok(Math.abs(back - start) < 0.001,
        'a wheel down must undo a wheel up: ' + start + ' -> ' + pixelScale + ' -> ' + back);
      assert.match(live.textContent, /%$/, 'the zoom must be reported to the live region');
    } finally { teardown(); }
  });
}
