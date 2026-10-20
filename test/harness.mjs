// test/harness.mjs — shared offline harness for the dsh-pele-mermaid suites (T3).
//
// Responsibilities
//  * happy-dom environment bootstrap. happy-dom's navigator is a getter-only property on the
//    Node 22 globalThis, so globals are installed with Object.defineProperty (plain assignment
//    of `navigator` throws "Cannot set property navigator of #<Object> which has only a getter").
//  * a stubbed window.__ModuleLoader__ that captures the built client bundle's factory.
//  * a deterministic fake Pele runtime installed through setPeleRuntimeForTesting, plus a
//    real-Pele loader (pure-Node ESM `render()` works with no DOM).
//  * a Cordis-like ctx stub whose effect() runs the callback immediately and records disposers.
//
// Nothing in here touches the network, the live DSH GUI, or any file outside the workspace.
// Owned by test-harness (task-3), scope test/**.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = resolve(TEST_DIR, '..');
export const DEFAULT_URL = 'http://127.0.0.1:50661/';
export const CLIENT_BUNDLE = join(WORKSPACE, 'lib', 'client.js');
export const HOST_ENTRY = join(WORKSPACE, 'lib', 'index.js');
export const RUNTIME_BUNDLE = join(WORKSPACE, 'lib', 'pele-runtime.js');
export const PELE_ESM = join(WORKSPACE, 'node_modules', 'pele', 'dist', 'pele.js');
export const HAPPY_DOM = join(WORKSPACE, 'node_modules', 'happy-dom', 'lib', 'index.js');

let importCounter = 0;

/**
 * Fail fast instead of hanging: a DOM suite that stops making progress exits the process with
 * an explicit message rather than blocking CI for an hour. Async hangs are caught by the timer;
 * a synchronous infinite loop cannot be interrupted from inside Node (kill the process).
 */
export function installWatchdog(label, ms = 120_000) {
  const timer = setTimeout(() => {
    console.error(`[${label}] WATCHDOG: no test completed in ${Math.round(ms / 1000)}s — aborting the run (hang, not a slow test).`);
    process.exit(1);
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

/** Thrown when a built/generated artifact another owner must produce is not present yet. */
export class MissingArtifactError extends Error {
  constructor(artifact) {
    super(`missing artifact: ${artifact}`);
    this.name = 'MissingArtifactError';
    this.artifact = artifact;
  }
}

export const SKIP_MESSAGES = {
  client: 'lib/client.js not built yet (task-1/scripts/build.mjs) — skipping built-artifact suite',
  host: 'lib/index.js not built yet (task-1) — skipping host-face suite',
};

export function workspacePath(...parts) {
  return join(WORKSPACE, ...parts);
}

/** Import an ESM module from a workspace-relative path, or return null when it does not exist. */
export async function tryImportSource(relativePath) {
  const full = workspacePath(...String(relativePath).split('/'));
  if (!existsSync(full)) return null;
  return { path: full, mod: await import(pathToFileURL(full).href) };
}

export async function readIfExists(path) {
  return existsSync(path) ? await readFile(path, 'utf8') : null;
}

/** Deterministic macrotask/microtask drain used after DOM mutations (R8 serial queue idling). */
export async function flushAsync(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// happy-dom environment
// ---------------------------------------------------------------------------

const DOM_GLOBALS = [
  'Node', 'Text', 'Comment', 'Document', 'DocumentFragment', 'Element', 'HTMLElement',
  'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLStyleElement',
  'HTMLScriptElement', 'HTMLPreElement', 'SVGElement', 'SVGSVGElement', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'FocusEvent',
  'InputEvent', 'DOMRect', 'DOMParser', 'XMLSerializer',
];

export function makeIdleCallbackShim() {
  return (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
}

/**
 * Create a happy-dom Window plus an installer that publishes the DOM globals
 * (defineProperty — never plain assignment) and restores them on uninstall.
 */
export async function createDomEnv(options = {}) {
  const happyDom = await import(pathToFileURL(HAPPY_DOM).href);
  const win = new happyDom.Window({
    url: options.url ?? DEFAULT_URL,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableJavaScriptEvaluation: false,
      errorCapture: 'none',
      ...(options.settings ?? {}),
    },
  });
  const doc = win.document;
  if (options.lang) doc.documentElement.setAttribute('lang', options.lang);
  if (options.dark) doc.body.setAttribute('data-ds-dark-theme', '');

  const observers = [];
  const listenerLog = [];
  const saved = [];
  let baseline = 0;

  const env = {
    win, doc, observers, listenerLog,
    url: win.location.href,
    installed: false,

    /** Snapshot of net plugin listeners starts here; call right before apply(). */
    listenerStart() { baseline = listenerLog.length; },
    /** Listeners still attached since listenerStart() (plugin must remove all of them). */
    listenerLeaks() {
      return listenerLog.slice(baseline).filter((r) => !r.removed);
    },

    install() {
      if (env.installed) return env;
      env.installed = true;
      const set = (key, value) => {
        const before = Object.getOwnPropertyDescriptor(globalThis, key);
        saved.push([key, before]);
        Object.defineProperty(globalThis, key, {
          value, configurable: true, writable: true, enumerable: false,
        });
      };
      set('window', win);
      set('document', doc);
      set('navigator', win.navigator);
      if (win.location) set('location', win.location);
      for (const name of DOM_GLOBALS) {
        if (win[name]) set(name, win[name]);
      }
      set('getComputedStyle', win.getComputedStyle.bind(win));
      set('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
      set('cancelAnimationFrame', (id) => clearTimeout(id));
      set('requestIdleCallback', makeIdleCallbackShim());
      set('cancelIdleCallback', (id) => clearTimeout(id));
      win.requestIdleCallback = globalThis.requestIdleCallback;
      win.cancelIdleCallback = globalThis.cancelIdleCallback;
      win.requestAnimationFrame = globalThis.requestAnimationFrame;
      win.cancelAnimationFrame = globalThis.cancelAnimationFrame;

      // Track MutationObservers so disposal (R12) can be asserted.
      const RealMO = win.MutationObserver;
      const TrackedMO = function TrackedMO(callback) {
        const inst = new RealMO(callback);
        const realDisconnect = inst.disconnect.bind(inst);
        const realObserve = inst.observe.bind(inst);
        inst.__dshDisconnected = false;
        inst.__dshObserved = [];
        inst.disconnect = () => { inst.__dshDisconnected = true; return realDisconnect(); };
        inst.observe = (target, opts) => { inst.__dshObserved.push({ target, opts }); return realObserve(target, opts); };
        observers.push(inst);
        return inst;
      };
      set('MutationObserver', TrackedMO);
      win.MutationObserver = TrackedMO;

      // Track document/window listeners so disposal (R12) can be asserted.
      const watchTarget = (target, label) => {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, fn, opts) => {
          const rec = { target: label, type, fn, options: opts, removed: false };
          listenerLog.push(rec);
          if (opts && typeof opts === 'object' && opts.signal) {
            const signal = opts.signal;
            if (signal.aborted) rec.removed = true;
            else signal.addEventListener('abort', () => { rec.removed = true; }, { once: true });
          }
          return add(type, fn, opts);
        };
        target.removeEventListener = (type, fn, opts) => {
          for (let i = listenerLog.length - 1; i >= 0; i -= 1) {
            const rec = listenerLog[i];
            if (!rec.removed && rec.target === label && rec.type === type && rec.fn === fn) {
              rec.removed = true;
              break;
            }
          }
          return remove(type, fn, opts);
        };
      };
      watchTarget(doc, 'document');
      watchTarget(win, 'window');
      return env;
    },

    uninstall() {
      if (!env.installed) return;
      env.installed = false;
      for (let i = saved.length - 1; i >= 0; i -= 1) {
        const [key, before] = saved[i];
        if (before) Object.defineProperty(globalThis, key, before);
        else delete globalThis[key];
      }
      saved.length = 0;
    },

    /** Append a <style> to <head>; returns the element. */
    style(css, attrs = {}) {
      const el = doc.createElement('style');
      if (attrs.id) el.id = attrs.id;
      el.textContent = css;
      doc.head.appendChild(el);
      return el;
    },

    /**
     * Define DSW theme tokens in a way happy-dom resolves for ANY element
     * (computed custom-property reads do not inherit downwards in happy-dom, but
     * a `*` rule plus inline values covers body, container and children alike).
     */
    setTokens(tokens, selector = '*') {
      // Replacing semantics: each call defines the complete token set, so a test can
      // simulate a theme switch without the previous values lingering in the cascade.
      const body = Object.entries(tokens).map(([k, v]) => `${k}: ${v};`).join(' ');
      const style = env.__tokenStyle || (env.__tokenStyle = env.style('', { id: 'dsh-test-tokens' }));
      style.textContent = `${selector} { ${body} }`;
      for (const name of env.__tokenNames || []) doc.body.style.removeProperty(name);
      for (const [k, v] of Object.entries(tokens)) doc.body.style.setProperty(k, v);
      env.__tokenNames = Object.keys(tokens);
      return style;
    },

    setDark(on) {
      if (on) doc.body.setAttribute('data-ds-dark-theme', '');
      else doc.body.removeAttribute('data-ds-dark-theme');
    },

    close() { try { win.close(); } catch { /* happy-dom teardown is best-effort */ } },
  };
  return env;
}

// ---------------------------------------------------------------------------
// Client bundle loader (window.__ModuleLoader__ stub)
// ---------------------------------------------------------------------------

function pickExport(mod, name) {
  if (mod && mod[name] !== undefined) return mod[name];
  if (mod && mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

export function normalizeClientModule(moduleExports) {
  const apply = pickExport(moduleExports, 'apply');
  if (typeof apply !== 'function') {
    throw new Error('lib/client.js factory did not return module.exports with apply()');
  }
  return {
    raw: moduleExports,
    apply,
    inject: pickExport(moduleExports, 'inject'),
    setPeleRuntimeForTesting: pickExport(moduleExports, 'setPeleRuntimeForTesting'),
    resetPeleRuntimeForTesting: pickExport(moduleExports, 'resetPeleRuntimeForTesting'),
    __internals: pickExport(moduleExports, '__internals'),
    default: moduleExports && moduleExports.default,
  };
}

/**
 * Import lib/client.js with a fresh module instance (cache-busted) after installing the
 * __ModuleLoader__ stub, then run the captured factory with a throwing require shim.
 */
export async function loadClientBundle(env, options = {}) {
  const bundlePath = options.path ?? CLIENT_BUNDLE;
  if (!existsSync(bundlePath)) throw new MissingArtifactError(bundlePath);
  const captured = [];
  env.win.__ModuleLoader__ = {
    load(spec) {
      if (!spec || typeof spec.factory !== 'function' || typeof spec.id !== 'string') {
        throw new Error('window.__ModuleLoader__.load must receive { id, factory }');
      }
      captured.push(spec);
    },
  };
  const href = pathToFileURL(bundlePath).href + '?dsh-test=' + (importCounter += 1);
  await import(href);
  if (captured.length !== 1) {
    throw new Error(`expected exactly one __ModuleLoader__.load call, saw ${captured.length}`);
  }
  const spec = captured[0];
  const requested = [];
  const requireShim = (id) => {
    requested.push(id);
    throw new Error(`client bundle called require(${id}) at runtime; pele must not be bundled (SPEC §2/§8)`);
  };
  const moduleExports = spec.factory(requireShim);
  return {
    spec,
    id: spec.id,
    moduleExports,
    plugin: normalizeClientModule(moduleExports),
    requires: requested,
    bundlePath,
    source: await readFile(bundlePath, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Deterministic fake Pele runtime
// ---------------------------------------------------------------------------

export const FAKE_TYPE_PATTERNS = [
  [/^\s*(?:flowchart|graph)\b/i, 'flowchart'],
  [/^\s*sequenceDiagram\b/i, 'sequence'],
  [/^\s*classDiagram\b/i, 'class'],
  [/^\s*stateDiagram(?:-v2)?\b/i, 'state'],
  [/^\s*erDiagram\b/i, 'er'],
  [/^\s*gantt\b/i, 'gantt'],
  [/^\s*pie\b/i, 'pie'],
  [/^\s*journey\b/i, 'journey'],
  [/^\s*timeline\b/i, 'timeline'],
  [/^\s*mindmap\b/i, 'mindmap'],
  [/^\s*gitGraph\b/i, 'gitGraph'],
  [/^\s*quadrantChart\b/i, 'quadrantChart'],
  [/^\s*requirementDiagram\b/i, 'requirement'],
  [/^\s*C4[A-Za-z]*\b/i, 'c4'],
  [/^\s*block-beta\b/i, 'block'],
  [/^\s*packet-beta\b/i, 'packet'],
  [/^\s*sankey-beta\b/i, 'sankey'],
  [/^\s*xychart-beta\b/i, 'xychart'],
];

export function stripLeadingNoise(source) {
  let s = String(source ?? '').replace(/^\uFEFF/, '');
  const front = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (front) s = s.slice(front[0].length);
  for (;;) {
    const m = /^\s*(?:%%\{[^]*?\}%%|%%.*)(?:\r?\n|$)/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

export function fakeDetectType(source) {
  const s = stripLeadingNoise(source);
  for (const [re, type] of FAKE_TYPE_PATTERNS) if (re.test(s)) return type;
  return null;
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fakeSvg(type, width = 320, height = 180) {
  return `<svg class="pele pele-${type}" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${escapeXml(type)} diagram"><title>${escapeXml(type)}</title><desc>fake pele svg</desc><rect width="10" height="10"/></svg>`;
}

/**
 * Deterministic fake Pele. It honours the mount() contract the SPEC relies on:
 * synchronous, inserts SVG HTML into the element, never throws on bad input but
 * reports through onError/error and writes the message with textContent.
 *
 * options:
 *   fail(source, element) -> Error|null   simulate PeleError for matching sources
 *   throwOn(source) -> boolean            make mount() itself throw (R6 "or any throw")
 *   svgFor(type) -> string                custom SVG body
 */
export function createFakePele(options = {}) {
  const state = {
    mounts: [], renders: [], updates: [], refreshes: [], destroyed: [], parses: [], detects: [], enableZoom: [],
    instances: [],
  };

  class FakePeleError extends Error {
    constructor(message, fields = {}) {
      super(message);
      this.name = 'PeleError';
      this.code = fields.code ?? 'syntax';
      this.type = fields.type ?? null;
      this.line = fields.line ?? 0;
      this.column = fields.column ?? 0;
      this.snippet = fields.snippet ?? '';
    }
  }

  const detectType = options.detectType ?? ((source) => fakeDetectType(source));
  const supports = (source) => detectType(source) !== null;
  const svgFor = options.svgFor ?? ((type) => fakeSvg(type));

  function render(source, renderOptions = {}) {
    const type = detectType(source);
    state.renders.push({ source, options: renderOptions, type });
    if (type === null) {
      throw new FakePeleError(`Unable to detect diagram type for: ${stripLeadingNoise(source).split(/\r?\n/)[0] ?? ''}`, { code: 'unsupported-diagram', type: null });
    }
    const svg = svgFor(type);
    return { svg, width: 320, height: 180, type, links: [] };
  }

  function parse(source, parseOptions = {}) {
    state.parses.push({ source, options: parseOptions });
    const type = detectType(source);
    if (type === null) throw new FakePeleError('Unable to detect diagram type', { code: 'unsupported-diagram' });
    return { __fake: true, type, source };
  }

  function mount(element, source, mountOptions = {}) {
    const id = state.mounts.length + 1;
    const record = { id, element, source, options: mountOptions, type: detectType(source), svg: null, error: null, result: null, instance: null };
    state.mounts.push(record);

    if (typeof options.throwOn === 'function' && options.throwOn(source)) {
      const thrown = new FakePeleError(`synthetic throw for: ${String(source).split(/\r?\n/)[0]}`, { type: record.type, line: 2, column: 3 });
      record.error = thrown;
      throw thrown;
    }

    const instance = {
      source,
      error: undefined,
      result: undefined,
      update(next, nextOptions) {
        instance.source = next;
        if (nextOptions) Object.assign(mountOptions, nextOptions);
        state.updates.push({ id, source: next });
        applySource(element, next, mountOptions, instance, record);
        return instance;
      },
      refresh() { state.refreshes.push(id); },
      destroy() { state.destroyed.push(id); },
    };
    state.instances.push(instance);
    record.instance = instance;

    function applySource(target, text, opts, inst, rec) {
      const type = detectType(text);
      rec.type = type;
      const err = typeof options.fail === 'function' ? (options.fail(text, target, FakePeleError) || null) : null;
      rec.source = text;
      if (err) {
        rec.error = err; rec.result = null; rec.svg = null;
        inst.error = err; inst.result = undefined;
        target.textContent = err.message;
        if (typeof opts.onError === 'function') opts.onError(err);
        return;
      }
      const svg = svgFor(type ?? 'unknown');
      rec.svg = svg; rec.error = null;
      const result = { svg, width: 320, height: 180, type: type ?? 'unknown', links: [] };
      rec.result = result;
      inst.error = undefined; inst.result = result;
      target.innerHTML = svg;
      if (typeof opts.onRender === 'function') opts.onRender(result);
    }

    applySource(element, source, mountOptions, instance, record);
    return instance;
  }

  function enableZoom(element, zoomOptions) {
    state.enableZoom.push({ element, options: zoomOptions });
    return { scale: 1, fit: 1, zoomBy() {}, zoomTo() {}, reset() {}, refresh() {}, destroy() {} };
  }

  const fake = {
    __fake: true,
    version: options.version ?? '1.6.0-fake',
    state,
    PeleError: FakePeleError,
    detectType,
    supports,
    render,
    parse,
    mount,
    enableZoom,
    forgetTextWidths() {},
    register() {},
    registered: () => [],
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Cordis-like ctx stub
// ---------------------------------------------------------------------------

/**
 * Minimal ctx for apply(ctx). effect() executes the callback immediately (as Cordis does)
 * and records the disposer it returns. dispose() runs every disposer LIFO.
 */
export function createCtx(extra = {}) {
  const disposers = [];
  let disposed = false;
  const log = [];
  const noop = () => {};
  const skip = () => noop;

  const ctx = {
    effect(fn, label) {
      if (typeof fn !== 'function') throw new TypeError('ctx.effect(fn) requires a function');
      log.push(label ?? fn.name ?? `effect-${log.length + 1}`);
      const result = fn();
      if (typeof result === 'function') disposers.push({ fn: result, label: label ?? 'effect cleanup' });
      return () => {
        const index = disposers.findIndex((d) => d.fn === result);
        if (index >= 0) disposers.splice(index, 1)[0].fn();
      };
    },
    on: skip, once: skip, off: noop, emit: noop,
    interval: skip, timeout: skip, setTimeout: () => 0, clearTimeout: noop,
    isActive: () => !disposed,
    get: () => undefined,
    config: {},
    logger: { debug: noop, info: noop, warn: noop, error: noop, level: 'info' },
    ...extra,
  };

  return {
    ctx,
    effects: log,
    effectCount: () => log.length,
    pendingDisposers: () => disposers.length,
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
      const errors = [];
      while (disposers.length) {
        const { fn, label } = disposers.pop();
        try { fn(); } catch (error) { errors.push(new Error(`cleanup "${label}" threw: ${error && error.message}`, { cause: error })); }
      }
      if (errors.length) throw new AggregateError(errors, 'ctx dispose failed');
    },
  };
}

// ---------------------------------------------------------------------------
// Full client-plugin setup
// ---------------------------------------------------------------------------

/**
 * Boot happy-dom, load lib/client.js, install the fake (or real) Pele runtime,
 * apply the plugin, and return handles for assertions + teardown.
 */
export async function setupClient(options = {}) {
  const env = await createDomEnv({ lang: options.lang, dark: options.dark, url: options.url });
  env.install();
  const bundle = await loadClientBundle(env, options);
  const fake = options.pele ?? createFakePele(options.peleOptions ?? {});
  if (typeof bundle.plugin.setPeleRuntimeForTesting !== 'function') {
    throw new Error('lib/client.js must re-export setPeleRuntimeForTesting (SPEC §4)');
  }
  bundle.plugin.setPeleRuntimeForTesting(fake);
  const ctxHandle = createCtx(options.ctxExtra ?? {});
  env.listenerStart();
  let cleanup = null;
  const apply = () => {
    if (cleanup === null) cleanup = bundle.plugin.apply(ctxHandle.ctx);
    return cleanup;
  };
  if (options.autoApply !== false) apply();
  const handle = {
    env,
    doc: env.doc,
    win: env.win,
    fake,
    bundle,
    plugin: bundle.plugin,
    internals: bundle.plugin.__internals,
    ctx: ctxHandle.ctx,
    ctxHandle,
    apply,
    get cleanup() { return cleanup; },
    teardown: () => {
      try { if (typeof cleanup === 'function') cleanup(); } finally { ctxHandle.dispose(); }
      env.uninstall();
      env.close();
    },
    flush: flushAsync,
    /** Append a mermaid-ish code block; returns { pre, code }. */
    addBlock(source, { lang = 'mermaid', codeClass, preAttrs = {}, parent } = {}) {
      const pre = env.doc.createElement('pre');
      for (const [k, v] of Object.entries(preAttrs)) pre.setAttribute(k, v);
      const code = env.doc.createElement('code');
      if (codeClass !== undefined) code.className = codeClass;
      else if (lang) code.className = 'language-' + lang;
      code.textContent = source;
      pre.appendChild(code);
      (parent ?? env.doc.body).appendChild(pre);
      return { pre, code };
    },
    containerFor(pre) { return pre.closest('[data-dsh-pele-mermaid]'); },
    containers() { return [...env.doc.querySelectorAll('[data-dsh-pele-mermaid]')]; },
    /**
     * Bounded wait for an asynchronous condition (render queue, pane state). The plugin's render
     * queue is debounced, so a fixed flush can race it on a loaded machine; polling exits as soon
     * as the condition holds and never waits longer than `timeout` (default 2 s, per T3 rules).
     */
    async waitFor(predicate, { timeout = 2000, interval = 10, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (predicate()) return true;
        if (Date.now() > deadline) throw new Error('waitFor(' + label + ') timed out after ' + timeout + 'ms');
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    /** Wait until at least `count` diagrams reached the fake runtime. */
    async waitForRenders(count, options = {}) {
      await handle.waitFor(() => handle.fake.state.mounts.length >= count, { label: count + ' render(s)', ...options });
      return handle.fake.state.mounts.length;
    },
    /** Wait until a container's pane reaches data-state=loading|ready|error. */
    async waitForPaneState(container, state, options = {}) {
      await handle.waitFor(() => {
        const pane = container && container.querySelector('.dsh-pm-pane');
        return !!pane && pane.getAttribute('data-state') === state;
      }, { label: 'pane state ' + state, ...options });
    },
    /**
     * Wait until `predicate` has held continuously for `stableFor` ms (bounded by `timeout`).
     * Catches delayed regressions (a detached block resurrected by a later debounced pass)
     * without relying on a fixed sleep.
     */
    async waitForStable(predicate, { stableFor = 150, timeout = 2000, interval = 10, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      let since = 0;
      for (;;) {
        if (predicate()) {
          if (!since) since = Date.now();
          if (Date.now() - since >= stableFor) return true;
        } else {
          since = 0;
        }
        if (Date.now() > deadline) throw new Error('waitForStable(' + label + ') did not hold for ' + stableFor + 'ms within ' + timeout + 'ms');
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    /**
     * Flush pending work and (when expected is given) wait for the containers to appear.
     * Falls back to __internals.enhance for the initial-scan path; returns the container count.
     */
    async settle(expected) {
      await flushAsync();
      if (typeof expected === 'number') {
        try {
          await handle.waitFor(() => handle.containers().length >= expected, { timeout: 800, label: expected + ' container(s)' });
        } catch {
          if (handle.internals && typeof handle.internals.enhance === 'function') {
            try { handle.internals.enhance(env.doc.documentElement); } catch { /* surfaced elsewhere */ }
            await flushAsync();
          }
        }
      }
      return handle.containers().length;
    },
  };
  return handle;
}

/** Load real Pele ESM (`pele`, dist/pele.js) or null when not installed. */
export async function importRealPele() {
  if (!existsSync(PELE_ESM)) return null;
  return await import(pathToFileURL(PELE_ESM).href);
}

// ---------------------------------------------------------------------------
// i18n helpers (key-agnostic: message keys are NOT frozen by SPEC, values are)
// ---------------------------------------------------------------------------

/** Collect en/zh message maps from __internals.constants/MESSAGES or src/i18n.js. */
export async function resolveMessages(handle) {
  const internals = handle && handle.internals;
  const candidates = [
    internals && internals.constants && internals.constants.MESSAGES,
    internals && internals.MESSAGES,
    handle && handle.plugin && handle.plugin.MESSAGES,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.en && candidate['zh-CN']) return candidate;
  }
  const i18n = await tryImportSource('src/i18n.js');
  if (i18n && i18n.mod.MESSAGES && i18n.mod.MESSAGES.en && i18n.mod.MESSAGES['zh-CN']) {
    return i18n.mod.MESSAGES;
  }
  return null;
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn a message template (`{type} · Pele`) into a regex matching a rendered string. */
export function messageToRegExp(template) {
  const parts = String(template).split(/\{[^}]*\}/g).map(escapeRegExp);
  return new RegExp('^' + parts.join('.+?') + '$');
}

/** Return the message key whose template matches `text`, or null. */
export function matchMessage(text, messages) {
  if (!messages) return null;
  for (const [key, template] of Object.entries(messages)) {
    if (typeof template === 'string' && messageToRegExp(template).test(text)) return key;
  }
  return null;
}

export function accessibleName(el) {
  if (!el) return '';
  return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
}

export function buttonsIn(root) {
  return [...root.querySelectorAll('button, [role="button"]')];
}

export function buttonNames(root) {
  return buttonsIn(root).map(accessibleName).filter(Boolean);
}

/**
 * User-visible chrome strings (badge, buttons, status, viewer title). Prefers aria-label,
 * never concatenates a whole toolbar, so each entry can be matched against one MESSAGES template.
 */
export function chromeTexts(root) {
  const out = [];
  for (const el of root.querySelectorAll('.dsh-pm-badge, .dsh-pm-btn, .dsh-pm-status, .dsh-pm-viewer-title')) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) { out.push(label.trim()); continue; }
    const text = (el.textContent || '').trim();
    if (text) out.push(text);
  }
  return [...new Set(out)];
}
