/**
 * dsh-pele-mermaid — Cordis client plugin (browser half).
 *
 * Renders `mermaid` fenced code blocks in the DSH Web GUI with Pele, without
 * bundling mermaid.js or Pele itself: the Pele runtime is injected lazily from
 * the host route through src/runtime.js.
 *
 * SPEC §4 (frozen exports) + SPEC §5 R1-R13 + SPEC §7 (DOM/CSS conventions).
 */

import {
  getPeleRuntime,
  loadPeleRuntime,
  setPeleRuntimeForTesting,
  resetPeleRuntimeForTesting,
} from './runtime.js';
import { ensureStandaloneSvg, svgFileName, downloadSvg } from './svg.js';
import {
  MIN_SCALE, MAX_SCALE, ZOOM_STEP, clamp, clampScroll, createZoomState, measureSvg, readScroll, round, writeScroll,
} from './zoom.js';
import { createViewer } from './viewer.js';
import {
  codeSource,
  isMermaidCodeBlock,
  diagramLabel,
  hasForeignLanguageClass,
  hasMermaidLanguageClass,
  hasAnyLanguageClass,
  hasMermaidKeyword,
  checkLimits,
} from './detection.js';
import { detectLang, t } from './i18n.js';
import { createIcon } from './icons.js';
import { STYLE_ATTR, installStyles, themeVariables, applyTheme } from './styles.js';

export { setPeleRuntimeForTesting, resetPeleRuntimeForTesting };

/** Cordis client plugins declare no service dependencies (SPEC §2/§4). */
export const inject = [];

const CONTAINER_ATTR = 'data-dsh-pele-mermaid';
/** Marker on the processed <pre>; the wrapper alone carries CONTAINER_ATTR (SPEC R2/§7). */
const BLOCK_ATTR = 'data-dsh-pele-mermaid-block';
const FOREIGN_SELECTOR = '.dsh-mmd, [data-dsh-mermaid]';
const RENDER_DEBOUNCE_MS = 60;
const FLUSH_DELAY_MS = 0;
const YIELD_MS = 0;

/** Renderer defaults (SPEC R4). */
const SETTINGS = Object.freeze({
  padding: 12,
  autoDirection: true,
  links: true,
  linkRel: 'noopener',
});

/**
 * Module singleton. Every field is reset by start()/teardown(), so a repeated
 * apply/cleanup/apply cycle never leaves duplicate observers or toolbars (R12).
 */
const state = {
  active: false,
  doc: null,
  win: null,
  lang: 'en',
  entries: new Map(),
  processed: new WeakSet(),
  pending: new Set(),
  queue: [],
  draining: false,
  drainPromise: null,
  flushTimer: null,
  flushing: false,
  flushPromise: null,
  observer: null,
  themeObserver: null,
  langObserver: null,
  viewer: null,
  currentTeardown: null,
};

function noop() {}

function resolveDoc(doc) {
  if (doc) return doc;
  return typeof document === 'undefined' ? null : document;
}

function resolveWin(win) {
  if (win) return win;
  return typeof window === 'undefined' ? null : window;
}

function tagOf(el) {
  return el && el.tagName ? String(el.tagName).toUpperCase() : '';
}

function isConnected(el) {
  if (!el) return false;
  if (typeof el.isConnected === 'boolean') return el.isConnected;
  return !!(state.doc && state.doc.contains && state.doc.contains(el));
}

function matches(el, selector) {
  return !!(el && typeof el.matches === 'function' && el.matches(selector));
}

function tr(key, params) {
  return t(state.lang, key, params);
}

function yieldControl() {
  return new Promise((resolve) => {
    setTimeout(resolve, YIELD_MS);
  });
}

/* ------------------------------------------------------------------ *
 * Detection / candidate collection
 * ------------------------------------------------------------------ */

/** Resolve a node argument to the `code` element we operate on. */
function resolveCode(target) {
  if (!target || target.nodeType !== 1) return null;
  const tag = tagOf(target);
  if (tag === 'CODE') return target;
  if (tag === 'PRE') return target.querySelector ? target.querySelector('code') : null;
  return target.querySelector ? target.querySelector('pre > code') : null;
}

function entryForElement(pre, codeEl) {
  if (codeEl && state.entries.has(codeEl)) return state.entries.get(codeEl);
  if (pre) {
    for (const entry of state.entries.values()) {
      if (entry.pre === pre) return entry;
    }
  }
  return null;
}

/** SPEC R2 — is this `pre` owned by us or by a foreign diagram plugin? */
function inForeignContainer(el) {
  if (!el) return false;
  if (el.closest) {
    try {
      if (el.closest(FOREIGN_SELECTOR)) return true;
    } catch {
      /* ignore selector support issues */
    }
  }
  // The reference plugin keeps the original pre as a sibling of .dsh-mmd.
  const sibling = el.previousElementSibling;
  if (sibling && matches(sibling, FOREIGN_SELECTOR)) return true;
  return false;
}

/**
 * Inspect a candidate `code` element.
 * Returns null when the block must not be enhanced, otherwise an info object;
 * `needsRuntime` marks Shiki plain-fallback blocks that still need Pele's
 * detectType before we may claim them (SPEC R1).
 */
function candidateInfo(codeEl) {
  if (!codeEl || tagOf(codeEl) !== 'CODE') return null;
  const pre = codeEl.parentElement;
  if (!pre || tagOf(pre) !== 'PRE') return null;
  if (pre.hasAttribute(BLOCK_ATTR)) return null;
  if (pre.closest) {
    try {
      if (pre.closest('[' + CONTAINER_ATTR + ']')) return null;
    } catch {
      /* ignore */
    }
  }
  if (entryForElement(pre, codeEl)) return null;
  if (inForeignContainer(pre) || inForeignContainer(codeEl)) return null;
  const source = codeSource(codeEl);
  if (!source.trim()) return null;
  if (hasForeignLanguageClass(codeEl)) return null;
  if (hasMermaidLanguageClass(codeEl)) return { pre, codeEl, source, needsRuntime: false };
  if (hasAnyLanguageClass(codeEl)) return null;
  if (!hasMermaidKeyword(source)) return null;
  const runtime = getPeleRuntime();
  const detectType = runtime && typeof runtime.detectType === 'function' ? runtime.detectType : null;
  if (!detectType) return { pre, codeEl, source, needsRuntime: true };
  if (!isMermaidCodeBlock(pre, codeEl, (value) => detectType.call(runtime, value))) return null;
  return { pre, codeEl, source, needsRuntime: false };
}

function currentDetectType() {
  const runtime = getPeleRuntime();
  if (runtime && typeof runtime.detectType === 'function') {
    return (source) => runtime.detectType(source);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Runtime loading (SPEC §2: lazy, deduped)
 * ------------------------------------------------------------------ */

function ensureRuntime() {
  const existing = getPeleRuntime();
  if (existing) return Promise.resolve(existing);
  const promise = Promise.resolve()
    .then(() => loadPeleRuntime(state.win))
    .catch((error) => {
      state.lastRuntimeError = error;
      return null;
    });
  return promise;
}

/* ------------------------------------------------------------------ *
 * DOM construction (SPEC §7)
 * ------------------------------------------------------------------ */

/**
 * One icon-only toolbar control.
 *
 * The bar used to print the localized words on the buttons themselves ("图形", "代码",
 * "下载 SVG", …). Next to a badge that already names the diagram type, that turned the strip
 * above every diagram into a sentence, and in a narrow chat column the labels wrapped before
 * they shrank. The controls now carry a graphic; the words move to `aria-label` (the
 * accessible name, R13) and `title` (the hover tooltip), filled by localizeEntry().
 */
function makeButton(doc, className, pressed, iconName, labelKey) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = className;
  if (pressed != null) button.setAttribute('aria-pressed', pressed);
  if (labelKey) button.setAttribute('data-i18n-key', labelKey);
  if (iconName) button.appendChild(createIcon(doc, state.win, iconName));
  return button;
}

/** Put the localized name on a control: accessible name + hover tooltip, never visible text. */
function labelControl(control, key) {
  if (!control) return;
  const text = t(state.lang, key);
  control.setAttribute('aria-label', text);
  control.setAttribute('title', text);
  control.setAttribute('data-i18n-key', key);
}

function localizeEntry(entry) {
  const lang = state.lang;
  const type = entry.type || 'mermaid';
  entry.bar.setAttribute('aria-label', t(lang, 'viewOptions'));
  entry.badge.textContent = t(lang, 'badge', { type });
  labelControl(entry.btnDiagram, 'diagramView');
  labelControl(entry.btnCode, 'codeView');
  labelControl(entry.btnFullscreen, 'fullscreen');
  labelControl(entry.btnDownload, 'downloadSvg');
  labelControl(entry.btnZoomOut, 'zoomOut');
  labelControl(entry.btnZoomIn, 'zoomIn');
  labelControl(entry.btnZoomReset, 'resetZoom');
  entry.pre.setAttribute('aria-label', t(lang, 'sourceLabel'));
  entry.statusEl.setAttribute('aria-label', t(lang, 'statusLabel'));
  if (entry.pane) entry.pane.setAttribute('aria-label', t(lang, 'paneLabel'));
  if (entry.zoomStatus) {
    entry.zoomStatus.setAttribute('aria-label', t(lang, 'zoomStatus', { zoom: entry.zoomStatus.textContent || '100%' }));
  }
  if (entry.messageKey) {
    const message = t(lang, entry.messageKey, entry.messageParams || {});
    entry.pane.textContent = message;
    entry.errorEl.textContent = message;
  }
  const svg = entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (svg && svg.getAttribute('aria-label')) {
    svg.setAttribute('aria-label', t(lang, 'diagramTitle', { type }));
  }
}

function setStatus(entry, key, params) {
  entry.statusKey = key || null;
  entry.statusParams = params || {};
  entry.statusEl.textContent = key ? t(state.lang, key, params || {}) : '';
}

function setView(entry, view) {
  const next = view === 'code' ? 'code' : 'diagram';
  entry.view = next;
  entry.wrapper.dataset.view = next;
  entry.btnDiagram.setAttribute('aria-pressed', String(next === 'diagram'));
  entry.btnCode.setAttribute('aria-pressed', String(next === 'code'));
}

function buildMountOptions(entry, generation) {
  const options = {
    autoDirection: SETTINGS.autoDirection,
    padding: SETTINGS.padding,
    icons: () => null,
    links: SETTINGS.links,
    linkRel: SETTINGS.linkRel,
    onRender: (result) => {
      if (isLive(entry) && generation === entry.generation) finalizeRendered(entry, result, generation);
    },
    onError: (error) => {
      if (isLive(entry) && generation === entry.generation) showRenderError(entry, error, generation);
    },
  };
  let width = 0;
  try {
    width = entry.pane.clientWidth || 0;
  } catch {
    width = 0;
  }
  if (!width && state.win && Number(state.win.innerWidth) > 0) {
    width = Number(state.win.innerWidth);
  }
  if (width > 0) options.maxWidth = Math.round(width);
  return options;
}

/** Build the wrapper, move the original pre inside and start rendering. */
function enhanceInfo(info) {
  if (!info) return null;
  const codeEl = info.codeEl;
  const pre = info.pre;
  const existing = state.entries.get(codeEl);
  if (existing) return existing;
  const doc = codeEl.ownerDocument || state.doc;
  const parent = pre.parentNode;
  if (!doc || !parent) return null;

  const origin = { parent, nextSibling: pre.nextSibling };
  const wrapper = doc.createElement('div');
  wrapper.className = 'dsh-pm';
  wrapper.setAttribute(CONTAINER_ATTR, '');
  wrapper.dataset.view = 'diagram';
  wrapper.dataset.state = 'loading';

  const bar = doc.createElement('div');
  bar.className = 'dsh-pm-bar';
  bar.setAttribute('role', 'group');

  const badge = doc.createElement('span');
  badge.className = 'dsh-pm-badge';

  const btnDiagram = makeButton(doc, 'dsh-pm-btn dsh-pm-view-control', 'true', 'diagram', 'diagramView');
  const btnCode = makeButton(doc, 'dsh-pm-btn dsh-pm-view-control', 'false', 'code', 'codeView');

  const actions = doc.createElement('div');
  actions.className = 'dsh-pm-actions';
  // Explicit zoom controls for the inline diagram. Without them the only ways to zoom were
  // Ctrl+wheel and the +/-/0 keys, which no discoverable control pointed at - the reported
  // "zoom buttons do not respond" symptom. They drive the same zoomInlineAt() path, so the
  // anchoring, the clamping and the live region behave exactly like the wheel.
  const btnZoomOut = makeButton(doc, 'dsh-pm-btn dsh-pm-zoom', null, 'zoomOut', 'zoomOut');
  const btnZoomIn = makeButton(doc, 'dsh-pm-btn dsh-pm-zoom', null, 'zoomIn', 'zoomIn');
  const btnZoomReset = makeButton(doc, 'dsh-pm-btn dsh-pm-zoom', null, 'resetZoom', 'resetZoom');
  const btnFullscreen = makeButton(doc, 'dsh-pm-btn dsh-pm-action', null, 'expand', 'fullscreen');
  const btnDownload = makeButton(doc, 'dsh-pm-btn dsh-pm-action', null, 'download', 'downloadSvg');
  actions.append(btnZoomOut, btnZoomIn, btnZoomReset, btnFullscreen, btnDownload);

  // The view toggle and the actions are two different kinds of control, so a hairline divides
  // them the way the fullscreen bar divides its view controls from the exit.
  const sep = doc.createElement('span');
  sep.className = 'dsh-pm-sep';
  sep.setAttribute('aria-hidden', 'true');

  bar.append(badge, btnDiagram, btnCode, sep, actions);

  const body = doc.createElement('div');
  body.className = 'dsh-pm-body';
  const pane = doc.createElement('div');
  pane.className = 'dsh-pm-pane';
  pane.dataset.state = 'loading';
  // The pane is a focusable, keyboard-operable viewport onto the diagram.
  pane.setAttribute('tabindex', '0');
  pane.setAttribute('role', 'group');
  pane.setAttribute('aria-label', t(state.lang, 'paneLabel'));
  const errorEl = doc.createElement('div');
  errorEl.className = 'dsh-pm-error';
  const statusEl = doc.createElement('div');
  statusEl.className = 'dsh-pm-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('aria-atomic', 'true');
  // The current zoom, exposed to assistive technology (R13).
  const zoomStatus = doc.createElement('span');
  zoomStatus.className = 'dsh-pm-sr-only';
  zoomStatus.setAttribute('aria-live', 'polite');
  zoomStatus.setAttribute('aria-label', t(state.lang, 'zoomStatus', { zoom: '100%' }));
  zoomStatus.textContent = '100%';
  body.append(pane, errorEl, statusEl, zoomStatus);

  const entry = {
    code: codeEl,
    pre,
    wrapper,
    bar,
    body,
    badge,
    pane,
    errorEl,
    statusEl,
    btnDiagram,
    btnCode,
    btnZoomIn,
    btnZoomOut,
    btnZoomReset,
    btnFullscreen,
    btnDownload,
    actions,
    origin,
    listeners: [],
    source: info.source,
    type: 'mermaid',
    view: 'diagram',
    lastRendered: '',
    generation: 0,
    messageKey: null,
    messageParams: null,
    statusKey: null,
    statusParams: {},
    renderTimer: null,
    queued: false,
    mounted: null,
    disposed: false,
    // Per-block zoom/pan state (SPEC R9 parity for the inline pane).
    zoom: createZoomState(),
    // The pristine Pele render result (svg markup + natural size), keyed by generation.
    pristine: null,
    // Saved inline state, restored when the fullscreen overlay closes (SPEC R9).
    inlineRestore: null,
    zoomNatural: { width: 0, height: 0 },
    zoomFit: 1,
    // The pane's height, frozen at the unzoomed size (see applyInlineZoom). 0 = not captured
    // yet, which is the normal state right up to the first render.
    zoomBaseHeight: 0,
    zoomStatus,
    drag: null,
  };
  entry.type = diagramLabel(info.source, currentDetectType());

  const onDiagram = () => setView(entry, 'diagram');
  const onCode = () => setView(entry, 'code');
  const onFullscreen = () => openViewer(entry);
  const onDownload = () => downloadEntry(entry);
  // The zoom buttons anchor on the centre of the area currently VISIBLE in the pane, so a
  // click zooms out of the middle of what the user is looking at rather than out of the
  // diagram's top-left corner. A click and the +/- keys therefore produce the same result.
  const paneCentre = () => inlineVisibleCentre(entry);
  const onZoomIn = () => {
    const point = paneCentre();
    if (!zoomInlineAt(entry, ZOOM_STEP, point.x, point.y)) {
      // Already at the maximum: re-apply so the state, the aria-label and the live region
      // still agree, instead of silently doing nothing.
      applyInlineZoom(entry);
    }
  };
  const onZoomOut = () => {
    const point = paneCentre();
    if (!zoomInlineAt(entry, 1 / ZOOM_STEP, point.x, point.y)) {
      applyInlineZoom(entry);
    }
  };
  const onZoomReset = () => resetInlineZoom(entry);
  entry.listeners.push(
    [btnDiagram, 'click', onDiagram],
    [btnCode, 'click', onCode],
    [btnZoomOut, 'click', onZoomOut],
    [btnZoomIn, 'click', onZoomIn],
    [btnZoomReset, 'click', onZoomReset],
    [btnFullscreen, 'click', onFullscreen],
    [btnDownload, 'click', onDownload],
  );
  // Inline pane interactions: Ctrl/Meta + wheel zooms at the pointer, a plain
  // wheel is left to the page, drag pans, and the keyboard drives the same state.
  // The move and release listeners live on the document, not on the pane: a drag
  // that leaves the pane must keep panning, and a release outside the pane must
  // still end the drag instead of leaving the pane stuck in the dragging state.
  const dragDoc = entry.pane.ownerDocument || state.doc;
  entry.listeners.push(
    [pane, 'wheel', (event) => onPaneWheel(entry, event), { passive: false }],
    [pane, 'pointerdown', (event) => onPanePointerDown(entry, event)],
    [dragDoc, 'pointermove', (event) => onPanePointerMove(entry, event)],
    [dragDoc, 'pointerup', (event) => onPanePointerUp(entry, event)],
    [dragDoc, 'pointercancel', (event) => onPanePointerUp(entry, event)],
    [pane, 'keydown', (event) => onPaneKeydown(entry, event)],
  );
  for (const entryItem of entry.listeners) {
    const [element, type, listener, options] = entryItem;
    element.addEventListener(type, listener, options);
  }

  parent.insertBefore(wrapper, pre);
  body.insertBefore(pre, errorEl);
  wrapper.append(bar, body);
  pre.classList.add('dsh-pm-code');
  pre.setAttribute(BLOCK_ATTR, '');
  wrapper.dataset.state = 'loading';

  applyTheme(wrapper, state.win);
  localizeEntry(entry);
  setView(entry, 'diagram');
  setStatus(entry, 'rendering');

  state.entries.set(codeEl, entry);
  state.processed.add(codeEl);
  scheduleRender(entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * Inline pane zoom/pan (SPEC R9 parity, keyboard accessible)
 * ------------------------------------------------------------------ *
 *
 * ONE pan model: the pane is a plain scroll container (overflow:auto) and the SVG gets an
 * explicit layout size (natural * effective scale), so every pan - pointer drag, wheel zoom
 * anchoring, arrow keys - is expressed as a scroll offset that goes through writeScroll().
 * zoom.tx/ty stay 0 on purpose: mixing a translate with a scroll is what used to clip the
 * diagram and make the drag fight the zoom maths.
 */

/**
 * The natural (intrinsic) size of the diagram inside the pane.
 * This is the size the SVG declares, not the size it is displayed at.
 *
 * Pele's RenderResult (remembered in entry.pristine) is authoritative: once the pane is
 * zoomed the on-screen width attribute is the DISPLAYED size, so re-measuring the element
 * would feed the zoomed width back into the maths and compound it. The element attributes
 * and the viewBox are only consulted before the first render result arrives.
 */
function inlineNatural(entry) {
  const pristine = entry.pristine;
  if (pristine && pristine.svg) {
    // The natural size comes from the markup's OWN width/height attributes first (they are
    // the size Pele actually drew), and from the reported result only as a fallback - a
    // runtime may report a different number than it emitted.
    const declared = declaredSize(pristine.svg);
    const width = declared.width > 0 ? declared.width : pristine.width;
    const height = declared.height > 0 ? declared.height : pristine.height;
    if (width > 0 && height > 0) return { width, height };
  }
  const svg = inlineSvg(entry);
  if (!svg) return entry.zoomNatural;
  const size = measureSvg(svg);
  if (size.width > 0 && size.height > 0) return size;
  return entry.zoomNatural && entry.zoomNatural.width > 0 ? entry.zoomNatural : { width: 640, height: 400 };
}

/**
 * The <svg> Pele mounted in the pane.
 *
 * The pane holds a STAGE element that wraps the diagram, and the zoom is applied to the stage
 * rather than to the svg itself (see inlineStage).
 */
function inlineSvg(entry) {
  if (!entry || !entry.pane || !entry.pane.querySelector) return null;
  return entry.pane.querySelector('svg');
}

/**
 * The element the inline zoom is applied to.
 *
 * WHY A WRAPPER: Pele installs a ResizeObserver on the pane and, whenever the pane resizes,
 * rewrites the WHOLE style attribute of the svg it mounted. The zoom used to be written
 * straight onto that svg (`style.width = '584px'`), so the observer - which fires precisely
 * because the zoom changed the pane's content size - wiped the width again. The reported
 * symptom was a zoom that changed `data-zoom` all the way down to 17% while the diagram
 * stayed exactly the same size.
 *
 * The stage is a plain div we own, so its size survives: the observer still fires and Pele
 * still restyles its svg, but the svg is then laid out by the stage through CSS
 * (`.dsh-pm-inline-stage > svg { width:100%; height:100% }`), which Pele's rewrite cannot undo.
 *
 * The class name is deliberately NOT `.dsh-pm-stage`: that one is the fullscreen viewer's
 * stage and is absolutely positioned. Sharing the name put the inline stage out of the
 * document flow, so the diagram floated over the page instead of scrolling inside the pane.
 */
function inlineStage(entry) {
  if (!entry || !entry.pane || !entry.pane.querySelector) return null;
  return entry.pane.querySelector('.dsh-pm-inline-stage');
}

/**
 * The scale that fits the diagram into the pane width.
 *
 * The stylesheet's `max-width:100%` used to do this implicitly; the zoom
 * state now multiplies it, so the unzoomed diagram still looks exactly as it
 * did before.
 */
function inlineFitScale(entry) {
  const natural = inlineNatural(entry);
  const geom = inlineGeometry(entry);
  if (geom.contentW > 0 && natural.width > 0) return Math.min(1, geom.contentW / natural.width);
  return entry.zoomFit > 0 ? entry.zoomFit : 1;
}

/** The effective on-screen scale (fit scale * user zoom). */
function inlineScale(entry) {
  return inlineFitScale(entry) * entry.zoom.scale;
}

/**
 * The pane's geometry: its padding and the size of its content box.
 *
 * The zoom maths works in the CONTENT box's screen coordinates, so the padding matters:
 * the scroll offsets are measured from the content box, while the visible band is the
 * client box (which INCLUDES the padding).
 */
function inlineGeometry(entry) {
  const pane = entry && entry.pane;
  const empty = { padL: 0, padR: 0, padT: 0, padB: 0, clientW: 0, clientH: 0, contentW: 0, contentH: 0 };
  if (!pane) return empty;
  const view = pane.ownerDocument && pane.ownerDocument.defaultView;
  let padL = 0, padR = 0, padT = 0, padB = 0;
  if (view && typeof view.getComputedStyle === 'function') {
    const cs = view.getComputedStyle(pane);
    padL = parseFloat(cs.paddingLeft) || 0;
    padR = parseFloat(cs.paddingRight) || 0;
    padT = parseFloat(cs.paddingTop) || 0;
    padB = parseFloat(cs.paddingBottom) || 0;
  }
  const clientW = pane.clientWidth || 0;
  const clientH = pane.clientHeight || 0;
  return {
    padL, padR, padT, padB, clientW, clientH,
    contentW: Math.max(0, clientW - padL - padR),
    contentH: Math.max(0, clientH - padT - padB),
  };
}

/**
 * The stage's top-left offset inside the pane's content box, on BOTH axes.
 *
 * Horizontal: the stage is centred by `margin: 0 auto`, which for an over-constrained block
 * (one wider than its container) resolves to 0. That is exactly `Math.max(0, (contentW - w) / 2)`,
 * and it is also what keeps a zoomed-in diagram's left edge reachable by scrolling - a real
 * auto margin would push it out of the scrollable area for good.
 *
 * Vertical: `margin: auto` resolves to 0 on the block axis (there is no free space to
 * distribute before the block's over-constrained margin rule kicks in), so the centring is
 * written explicitly by applyInlineZoom as a margin-top in the same
 * `Math.max(0, (contentH - h) / 2)` form. Without it a diagram shrunk below the pane's frozen
 * height would sit against the top edge, off-centre from where it started.
 *
 * This is not a guess about the layout, it IS the layout: the zoom maths has to agree with
 * the box the browser actually produced, or the anchored point drifts on every step. Deriving
 * the vertical origin from `contentW` (a single-axis helper reused for both axes) is what used
 * to tilt the diagram towards the top-left corner on every zoom step.
 */
function inlineStageOrigin(stageWidth, stageHeight, geom) {
  const g = geom || { contentW: 0, contentH: 0 };
  return {
    x: Math.max(0, (g.contentW - (Number(stageWidth) || 0)) / 2),
    y: Math.max(0, (g.contentH - (Number(stageHeight) || 0)) / 2),
  };
}

/**
 * The centre of the area the user can currently SEE, in content-box screen coordinates -
 * the same space inlinePointInPane() returns, which is what zoomInlineAt() anchors in.
 *
 * `clientW / 2 - padL`, and deliberately NOT `scrollLeft + ...`: this is a SCREEN position
 * measured from the content box's left edge, and zoomInlineAt() adds the scroll offset itself
 * when it converts it into a content offset. Adding it here too would count the scroll twice
 * and make every zoom step creep towards the right-hand edge.
 *
 * The padding is subtracted because the client box includes it while the content box - the
 * space the scroll offsets are measured in - does not.
 *
 * The zoom buttons and the +/- keys anchor here, which is what makes a zoom grow out of the
 * middle of what is on screen instead of out of the diagram's origin.
 */
function inlineVisibleCentre(entry) {
  const geom = inlineGeometry(entry);
  return { x: geom.clientW / 2 - geom.padL, y: geom.clientH / 2 - geom.padT };
}

/**
 * A viewport point (clientX/clientY) expressed in the pane's content-box screen coordinates -
 * the same space zoomInlineAt() anchors in.
 *
 * The pane's padding is subtracted because the scroll offsets are measured from the content
 * box while clientX/clientY are measured from the viewport.
 */
function inlinePointInPane(entry, clientX, clientY) {
  const pane = entry && entry.pane;
  const geom = inlineGeometry(entry);
  const centre = inlineVisibleCentre(entry);
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (!pane || typeof pane.getBoundingClientRect !== 'function' || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return centre;
  }
  const rect = pane.getBoundingClientRect();
  if (!rect) return centre;
  return { x: cx - rect.left - geom.padL, y: cy - rect.top - geom.padT };
}

/**
 * Write the current zoom state onto the rendered diagram and the accessibility tree.
 *
 * The effective scale becomes the STAGE's layout size (see inlineStage for why the stage and
 * not the svg), so the pane can scroll to the enlarged content; the pan itself is a scroll
 * offset, never a transform.
 *
 * The stage is ALWAYS sized explicitly - even at 100% - because the stylesheet's
 * `max-width:100%` would otherwise shrink the diagram to the column width without telling
 * the zoom maths about it, and the two would disagree about where the content sits.
 */
function applyInlineZoom(entry) {
  if (!entry || !entry.pane) return;
  const stage = inlineStage(entry);
  const svg = inlineSvg(entry);
  if (!stage || !svg) return;
  const natural = inlineNatural(entry);
  entry.zoomNatural = natural;
  entry.zoomFit = inlineFitScale(entry);
  const zoom = entry.zoom;
  const effective = inlineScale(entry);
  const stageWidth = natural.width * effective;
  const stageHeight = natural.height * effective;
  // The stage carries the SCALED size, and the svg fills it (see the stylesheet). The
  // diagram is therefore always exactly natural * effective pixels wide.
  stage.style.width = round(stageWidth, 2) + 'px';
  stage.style.height = round(stageHeight, 2) + 'px';
  // Vertically centre the stage inside the pane's content box, so a diagram smaller than the
  // pane's frozen height stays in the middle instead of climbing to the top edge. Written as
  // a margin rather than left to `margin: auto`, which resolves to 0 on the block axis; the
  // value is the same one zoomInlineAt() reads back as the vertical origin.
  const origin = inlineStageOrigin(stageWidth, stageHeight, inlineGeometry(entry));
  stage.style.marginTop = round(origin.y, 2) + 'px';
  // The pan is normally a scroll offset. When the pane cannot scroll (not laid out yet, or
  // the diagram is smaller than the pane) the drag falls back to a translate, which is
  // applied here and dropped by the next scroll-capable gesture.
  if (zoom.tx || zoom.ty) {
    stage.style.transform = 'translate(' + round(zoom.tx) + 'px, ' + round(zoom.ty) + 'px)';
    stage.style.transformOrigin = '0 0';
  } else {
    stage.style.transform = '';
    stage.style.transformOrigin = '';
  }
  // A bounded pane makes the enlarged diagram scrollable instead of pushing
  // the rest of the message out of the view.
  if (!entry.pane.style.maxHeight) entry.pane.style.maxHeight = '70vh';
  // Freeze the pane's height at the unzoomed size.
  //
  // WHY: the pane is a scroll container, and the zoom anchoring works by moving its scroll
  // offsets. But a pane whose height is CONTENT-driven grows as the diagram grows, so it
  // never becomes taller than its content and the vertical scroll range stays 0 - there is
  // simply nothing to scroll, and the anchor cannot be held on that axis at all. Zooming in
  // then looked like the diagram was growing out of its top-left corner, which is exactly
  // what "zoom around the visible centre" is supposed to prevent.
  //
  // Pinning the height makes the visible band a FIXED region: the diagram is centred inside
  // it when smaller and scrolls inside it when larger, so "the centre of what is visible"
  // is a stable point on both axes.
  //
  // The height is captured once, on the first pass at 100%, so the pane looks exactly as
  // tall as the diagram did before any zooming. `box-sizing:border-box` (set on .dsh-pm *)
  // in the stylesheet) keeps the padding inside this height, so clientHeight stays stable too.
  if (entry.zoomBaseHeight > 0) {
    entry.pane.style.height = entry.zoomBaseHeight + 'px';
  } else if (zoom.scale === 1 && entry.pane.clientHeight > 0) {
    entry.zoomBaseHeight = entry.pane.clientHeight;
    entry.pane.style.height = entry.zoomBaseHeight + 'px';
  }
  if (entry.pane.dataset) {
    entry.pane.dataset.zoom = String(Math.round(zoom.scale * 100));
    entry.pane.dataset.panX = String(Math.round(readScroll(entry.pane, 'left')));
    entry.pane.dataset.panY = String(Math.round(readScroll(entry.pane, 'top')));
  }
  updateZoomStatus(entry);
}

/** Announce the current zoom through the polite live region (R13). */
function updateZoomStatus(entry) {
  if (!entry || !entry.zoomStatus) return;
  const percent = Math.round(entry.zoom.scale * 100) + '%';
  entry.zoomStatus.textContent = percent;
  entry.zoomStatus.setAttribute('aria-label', tr('zoomStatus', { zoom: percent }));
}

/**
 * Zoom the inline diagram around the pane point (px, py), expressed in the pane's
 * content-box screen coordinates (see inlinePointInPane / inlineVisibleCentre).
 * The content point under that point stays under that point.
 *
 * The scale becomes the STAGE's layout size, so the pan is the pane's scroll offset and the
 * anchored point is held by writing a new offset:
 *
 *   u           = (scrollLeft + px - originBefore) / effectiveBefore   // natural units
 *   scrollLeft' =  originAfter + u * effectiveAfter - px
 *
 * `origin` is the stage's centring offset inside the content box, and it CHANGES with the
 * scale (a diagram narrower than the column is centred, a wider one is left aligned). Using
 * one origin for both sides - which is what mixing `fit` and the user scale did - made the
 * diagram creep towards the top-left on every step.
 *
 * The offsets go through writeScroll, so they are clamped to what the pane can actually
 * scroll to: a pointer near the origin can never ask for a negative scroll, and a browser
 * would clamp that to 0 anyway and silently break the anchor.
 *
 * Returns false when the scale is already at the limit the factor asks for.
 */
function zoomInlineAt(entry, factor, px, py) {
  if (!entry || !entry.zoom || !entry.pane) return false;
  const zoom = entry.zoom;
  const ratio = Number(factor);
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  const previous = zoom.scale;
  const next = clamp(previous * ratio, MIN_SCALE, MAX_SCALE);
  if (next === previous) return false;

  const geom = inlineGeometry(entry);
  const natural = inlineNatural(entry);
  const fit = inlineFitScale(entry);
  const x = Number.isFinite(px) ? px : geom.clientW / 2;
  const y = Number.isFinite(py) ? py : geom.clientH / 2;

  // The anchored point is held by the scroll offsets, so any translate left over from a drag
  // on an unscrollable pane is retired here: keeping both would double-count the pan.
  const offsetX = zoom.tx;
  const offsetY = zoom.ty;
  zoom.tx = 0;
  zoom.ty = 0;
  const scrollLeft = Math.max(0, readScroll(entry.pane, 'left') - offsetX);
  const scrollTop = Math.max(0, readScroll(entry.pane, 'top') - offsetY);

  const originBefore = inlineStageOrigin(natural.width * fit * previous, natural.height * fit * previous, geom);
  const originAfter = inlineStageOrigin(natural.width * fit * next, natural.height * fit * next, geom);

  // The natural (unscaled) content coordinate under the anchor, which must not move.
  const contentX = (scrollLeft + x - originBefore.x) / (fit * previous);
  const contentY = (scrollTop + y - originBefore.y) / (fit * previous);

  zoom.setScale(next);
  applyInlineZoom(entry);

  writeScroll(entry.pane, 'left', originAfter.x + contentX * fit * next - x);
  writeScroll(entry.pane, 'top', originAfter.y + contentY * fit * next - y);
  if (entry.pane.dataset) {
    entry.pane.dataset.panX = String(Math.round(readScroll(entry.pane, 'left')));
    entry.pane.dataset.panY = String(Math.round(readScroll(entry.pane, 'top')));
  }
  return true;
}

/** Pan the inline diagram by (dx, dy) pointer pixels, as a scroll. */
function panInline(entry, dx, dy) {
  if (!entry || !entry.zoom || !entry.pane) return;
  // Retire a translate left over from an unscrollable drag, so the two never compound.
  if (entry.zoom.tx || entry.zoom.ty) {
    entry.zoom.tx = 0;
    entry.zoom.ty = 0;
    applyInlineZoom(entry);
  }
  writeScroll(entry.pane, 'left', readScroll(entry.pane, 'left') - dx);
  writeScroll(entry.pane, 'top', readScroll(entry.pane, 'top') - dy);
  if (entry.pane.dataset) {
    entry.pane.dataset.panX = String(Math.round(readScroll(entry.pane, 'left')));
    entry.pane.dataset.panY = String(Math.round(readScroll(entry.pane, 'top')));
  }
}

/** Reset the inline zoom/pan to the natural size. */
function resetInlineZoom(entry) {
  if (!entry || !entry.zoom) return;
  entry.zoom.reset();
  if (entry.pane) {
    writeScroll(entry.pane, 'left', 0);
    writeScroll(entry.pane, 'top', 0);
  }
  applyInlineZoom(entry);
}

/** Ctrl/Meta + wheel zooms at the pointer; a plain wheel is left alone. */
function onPaneWheel(entry, event) {
  if (!event) return;
  if (!event.ctrlKey && !event.metaKey) return; // the page must keep scrolling
  if (typeof event.preventDefault === 'function') event.preventDefault();
  // The pointer anchor lives in the pane's content-box space, padding included (see
  // inlinePointInPane). Deriving it from the raw clientX/clientY would offset the zoom by
  // the pane's padding, which is exactly the drift the anchoring maths exists to prevent.
  const point = inlinePointInPane(entry, event.clientX, event.clientY);
  const delta = typeof event.deltaY === 'number' ? event.deltaY : 0;
  let factor = Math.exp(-delta * 0.0015);
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) factor = ZOOM_STEP;
  zoomInlineAt(entry, factor, point.x, point.y);
}

function onPanePointerDown(entry, event) {
  if (!event) return;
  if (event.button != null && event.button !== 0) return;
  if (event.pointerType === 'touch') return; // touch keeps the native scrolling
  entry.drag = {
    x: Number(event.clientX) || 0,
    y: Number(event.clientY) || 0,
    scrollLeft: readScroll(entry.pane, 'left'),
    scrollTop: readScroll(entry.pane, 'top'),
    // Kept for the unscrollable fallback (see onPanePointerMove).
    tx: entry.zoom.tx,
    ty: entry.zoom.ty,
  };
  if (entry.pane.setAttribute) entry.pane.setAttribute('data-dragging', 'true');
  // Capture the pointer so the browser keeps delivering move and release events
  // even when the cursor leaves the pane.
  if (event.pointerId != null && entry.pane.setPointerCapture) {
    try { entry.pane.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
  }
  if (typeof entry.pane.focus === 'function') {
    try { entry.pane.focus(); } catch (error) { /* focus is best-effort */ }
  }
  if (typeof event.preventDefault === 'function') event.preventDefault();
}

function onPanePointerMove(entry, event) {
  const drag = entry.drag;
  if (!drag || !event) return;
  const dx = (Number(event.clientX) || 0) - drag.x;
  const dy = (Number(event.clientY) || 0) - drag.y;
  const pane = entry.pane;
  // ONE model: the pan is a scroll. Dragging right moves the content right (the scroll
  // offset decreases), so the diagram follows the pointer and never leaves a gap at the
  // origin. When the pane cannot scroll at all - not laid out yet, or the diagram is
  // smaller than the pane - there is nothing to scroll, and a scroll-only drag would be a
  // silent no-op. In that case the drag becomes a translate, so the gesture ALWAYS moves
  // the diagram; the translate is dropped as soon as the pane can scroll again.
  const scrollable = pane && (pane.scrollWidth > (pane.clientWidth || 0) || pane.scrollHeight > (pane.clientHeight || 0));
  if (scrollable) {
    writeScroll(pane, 'left', drag.scrollLeft - dx);
    writeScroll(pane, 'top', drag.scrollTop - dy);
    if (entry.zoom.tx || entry.zoom.ty) {
      entry.zoom.tx = 0;
      entry.zoom.ty = 0;
    }
  } else {
    entry.zoom.tx = drag.tx + dx;
    entry.zoom.ty = drag.ty + dy;
    applyInlineZoom(entry);
  }
  if (pane && pane.dataset) {
    pane.dataset.panX = String(Math.round(scrollable ? readScroll(pane, 'left') : entry.zoom.tx));
    pane.dataset.panY = String(Math.round(scrollable ? readScroll(pane, 'top') : entry.zoom.ty));
  }
  if (typeof event.preventDefault === 'function') event.preventDefault();
}

function onPanePointerUp(entry) {
  if (!entry.drag) return;
  entry.drag = null;
  if (entry.pane && entry.pane.removeAttribute) entry.pane.removeAttribute('data-dragging');
}

function onPaneKeydown(entry, event) {
  if (!event) return;
  const key = event.key;
  const stop = () => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  };
  // The +/- keys anchor on the centre of the visible area, exactly like the toolbar buttons
  // (see inlineVisibleCentre).
  if (key === '+' || key === '=') {
    stop();
    const point = inlineVisibleCentre(entry);
    zoomInlineAt(entry, ZOOM_STEP, point.x, point.y);
    return;
  }
  if (key === '-' || key === '_') {
    stop();
    const point = inlineVisibleCentre(entry);
    zoomInlineAt(entry, 1 / ZOOM_STEP, point.x, point.y);
    return;
  }
  if (key === '0') {
    stop();
    resetInlineZoom(entry);
    return;
  }
  const step = event.shiftKey ? 60 : 20;
  if (key === 'ArrowLeft') { stop(); panInline(entry, -step, 0); }
  else if (key === 'ArrowRight') { stop(); panInline(entry, step, 0); }
  else if (key === 'ArrowUp') { stop(); panInline(entry, 0, -step); }
  else if (key === 'ArrowDown') { stop(); panInline(entry, 0, step); }
}

/* ------------------------------------------------------------------ *
 * Rendering (SPEC R4/R6/R7/R8)
 * ------------------------------------------------------------------ */

function isLive(entry) {
  return !!entry && state.active && !entry.disposed && isConnected(entry.wrapper) &&
    isConnected(entry.code) && !!entry.wrapper.contains(entry.code);
}

function destroyMounted(entry) {
  const mounted = entry.mounted;
  entry.mounted = null;
  if (mounted && typeof mounted.destroy === 'function') {
    try {
      mounted.destroy();
    } catch {
      /* ignore */
    }
  }
}

function detailOf(error) {
  if (error == null) return '';
  if (error.message) return String(error.message);
  return String(error);
}

function formatRenderFailure(error) {
  const detail = detailOf(error);
  const line = Number(error && error.line);
  const column = Number(error && error.column);
  if (Number.isFinite(line) && line > 0) {
    return tr('renderFailedAt', {
      detail,
      line,
      column: Number.isFinite(column) && column > 0 ? column : 1,
    });
  }
  return tr('renderFailed', { detail });
}

function finalizeRendered(entry, result, generation) {
  if (!isLive(entry) || generation !== entry.generation) return;
  entry.lastRendered = entry.source;
  // Remember the PRISTINE render result (SPEC R10): result.svg is the markup Pele produced,
  // before any of our inline zoom styles were applied to the mounted element. The export and
  // the viewer both need it, and it is keyed by generation so a stale render cannot leak in.
  // Pele emits NO viewBox, so its width/height are the only source of the true natural size.
  entry.pristine = {
    generation: entry.generation,
    svg: typeof (result && result.svg) === 'string' ? result.svg : '',
    width: Number(result && result.width) > 0 ? Number(result.width) : 0,
    height: Number(result && result.height) > 0 ? Number(result.height) : 0,
  };
  // A fresh render replaces the diagram, so the per-block zoom/pan state starts
  // over (the previous transform belonged to the old SVG). The stage is (re)built first:
  // resetInlineZoom measures and sizes it, so it has to exist before the reset.
  // The frozen pane height belongs to the OLD diagram too, so it is released here and
  // re-captured from the new one (a different diagram may be a different size).
  entry.zoomBaseHeight = 0;
  if (entry.pane.style) entry.pane.style.height = '';
  ensureInlineStage(entry);
  resetInlineZoom(entry);
  entry.wrapper.dataset.state = 'ready';
  entry.pane.dataset.state = 'ready';
  entry.messageKey = null;
  entry.messageParams = null;
  entry.errorEl.textContent = '';
  const svg = entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (svg && !svg.getAttribute('aria-label') && !svg.getAttribute('aria-labelledby')) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', tr('diagramTitle', { type: entry.type || 'mermaid' }));
  }
  setStatus(entry, 'rendered');
}

/**
 * Wrap the freshly mounted diagram in the stage the inline zoom is applied to.
 *
 * Pele installs a ResizeObserver on the pane and rewrites the whole style attribute of the
 * svg it mounted whenever the pane resizes, so a zoom written onto that svg is wiped the
 * moment it changes the pane's size. The stage is ours, so sizing it survives (see
 * inlineStage). Wrapping happens after every render because renderEntry clears the pane.
 */
function ensureInlineStage(entry) {
  const pane = entry && entry.pane;
  if (!pane || !pane.querySelector) return null;
  const svg = pane.querySelector('svg');
  if (!svg) return null;
  let stage = pane.querySelector('.dsh-pm-inline-stage');
  if (stage && stage.contains(svg)) return stage;
  const doc = svg.ownerDocument || state.doc;
  if (!doc) return null;
  stage = doc.createElement('div');
  stage.className = 'dsh-pm-inline-stage';
  // insertBefore(svg) keeps the diagram in the same document position it already had, so
  // re-wrapping an already-wrapped stage cannot duplicate or drop it.
  pane.insertBefore(stage, svg);
  stage.appendChild(svg);
  return stage;
}

function showRenderError(entry, error, generation) {
  if (!isLive(entry)) return;
  if (generation != null && generation !== entry.generation) return;
  destroyMounted(entry);
  const message = formatRenderFailure(error);
  entry.wrapper.dataset.state = 'error';
  entry.pane.dataset.state = 'error';
  if (entry.pane.replaceChildren) entry.pane.replaceChildren();
  entry.pane.textContent = message;
  entry.errorEl.textContent = message;
  entry.messageKey = 'renderFailed';
  entry.messageParams = { detail: detailOf(error) };
  entry.lastRendered = '';
  setStatus(entry, 'renderFailedStatus');
  setView(entry, 'code');
}

function showRuntimeError(entry, error, generation) {
  if (!isLive(entry) || generation !== entry.generation) return;
  destroyMounted(entry);
  const detail = detailOf(error) || 'unknown';
  const message = tr('runtimeFailed', { detail });
  entry.wrapper.dataset.state = 'error';
  entry.pane.dataset.state = 'error';
  entry.pane.textContent = message;
  entry.errorEl.textContent = message;
  entry.messageKey = 'runtimeFailed';
  entry.messageParams = { detail };
  entry.lastRendered = '';
  setStatus(entry, 'runtimeFailedStatus');
  setView(entry, 'code');
}

function showLimitNotice(entry, verdict) {
  const key = verdict.reason === 'lines' ? 'tooManyLines' : 'tooLong';
  const params = { actual: verdict.actual, limit: verdict.limit };
  const message = tr(key, params);
  destroyMounted(entry);
  entry.wrapper.dataset.state = 'error';
  entry.pane.dataset.state = 'error';
  if (entry.pane.replaceChildren) entry.pane.replaceChildren();
  entry.pane.textContent = message;
  entry.errorEl.textContent = message;
  entry.messageKey = key;
  entry.messageParams = params;
  entry.lastRendered = '';
  setStatus(entry, 'limitStatus');
  setView(entry, 'code');
}

async function renderEntry(entry) {
  if (!isLive(entry)) return;
  const generation = ++entry.generation;
  const source = codeSource(entry.code).trim();
  if (!source) return;
  const runtime = getPeleRuntime();
  if (runtime && entry.lastRendered === source && entry.wrapper.dataset.state === 'ready') {
    return;
  }
  entry.source = source;
  entry.type = diagramLabel(source, currentDetectType());

  entry.wrapper.dataset.state = 'loading';
  entry.pane.dataset.state = 'loading';
  setStatus(entry, 'rendering');

  const limits = checkLimits(source);
  if (!limits.ok) {
    showLimitNotice(entry, limits);
    return;
  }

  const pele = runtime || (await ensureRuntime());
  if (!isLive(entry) || generation !== entry.generation) return;
  if (codeSource(entry.code).trim() !== source) {
    scheduleRender(entry);
    return;
  }
  if (!pele || typeof pele.mount !== 'function') {
    showRuntimeError(entry, state.lastRuntimeError, generation);
    return;
  }

  applyTheme(entry.wrapper, state.win);
  destroyMounted(entry);
  if (entry.pane.replaceChildren) entry.pane.replaceChildren();
  else entry.pane.textContent = '';
  entry.pane.textContent = tr('rendering');

  let handle = null;
  try {
    handle = pele.mount(entry.pane, source, buildMountOptions(entry, generation));
  } catch (error) {
    showRenderError(entry, error, generation);
    return;
  }
  if (!isLive(entry) || generation !== entry.generation) {
    if (handle && typeof handle.destroy === 'function') {
      try {
        handle.destroy();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  entry.mounted = handle || null;
  const failure = (handle && handle.error) || null;
  if (failure) {
    showRenderError(entry, failure, generation);
    return;
  }
  const svg = entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (svg) finalizeRendered(entry, handle && handle.result, generation);
}

function enqueue(entry) {
  if (!entry || entry.disposed || entry.queued) return;
  entry.queued = true;
  state.queue.push(entry);
  drain();
}

function scheduleRender(entry, delay) {
  if (!entry || entry.disposed) return;
  if (entry.renderTimer != null) clearTimeout(entry.renderTimer);
  entry.renderTimer = setTimeout(() => {
    entry.renderTimer = null;
    enqueue(entry);
  }, delay == null ? RENDER_DEBOUNCE_MS : delay);
}

/** SPEC R8 — serial queue; one diagram at a time with a yield in between. */
function drain() {
  if (state.draining) return state.drainPromise || Promise.resolve();
  state.draining = true;
  const promise = (async () => {
    try {
      while (state.queue.length) {
        const entry = state.queue.shift();
        entry.queued = false;
        if (!isLive(entry)) continue;
        await renderEntry(entry);
        await yieldControl();
      }
    } finally {
      state.draining = false;
      state.drainPromise = null;
    }
  })();
  state.drainPromise = promise;
  return promise;
}

/* ------------------------------------------------------------------ *
 * Candidate scheduling + mutation handling (SPEC R8, coalesced)
 * ------------------------------------------------------------------ */

function queueCandidate(codeEl) {
  if (codeEl) state.pending.add(codeEl);
}

async function reviewCandidate(codeEl) {
  const info = candidateInfo(codeEl);
  if (!info) return;
  if (info.needsRuntime) {
    const runtime = await ensureRuntime();
    if (!runtime || !isConnected(codeEl)) return;
    const again = candidateInfo(codeEl);
    if (!again || again.needsRuntime) return;
    enhanceInfo(again);
    return;
  }
  enhanceInfo(info);
}

function runFlush() {
  if (state.flushing) return state.flushPromise || Promise.resolve();
  state.flushing = true;
  const promise = (async () => {
    try {
      while (state.pending.size) {
        const batch = Array.from(state.pending);
        state.pending.clear();
        for (const codeEl of batch) {
          if (!isConnected(codeEl)) continue;
          await reviewCandidate(codeEl);
        }
      }
    } finally {
      state.flushing = false;
      state.flushPromise = null;
    }
  })();
  state.flushPromise = promise;
  return promise;
}

function scheduleFlush() {
  if (state.flushTimer != null) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    runFlush();
  }, FLUSH_DELAY_MS);
}

function flushNow() {
  if (state.flushTimer != null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  return runFlush();
}

function collectFrom(node) {
  if (!node || node.nodeType !== 1) return;
  if (tagOf(node) === 'CODE') queueCandidate(node);
  if (node.querySelectorAll) {
    let found = [];
    try {
      found = node.querySelectorAll('pre > code');
    } catch {
      found = [];
    }
    for (const codeEl of found) queueCandidate(codeEl);
  }
}

function gc() {
  for (const entry of Array.from(state.entries.values())) {
    if (!isConnected(entry.code) || !isConnected(entry.wrapper) || !entry.wrapper.contains(entry.code)) {
      // A detached wrapper means DSH removed the block (message re-render,
      // virtualization). Restoring the pre here would resurrect a node the app
      // just discarded and re-enhance it, producing a duplicate block.
      disposeEntry(entry, false);
    }
  }
}

/** Re-render (or queue) the block whose <code> element changed. */
function noteCodeTarget(parent) {
  if (!parent) return false;
  const codeEl = tagOf(parent) === 'CODE'
    ? parent
    : (parent.closest ? parent.closest('code') : null);
  if (!codeEl) return false;
  const entry = state.entries.get(codeEl);
  if (entry) {
    scheduleRender(entry);
    return true;
  }
  if (tagOf(codeEl) === 'CODE' && codeEl.parentElement) queueCandidate(codeEl);
  return true;
}

function onMutations(records) {
  let queued = false;
  let removed = false;
  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of Array.from(record.addedNodes || [])) {
        if (!node) continue;
        if (node.nodeType === 1) {
          collectFrom(node);
          queued = true;
        } else if (node.nodeType === 3) {
          if (noteCodeTarget(node.parentElement)) queued = true;
        }
      }
      if (record.removedNodes && record.removedNodes.length) removed = true;
    } else if (record.type === 'characterData') {
      if (noteCodeTarget(record.target && record.target.parentElement)) queued = true;
    }
  }
  if (removed) gc();
  if (queued) scheduleFlush();
}

function onThemeChange() {
  for (const entry of state.entries.values()) {
    applyTheme(entry.wrapper, state.win);
    entry.lastRendered = '';
    scheduleRender(entry, 0);
  }
}

function onLangChange() {
  const next = detectLang(state.doc);
  if (next === state.lang) return;
  state.lang = next;
  for (const entry of state.entries.values()) localizeEntry(entry);
  // An open viewer must re-label itself (R11); syncLabels is a no-op when the
  // language is unchanged and cheap when it is.
  if (state.viewer && typeof state.viewer.syncLabels === 'function') {
    try {
      state.viewer.syncLabels();
    } catch {
      /* viewer is best-effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Actions: viewer (R9) + SVG export (R10)
 * ------------------------------------------------------------------ */

function ensureViewer() {
  if (state.viewer) return state.viewer;
  state.viewer = createViewer({
    doc: state.doc,
    win: state.win,
    // Resolve the language at call time so an already-open viewer follows a
    // live document language switch (R11) instead of the switch-time language.
    t: (key, params) => t(state.lang, key, params),
    getLang: () => state.lang,
  });
  return state.viewer;
}

function openViewer(entry) {
  if (!isLive(entry)) return;
  const svg = entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (!svg) return;
  // Remember where the inline pane was, so closing the overlay can restore it.
  entry.inlineRestore = {
    scrollLeft: readScroll(entry.pane, 'left'),
    scrollTop: readScroll(entry.pane, 'top'),
    zoom: entry.zoom ? entry.zoom.snapshot() : null,
  };
  // The overlay continues from the EFFECTIVE on-screen scale of the inline
  // diagram (the fit scale times the user zoom), so the transition is seamless
  // even when the diagram is wider than the column.
  const effective = inlineScale(entry);
  try {
    ensureViewer().open({
      // The pristine markup, so the overlay shows the WHOLE diagram at its natural size.
      svg: pristineMarkup(entry).markup || svg.outerHTML,
      source: entry.source,
      type: entry.type || 'mermaid',
      trigger: entry.btnFullscreen,
      // The overlay continues from the inline zoom instead of resetting to
      // "fit to window", so the transition is seamless.
      zoom: { scale: effective, tx: 0, ty: 0 },
      onClose: () => restoreInlineAfterViewer(entry),
    });
  } catch {
    /* viewer failures must never break the diagram chrome */
  }
}

/**
 * Restore the inline pane after the fullscreen overlay closes: the previous
 * scroll offset and zoom come back, the diagram stays visible, and the trigger
 * keeps the focus (the viewer restores it - see src/viewer.js).
 */
function restoreInlineAfterViewer(entry) {
  if (!entry || entry.disposed) return;
  const saved = entry.inlineRestore;
  if (!saved) return;
  if (saved.zoom && entry.zoom) entry.zoom.restore(saved.zoom);
  if (entry.pane) {
    applyInlineZoom(entry);
    if (entry.pane.scrollLeft !== undefined) entry.pane.scrollLeft = saved.scrollLeft;
    if (entry.pane.scrollTop !== undefined) entry.pane.scrollTop = saved.scrollTop;
    if (typeof entry.pane.scrollIntoView === 'function') {
      try {
        entry.pane.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        /* scrolling into view is best-effort */
      }
    }
  }
}

/** The width/height attributes an SVG string declares on its root, in px (0 when absent). */
function declaredSize(markup) {
  const match = /<svg\b[^>]*>/i.exec(String(markup || ''));
  if (!match) return { width: 0, height: 0 };
  const tag = match[0];
  const width = /\swidth\s*=\s*["']([\d.]+)["']/i.exec(tag);
  const height = /\sheight\s*=\s*["']([\d.]+)["']/i.exec(tag);
  return {
    width: width ? Number(width[1]) : 0,
    height: height ? Number(height[1]) : 0,
  };
}

/**
 * The pristine markup to export.
 *
 * The mounted <svg> carries the inline zoom styles written by applyInlineZoom() (an explicit
 * width/height and max-width:none), so serialising the on-screen element exported the CROPPED,
 * ZOOMED rendering: the file showed whatever happened to be inside the pane, and it changed
 * every time the user zoomed or panned. Pele's RenderResult.svg is the untouched markup, which
 * is what R10 asks for. The DOM element is only a fallback for runtimes that do not report a
 * result, and even then the zoom styles are stripped and the natural size restored.
 */
function pristineMarkup(entry) {
  const pristine = entry.pristine;
  if (pristine && pristine.svg) {
    // The natural size comes from the markup's OWN width/height attributes first (they are the
    // size Pele actually drew), and from the reported result only as a fallback - a runtime
    // may report a different number than it emitted.
    const declared = declaredSize(pristine.svg);
    return {
      markup: pristine.svg,
      width: declared.width > 0 ? declared.width : pristine.width,
      height: declared.height > 0 ? declared.height : pristine.height,
    };
  }
  const svg = entry.pane && entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (!svg) return { markup: '', width: 0, height: 0 };
  const clone = svg.cloneNode(true);
  const style = clone.style;
  if (style) {
    for (const name of ['width', 'height', 'max-width', 'min-width', 'min-height', 'transform', 'transform-origin', 'margin', 'position']) {
      try { style.removeProperty(name); } catch { /* ignore unusable style objects */ }
    }
  }
  // Restore the natural size from the remembered render result.
  const natural = entry.zoomNatural || {};
  if (natural.width > 0 && !clone.getAttribute('width')) {
    try { clone.setAttribute('width', String(natural.width)); } catch { /* ignore */ }
  }
  if (natural.height > 0 && !clone.getAttribute('height')) {
    try { clone.setAttribute('height', String(natural.height)); } catch { /* ignore */ }
  }
  return { markup: clone.outerHTML, width: natural.width || 0, height: natural.height || 0 };
}

/**
 * Write the resolved --pele-* variables onto the ROOT element of an SVG string.
 *
 * They are what makes the export look the same outside DSH (R10). They are injected as a
 * `style` attribute on the root, which is why this must run on the PRISTINE markup: the
 * on-screen element's style attribute is owned by the zoom code.
 */
function withThemeVariables(markup, variables) {
  const names = Object.keys(variables || {}).filter((name) => name.indexOf('--pele-') === 0 && variables[name]);
  if (!names.length || typeof markup !== 'string' || !markup) return markup;
  const declarations = names.map((name) => name + ':' + variables[name]).join(';');
  const match = /<svg\b[^>]*>/i.exec(markup);
  if (!match) return markup;
  const tag = match[0];
  const styled = /\sstyle\s*=\s*"([^"]*)"/i.exec(tag);
  let next;
  if (styled) {
    const merged = String(styled[1]).replace(/;\s*$/, '');
    next = tag.replace(styled[0], ' style="' + (merged ? merged + ';' : '') + declarations + '"');
  } else {
    next = tag.replace(/>$/, ' style="' + declarations + '">');
  }
  return markup.replace(match[0], next);
}

function downloadEntry(entry) {
  if (!isLive(entry)) return;
  const variables = themeVariables(state.win);
  const source = pristineMarkup(entry);
  if (!source.markup) return;
  // R10: the exported root must carry the resolved theme variables, so the file looks the
  // same outside DSH. They are injected onto the pristine root, which never had any zoom
  // style on it, so the export stays byte-identical whether or not the user zoomed.
  const themed = withThemeVariables(source.markup, variables);
  const markup = ensureStandaloneSvg(themed, {
    background: variables['--pele-bg'],
    width: source.width,
    height: source.height,
  });
  downloadSvg(markup, svgFileName(entry.type || 'mermaid', new Date()), state.doc);
  setStatus(entry, 'downloaded');
}

/* ------------------------------------------------------------------ *
 * Lifecycle: enhance / dispose / start / teardown (R12)
 * ------------------------------------------------------------------ */

function disposeEntry(entry, restore = true) {
  if (!entry || entry.disposed) return;
  entry.disposed = true;
  entry.generation += 1;
  if (entry.renderTimer != null) {
    clearTimeout(entry.renderTimer);
    entry.renderTimer = null;
  }
  entry.queued = false;
  destroyMounted(entry);
  for (const [element, type, listener, options] of entry.listeners) {
    try {
      element.removeEventListener(type, listener, options);
    } catch {
      /* ignore */
    }
  }
  entry.listeners = [];
  state.entries.delete(entry.code);

  const pre = entry.pre;
  const wrapper = entry.wrapper;
  try {
    pre.classList.remove('dsh-pm-code');
    pre.removeAttribute(BLOCK_ATTR);
    pre.removeAttribute('aria-label');
  } catch {
    /* ignore */
  }
  // The pre lives inside the wrapper's .dsh-pm-body, so a strict parentNode ===
  // wrapper test never fires and the pre would be destroyed with the wrapper (R12).
  if (restore && pre.parentNode && (pre.parentNode === wrapper || (typeof wrapper.contains === 'function' && wrapper.contains(pre)))) {
    const origin = entry.origin || {};
    if (origin.parent) {
      let reference = origin.nextSibling;
      if (reference && reference.parentNode !== origin.parent) reference = null;
      try {
        origin.parent.insertBefore(pre, reference || null);
      } catch {
        try {
          origin.parent.appendChild(pre);
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (wrapper.parentNode) {
    try {
      wrapper.parentNode.removeChild(wrapper);
    } catch {
      /* ignore */
    }
  }
}

function removeStyles() {
  const doc = state.doc;
  if (!doc || !doc.head || !doc.head.querySelector) return;
  const element = doc.head.querySelector('style[' + STYLE_ATTR + ']');
  if (element && element.parentNode) element.parentNode.removeChild(element);
}

function teardown() {
  state.active = false;
  if (state.flushTimer != null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.observer) {
    try {
      state.observer.disconnect();
    } catch {
      /* ignore */
    }
    state.observer = null;
  }
  if (state.themeObserver) {
    try {
      state.themeObserver.disconnect();
    } catch {
      /* ignore */
    }
    state.themeObserver = null;
  }
  if (state.langObserver) {
    try {
      state.langObserver.disconnect();
    } catch {
      /* ignore */
    }
    state.langObserver = null;
  }
  state.pending.clear();
  state.queue.length = 0;
  state.draining = false;
  state.drainPromise = null;
  state.flushing = false;
  state.flushPromise = null;
  for (const entry of Array.from(state.entries.values())) disposeEntry(entry);
  state.entries.clear();
  state.processed = new WeakSet();
  if (state.viewer) {
    try {
      state.viewer.destroy();
    } catch {
      /* ignore */
    }
    state.viewer = null;
  }
  removeStyles();
  state.currentTeardown = null;
  state.doc = null;
  state.win = null;
}

function createObserver(kind) {
  const Owner = (state.win && state.win.MutationObserver) ||
    (typeof MutationObserver === 'undefined' ? null : MutationObserver);
  if (!Owner) return null;
  return new Owner(kind);
}

function scanExisting() {
  const doc = state.doc;
  if (!doc || !doc.body || !doc.body.querySelectorAll) return;
  let nodes = [];
  try {
    nodes = doc.body.querySelectorAll('pre > code');
  } catch {
    nodes = [];
  }
  for (const codeEl of nodes) queueCandidate(codeEl);
  scheduleFlush();
}

function start() {
  if (state.active) return state.currentTeardown || noop;
  const doc = resolveDoc();
  if (!doc || !doc.body) return noop;
  state.doc = doc;
  state.win = resolveWin() || (doc.defaultView || null);
  state.lang = detectLang(doc);
  state.active = true;
  installStyles(doc);

  const observer = createObserver(onMutations);
  if (observer) {
    try {
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    } catch {
      /* observer unsupported */
    }
  }
  state.observer = observer;

  const themeObserver = createObserver((records) => {
    for (const record of records) {
      if (record.attributeName === 'data-ds-dark-theme') {
        onThemeChange();
        return;
      }
    }
  });
  if (themeObserver) {
    try {
      themeObserver.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    } catch {
      /* ignore */
    }
  }
  state.themeObserver = themeObserver;

  const langObserver = createObserver((records) => {
    for (const record of records) {
      if (record.attributeName === 'lang') {
        onLangChange();
        return;
      }
    }
  });
  if (langObserver && doc.documentElement) {
    try {
      langObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
    } catch {
      /* ignore */
    }
  }
  state.langObserver = langObserver;

  state.currentTeardown = teardown;
  scanExisting();
  return teardown;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Enhance one block (tests + manual use). Returns the entry or null. */
function enhance(target) {
  if (!state.active) start();
  const codeEl = resolveCode(target);
  if (!codeEl) return null;
  const existing = state.entries.get(codeEl);
  if (existing) return existing;
  const info = candidateInfo(codeEl);
  if (!info) return null;
  if (info.needsRuntime) {
    ensureRuntime().then((runtime) => {
      if (runtime) reviewCandidate(codeEl);
    });
    return null;
  }
  return enhanceInfo(info);
}

function reset() {
  teardown();
}

/** Cordis client plugin entry point (SPEC §4/R12). */
export function apply(ctx) {
  if (!ctx || typeof ctx.effect !== 'function') {
    return start();
  }
  return ctx.effect(() => {
    const dispose = start();
    return () => {
      dispose();
    };
  });
}

/** Test-only surface (SPEC §4). */
export const __internals = {
  enhance,
  reset,
  state,
  constants: Object.freeze({
    CONTAINER_ATTR,
    BLOCK_ATTR,
    FOREIGN_SELECTOR,
    RENDER_DEBOUNCE_MS,
    FLUSH_DELAY_MS,
    SETTINGS,
  }),
  flush: () => flushNow(),
  whenIdle: async () => {
    await flushNow();
    if (state.drainPromise) await state.drainPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
  },
  renderNow: (target) => {
    const codeEl = resolveCode(target);
    const entry = (codeEl && state.entries.get(codeEl)) || (state.entries.has(target) ? state.entries.get(target) : null);
    if (!entry) return false;
    if (entry.renderTimer != null) {
      clearTimeout(entry.renderTimer);
      entry.renderTimer = null;
    }
    enqueue(entry);
    return true;
  },
  dispose: (target) => {
    const codeEl = resolveCode(target);
    const entry = codeEl ? state.entries.get(codeEl) : null;
    if (!entry) return false;
    disposeEntry(entry);
    return true;
  },
};
