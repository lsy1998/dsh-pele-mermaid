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

function makeButton(doc, className, pressed) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = className;
  if (pressed != null) button.setAttribute('aria-pressed', pressed);
  return button;
}

function localizeEntry(entry) {
  const lang = state.lang;
  const type = entry.type || 'mermaid';
  entry.bar.setAttribute('aria-label', t(lang, 'viewOptions'));
  entry.badge.textContent = t(lang, 'badge', { type });
  entry.btnDiagram.textContent = t(lang, 'diagramView');
  entry.btnDiagram.setAttribute('aria-label', t(lang, 'diagramView'));
  entry.btnCode.textContent = t(lang, 'codeView');
  entry.btnCode.setAttribute('aria-label', t(lang, 'codeView'));
  entry.btnFullscreen.textContent = t(lang, 'fullscreen');
  entry.btnFullscreen.setAttribute('aria-label', t(lang, 'fullscreen'));
  entry.btnDownload.textContent = t(lang, 'downloadSvg');
  entry.btnDownload.setAttribute('aria-label', t(lang, 'downloadSvg'));
  entry.pre.setAttribute('aria-label', t(lang, 'sourceLabel'));
  entry.statusEl.setAttribute('aria-label', t(lang, 'statusLabel'));
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

  const btnDiagram = makeButton(doc, 'dsh-pm-btn dsh-pm-view-control', 'true');
  const btnCode = makeButton(doc, 'dsh-pm-btn dsh-pm-view-control', 'false');

  const actions = doc.createElement('div');
  actions.className = 'dsh-pm-actions';
  const btnFullscreen = makeButton(doc, 'dsh-pm-btn dsh-pm-action', null);
  const btnDownload = makeButton(doc, 'dsh-pm-btn dsh-pm-action', null);
  actions.append(btnFullscreen, btnDownload);

  bar.append(badge, btnDiagram, btnCode, actions);

  const body = doc.createElement('div');
  body.className = 'dsh-pm-body';
  const pane = doc.createElement('div');
  pane.className = 'dsh-pm-pane';
  pane.dataset.state = 'loading';
  const errorEl = doc.createElement('div');
  errorEl.className = 'dsh-pm-error';
  const statusEl = doc.createElement('div');
  statusEl.className = 'dsh-pm-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('aria-atomic', 'true');
  body.append(pane, errorEl, statusEl);

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
  };
  entry.type = diagramLabel(info.source, currentDetectType());

  const onDiagram = () => setView(entry, 'diagram');
  const onCode = () => setView(entry, 'code');
  const onFullscreen = () => openViewer(entry);
  const onDownload = () => downloadEntry(entry);
  entry.listeners.push(
    [btnDiagram, 'click', onDiagram],
    [btnCode, 'click', onCode],
    [btnFullscreen, 'click', onFullscreen],
    [btnDownload, 'click', onDownload],
  );
  for (const [element, type, listener] of entry.listeners) element.addEventListener(type, listener);

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
  try {
    ensureViewer().open({
      svg: svg.outerHTML,
      source: entry.source,
      type: entry.type || 'mermaid',
      trigger: entry.btnFullscreen,
    });
  } catch {
    /* viewer failures must never break the diagram chrome */
  }
}

function downloadEntry(entry) {
  if (!isLive(entry)) return;
  const svg = entry.pane.querySelector ? entry.pane.querySelector('svg') : null;
  if (!svg) return;
  const variables = themeVariables(state.win);
  const clone = svg.cloneNode(true);
  if (clone.style && typeof clone.style.setProperty === 'function') {
    for (const name of Object.keys(variables)) {
      try {
        clone.style.setProperty(name, variables[name]);
      } catch {
        /* ignore */
      }
    }
  }
  const markup = ensureStandaloneSvg(clone.outerHTML, { background: variables['--pele-bg'] });
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
  for (const [element, type, listener] of entry.listeners) {
    try {
      element.removeEventListener(type, listener);
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
