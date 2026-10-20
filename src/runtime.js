/**
 * dsh-pele-mermaid - lazy Pele browser-runtime loader (SPEC 4, SPEC 2).
 *
 * The client never bundles Pele. The first detected mermaid block injects
 * <script data-dsh-pele-runtime src="/dsh-pele-mermaid/pele-runtime.js"></script>
 * and the loader resolves with the global `pele` instance.
 */

/** Public URL of the runtime route registered by lib/index.js. */
export const RUNTIME_PATH = '/dsh-pele-mermaid/pele-runtime.js';

/** Marker attribute used to recognise the injected script element. */
export const RUNTIME_SCRIPT_ATTR = 'data-dsh-pele-runtime';

var overrideActive = false;
var overrideValue = null;
var pending = null;

function resolveWindow(win) {
  if (win) return win;
  if (typeof window !== 'undefined') return window;
  if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
  return undefined;
}

/** The loaded Pele instance, or null. Honours the test override. */
export function getPeleRuntime() {
  if (overrideActive) return overrideValue;
  var win = resolveWindow();
  return (win && win.pele) || null;
}

/** Override the loader for tests; null clears the override (window.pele wins again). */
export function setPeleRuntimeForTesting(pele) {
  if (pele == null) {
    overrideActive = false;
    overrideValue = null;
    return;
  }
  overrideActive = true;
  overrideValue = pele;
}

/** Drop the test override and any in-flight load. */
export function resetPeleRuntimeForTesting() {
  overrideActive = false;
  overrideValue = null;
  pending = null;
}

/**
 * Load the Pele runtime once. Concurrent calls share a single script element
 * and a single promise; a failure rejects every waiter and allows a retry.
 */
export function loadPeleRuntime(win) {
  var target = resolveWindow(win);
  if (overrideActive) {
    if (overrideValue) return Promise.resolve(overrideValue);
    return Promise.reject(new Error('Pele runtime is not available (test override is empty)'));
  }
  if (!target || !target.document) {
    return Promise.reject(new Error('Pele runtime requires a window with a document'));
  }
  if (target.pele) return Promise.resolve(target.pele);
  if (pending) return pending;

  var promise = new Promise(function (resolve, reject) {
    var script;
    try {
      script = target.document.createElement('script');
    } catch (error) {
      reject(error);
      return;
    }
    script.setAttribute(RUNTIME_SCRIPT_ATTR, '');
    script.src = RUNTIME_PATH;
    script.async = true;
    function settle() {
      if (target.pele) resolve(target.pele);
      else reject(new Error('Pele runtime at ' + RUNTIME_PATH + ' did not define window.pele'));
    }
    script.onload = settle;
    script.onerror = function () {
      reject(new Error('Failed to load Pele runtime: ' + RUNTIME_PATH));
    };
    if (typeof script.addEventListener === 'function') {
      script.addEventListener('load', settle);
      script.addEventListener('error', function () {
        reject(new Error('Failed to load Pele runtime: ' + RUNTIME_PATH));
      });
    }
    var parent = target.document.head || target.document.documentElement || target.document.body;
    if (!parent) {
      reject(new Error('Pele runtime cannot be injected: the document has no root element'));
      return;
    }
    parent.appendChild(script);
  });

  var tracked = promise.then(
    function (value) {
      if (pending === tracked) pending = null;
      return value;
    },
    function (error) {
      if (pending === tracked) pending = null;
      throw error;
    },
  );
  pending = tracked;
  return tracked;
}
