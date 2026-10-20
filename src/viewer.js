/**
 * dsh-pele-mermaid - fullscreen zoom/pan viewer (SPEC 4 createViewer, SPEC 5 R9, SPEC 7 classes).
 *
 * The overlay is built lazily, traps focus while open, restores focus to the
 * trigger on close and destroys every listener and node on `destroy()`.
 *
 * The zoom/pan maths lives in src/zoom.js and is shared with the inline pane
 * (src/client.js) - this module only owns the overlay DOM and its behaviour.
 */

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
  var drag = null;
  var currentType = 'diagram';
  var closeHandler = null;
  var listeners = [];

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

    bar = el('div', 'dsh-pm-viewer-bar');
    titleEl = el('div', 'dsh-pm-viewer-title');
    bar.appendChild(titleEl);

    var actions = el('div', 'dsh-pm-actions');
    actions.appendChild(button('zoomOut', '−', function () { zoomBy(1 / ZOOM_STEP); }));
    actions.appendChild(button('zoomIn', '+', function () { zoomBy(ZOOM_STEP); }));
    actions.appendChild(button('fitWindow', '⤡', function () { fitToWindow(); }));
    actions.appendChild(button('resetZoom', '1:1', function () { resetToNatural(); }));
    actions.appendChild(button('closeViewer', '✕', function () { closeViewer(); }));
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

  function apply() {
    if (!stage) return;
    applyTransform(stage, zoom, { mode: 'transform' });
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

  function onPointerDown(event) {
    if (!isOpenState) return;
    if (event && event.button != null && event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, tx: zoom.tx, ty: zoom.ty };
    if (event && event.pointerId != null && viewport && typeof viewport.setPointerCapture === 'function') {
      try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
    }
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || !event) return;
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

  function bindInteractions() {
    removeListeners();
    var usePointer = !!(win && typeof win.PointerEvent === 'function');
    listen(viewport, usePointer ? 'pointerdown' : 'mousedown', onPointerDown);
    listen(doc, usePointer ? 'pointermove' : 'mousemove', onPointerMove);
    listen(doc, usePointer ? 'pointerup' : 'mouseup', onPointerUp);
    listen(viewport, 'wheel', onWheel, { passive: false });
    listen(doc, 'keydown', onKeydown);
    listen(win, 'resize', onResize);
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
    built = false;
  }

  return {
    open: openViewer,
    close: closeViewer,
    isOpen: isOpen,
    destroy: destroy,
    refreshLabels: refreshLabels,
    syncLabels: syncLabels,
  };
}
