/**
 * dsh-pele-mermaid - standalone SVG export helpers (SPEC 4, SPEC 5 R10).
 */

var SVG_NS = 'http://www.w3.org/2000/svg';
var XLINK_NS = 'http://www.w3.org/1999/xlink';
var ROOT_TAG_RE = /<svg\b[^>]*>/i;
var VIEW_BOX_RE = /\bviewBox\s*=\s*["']([^"']+)["']/i;

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseViewBox(tag) {
  var match = VIEW_BOX_RE.exec(tag);
  if (!match) return null;
  var parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(function (n) { return !isFinite(n); })) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Make a rendered Pele SVG usable outside DSH: namespaces, an explicit
 * pixel size and, when requested, an opaque background rectangle.
 * Non-SVG input is returned unchanged.
 */
export function ensureStandaloneSvg(svg, opts) {
  var options = opts || {};
  var input = typeof svg === 'string' ? svg.trim() : '';
  if (!input) return '';
  var match = ROOT_TAG_RE.exec(input);
  if (!match) return input;
  var tag = match[0];
  if (!/\sxmlns\s*=/.test(tag)) {
    tag = tag.replace(/^<svg/i, '<svg xmlns="' + SVG_NS + '"');
  }
  if (!/\sxmlns:xlink\s*=/.test(tag)) {
    tag = tag.replace(/^<svg/i, '<svg xmlns:xlink="' + XLINK_NS + '"');
  }
  var box = parseViewBox(tag);
  var hasWidth = /\swidth\s*=/.test(tag);
  var hasHeight = /\sheight\s*=/.test(tag);
  if (box && (!hasWidth || !hasHeight)) {
    var size = '';
    if (!hasWidth) size += ' width="' + box.width + '"';
    if (!hasHeight) size += ' height="' + box.height + '"';
    tag = tag.replace(/>$/, size + '>');
  }
  var background = options.background;
  if (background && background !== 'transparent' && background !== 'none') {
    var fill = escapeAttribute(background);
    var rect = box
      ? '<rect x="' + box.x + '" y="' + box.y + '" width="' + box.width + '" height="' + box.height + '" fill="' + fill + '"/>'
      : '<rect width="100%" height="100%" fill="' + fill + '"/>';
    tag += rect;
  }
  if (tag === match[0]) return input;
  return input.replace(match[0], tag);
}

function pad(value, width) {
  return String(value).padStart(width || 2, '0');
}

/** pele-<type>-YYYYMMDD-HHmmss.svg (local time). */
export function svgFileName(type, now) {
  var raw = String(type == null ? '' : type).trim().toLowerCase();
  var safe = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
  var date = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  var stamp = String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  return 'pele-' + safe + '-' + stamp + '.svg';
}

/** Save `svg` as `filename` through a temporary object URL. Returns success. */
export function downloadSvg(svg, filename, doc) {
  var target = doc || (typeof document !== 'undefined' ? document : undefined);
  if (!target || typeof target.createElement !== 'function') return false;
  var parent = target.body || target.documentElement;
  if (!parent || typeof parent.appendChild !== 'function') return false;
  var markup = typeof svg === 'string' ? svg : '';
  var name = filename || svgFileName('diagram');
  var view = target.defaultView || (typeof window !== 'undefined' ? window : undefined);
  var url = null;
  var objectUrl = null;
  try {
    var BlobCtor = (view && view.Blob) || (typeof Blob !== 'undefined' ? Blob : undefined);
    var UrlCtor = (view && view.URL) || (typeof URL !== 'undefined' ? URL : undefined);
    if (BlobCtor && UrlCtor && typeof UrlCtor.createObjectURL === 'function') {
      objectUrl = UrlCtor.createObjectURL(new BlobCtor([markup], { type: 'image/svg+xml;charset=utf-8' }));
      url = objectUrl;
    }
  } catch (error) {
    objectUrl = null;
    url = null;
  }
  if (!url) url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);

  var anchor = target.createElement('a');
  anchor.setAttribute('href', url);
  anchor.setAttribute('download', name);
  anchor.setAttribute('rel', 'noopener');
  if (anchor.style) anchor.style.display = 'none';
  parent.appendChild(anchor);
  try {
    if (typeof anchor.click === 'function') anchor.click();
  } finally {
    if (anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
      anchor.parentNode.removeChild(anchor);
    }
    if (objectUrl) {
      var revoke = function () {
        try {
          var UrlCtor2 = (view && view.URL) || (typeof URL !== 'undefined' ? URL : undefined);
          if (UrlCtor2 && typeof UrlCtor2.revokeObjectURL === 'function') UrlCtor2.revokeObjectURL(objectUrl);
        } catch (error) { /* ignore */ }
      };
      if (typeof setTimeout === 'function') setTimeout(revoke, 1000);
      else revoke();
    }
  }
  return true;
}
