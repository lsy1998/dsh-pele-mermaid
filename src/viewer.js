/**
 * dsh-pele-mermaid - fullscreen zoom/pan viewer (SPEC 4 createViewer, SPEC 5 R9, SPEC 7 classes).
 *
 * The overlay is built lazily, traps focus while open, restores focus to the
 * trigger on close and destroys every listener and node on `destroy()`.
 *
 * The zoom/pan maths lives in src/zoom.js and is shared with the inline pane
 * (src/client.js) - this module only owns the overlay DOM and its behaviour.
 */

import { BUILD_STAMP } from './build-stamp.js';
import { createIcon } from './icons.js';
import {
  ZOOM_STEP,
  applyTransform,
  createZoomState,
  measureSvg,
  round,
} from './zoom.js';

var FALLBACK_MESSAGES = {
  viewerLabel: 'Fullscreen Pele diagram viewer',
  viewerTitle: '{type} · Pele',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetZoom: 'Reset zoom to 100%',
  fitWindow: 'Fit to window',
  closeViewer: 'Close fullscreen viewer',
  statusLabel: 'Diagram status',
};

var INTERPOLATE_RE = /\{(\w+)\}/g;
var FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Wheel sensitivity.
 *
 * The wheel is normalized to "notches" (see wheelNotches) and one notch is worth
 * ZOOM_NOTCH in log space, i.e. about 10% of zoom per notch - enough to feel responsive
 * without overshooting on a fast scroll.
 */
var ZOOM_NOTCH = 0.095;

export function createViewer(deps) {
  var options = deps || {};
  var doc = options.doc || (typeof document !== 'undefined' ? document : undefined);
  var win = options.win || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : undefined);
  var translate = typeof options.t === 'function' ? options.t : null;
  // Optional language accessor so the overlay can follow a live language switch.
  var langOf = typeof options.getLang === 'function' ? options.getLang : null;
  var langStamp = langOf ? langOf() : undefined;

  function t(key, params) {
    if (translate) return String(translate(key, params));
    var template = Object.prototype.hasOwnProperty.call(FALLBACK_MESSAGES, key) ? FALLBACK_MESSAGES[key] : key;
    if (!params) return template;
    return template.replace(INTERPOLATE_RE, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) && params[name] != null ? String(params[name]) : match;
    });
  }

  var root = null;
  var titleEl = null;
  var viewport = null;
  var stage = null;
  var svgEl = null;
  var liveEl = null;
  var built = false;
  var isOpenState = false;
  var destroyed = false;
  // Shared zoom/pan state (src/zoom.js) - the single source of the maths.
  var zoom = createZoomState();
  var trigger = null;
  var bar = null;
  var buildEl = null;
  var backdrop = null;
  var drag = null;
  var currentType = 'diagram';
  var closeHandler = null;
  var listeners = [];
  // Diagnostics: a live event log, toggled with Ctrl+Shift+D, that answers "did the click
  // even reach the viewer?" without opening developer tools.
  var diag = null;
  var diagOn = false;
  var diagLines = [];

  function listen(target, type, handler, listenerOptions) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, listenerOptions);
    listeners.push([target, type, handler, listenerOptions]);
  }

  function removeListeners() {
    for (var index = 0; index < listeners.length; index += 1) {
      var entry = listeners[index];
      try {
        entry[0].removeEventListener(entry[1], entry[2], entry[3]);
      } catch (error) { /* the target may be gone */ }
    }
    listeners = [];
  }

  function el(tag, className) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  /**
   * An icon-only control: an inline SVG plus the localized name in aria-label/title.
   *
   * The controls are icon-only by design - a row of five text buttons down the corner of the
   * window is noisy, and the diagram deserves the space. The name still travels with the
   * control: aria-label is the accessible name (R13) and title is the hover tooltip, so
   * nothing is lost to a screen-reader user or to someone who just hovers.
   */
  function button(key, iconName, handler) {
    var node = el('button', 'dsh-pm-btn');
    node.type = 'button';
    node.setAttribute('data-i18n-key', key);
    node.setAttribute('aria-label', t(key));
    node.setAttribute('title', t(key));
    node.appendChild(createIcon(doc, win, iconName));
    node.onclick = handler;
    return node;
  }

  /** Re-apply every localized string; called on open() and on a language change. */
  function refreshLabels() {
    if (langOf) langStamp = langOf();
    if (!root) return;
    root.setAttribute('aria-label', t('viewerLabel'));
    if (titleEl) titleEl.textContent = t('viewerTitle', { type: currentType });
    if (viewport) viewport.setAttribute('aria-label', t('viewerTitle', { type: currentType }));
    if (liveEl) liveEl.setAttribute('aria-label', t('statusLabel'));
    if (bar) {
      var nodes = bar.querySelectorAll ? bar.querySelectorAll('[data-i18n-key]') : [];
      for (var i = 0; i < nodes.length; i += 1) {
        var key = nodes[i].getAttribute('data-i18n-key');
        if (!key) continue;
        var text = t(key);
        // The controls are icon-only: the localized string lives in aria-label (the
        // accessible name, R13) and in title (the hover tooltip). A language switch
        // therefore has to refresh both, not just the visible text.
        nodes[i].setAttribute('aria-label', text);
        nodes[i].setAttribute('title', text);
      }
    }
  }

  /** Refresh only when the language actually changed since the last apply. */
  function syncLabels() {
    if (langOf && langOf() === langStamp) return;
    refreshLabels();
  }

  function attachOverlay() {
    if (!root || !doc || !doc.body) return;
    if (root.parentNode) return;
    doc.body.appendChild(root);
  }

  function detachOverlay() {
    if (root && root.parentNode && typeof root.parentNode.removeChild === 'function') {
      root.parentNode.removeChild(root);
    }
  }

  function build() {
    if (built || destroyed || !doc || !doc.body) return;
    root = el('div', 'dsh-pm-viewer');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', t('viewerLabel'));
    root.setAttribute('hidden', '');

    // The scrim is inert. It used to carry the click-to-close behaviour, and because it is
    // position:fixed over the whole window it also sat ABOVE the viewport in paint order
    // (z-index:1 vs the viewport's auto), so every press landed on it: a click closed the
    // overlay and a drag closed it too. Nothing in the overlay closes on a click any more -
    // Escape and the exit control are the only ways out - and pointer-events:none makes it
    // impossible for a decorative layer to swallow a press again.
    backdrop = el('div', 'dsh-pm-viewer-backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    root.appendChild(backdrop);

    // The viewport fills the WHOLE overlay: the controls float above it in a corner, so the
    // diagram gets the entire window and every press that is not on a control is a pan.
    viewport = el('div', 'dsh-pm-viewport');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('aria-label', t('viewerLabel'));
    stage = el('div', 'dsh-pm-stage');
    viewport.appendChild(stage);
    root.appendChild(viewport);

    // A quiet caption in the top-left corner: it labels the diagram without stealing a press.
    titleEl = el('div', 'dsh-pm-viewer-title');
    root.appendChild(titleEl);

    // The controls float in the bottom-right corner, clear of the diagram and of the pointer,
    // grouped by function: the view controls first, the exit below a separator. All of them
    // are icon-only - the name is in the aria-label and in the hover tooltip.
    bar = el('div', 'dsh-pm-viewer-bar');
    var actions = el('div', 'dsh-pm-actions');
    actions.appendChild(button('zoomIn', 'zoomIn', function () { zoomBy(ZOOM_STEP); }));
    actions.appendChild(button('zoomOut', 'zoomOut', function () { zoomBy(1 / ZOOM_STEP); }));
    actions.appendChild(button('fitWindow', 'fitWindow', function () { fitToWindow(); }));
    actions.appendChild(button('resetZoom', 'resetZoom', function () { resetToNatural(); }));
    bar.appendChild(actions);
    bar.appendChild(el('div', 'dsh-pm-viewer-sep'));
    // The exit control carries its own class so the stylesheet can single it out as the one
    // destructive action in the group, whatever else the bar holds.
    var exit = button('closeViewer', 'close', function () { closeViewer(); });
    exit.className += ' dsh-pm-viewer-exit';
    bar.appendChild(exit);
    root.appendChild(bar);

    // The build stamp: which version of the plugin this page actually loaded. A stale
    // bundle then answers "did my update take effect?" without opening a terminal.
    buildEl = el('span', 'dsh-pm-viewer-build');
    buildEl.setAttribute('data-build-stamp', BUILD_STAMP);
    buildEl.setAttribute('title', 'dsh-pele-mermaid build: ' + BUILD_STAMP);
    buildEl.textContent = BUILD_STAMP;
    root.appendChild(buildEl);

    liveEl = el('span', 'dsh-pm-sr-only');
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    liveEl.setAttribute('aria-label', t('statusLabel'));
    root.appendChild(liveEl);

    attachOverlay();
    built = true;
  }

  function announce(message) {
    if (!liveEl || message == null) return;
    if (liveEl.textContent === String(message)) return;
    liveEl.textContent = String(message);
  }

  function mountSvg(markup) {
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    svgEl = null;
    if (typeof markup !== 'string' || !markup) return;
    var node = null;
    var Parser = (win && win.DOMParser) || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (Parser) {
      try {
        var parsed = new Parser().parseFromString(markup, 'image/svg+xml');
        var rootNode = parsed && parsed.documentElement;
        var errors = parsed && typeof parsed.getElementsByTagName === 'function'
          ? parsed.getElementsByTagName('parsererror')
          : null;
        var failed = errors && errors.length > 0;
        if (rootNode && String(rootNode.nodeName).toLowerCase() === 'svg' && !failed) {
          node = typeof doc.importNode === 'function' ? doc.importNode(rootNode, true) : rootNode;
        }
      } catch (error) {
        node = null;
      }
    }
    if (node) stage.appendChild(node);
    else stage.innerHTML = markup;
    svgEl = typeof stage.querySelector === 'function' ? stage.querySelector('svg') : (stage.firstElementChild || null);
  }

  function measure() {
    var size = measureSvg(svgEl);
    zoom.setNatural(size.width > 0 ? size.width : 640, size.height > 0 ? size.height : 400);
  }

  function viewportSize() {
    var width = viewport && viewport.clientWidth ? viewport.clientWidth : 0;
    var height = viewport && viewport.clientHeight ? viewport.clientHeight : 0;
    if (!width && win && win.innerWidth > 0) width = win.innerWidth;
    if (!height && win && win.innerHeight > 0) height = win.innerHeight;
    return { width: width > 0 ? width : 800, height: height > 0 ? height : 600 };
  }

  /**
   * Put the zoom state on the stage and report it.
   *
   * The stage is anchored at its TOP-LEFT corner (styles.js) and the translate is the content's
   * top-left position in the viewport, which is exactly what zoom.js computes (fit/zoom/reset
   * all centre through the same (viewport - natural * scale) / 2). Keeping the CSS anchor and
   * the maths in the same coordinate space is what makes every control visibly work: with a
   * centre anchor the translate was applied from the centre and the diagram was painted off to
   * the right and below the window, so the controls looked dead.
   */
  function apply() {
    if (!stage) return;
    var size = viewportSize();
    applyTransform(stage, { scale: zoom.scale, tx: zoom.tx, ty: zoom.ty }, { mode: 'transform' });
    announce(Math.round(zoom.scale * 100) + '%');
  }

  function center() {
    var size = viewportSize();
    zoom.center(size.width, size.height);
    apply();
  }

  function fitToWindow() {
    var size = viewportSize();
    zoom.fitToWindow(size.width, size.height);
    apply();
  }

  function resetToNatural() {
    var size = viewportSize();
    zoom.resetToNatural(size.width, size.height);
    apply();
  }

  function zoomBy(factor, clientX, clientY) {
    if (!isOpenState) return;
    var size = viewportSize();
    var pointX = typeof clientX === 'number' ? clientX : size.width / 2;
    var pointY = typeof clientY === 'number' ? clientY : size.height / 2;
    if (!zoom.zoomAtPoint(factor, pointX, pointY)) return;
    apply();
  }

  function panBy(dx, dy) {
    zoom.panBy(dx, dy);
    apply();
  }

  /**
   * True when the press began on one of the overlay's own controls.
   *
   * The floating toolbar sits above the viewport, so without this a press that starts on a
   * button would also start a pan and the diagram would slide out from under the click.
   */
  function fromControl(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest(CHROME_SELECTOR);
  }

  function onPointerDown(event) {
    if (!isOpenState) return;
    if (event && event.button != null && event.button !== 0) return;
    // A press that begins on a control is that control's, not the start of a drag.
    if (fromControl(event)) return;
    drag = { x: event.clientX, y: event.clientY, tx: zoom.tx, ty: zoom.ty };
    if (event && event.pointerId != null && viewport && typeof viewport.setPointerCapture === 'function') {
      try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
    }
    if (!drag) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || !event) return;
    // A pan is never a click: the diagram follows the pointer and the overlay stays open.
    zoom.tx = drag.tx + (event.clientX - drag.x);
    zoom.ty = drag.ty + (event.clientY - drag.y);
    apply();
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerUp() {
    drag = null;
  }

  /**
   * The wheel zooms the diagram, anchored at the pointer.
   *
   * In the fullscreen overlay the diagram owns the whole window, so there is nothing for a
   * plain wheel to scroll: the only sensible reading of a scroll gesture here is "get closer
   * to what I am pointing at". The event is always consumed, otherwise the page behind the
   * overlay would scroll under the user's feet.
   *
   * The deltas are normalized to "notches" first: browsers report a wheel notch as ~100px,
   * as 3 lines or as a whole page, and the zoom rate has to feel the same on all of them.
   * One notch is worth ZOOM_NOTCH (about 10%), and a trackpad's small continuous deltas
   * turn into a smooth ramp.
   */
  function onWheel(event) {
    if (!isOpenState || !event) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    var pointX = 0;
    var pointY = 0;
    if (viewport && typeof viewport.getBoundingClientRect === 'function') {
      var rect = viewport.getBoundingClientRect();
      pointX = (typeof event.clientX === 'number' ? event.clientX : rect.left + rect.width / 2) - rect.left;
      pointY = (typeof event.clientY === 'number' ? event.clientY : rect.top + rect.height / 2) - rect.top;
    }
    var notches = wheelNotches(event);
    if (!notches) return;
    var factor = Math.exp(-notches * ZOOM_NOTCH);
    if (!isFinite(factor) || factor <= 0 || factor === 1) factor = ZOOM_STEP;
    zoomBy(factor, pointX, pointY);
  }

  /**
   * The wheel delta as a number of notches.
   *
   * deltaMode 0 is pixels (~100 per notch), 1 is lines (3 per notch) and 2 is pages.
   * Anything else is treated as pixels.
   */
  function wheelNotches(event) {
    var delta = typeof event.deltaY === 'number' ? event.deltaY : 0;
    if (!delta) return 0;
    var mode = typeof event.deltaMode === 'number' ? event.deltaMode : 0;
    if (mode === 1) return delta / 3;
    if (mode === 2) return delta;
    return delta / 100;
  }

  function onResize() {
    if (isOpenState) fitToWindow();
  }

  /** Render the diagnostics panel: the build, the last events and the current geometry. */
  function diagRender() {
    if (!diag) return;
    var size = viewportSize();
    var body = diagLines.slice(-14);
    diag.textContent = 'dsh-pele-mermaid ' + BUILD_STAMP + '\n' +
      'viewport ' + Math.round(size.width) + 'x' + Math.round(size.height) + ' | stage ' +
      (stage ? stage.style.transform : '-') + '\n' + body.join('\n');
  }

  /** Record one event in the diagnostics log. */
  function diagLog(event, label) {
    if (!diagOn || !diag) return;
    var target = event && event.target;
    var name = target && target.className ? (target.className + '').split(' ')[0] : (target && target.nodeName);
    diagLines.push((label || 'event') + ' @' + (event && event.clientX) + ',' + (event && event.clientY) +
      ' -> ' + name + (event && event.defaultPrevented ? ' (prevented)' : ''));
    diagRender();
  }

  function toggleDiag() {
    diagOn = !diagOn;
    if (diagOn && !diag) {
      diag = el('pre', 'dsh-pm-viewer-diag');
      root.appendChild(diag);
      diagRender();
    } else if (diag) {
      diag.textContent = '';
      diag.style.display = diagOn ? 'block' : 'none';
    }
  }

  /** Ctrl+Shift+D anywhere in the page toggles the diagnostics panel while the viewer is open. */
  function onDiagKey(event) {
    if (!event || !event.ctrlKey || !event.shiftKey || String(event.key).toLowerCase() !== 'd') return;
    event.preventDefault();
    if (!isOpenState) return;
    toggleDiag();
  }

  function focusableNodes() {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var nodes = root.querySelectorAll(FOCUSABLE_SELECTOR);
    var out = [];
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (node.disabled) continue;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') continue;
      out.push(node);
    }
    return out;
  }

  function trapFocus(event) {
    var nodes = focusableNodes();
    if (!nodes.length) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (viewport && typeof viewport.focus === 'function') viewport.focus();
      return;
    }
    var active = doc ? doc.activeElement : null;
    var index = -1;
    for (var cursor = 0; cursor < nodes.length; cursor += 1) {
      if (nodes[cursor] === active) { index = cursor; break; }
    }
    var nextIndex;
    if (event.shiftKey) nextIndex = index <= 0 ? nodes.length - 1 : index - 1;
    else nextIndex = index === -1 || index === nodes.length - 1 ? 0 : index + 1;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    var next = nodes[nextIndex];
    if (next && typeof next.focus === 'function') next.focus();
  }

  function onKeydown(event) {
    if (!isOpenState || !event) return;
    var key = event.key;
    if (key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      closeViewer();
      return;
    }
    if (key === 'Tab') { trapFocus(event); return; }
    if (key === '+' || key === '=') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      zoomBy(ZOOM_STEP);
      return;
    }
    if (key === '-' || key === '_') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
      return;
    }
    if (key === '0') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      resetToNatural();
      return;
    }
    var step = event.shiftKey ? 60 : 20;
    if (key === 'ArrowLeft') panBy(-step, 0);
    else if (key === 'ArrowRight') panBy(step, 0);
    else if (key === 'ArrowUp') panBy(0, -step);
    else if (key === 'ArrowDown') panBy(0, step);
  }

/** The interactive parts of the viewer chrome (a press on one belongs to the control). */
  var CHROME_SELECTOR = 'button, a, input, select, textarea, [contenteditable], [role="button"]';

  /**
   * A click inside the overlay is swallowed, never interpreted.
   *
   * The viewport fills the whole overlay, so a click on the diagram, on the empty area or on
   * the floating controls all arrive here. Closing the overlay on any of them made both
   * ordinary interactions destructive - a drag ended with a click, and a click anywhere near
   * the diagram dismissed it - and the "which press was that?" bookkeeping it needed
   * (pressMarked / dragMoved) was guesswork that could not tell a click from the tail of a
   * pan. The overlay is now closed deliberately: the exit control or Escape, nothing else.
   */
  function onOverlayClick(event) {
    swallow(event);
  }

  /** A click inside the chrome must not fall through to anything behind the overlay. */
  function swallow(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  function bindInteractions() {
    removeListeners();
    var usePointer = !!(win && typeof win.PointerEvent === 'function');
    listen(viewport, usePointer ? 'pointerdown' : 'mousedown', onPointerDown);
    listen(doc, usePointer ? 'pointermove' : 'mousemove', onPointerMove);
    listen(doc, usePointer ? 'pointerup' : 'mouseup', onPointerUp);
    // The wheel zooms. It is bound to the OVERLAY, not to the viewport, so a scroll over the
    // floating controls zooms too instead of doing nothing.
    listen(root, 'wheel', onWheel, { passive: false });
    listen(doc, 'keydown', onKeydown);
    listen(win, 'resize', onResize);
    // Every click inside the overlay is swallowed: the diagram, the empty area and the
    // floating controls all reach this one handler, and none of them may fall through to the
    // page behind or be read as "close".
    listen(root, 'click', onOverlayClick);
    // The diagnostic taps come AFTER the real handlers (so an early close is still recorded)
    // and observe without ever preventing or stopping anything.
    listen(root, 'pointerdown', function (event) { diagLog(event, 'down'); }, { passive: true });
    listen(root, 'click', function (event) { diagLog(event, 'click'); }, { passive: true });
    listen(root, 'pointerup', function (event) { diagLog(event, 'up'); }, { passive: true });
    listen(doc, 'keydown', onDiagKey);
  }

  function openViewer(settings) {
    var config = settings || {};
    if (destroyed || !doc || !doc.body) return;
    build();
    if (!built) return;
    currentType = config.type || 'diagram';
    trigger = config.trigger || null;
    // The caller may continue from its own zoom (the inline pane), so the
    // transition into the overlay is seamless instead of a jump to "fit".
    var requested = config.zoom && typeof config.zoom === 'object' ? config.zoom : null;
    closeHandler = typeof config.onClose === 'function' ? config.onClose : null;
    refreshLabels();
    mountSvg(config.svg);
    attachOverlay();
    root.removeAttribute('hidden');
    isOpenState = true;
    measure();
    if (requested && Number.isFinite(requested.scale) && requested.scale !== 1) {
      // Continue from the caller's zoom, but re-center: the translate offsets
      // live in a different coordinate space than the overlay's viewport.
      zoom.setScale(requested.scale);
      center();
    } else {
      fitToWindow();
    }
    bindInteractions();
    if (typeof viewport.focus === 'function') {
      try { viewport.focus(); } catch (error) { /* focus is best-effort */ }
    }
    announce(titleEl.textContent);
  }

  function closeViewer() {
    if (!isOpenState) return;
    isOpenState = false;
    drag = null;
    removeListeners();
    if (stage) {
      while (stage.firstChild) stage.removeChild(stage.firstChild);
    }
    svgEl = null;
    if (root) root.setAttribute('hidden', '');
    detachOverlay();
    var back = trigger;
    trigger = null;
    // Restore the caller's inline state before the focus moves back, so the
    // user lands on the diagram they were looking at.
    var onClose = closeHandler;
    closeHandler = null;
    if (onClose) {
      try { onClose(); } catch (error) { /* the caller restores best-effort */ }
    }
    if (back && typeof back.focus === 'function') {
      try { back.focus(); } catch (error) { /* the trigger may be gone */ }
    }
  }

  function isOpen() {
    return isOpenState;
  }

  function destroy() {
    if (destroyed) return;
    if (isOpenState) closeViewer();
    removeListeners();
    destroyed = true;
    detachOverlay();
    root = null;
    titleEl = null;
    viewport = null;
    stage = null;
    svgEl = null;
    liveEl = null;
    backdrop = null;
    bar = null;
    buildEl = null;
    diag = null;
    diagOn = false;
    diagLines = [];
    built = false;
  }

  return {
    build: BUILD_STAMP,
    open: openViewer,
    close: closeViewer,
    isOpen: isOpen,
    destroy: destroy,
    refreshLabels: refreshLabels,
    syncLabels: syncLabels,
  };
}
