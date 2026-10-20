# SPEC — dsh-pele-mermaid

Status: FROZEN (lead). All teammates implement against this file. Do not edit it without lead approval.

## 0. Goal

Build a **DeepSeek Harness (DSH) profile plugin bundle** named `dsh-pele-mermaid` that renders
```mermaid fenced code blocks in the DSH Web GUI as SVG using **Pele**
(https://github.com/obsidianmd/pele, npm `pele@1.6.0`) instead of mermaid.js, with a
**Code / Diagram** toggle, fullscreen zoom viewer, SVG export, theme adaptation and error fallback.

Deliverable root = this workspace. The package must be installable into the DSH `desktop` profile
via `dsh plugin --profile desktop add -w --save-exact <abs-path>`.

## 1. Verified environment facts (recon, do not re-derive)

- DSH profile dir: the active `desktop` profile under `~/.dsh/profiles/desktop` (DSH_PROFILE=desktop, DSH_HOME=~/.dsh).
- Node v22.18.0, npm 10.9.3, pnpm 11.21.0. Plugin engines: node >= 22.19 recommended (match dsh-mermaid).
- npm must run with the workspace `.npmrc` (cache=.npm-cache) and `--ignore-scripts` (sandbox blocks
  npm lifecycle child processes). Never write outside the workspace without lead approval.
- Reference implementation installed at
  `<desktop-profile>/node_modules/dsh-mermaid` (v0.4.1) — read it for DOM/toolbar
  conventions, but write ORIGINAL code. Our CSS prefix is `dsh-pm-` (not `dsh-mmd-`).
- DSH ships the authoritative skill `cordis-plugin-development` inside app.asar
  (`...app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development`);
  only node fs reads can open app.asar (rg/glob/shell cannot).
- Pele 1.6.0 is installed at `node_modules/pele`. `dist/pele.global.js` (682 KB) is a **classic script**
  that defines the global `var pele`. `dist/pele.js` / `dist/index.d.ts` are the ESM + types.
- Pele ESM `render(source, options)` works in **pure Node with no DOM** and returns
  `{ svg, width, height, type, links }`. `PeleError` has `code` (unsupported-diagram|syntax|semantic|limit),
  `type`, `line`, `column`, `snippet`. Exports: `PeleError, detectType, enableZoom, forgetTextWidths,
  mount, parse, register, registered, render, supports`. Error `message` embeds the source line — always
  display it with `textContent`, never `innerHTML`.
- Pele SVG root is `<svg class="pele pele-<type>">` and reads CSS variables inherited from ancestors:
  `--pele-bg --pele-fg --pele-muted --pele-line --pele-surface --pele-surface-alt --pele-border
  --pele-accent --pele-font --pele-radius --pele-error --pele-series-1..8`. Colors adapt without
  re-render; `mount().refresh()` is needed after font/theme *geometry* changes.

## 2. Wire protocol (must match EXACTLY)

```jsonc
// package.json (required keys)
{
  "name": "dsh-pele-mermaid",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: ui-pele-mermaid
      name: 'dsh-pele-mermaid'
```

Host face `lib/index.js` (Cordis, node half) — mirrors dsh-mermaid exactly:
```js
export const inject = ['webServer'];
export const RUNTIME_PATH = '/dsh-pele-mermaid/pele-runtime.js';
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: RUNTIME_PATH,
    async handler(req, res) { /* GET|HEAD -> 200 text/javascript + immutable cache; else 404/405 */ },
  }), 'dsh-pele-mermaid: runtime route');
}
```

Client face `lib/client.js` (browser half) — single self-executing loader call:
```js
window.__ModuleLoader__.load({ id: 'dsh-pele-mermaid', factory: (require) => { /* bundled */ return module.exports } });
// module.exports = { apply, inject: [], setPeleRuntimeForTesting, ... }
```
Client runtime is loaded lazily on the first detected mermaid block by injecting
`<script data-dsh-pele-runtime src="/dsh-pele-mermaid/pele-runtime.js">`; `window.pele` is the instance.
The client **must not** bundle or import pele at build time.

## 3. Repo layout & write ownership (disjoint — do not write outside your scope)

| Path | Owner |
| --- | --- |
| SPEC.md, .recon/** | lead |
| src/client.js, src/detection.js, src/i18n.js, src/styles.js | plugin-core |
| src/runtime.js, src/viewer.js, src/svg.js, lib/index.js, scripts/build.mjs, package.json, cordis.patch.yml, bin/dsh-pele-mermaid.mjs, icon.svg, .npmrc, .gitignore | viewer-host |
| test/** (`npm test`), test/fixtures/** | test-harness |
| README.md, README.zh-CN.md, CHANGELOG.md, LICENSE | docs-release |
| .verify/** | verifier |

Generated, never hand-edited: `lib/client.js`, `lib/pele-runtime.js` (build output), `node_modules/**`.

## 4. Frozen module interfaces

```js
// src/runtime.js  (viewer-host)
export const RUNTIME_PATH = '/dsh-pele-mermaid/pele-runtime.js';
export const RUNTIME_SCRIPT_ATTR = 'data-dsh-pele-runtime';
export function getPeleRuntime(): any | null;          // window.pele when present
export function setPeleRuntimeForTesting(pele: any): void; // overrides the loader; null clears
export function loadPeleRuntime(win?: Window): Promise<any>; // idempotent, dedupes concurrent calls
export function resetPeleRuntimeForTesting(): void;

// src/detection.js  (plugin-core)
export const LANG_CLASS: RegExp;                       // /^language-(?:mermaid|mermaidjs|mmd)$/i
export function codeSource(codeEl: Element): string;   // textContent of the code element
export function isMermaidCodeBlock(pre: Element, codeEl: Element, detectType: (s:string)=>string|null): boolean;
export function diagramLabel(source: string, detectType?: (s:string)=>string|null): string; // 'flowchart' etc, or 'mermaid'
export function hasForeignLanguageClass(codeEl: Element): boolean; // any /^language-/ other than mermaid
export function checkLimits(source: string, limits?: { maxChars?: number; maxLines?: number }):
  { ok: true } | { ok: false; reason: 'chars' | 'lines'; actual: number; limit: number };

// src/i18n.js  (plugin-core)
export const MESSAGES: { en: Record<string,string>; 'zh-CN': Record<string,string> };
export function normalizeLang(tag?: string): 'en' | 'zh-CN';
export function detectLang(doc?: Document): 'en' | 'zh-CN';
export function t(lang: string, key: string, params?: Record<string, unknown>): string;

// src/styles.js  (plugin-core)
export const CSS: string;                              // all classes prefixed dsh-pm-
export function installStyles(doc?: Document): void;   // <style data-dsh-pele-mermaid-styles>
export function themeVariables(win?: Window): Record<string, string>; // DSW tokens -> --pele-* values
export function applyTheme(container: Element, win?: Window): void;   // set vars on container

// src/svg.js  (viewer-host)
export function ensureStandaloneSvg(svg: string, opts?: { background?: string }): string;
export function svgFileName(type: string, now?: Date): string;   // pele-<type>-YYYYMMDD-HHmmss.svg
export function downloadSvg(svg: string, filename: string, doc?: Document): void;

// src/viewer.js  (viewer-host)
export function createViewer(deps: { doc?: Document; t?: (k:string,p?:object)=>string; win?: Window }): {
  open(opts: { svg: string; source: string; type: string; trigger?: Element | null }): void;
  close(): void; isOpen(): boolean; destroy(): void;
};

// src/client.js  (plugin-core) — the Cordis client plugin
export const inject: string[];                       // []
export function apply(ctx: any): void;
export function setPeleRuntimeForTesting(pele: any): void;   // re-export from src/runtime.js
export const __internals: { /* exported for tests: enhance, reset, state, constants */ };
```

## 5. Behaviour requirements (each is testable)

R1 **Detection** — enhance only `pre > code` blocks whose class contains
   `language-mermaid|mermaidjs|mmd`. When the code element carries **no** `language-` class (DSH/Shiki
   plain fallback) treat it as mermaid only if `pele.detectType(source)` returns a type AND the first
   token is a known mermaid keyword. Never enhance a block with another `language-*` class. Never touch
   inline `code`.
R2 **Idempotence / coexistence** — skip any `pre` that is already inside our container
   (`[data-dsh-pele-mermaid]`) or inside a foreign diagram container (`.dsh-mmd`, `[data-dsh-mermaid]`).
   Mark processed blocks with `data-dsh-pele-mermaid-block` on the `pre` (the container alone carries
   `data-dsh-pele-mermaid`, so a `[data-dsh-pele-mermaid]` count equals the number of blocks exactly once).
R3 **Toggle** — toolbar with a badge (diagram type + "Pele") and Code/Diagram buttons
   (`aria-pressed`), plus Fullscreen + Download SVG actions; diagram view is the default; the original
   `pre` is preserved and shown in code view.
R4 **Render** — render through `window.pele.mount(element, source, options)` so layout adapts to the
   container width. Options: `{ maxWidth, autoDirection, padding, icons: () => null, links: true,
   linkRel: 'noopener' }` derived from settings; pass `onError` and `onRender`.
R5 **Theme** — map DSW tokens to Pele vars via `themeVariables()` (see §6). Re-apply on
   `body[data-ds-dark-theme]` mutation and on `documentElement[lang]` change; re-render only what changes.
R6 **Errors** — on `PeleError` (or any throw) show the source and a localized message built with
   `textContent`; include line/column when available; never inject error text or diagram source as HTML.
R7 **Limits** — default 50 000 chars / 2 000 lines; over-limit blocks stay as source with a localized
   notice (reason: chars|lines), never rendered.
R8 **Streaming safety** — a monotonic generation counter per block; async runtime load + render results
   are discarded when the block's source changed or the node was detached; renders run through a serial
   queue with a microtask/idle yield between diagrams to keep the page responsive.
R9 **Viewer** — fullscreen overlay: zoom in/out/reset/fit, pan by drag, wheel with Ctrl/Meta zoom,
   Escape closes, focus is trapped inside while open and restored to the trigger on close,
   `role="dialog" aria-modal="true"`, localized labels.
R10 **Export** — download a standalone `.svg` (`svgFileName`) whose root carries the resolved theme
   variables so it looks the same outside DSH.
R11 **i18n** — every user-visible string comes from `MESSAGES` via `t()`; `en` + `zh-CN`;
   language from `document.documentElement.lang` / `navigator.language`; live switch on `lang` change.
R12 **Disposal** — `apply` registers every observer/listener inside `ctx.effect(...)` and returns a
   cleanup that disconnects observers, removes listeners, restores the DOM it changed and destroys the
   viewer. A repeated apply/cleanup/apply cycle must leave no duplicate toolbars or observers.
R13 **Accessibility** — toolbar buttons have localized `aria-label`, rendered diagrams get an accessible
   name, status changes are announced via an `aria-live` region, focus-visible outlines preserved.

## 6. Theme token mapping (frozen)

| Pele var | Source (first defined wins) |
| --- | --- |
| `--pele-bg` | `--dsw-alias-bg-layer-2` → `--dsw-alias-bg-base` → `transparent` |
| `--pele-fg` | `--dsw-alias-label-primary` → `currentColor` |
| `--pele-muted` | `--dsw-alias-label-tertiary` |
| `--pele-line` | `--dsw-alias-border-l1` → `--dsw-alias-label-secondary` |
| `--pele-surface` | `--dsw-alias-bg-layer-1` |
| `--pele-surface-alt` | `--dsw-alias-bg-layer-2` |
| `--pele-border` | `--dsw-alias-border-l2` → `--dsw-alias-border-l1` |
| `--pele-accent` | `--dsw-alias-button-primary-fill` → `--dsw-alias-brand-primary` |
| `--pele-font` | `--ds-font-family-default` → `--ds-font-family-interface` → `sans-serif` |
| `--pele-error` | `--dsw-alias-state-error-primary` |

Resolve values with `getComputedStyle` on the container/body; when a token is empty keep Pele's default
(do not emit `--pele-x: `). Emit them on our `.dsh-pm` container, so Pele inherits them.

## 7. DOM & CSS conventions (frozen)

Container: `<div class="dsh-pm" data-dsh-pele-mermaid data-view="diagram">` wrapping the original `pre`.
Children: `.dsh-pm-bar` (toolbar), `.dsh-pm-badge`, `.dsh-pm-btn`, `.dsh-pm-actions`,
`.dsh-pm-body`, `.dsh-pm-pane` (`data-state="loading|ready|error"`), `.dsh-pm-code`,
`.dsh-pm-error`, `.dsh-pm-status` (`aria-live="polite"`), viewer: `.dsh-pm-viewer`,
`.dsh-pm-viewer-bar`, `.dsh-pm-viewer-title`, `.dsh-pm-viewport`, `.dsh-pm-stage`, `.dsh-pm-sr-only`.
Use DSW tokens for our own chrome (same family as dsh-mermaid: `--dsw-alias-*`, `--ds-font-family-code`,
`--dsw-radius-*`) with literal fallbacks. Respect `prefers-reduced-motion`.

## 8. Build / test / check (single source of truth)

- `scripts/build.mjs`: esbuild bundles `src/client.js` → `lib/client.js` (format iife/cjs, target es2022,
  banner+footer wrapping the `window.__ModuleLoader__.load({ id: 'dsh-pele-mermaid', factory(require){ ... } })`
  contract, minify), and copies `node_modules/pele/dist/pele.global.js` → `lib/pele-runtime.js`
  (byte-identical; record sha256 in the build log).
- `npm run build` = `node scripts/build.mjs`; `npm run check` = syntax-check every shipped JS with
  `node --check` + `npm test`; `npm test` = `node --test test/`.
- LEAD AMENDMENT (sandbox): this host's DSH sandbox blocks piped child-process creation, so
  `node --test test/` fails with `spawn EPERM` before any test runs. package.json therefore also ships
  `"test:offline": "node --test --experimental-test-isolation=none \"test/**/*.test.mjs\""`
  (verified on Node v22.18.0: `isolation=none` + a bare `test/` directory argument fails with
  ERR_UNSUPPORTED_DIR_IMPORT, so the quoted glob is required; it also excludes test/harness.mjs, which
  no-path discovery would wrongly run as a test file) (viewer-host owns package.json)
  and `check` ends with `npm run test:offline`. In-sandbox acceptance evidence = the `test:offline` run plus
  direct `node test/<file>.test.mjs` runs, reported with raw output.
- Tests must run offline against the built `lib/client.js` and must not need network or a browser.

## 9. Definition of done

1. `npm run build && npm run check` pass on a clean checkout of the workspace.
2. `lib/client.js` loads under happy-dom after a stubbed `window.__ModuleLoader__`; a synthetic
   `<pre><code class="language-mermaid">` block becomes a toolbar + rendered Pele SVG; error, limits,
   idempotence, disposal, i18n and viewer behaviours are covered by passing tests.
3. Host face test proves the exact route, content-type, HEAD handling, and 404/405 branches.
4. `npm pack --dry-run` lists exactly: package.json, cordis.patch.yml, lib/index.js, lib/client.js,
   lib/pele-runtime.js, bin/, icon.svg, README/README.zh-CN/CHANGELOG/LICENSE.
5. Verifier independently reproduces 1–4 and reports evidence in `.verify/`.
6. Lead reviews the final diff and confirms no writer touched another's scope.
