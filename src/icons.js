/**
 * dsh-pele-mermaid — the inline SVG icon set shared by the inline toolbar and the
 * fullscreen viewer.
 *
 * The chrome is icon-only: the graphics carry the meaning, and every control keeps its
 * localized name in `aria-label` (the accessible name, SPEC R13) and `title` (the hover
 * tooltip). Text labels used to sit next to the icons in the inline bar; a row of Chinese
 * words plus a percentage read as a paragraph above every diagram, and it wrapped first on a
 * narrow chat column.
 *
 * Real SVG paths, not typographic glyphs: glyphs (✕, ⤡, 1:1) render differently on every
 * platform, and some (⤡, U+2921) are simply missing from common Windows fonts, so a control
 * could end up as a blank box. A stroked path inherits the button's colour through
 * `currentColor` (see `.dsh-pm-icon`) and looks the same everywhere.
 *
 * The markup is a compile-time constant — no user data ever reaches the DOM as markup.
 */

/** 16×16 stroked paths, one entry per control. */
export const ICON_PATHS = Object.freeze({
  // Magnifier with a plus: zoom in.
  zoomIn: '<circle cx="6.75" cy="6.75" r="4.25"></circle>' +
    '<path d="M9.9 9.9 13.5 13.5"></path>' +
    '<path d="M4.9 6.75h3.7M6.75 4.9v3.7"></path>',
  // The same magnifier with a minus: zoom out.
  zoomOut: '<circle cx="6.75" cy="6.75" r="4.25"></circle>' +
    '<path d="M9.9 9.9 13.5 13.5"></path>' +
    '<path d="M4.9 6.75h3.7"></path>',
  // Four corner brackets: fit the diagram to the window.
  fitWindow: '<path d="M2 6V3.5A1.5 1.5 0 0 1 3.5 2H6"></path>' +
    '<path d="M10 2h2.5A1.5 1.5 0 0 1 14 3.5V6"></path>' +
    '<path d="M14 10v2.5a1.5 1.5 0 0 1-1.5 1.5H10"></path>' +
    '<path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5V10"></path>',
  // A frame around a smaller frame: the diagram back at its natural 1:1 size.
  resetZoom: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"></rect>' +
    '<rect x="6" y="6" width="4" height="4" rx="0.5"></rect>',
  // A cross: leave the fullscreen viewer.
  close: '<path d="M4 4l8 8M12 4l-8 8"></path>',
  // Two arrows pointing out of opposite corners: open the diagram fullscreen. Deliberately the
  // mirror image of fitWindow (brackets pointing inward) so the two never read as the same
  // control when they sit in different bars.
  expand: '<path d="M9.5 2.5h4v4"></path>' +
    '<path d="M13.5 2.5 8.5 7.5"></path>' +
    '<path d="M6.5 13.5h-4v-4"></path>' +
    '<path d="M2.5 13.5 7.5 8.5"></path>',
  // An arrow into a tray: save the diagram as a standalone SVG.
  download: '<path d="M8 2.5v7"></path>' +
    '<path d="M5.2 6.8 8 9.6l2.8-2.8"></path>' +
    '<path d="M2.5 11.3v1.4A1.8 1.8 0 0 0 4.3 14.5h7.4a1.8 1.8 0 0 0 1.8-1.8v-1.4"></path>',
  // Two connected boxes: the rendered diagram view.
  diagram: '<rect x="2" y="2.5" width="5.6" height="4.2" rx="1"></rect>' +
    '<rect x="8.4" y="9.3" width="5.6" height="4.2" rx="1"></rect>' +
    '<path d="M4.8 6.7v4.6h3.6"></path>',
  // Angle brackets with a slash: the Mermaid source view.
  code: '<path d="M5.4 4.6 2.2 8l3.2 3.4"></path>' +
    '<path d="M10.6 4.6 13.8 8l-3.2 3.4"></path>' +
    '<path d="M9.3 2.8 6.7 13.2"></path>',
});

/** Fallback glyphs, used only if the DOM cannot parse SVG (then the control is never blank). */
export const ICON_FALLBACK = Object.freeze({
  zoomIn: '+',
  zoomOut: '−',
  fitWindow: '⤡',
  resetZoom: '1:1',
  close: '✕',
  expand: '⛶',
  download: '↓',
  diagram: '◇',
  code: '</>',
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build the inline SVG for `name`, or a text fallback if the DOM cannot make one.
 *
 * `doc` is the document that will own the node (importNode keeps it in one realm); `win` is
 * only consulted for its DOMParser, so a sandboxed document and the page that renders it can
 * differ.
 */
export function createIcon(doc, win, name) {
  if (!doc) return null;
  const markup = ICON_PATHS[name];
  if (!markup) return doc.createTextNode(ICON_FALLBACK[name] || '');
  const Parser = (win && win.DOMParser) || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (Parser) {
    try {
      const parsed = new Parser().parseFromString(
        '<svg xmlns="' + SVG_NS + '" viewBox="0 0 16 16">' + markup + '</svg>', 'image/svg+xml');
      const rootNode = parsed && parsed.documentElement;
      const failed = parsed && typeof parsed.getElementsByTagName === 'function'
        ? parsed.getElementsByTagName('parsererror')
        : null;
      if (rootNode && String(rootNode.nodeName).toLowerCase() === 'svg' && failed && !failed.length) {
        const svg = doc.importNode(rootNode, true);
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        // Decorative: the control that owns it already carries the accessible name, so the
        // graphic must not be announced twice.
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('class', 'dsh-pm-icon');
        return svg;
      }
    } catch (error) { /* fall through to the glyph */ }
  }
  return doc.createTextNode(ICON_FALLBACK[name] || '');
}
