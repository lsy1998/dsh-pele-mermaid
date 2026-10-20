/**
 * dsh-pele-mermaid - fullscreen zoom/pan viewer (SPEC 4 createViewer, SPEC 5 R9, SPEC 7 classes).
 *
 * The overlay is built lazily, traps focus while open, restores focus to the
 * trigger on close and destroys every listener and node on `destroy()`.
 */

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
var MIN_SCALE = 0.1;
var MAX_SCALE = 8;
var ZOOM_STEP = 1.25;
var FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function round(value, digits) {
  var factor = Math.pow(10, digits || 2);
  return Math.round(value * factor) / factor;
}

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
  var scale = 1;
  var tx = 0;
  var ty = 0;
  var naturalWidth = 0;
  var naturalHeight = 0;
  var trigger = null;
  var bar = null;
  var drag = null;
  var currentType = 'diagram';
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

  function readDimension(node, attribute) {
    if (!node || typeof node.getAttribute !== 'function') return 0;
    var raw = node.getAttribute(attribute);
    if (!raw) return 0;
    var value = parseFloat(raw);
    return isFinite(value) && value > 0 ? value : 0;
  }

  function measure() {
    var width = readDimension(svgEl, 'width');
    var height = readDimension(svgEl, 'height');
    if ((!width || !height) && svgEl && typeof svgEl.getAttribute === 'function') {
      var viewBox = svgEl.getAttribute('viewBox');
      if (viewBox) {
        var parts = String(viewBox).trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4) {
          if (!width && isFinite(parts[2]) && parts[2] > 0) width = parts[2];
          if (!height && isFinite(parts[3]) && parts[3] > 0) height = parts[3];
        }
      }
    }
    if ((!width || !height) && svgEl && typeof svgEl.getBoundingClientRect === 'function') {
      var rect = svgEl.getBoundingClientRect();
      if (!width && rect && rect.width > 0) width = rect.width;
      if (!height && rect && rect.height > 0) height = rect.height;
    }
    naturalWidth = width > 0 ? width : 640;
    naturalHeight = height > 0 ? height : 400;
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
    stage.style.transform = 'translate(' + round(tx) + 'px, ' + round(ty) + 'px) scale(' + round(scale, 4) + ')';
    stage.style.transformOrigin = '0 0';
    announce(Math.round(scale * 100) + '%');
  }

  function center() {
    var size = viewportSize();
    tx = (size.width - naturalWidth * scale) / 2;
    ty = (size.height - naturalHeight * scale) / 2;
    apply();
  }

  function fitToWindow() {
    var size = viewportSize();
    var fitted = Math.min(size.width / naturalWidth, size.height / naturalHeight);
    if (!isFinite(fitted) || fitted <= 0) fitted = 1;
    scale = clamp(fitted, MIN_SCALE, MAX_SCALE);
    center();
  }

  function resetToNatural() {
    scale = clamp(1, MIN_SCALE, MAX_SCALE);
    center();
  }

  function zoomBy(factor, clientX, clientY) {
    if (!isOpenState) return;
    var size = viewportSize();
    var pointX = typeof clientX === 'number' ? clientX : size.width / 2;
    var pointY = typeof clientY === 'number' ? clientY : size.height / 2;
    var next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === scale) return;
    tx = pointX - (pointX - tx) * (next / scale);
    ty = pointY - (pointY - ty) * (next / scale);
    scale = next;
    apply();
  }

  function panBy(dx, dy) {
    tx += dx;
    ty += dy;
    apply();
  }

  function onPointerDown(event) {
    if (!isOpenState) return;
    if (event && event.button != null && event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, tx: tx, ty: ty };
    if (event && event.pointerId != null && viewport && typeof viewport.setPointerCapture === 'function') {
      try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
    }
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || !event) return;
    tx = drag.tx + (event.clientX - drag.x);
    ty = drag.ty + (event.clientY - drag.y);
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
    refreshLabels();
    mountSvg(config.svg);
    attachOverlay();
    root.removeAttribute('hidden');
    isOpenState = true;
    measure();
    fitToWindow();
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
