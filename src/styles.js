/**
 * dsh-pele-mermaid — styles, DSW→Pele theme mapping, style installation.
 *
 * SPEC §4 (frozen signatures), SPEC §6 (token mapping), SPEC §7 (class names).
 * Every class we own is prefixed `dsh-pm-`.
 */

/** Marker attribute used on our `<style>` element. */
export const STYLE_ATTR = 'data-dsh-pele-mermaid-styles';

/** Pele CSS custom properties we resolve (SPEC §6 order). */
export const PELE_VARIABLES = Object.freeze([
  '--pele-bg',
  '--pele-fg',
  '--pele-muted',
  '--pele-line',
  '--pele-surface',
  '--pele-surface-alt',
  '--pele-border',
  '--pele-accent',
  '--pele-font',
  '--pele-error',
]);

/** All CSS owned by the plugin (chrome + panes + fullscreen viewer). */
export const CSS = `
.dsh-pm{box-sizing:border-box;margin:8px 0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));overflow:hidden}
.dsh-pm *,.dsh-pm *::before,.dsh-pm *::after{box-sizing:border-box}
.dsh-pm-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-pm-badge{margin-right:auto;font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#888);padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pm-btn{appearance:none;min-width:28px;min-height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:5px;font:12px/20px inherit;padding:2px 10px;cursor:pointer}
.dsh-pm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsh-pm-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:2px}
.dsh-pm-btn[aria-pressed='true']{border-color:var(--dsw-alias-button-primary-fill,#4c6ef5);color:var(--dsw-alias-button-primary-fill,#4c6ef5);background:var(--dsw-alias-interactive-bg-active,rgba(76,110,245,.12))}
.dsh-pm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsh-pm-body{padding:0}
.dsh-pm-pane{display:block;padding:10px 12px;overflow:auto;cursor:grab;touch-action:pan-x pan-y}
.dsh-pm-pane[data-dragging='true']{cursor:grabbing}
.dsh-pm-pane:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:-2px}
.dsh-pm-pane svg{max-width:100%;height:auto;display:block;margin:0 auto}
/* Zoomed: the pane is a plain scroll container. The auto centring margin and
   the max-width clamp would offset/scale the rendered box away from where the zoom
   maths puts it (the transform origin is 0 0), so both are switched off as soon as
   the user zooms. The JS also sets an explicit inline size, which would win anyway. */
.dsh-pm-pane[data-zoom]:not([data-zoom='100']) svg{margin:0;max-width:none;height:auto}
/* A zoomed diagram is scrollable rather than stretching the page. */
.dsh-pm-pane[data-zoom]:not([data-zoom='100']){overscroll-behavior:contain}
.dsh-pm-pane[data-state='loading']{font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#888);padding:12px 14px;white-space:pre-wrap}
.dsh-pm-pane[data-state='error']{font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-state-error-primary,#d33);padding:12px 14px;white-space:pre-wrap}
.dsh-pm-code{display:none;margin:0;padding:12px 14px;overflow-x:auto;font:var(--dsw-font-markdown-code-block,13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-primary,#e6e6e6);white-space:pre;tab-size:4}
.dsh-pm-error{display:none;font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-state-error-primary,#d33);padding:10px 14px 0;white-space:pre-wrap}
.dsh-pm-status{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.dsh-pm-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.dsh-pm[data-view='code'] .dsh-pm-pane{display:none}
.dsh-pm[data-view='code'] .dsh-pm-code{display:block}
.dsh-pm[data-view='diagram'] .dsh-pm-code{display:none}
.dsh-pm[data-view='code'][data-state='error'] .dsh-pm-error{display:block}
.dsh-pm:not([data-state='ready']) .dsh-pm-action{display:none}
.dsh-pm-viewer{position:fixed;z-index:2147483000;inset:0;display:flex;flex-direction:column;background:#fff;color:var(--dsw-alias-label-primary,#222)}
body[data-ds-dark-theme] .dsh-pm-viewer{background:#121212;color:var(--dsw-alias-label-primary,#f5f5f5)}
.dsh-pm-viewer[hidden]{display:none}
/* The bar wraps instead of pushing the close control off-screen: with a 12px font,
   5 glyph buttons + a title + gap need ~470px, and a 700-900px window still has to
   leave room for the label + padding. flex-wrap + min-width:0 on the title keeps the
   actions on the first line whenever there is space and never hides them. */
.dsh-pm-viewer-bar{position:relative;z-index:2;display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:48px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.98))}
.dsh-pm-viewer-bar .dsh-pm-actions{flex-wrap:wrap;justify-content:flex-end;margin-left:auto}
.dsh-pm-viewer-bar .dsh-pm-actions .dsh-pm-btn{flex:0 0 auto}
/* A text label is unmistakable next to four bare glyph buttons; it only needs the
   room when the bar is narrow, so it is hidden from the layout (not from AT) below
   640px, where the ✕ glyph plus the aria-label/title carry the meaning. */
.dsh-pm-viewer-exit-label{white-space:nowrap}
@media (max-width:639px){.dsh-pm-viewer-exit-label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}}
/* The backdrop is the part of the overlay that is NOT the diagram viewport, so a
   click anywhere around the diagram closes the viewer. */
.dsh-pm-viewer-backdrop{position:fixed;inset:0;z-index:1;background:transparent;border:0;padding:0;cursor:default}
body[data-ds-dark-theme] .dsh-pm-viewer-bar{background:var(--dsw-alias-bg-layer-1,rgba(30,30,30,.98))}
.dsh-pm-viewer-title{margin-right:auto;font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pm-viewer .dsh-pm-btn{color:var(--dsw-alias-label-secondary,#555);border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.35))}
body[data-ds-dark-theme] .dsh-pm-viewer .dsh-pm-btn{color:var(--dsw-alias-label-secondary,#ddd)}
.dsh-pm-viewport{position:relative;flex:1;min-height:0;overflow:hidden;cursor:grab;touch-action:none}
.dsh-pm-viewport[data-dragging='true']{cursor:grabbing}
.dsh-pm-stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.dsh-pm-stage svg{display:block;max-width:none;height:auto;background:transparent}
@media (prefers-reduced-motion:reduce){.dsh-pm *,.dsh-pm-viewer *,.dsh-pm-viewer{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.dsh-pm-btn:focus-visible{outline-color:Highlight}}
`;

function resolveDoc(doc) {
  if (doc) return doc;
  if (typeof document !== 'undefined') return document;
  return null;
}

function resolveWindow(win) {
  if (win) return win;
  if (typeof window !== 'undefined') return window;
  return null;
}

/** Inject the plugin stylesheet once per document. */
export function installStyles(doc) {
  const target = resolveDoc(doc);
  if (!target || !target.head) return;
  if (typeof target.head.querySelector === 'function' && target.head.querySelector('style[' + STYLE_ATTR + ']')) return;
  const style = target.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = CSS;
  target.head.appendChild(style);
}

function readVar(style, names) {
  if (!style) return '';
  for (const name of names) {
    let value = '';
    try {
      value = style.getPropertyValue(name);
    } catch {
      value = '';
    }
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

/**
 * SPEC §6 — resolve DSW design tokens to Pele CSS variables.
 * First defined token wins; literal fallbacks are used where the table defines
 * one, and `undefined` tokens are omitted so Pele keeps its own default.
 */
export function themeVariables(win) {
  const target = resolveWindow(win);
  const doc = target && target.document;
  const source = doc && (doc.body || doc.documentElement);
  if (!source || typeof target.getComputedStyle !== 'function') return {};
  let computed = null;
  try {
    computed = target.getComputedStyle(source);
  } catch {
    computed = null;
  }
  const vars = {};
  const put = (name, value) => {
    const resolved = value && String(value).trim();
    if (resolved) vars[name] = resolved;
  };
  put('--pele-bg', readVar(computed, ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-base']) || 'transparent');
  put('--pele-fg', readVar(computed, ['--dsw-alias-label-primary']) || 'currentColor');
  put('--pele-muted', readVar(computed, ['--dsw-alias-label-tertiary']));
  put('--pele-line', readVar(computed, ['--dsw-alias-border-l1', '--dsw-alias-label-secondary']));
  put('--pele-surface', readVar(computed, ['--dsw-alias-bg-layer-1']));
  put('--pele-surface-alt', readVar(computed, ['--dsw-alias-bg-layer-2']));
  put('--pele-border', readVar(computed, ['--dsw-alias-border-l2', '--dsw-alias-border-l1']));
  put('--pele-accent', readVar(computed, ['--dsw-alias-button-primary-fill', '--dsw-alias-brand-primary']));
  put('--pele-font', readVar(computed, ['--ds-font-family-default', '--ds-font-family-interface']) || 'sans-serif');
  put('--pele-error', readVar(computed, ['--dsw-alias-state-error-primary']));
  return vars;
}

/** Apply the resolved theme variables to one of our containers. */
export function applyTheme(container, win) {
  if (!container || !container.style || typeof container.style.setProperty !== 'function') return;
  const vars = themeVariables(win);
  for (const name of PELE_VARIABLES) {
    const value = vars[name];
    try {
      if (value) container.style.setProperty(name, value);
      else container.style.removeProperty(name);
    } catch {
      /* ignore unusable style objects */
    }
  }
}
