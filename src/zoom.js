/**
 * dsh-pele-mermaid - shared zoom/pan maths (SPEC R9 + inline pane zoom).
 *
 * ONE implementation of scale/translate state, clamping, zoom-at-point, pan,
 * fit-to-window, reset and transform application, used by BOTH the inline pane
 * (src/client.js) and the fullscreen overlay (src/viewer.js).
 *
 * Coordinate spaces
 *  - natural units: the SVG intrinsic size (viewBox, else width/height attributes).
 *  - layout pixels: the on-screen size of the content (natural * scale).
 *  - the translate (tx, ty) is expressed in layout pixels and applied to the
 *    content, so a content point p maps to the layout point p * scale + t.
 *
 * Two application modes are supported (see applyTransform):
 *  - "transform": the scale is a CSS transform (the fullscreen stage).
 *  - "size":      the scale is the element layout size, so a scroll container
 *                grows with the content and can scroll to it (the inline pane).
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.25;

/** Clamp `value` into [min, max]; a non-finite value resolves to `min`. */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Round to `digits` decimals (default 2). */
export function round(value, digits) {
  const factor = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(value * factor) / factor;
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Parse an absolute CSS length ("320", "320px"); percentages are rejected. */
function absoluteLength(raw) {
  if (raw == null) return 0;
  const text = String(raw).trim();
  if (!text || text.indexOf('%') !== -1) return 0;
  if (!/^[\d.]+([a-zA-Z%]*)$/.test(text)) return 0;
  const value = parseFloat(text);
  return positive(value);
}

/**
 * The SVG width/height attributes, when they are usable absolute lengths.
 * Percentages and other relative units are ignored on purpose: they do not
 * describe the diagram's own size.
 */
export function measureAttributeSize(element) {
  if (!element || typeof element.getAttribute !== 'function') return { width: 0, height: 0 };
  return { width: absoluteLength(element.getAttribute('width')), height: absoluteLength(element.getAttribute('height')) };
}

/** The SVG viewBox, when it is usable. */
export function measureViewBox(element) {
  if (!element || typeof element.getAttribute !== 'function') return { width: 0, height: 0 };
  const viewBox = element.getAttribute('viewBox');
  if (!viewBox) return { width: 0, height: 0 };
  const parts = String(viewBox).trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return { width: 0, height: 0 };
  return { width: positive(parts[2]), height: positive(parts[3]) };
}

/**
 * Measure an SVG: the width/height attributes first, then the viewBox, then the
 * bounding rect. This is the reference the fullscreen viewer has always used.
 */
export function measureSvg(element) {
  if (!element) return { width: 0, height: 0 };
  const attributes = measureAttributeSize(element);
  let width = attributes.width;
  let height = attributes.height;
  if (!width || !height) {
    const viewBox = measureViewBox(element);
    if (!width) width = viewBox.width;
    if (!height) height = viewBox.height;
  }
  if ((!width || !height) && typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    if (!width && rect && rect.width > 0) width = rect.width;
    if (!height && rect && rect.height > 0) height = rect.height;
  }
  return { width, height };
}

/**
 * Create a zoom/pan state. The object owns scale/translate; the methods below
 * are the only place the maths lives.
 */
export function createZoomState(init) {
  const options = init || {};
  const initialScale = Number(options.scale);
  const zoom = {
    scale: Number.isFinite(initialScale) ? clamp(initialScale, MIN_SCALE, MAX_SCALE) : 1,
    tx: Number.isFinite(options.tx) ? options.tx : 0,
    ty: Number.isFinite(options.ty) ? options.ty : 0,
    naturalWidth: positive(options.naturalWidth),
    naturalHeight: positive(options.naturalHeight),
  };

  zoom.setNatural = function setNatural(width, height) {
    zoom.naturalWidth = positive(width);
    zoom.naturalHeight = positive(height);
  };

  zoom.getScale = function getScale() {
    return zoom.scale;
  };

  /** Set the scale (clamped) without moving the translate. */
  zoom.setScale = function setScale(scale) {
    const value = Number(scale);
    zoom.scale = Number.isFinite(value) ? clamp(value, MIN_SCALE, MAX_SCALE) : zoom.scale;
    return zoom.scale;
  };

  /**
   * Zoom by `factor` around the viewport point (pointX, pointY): the content
   * point under that point stays put. Returns true when the scale changed.
   */
  zoom.zoomAtPoint = function zoomAtPoint(factor, pointX, pointY) {
    const ratio = Number(factor);
    if (!Number.isFinite(ratio) || ratio <= 0) return false;
    const next = clamp(zoom.scale * ratio, MIN_SCALE, MAX_SCALE);
    if (next === zoom.scale) return false;
    if (Number.isFinite(pointX) && Number.isFinite(pointY)) {
      const applied = next / zoom.scale;
      zoom.tx = pointX - (pointX - zoom.tx) * applied;
      zoom.ty = pointY - (pointY - zoom.ty) * applied;
    }
    zoom.scale = next;
    return true;
  };

  /** Translate the content by (dx, dy) layout pixels. */
  zoom.panBy = function panBy(dx, dy) {
    zoom.tx += Number.isFinite(dx) ? dx : 0;
    zoom.ty += Number.isFinite(dy) ? dy : 0;
  };

  /** Center the content inside a viewport of the given size. */
  zoom.center = function center(width, height) {
    const w = Number.isFinite(width) ? width : 0;
    const h = Number.isFinite(height) ? height : 0;
    zoom.tx = (w - zoom.naturalWidth * zoom.scale) / 2;
    zoom.ty = (h - zoom.naturalHeight * zoom.scale) / 2;
  };

  /** Scale so the whole diagram fits the viewport, then center it. */
  zoom.fitToWindow = function fitToWindow(width, height) {
    const w = positive(width);
    const h = positive(height);
    let fitted = 1;
    if (w > 0 && h > 0 && zoom.naturalWidth > 0 && zoom.naturalHeight > 0) {
      fitted = Math.min(w / zoom.naturalWidth, h / zoom.naturalHeight);
    }
    if (!Number.isFinite(fitted) || fitted <= 0) fitted = 1;
    zoom.scale = clamp(fitted, MIN_SCALE, MAX_SCALE);
    zoom.center(w, h);
    return zoom.scale;
  };

  /** Reset to natural size (scale 1) and center it in the viewport. */
  zoom.resetToNatural = function resetToNatural(width, height) {
    zoom.scale = clamp(1, MIN_SCALE, MAX_SCALE);
    if (Number.isFinite(width) || Number.isFinite(height)) {
      zoom.center(Number.isFinite(width) ? width : 0, Number.isFinite(height) ? height : 0);
    }
    return zoom.scale;
  };

  /**
   * Zoom a scrollable content around the pointer.
   *
   * `getOrigin(scale)` returns the content origin inside the scroll container
   * for a given scale (0 when the content is left aligned, the centring margin
   * when it is smaller than the container). The content point under the pointer
   * stays under the pointer.
   *
   * Returns true when the scale changed.
   */
  zoom.scrollZoomAtPoint = function scrollZoomAtPoint(factor, pointerX, pointerY, getOrigin) {
    const ratio = Number(factor);
    if (!Number.isFinite(ratio) || ratio <= 0) return false;
    const next = clamp(zoom.scale * ratio, MIN_SCALE, MAX_SCALE);
    if (next === zoom.scale) return false;
    const px = Number.isFinite(pointerX) ? pointerX : 0;
    const py = Number.isFinite(pointerY) ? pointerY : 0;
    const originOf = typeof getOrigin === 'function' ? getOrigin : null;
    const now = originOf ? (originOf(zoom.scale) || { x: 0, y: 0 }) : { x: 0, y: 0 };
    const after = originOf ? (originOf(next) || now) : now;
    // The content point (in natural units) under the pointer, before the zoom.
    const contentX = (zoom.tx + px - now.x) / zoom.scale;
    const contentY = (zoom.ty + py - now.y) / zoom.scale;
    zoom.tx = Math.max(0, after.x + contentX * next - px);
    zoom.ty = Math.max(0, after.y + contentY * next - py);
    zoom.scale = next;
    return true;
  };

  /** Reset to the identity transform (no translation, natural scale). */
  zoom.reset = function reset() {
    zoom.scale = 1;
    zoom.tx = 0;
    zoom.ty = 0;
  };

  /** Capture the current scale/translate. */
  zoom.snapshot = function snapshot() {
    return { scale: zoom.scale, tx: zoom.tx, ty: zoom.ty };
  };

  /** Restore a snapshot taken with snapshot(). */
  zoom.restore = function restore(saved) {
    if (!saved) return;
    if (Number.isFinite(saved.scale)) zoom.scale = clamp(saved.scale, MIN_SCALE, MAX_SCALE);
    if (Number.isFinite(saved.tx)) zoom.tx = saved.tx;
    if (Number.isFinite(saved.ty)) zoom.ty = saved.ty;
  };

  return zoom;
}

/**
 * Apply a zoom state to a target element.
 *
 * options.mode:
 *  - "transform" (default): the scale is a CSS transform; the element keeps its
 *    natural size and the transform is translate(tx, ty) scale(s).
 *  - "size": the scale is the element layout size (natural * scale) and the
 *    transform carries only the translation, so a scroll container grows with
 *    the content and can scroll to it.
 *
 * options.natural: { width, height } - required for mode "size".
 */
export function applyTransform(target, zoom, options) {
  if (!target || !target.style) return;
  const opts = options || {};
  if (!zoom) return;
  const scale = Number.isFinite(zoom.scale) ? zoom.scale : 1;
  const tx = Number.isFinite(zoom.tx) ? zoom.tx : 0;
  const ty = Number.isFinite(zoom.ty) ? zoom.ty : 0;

  if (opts.mode === 'size') {
    // The scale becomes the element's layout size, so the scroll container grows
    // with the content and can scroll to it. The translation is realised by the
    // scroll container's scroll offsets, not by a transform (which would not
    // enlarge the scrollable area).
    const natural = opts.natural || {};
    const width = positive(natural.width);
    const height = positive(natural.height);
    if (width > 0) target.style.width = round(width * scale, 2) + 'px';
    if (height > 0) target.style.height = round(height * scale, 2) + 'px';
    if (typeof target.style.setProperty === 'function') target.style.setProperty('max-width', 'none');
    else target.style.maxWidth = 'none';
    return;
  }
  target.style.transform = 'translate(' + round(tx) + 'px, ' + round(ty) + 'px) scale(' + round(scale, 4) + ')';
  target.style.transformOrigin = '0 0';
}
/**
 * Zoom a scrollable content around the pointer and return the new scroll offsets.
 *
 * The scroll container realises the translation through its scroll offsets, so
 * the content point under the pointer must stay under the pointer:
 *
 *   contentX = (scrollLeft + pointerX - originX) / scale
 *   scrollLeft' = contentX * scale' + originX - pointerX
 *
 * `originX`/`originY` are the content offsets inside the container (0 when the
 * content is larger than the container, the centring margin when it is smaller).
 *
 * Returns null when the scale would not change.
 */
export function zoomScrollAtPointer(state, factor, pointerX, pointerY, scrollLeft, scrollTop, originX, originY) {
  const source = state || {};
  const ratio = Number(factor);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const current = Number.isFinite(source.scale) ? source.scale : 1;
  if (current <= 0) return null;
  const next = clamp(current * ratio, MIN_SCALE, MAX_SCALE);
  if (next === current) return null;
  const applied = next / current;
  const left = Number.isFinite(scrollLeft) ? scrollLeft : 0;
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const px = Number.isFinite(pointerX) ? pointerX : 0;
  const py = Number.isFinite(pointerY) ? pointerY : 0;
  const ox = Number.isFinite(originX) ? originX : 0;
  const oy = Number.isFinite(originY) ? originY : 0;
  return {
    scale: next,
    scrollLeft: (left + px - ox) * applied + ox - px,
    scrollTop: (top + py - oy) * applied + oy - py,
  };
}
