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
  '--pele-font-mono',
  '--pele-error',
  '--pele-critical',
]);

/** All CSS owned by the plugin (chrome + panes + fullscreen viewer). */
export const CSS = `
.dsh-pm{box-sizing:border-box;margin:8px 0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));overflow:hidden}
.dsh-pm *,.dsh-pm *::before,.dsh-pm *::after{box-sizing:border-box}
.dsh-pm-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-pm-badge{margin-right:auto;font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#888);padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Icon-only controls: a fixed square keeps the strip even, and the 16px graphic centres itself
   inside it. The visible label is gone, so there is no text padding left to reserve; the
   localized name still lives in aria-label/title (see labelControl in client.js). */
.dsh-pm-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;min-width:28px;height:28px;min-height:28px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:6px;font:12px/20px inherit;cursor:pointer}
.dsh-pm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsh-pm-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:2px}
.dsh-pm-btn[aria-pressed='true']{border-color:var(--dsw-alias-button-primary-fill,#4c6ef5);color:var(--dsw-alias-button-primary-fill,#4c6ef5);background:var(--dsw-alias-interactive-bg-active,rgba(76,110,245,.12))}
.dsh-pm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
/* A hairline between the view toggle and the actions: two different kinds of control, so they
   read as two groups instead of one run of seven identical squares. */
.dsh-pm-sep{flex:0 0 auto;width:1px;height:16px;margin:0 2px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.28))}
/* The icon is a stroked SVG that inherits the button's colour, so it follows the theme in
   both light and dark mode without a second set of assets. */
.dsh-pm-icon{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.dsh-pm-body{padding:0}
.dsh-pm-pane{display:block;padding:10px 12px;overflow:auto;cursor:grab;touch-action:pan-x pan-y}
.dsh-pm-pane[data-dragging='true']{cursor:grabbing}
.dsh-pm-pane:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:-2px}
.dsh-pm-pane svg{max-width:100%;height:auto;display:block;margin:0 auto}
/* The stage is the element the inline zoom sizes (see inlineStage in client.js). Pele
   rewrites the whole style attribute of the svg it mounted whenever the pane resizes,
   which wiped a zoom written onto the svg itself; the stage is ours, so sizing it
   survives. The svg is then laid out by the stage through this rule.
   The class is NOT "dsh-pm-stage": that one belongs to the fullscreen viewer and is
   absolutely positioned, so sharing the name pulled the inline stage out of the flow
   and the diagram floated over the page instead of scrolling inside the pane. */
.dsh-pm-inline-stage{display:block;margin:0 auto;transform-origin:0 0}
.dsh-pm-inline-stage>svg{display:block;max-width:none;width:100%;height:100%;margin:0}
/* The stage keeps its auto centring margin on the inline axis at EVERY scale, including 100%.
   An auto margin is not a fixed offset: for a block wider than its container the auto margins
   resolve to 0 (left aligned, reachable by scrolling), and for a narrower one they centre it.
   That is exactly the origin the zoom maths reads back in inlineStageOrigin(), so the centring
   must NOT be switched off when the zoom leaves 100% - doing so left-aligned a shrunken diagram
   and made every zoom step creep towards the top-left corner.
   The block axis has no auto margin to resolve (it would compute to 0), so applyInlineZoom
   writes an explicit margin-top there for the same reason.
   The JS sizes the stage explicitly, which wins over the stylesheet anyway. */
/* A zoomed diagram is scrollable rather than stretching the page. The pane's height is frozen
   at its unzoomed size by the JS (see applyInlineZoom): a content-driven pane grows with the
   diagram and never has a vertical scroll range, which leaves the zoom no way to hold its
   anchor on that axis. */
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
.dsh-pm-viewer{position:fixed;z-index:2147483000;inset:0;display:block;isolation:isolate;background:#fff;color:var(--dsw-alias-label-primary,#222)}
body[data-ds-dark-theme] .dsh-pm-viewer{background:#121212;color:var(--dsw-alias-label-primary,#f5f5f5)}
.dsh-pm-viewer[hidden]{display:none}
/* The scrim is inert: it never closes the overlay and it never takes a press. It used to be
   position:fixed with z-index:1 while the viewport had z-index:auto, so it painted ON TOP of
   the diagram and swallowed every click and every drag. pointer-events:none is the belt to
   that braces: a decorative full-window layer can no longer intercept anything. */
.dsh-pm-viewer-backdrop{position:absolute;inset:0;z-index:0;background:transparent;border:0;padding:0;pointer-events:none;cursor:default}
/* The controls float in the bottom-right corner instead of sitting in a bar across the top,
   so the diagram gets the whole window and nothing is under the pointer at the top edge. */
.dsh-pm-viewer-bar{position:absolute;right:16px;bottom:16px;z-index:3;display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.96));box-shadow:0 6px 24px rgba(0,0,0,.18)}
.dsh-pm-viewer-bar .dsh-pm-actions{flex-direction:column;align-items:stretch;gap:6px}
/* Icon-only buttons: a fixed square keeps the column of controls even, and the icon
   centres itself inside it. */
.dsh-pm-viewer-bar .dsh-pm-actions .dsh-pm-btn{flex:0 0 auto;width:40px;min-width:40px;height:40px;min-height:40px;padding:0;display:flex;align-items:center;justify-content:center}
.dsh-pm-viewer-bar > .dsh-pm-btn{align-self:stretch;width:40px;min-width:40px;height:40px;min-height:40px;padding:0;display:flex;align-items:center;justify-content:center}
/* The separator divides the view controls from the exit, so the exit is its own group. */
.dsh-pm-viewer-sep{height:1px;margin:2px 0;background:var(--dsw-alias-border-l1,rgba(127,127,127,.3))}
body[data-ds-dark-theme] .dsh-pm-viewer-bar{background:var(--dsw-alias-bg-layer-1,rgba(30,30,30,.96))}
.dsh-pm-viewer-diag{position:absolute;left:16px;top:46px;z-index:5;max-width:min(640px,calc(100vw - 32px));margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(20,20,20,.96));color:var(--dsw-alias-label-primary,#eee);font:11px/16px var(--ds-font-family-code,ui-monospace,monospace);white-space:pre-wrap;overflow:hidden;pointer-events:none}
.dsh-pm-viewer-build{position:absolute;left:16px;bottom:16px;z-index:2;max-width:min(340px,40vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#888);opacity:.85;cursor:default;user-select:text}
@media (max-width:759px){.dsh-pm-viewer-build{display:none}}
/* A quiet caption in the top-left corner: pointer-events:none so it labels the diagram
   without ever stealing a press that should pan. */
.dsh-pm-viewer-title{position:absolute;left:16px;top:14px;z-index:2;max-width:min(60vw,420px);font:12px/20px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;user-select:none}
.dsh-pm-viewer .dsh-pm-btn{color:var(--dsw-alias-label-secondary,#555);border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.35))}
body[data-ds-dark-theme] .dsh-pm-viewer .dsh-pm-btn{color:var(--dsw-alias-label-secondary,#ddd)}
/* The exit control is the one destructive action in the group, so it reads as such: the
   cross is drawn in the error colour while the view controls stay neutral. These rules
   come AFTER the generic .dsh-pm-viewer .dsh-pm-btn colour, otherwise the generic one
   (higher specificity) would win and the cross would stay grey. */
.dsh-pm-viewer-bar>.dsh-pm-viewer-exit{color:var(--dsw-alias-state-error-primary,#e03131);border-color:var(--dsw-alias-state-error-primary,rgba(224,49,49,.45))}
.dsh-pm-viewer-bar>.dsh-pm-viewer-exit:hover{background:var(--dsw-alias-state-error-container,rgba(224,49,49,.12));border-color:var(--dsw-alias-state-error-primary,#e03131)}
body[data-ds-dark-theme] .dsh-pm-viewer-bar>.dsh-pm-viewer-exit{color:var(--dsw-alias-state-error-primary,#ff8787);border-color:var(--dsw-alias-state-error-primary,rgba(255,135,135,.45))}
/* The viewport owns the whole window (the controls float above it), so a press anywhere that
   is not a control is a pan. touch-action:none keeps a touch drag from turning into a
   scroll, and user-select:none stops a pan from selecting the diagram's text. */
.dsh-pm-viewport{position:absolute;inset:0;z-index:1;overflow:hidden;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
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
  // Pele 1.9 renders <code>, <kbd>, <samp> and <tt> labels in its monospace face, so the
  // mono token has to be mapped too or those labels fall back to Pele's own monospace.
  put('--pele-font-mono', readVar(computed, ['--ds-font-family-code', '--dsw-font-markdown-code-font-family']));
  put('--pele-error', readVar(computed, ['--dsw-alias-state-error-primary']));
  // Pele colours its "critical" marks (e.g. gantt critical tasks) with this; DSH has no
  // critical token, so borrow the warning colour and fall back to the error colour.
  put('--pele-critical', readVar(computed, ['--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary']));
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
