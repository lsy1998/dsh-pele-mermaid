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
/** Pointer movement that turns a press into a pan rather than a click. */
var DRAG_SLOP = 3;

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
  // Set by a press that actually moved: the click that ends that press is a pan, not a click.
  var dragMoved = false;
  // Set when a press began on the diagram or the chrome: the click that ends it is not a
  // click on the empty page and must not close the viewer.
  var pressMarked = false;
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

  function button(key, glyph, handler) {
    var node = el('button', 'dsh-pm-btn');
    node.type = 'button';
    node.setAttribute('data-i18n-key', key);
    node.setAttribute('aria-label', t(key));
    node.setAttribute('title', t(key));
    node.textContent = glyph;
    node.onclick = handler;
    return node;
  }

  /**
   * A TEXT button: the glyph plus a visible, localized label.
   *
   * The overlay used to offer a single ✕ glyph. It worked and was on top of everything,
   * but it was indistinguishable from the four other glyph buttons (zoom out/in/fit/reset)
   * and it carried no visible text, so users did not find it. The label makes the exit
   * affordance unmistakable; below 640px the stylesheet hides the label visually (the aria-label
   * and title still carry it) so the bar does not wrap.
   */
  function textButton(key, glyph, handler, labelKey) {
    var node = button(key, glyph, handler);
    var label = el('span', 'dsh-pm-viewer-exit-label');
    label.setAttribute('data-i18n-key', key);
    label.textContent = t(labelKey || key);
    node.appendChild(label);
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
      var nodes = bar.querySelectorAll ? bar.querySelectorAll('button') : [];
      for (var i = 0; i < nodes.length; i += 1) {
        var key = nodes[i].getAttribute && nodes[i].getAttribute('data-i18n-key');
        if (!key) continue;
        nodes[i].setAttribute('aria-label', t(key));
        nodes[i].setAttribute('title', t(key));
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

    // The click-to-close surface is the overlay's FIRST child, so every stage of the viewer
    // (bar, viewport, live region) is appended after it and therefore paints above it. It used
    // to be appended LAST, which put a full-window transparent surface on top of the toolbar
    // and the diagram: every press on a control landed on it and closed the viewer.
    backdrop = el('div', 'dsh-pm-viewer-backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.onclick = function () { closeViewer(); };
    root.appendChild(backdrop);

    bar = el('div', 'dsh-pm-viewer-bar');
    titleEl = el('div', 'dsh-pm-viewer-title');
    bar.appendChild(titleEl);

    var actions = el('div', 'dsh-pm-actions');
    actions.appendChild(button('zoomOut', '−', function () { zoomBy(1 / ZOOM_STEP); }));
    actions.appendChild(button('zoomIn', '+', function () { zoomBy(ZOOM_STEP); }));
    actions.appendChild(button('fitWindow', '⤡', function () { fitToWindow(); }));
    actions.appendChild(button('resetZoom', '1:1', function () { resetToNatural(); }));
    // The exit control is a TEXT button, not a bare glyph: it must be findable.
    actions.appendChild(textButton('closeViewer', '✕', function () { closeViewer(); }, 'exitFullscreen'));
    // The build stamp: which version of the plugin this page actually loaded. A stale
    // bundle then answers "did my update take effect?" without opening a terminal.
    buildEl = el('span', 'dsh-pm-viewer-build');
    buildEl.setAttribute('data-build-stamp', BUILD_STAMP);
    buildEl.setAttribute('title', 'dsh-pele-mermaid build: ' + BUILD_STAMP);
    buildEl.textContent = BUILD_STAMP;
    actions.appendChild(buildEl);
    bar.appendChild(actions);
    root.appendChild(bar);

    viewport = el('div', 'dsh-pm-viewport');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('aria-label', t('viewerLabel'));
    stage = el('div', 'dsh-pm-stage');
    viewport.appendChild(stage);
    root.appendChild(viewport);

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

  /** True when the event started on one of the overlay's own controls (a button must stay a click). */
  function fromControl(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('button, a, input, [contenteditable]');
  }

  function onPointerDown(event) {
    if (!isOpenState) return;
    if (event && event.button != null && event.button !== 0) return;
    var target = event && event.target;
    pressMarked = !!(target && target.closest && target.closest('svg, ' + CHROME_SELECTOR));
    // A press that begins on a control is that control's, not the start of a drag.
    if (fromControl(event)) return;
    dragMoved = false;
    drag = { x: event.clientX, y: event.clientY, tx: zoom.tx, ty: zoom.ty };
    if (event && event.pointerId != null && viewport && typeof viewport.setPointerCapture === 'function') {
      try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
    }
    if (!drag) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || !event) return;
    // A press that moved is a pan, not a click: the click that ends it must not close the
    // viewer (see onViewportClick).
    if (Math.abs(event.clientX - drag.x) > DRAG_SLOP || Math.abs(event.clientY - drag.y) > DRAG_SLOP) {
      dragMoved = true;
    }
    zoom.tx = drag.tx + (event.clientX - drag.x);
    zoom.ty = drag.ty + (event.clientY - drag.y);
    apply();
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerUp() {
    drag = null;
  }

  function onWheel(event) {
    if (!isOpenState || !event) return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    var pointX = event.clientX;
    var pointY = event.clientY;
    if (viewport && typeof viewport.getBoundingClientRect === 'function') {
      var rect = viewport.getBoundingClientRect();
      pointX = (typeof pointX === 'number' ? pointX : rect.left + rect.width / 2) - rect.left;
      pointY = (typeof pointY === 'number' ? pointY : rect.top + rect.height / 2) - rect.top;
    }
    var delta = typeof event.deltaY === 'number' ? event.deltaY : 0;
    var factor = Math.exp(-delta * 0.0015);
    if (!isFinite(factor) || factor <= 0 || factor === 1) factor = ZOOM_STEP;
    zoomBy(factor, pointX, pointY);
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

/** The interactive parts of the viewer chrome inside the viewport (a click on one is not a click on the page). */
  var CHROME_SELECTOR = 'button, a, input, select, textarea, [contenteditable], [role="button"]';

  /**
   * The diagram viewport fills the whole overlay below the bar, so it doubles as the "page
   * around the diagram".
   *
   * A viewed SVG swallows pointerdown/pointerup once the press starts, so in a real browser a
   * click on the DIAGRAM bubbles as a click whose target is only the viewport. Closing on that
   * would make "click the diagram" also mean "close", which is wrong. The close therefore
   * looks at the press itself (pressMarked): a press on the svg, on any chrome control or on
   * a drag is not a background click; only a plain press on the empty page closes.
   */
  function onViewportClick(event) {
    swallow(event);
    if (!isOpenState) return;
    var target = event && event.target;
    if (target && target.closest && target.closest('svg, ' + CHROME_SELECTOR)) return;
    if (dragMoved) { dragMoved = false; return; }
    if (pressMarked) { pressMarked = false; return; }
    closeViewer();
  }

  /** A click inside the chrome must not fall through to the backdrop. */
  function swallow(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  function bindInteractions() {
    removeListeners();
    var usePointer = !!(win && typeof win.PointerEvent === 'function');
    listen(viewport, usePointer ? 'pointerdown' : 'mousedown', onPointerDown);
    listen(doc, usePointer ? 'pointermove' : 'mousemove', onPointerMove);
    listen(doc, usePointer ? 'pointerup' : 'mouseup', onPointerUp);
    listen(viewport, 'wheel', onWheel, { passive: false });
    listen(doc, 'keydown', onKeydown);
    listen(win, 'resize', onResize);
    // The bar and the viewport sit above the backdrop, so their clicks must not bubble to it:
    // clicking a zoom button, or dragging the diagram, must not close the overlay.
    listen(bar, 'click', swallow);
    listen(viewport, 'click', onViewportClick);
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
