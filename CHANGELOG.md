# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Zoom and pan the inline diagram in place: `Ctrl`/`Cmd` + wheel zooms at the pointer, drag
  pans, and `+`/`-`/`0`/arrow keys work too. A plain wheel still scrolls the page. The state is
  per block and resets when the diagram re-renders.
- The inline pane is a focusable viewport (`tabindex="0"`, `role="group"`, localized label) that
  announces its current zoom through a polite live region.

### Changed

- The fullscreen viewer opens at the inline pane's current zoom, and closing it restores the
  inline scroll offsets and zoom before focus returns to the trigger, so the round trip is
  lossless.
- The zoom and pan maths live in one shared module (`src/zoom.js`) used by both the inline pane
  and the fullscreen overlay.

## [0.1.0] - 2026-10-19

### Added

- Render Mermaid fenced code blocks in the DSH Web GUI as SVG with Pele 1.6.0 instead of a
  mermaid.js runtime.
- Support the `mermaid`, `mermaidjs` and `mmd` info strings, and recover DSH/Shiki plain
  fallback blocks when Pele detects a Mermaid keyword; never enhance inline code or a block
  carrying another `language-*` class.
- **Code / Diagram** toggle with `aria-pressed`, a diagram-type badge, fullscreen and
  **Download SVG** actions, and the original `pre` preserved for code view.
- Fullscreen viewer with zoom in/out/reset/fit, drag pan, `Ctrl`/`Cmd` + wheel zoom,
  `Escape` to close, trapped focus, focus restore and localized labels.
- Standalone SVG export whose root carries the resolved theme variables.
- Map DSW design tokens to Pele CSS variables, re-applied on dark-theme and document-language
  changes.
- Localized error fallback with line and column when Pele provides them.
- 50,000-character and 2,000-line per-diagram limits with a localized notice.
- Serial render queue, a per-block generation counter and a yield between diagrams for streaming
  safety.
- English and Simplified Chinese interface strings with live language switching.
- Accessible names on rendered diagrams, polite `aria-live` status announcements and
  `focus-visible` outlines.
- Dual-face bundle: a Cordis host route that serves the vendored Pele script and a client bundle
  registered with the DSH client module loader.
- Installer script `bin/dsh-pele-mermaid.mjs` wrapping `dsh plugin --profile <name> add -w
  --save-exact` and `remove -w`.
- Offline test entry point `npm run test:offline`
  (`node --test --experimental-test-isolation=none "test/**/*.test.mjs"`) for sandboxes that
  block node's per-file test child processes; `npm run check` uses it.

### Security

- Error messages and diagram source are inserted with `textContent` only, never as HTML.
- Pele icon markup is disabled (`icons` returns `null`), and the Pele runtime is served from
  the plugin's own same-origin route with no CDN.

### Documentation

- English and Simplified Chinese READMEs, this changelog, and an MIT license that carries the
  third-party notice for the vendored Pele runtime.
