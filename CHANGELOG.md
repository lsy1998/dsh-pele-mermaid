# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-23

### Fixed

- **The plugin installed cleanly and then did nothing.** Two identifiers had to be the
  published package name (`@lsy1998/dsh-pele-mermaid`) and were instead the bare
  `dsh-pele-mermaid`:
  - `cordis.patch.yml` used the bare name as an entry `name`. The host treats that field as a
    **module specifier**: it runs `loader.import(name)` and then locates the package manifest by
    matching `package.json#name` exactly. On a machine with no stray `node_modules/dsh-pele-mermaid`
    link the import throws, the entry is recorded as `error`, and startup carries on — so the
    plugin was simply absent, with no message about it.
  - the built client bundle registered as `dsh-pele-mermaid`. The host derives each boot-graph
    row's `id` from the package name, executes the bundle, then asserts `factories.has(row.id)`.
    A short id leaves that false, `arrive()` throws *"loaded without registering ... via
    `__ModuleLoader__.load`"*, and the browser half never activates — while the host half keeps
    serving its route, which is why the failure looked like "installed but useless" rather than
    an install error.

  Both values are now derived from `package.json#name` instead of hard-coded, and both are
  guarded: `cordis.patch.yml` must equal the package name, and the bundle must register under
  it. The two older assertions had pinned the wrong literals, which is how the mismatch survived.

## [0.1.1] - 2026-10-22

### Added

- Zoom and pan the inline diagram in place: `Ctrl`/`Cmd` + wheel zooms at the pointer, drag
  pans, and `+`/`-`/`0`/arrow keys work too. A plain wheel still scrolls the page. The state is
  per block and resets when the diagram re-renders.
- The inline pane is a focusable viewport (`tabindex="0"`, `role="group"`, localized label) that
  announces its current zoom through a polite live region.
- Zoom in / Zoom out / Reset zoom buttons on the inline diagram toolbar.
- Build stamp in the fullscreen viewer: the bar shows `v0.1.0+<commit> at <UTC time>` and
  carries it in `data-build-stamp`, so a page can be told apart from an older cached bundle no
  matter how it was installed.
- Discoverability for the DSH plugin ecosystem: the repository carries the `deepseek-harness`
  and `dsh-plugin` topics, `dsh-plugin` is an npm keyword, and both READMEs point at the GitHub
  topic listings and dshmarket.com.

### Fixed

- **A click anywhere in the fullscreen viewer closed it.** The transparent click-to-close
  backdrop was appended last and still painted above the toolbar and the diagram, so the first
  click on a zoom control (or anywhere else) hit the backdrop and closed the viewer; that is why
  the controls looked dead. The backdrop is now the overlay's first child, so nothing above it
  can be covered, the viewport itself carries the click-to-close behaviour, and a press that
  panned the diagram never counts as a click.
- **Nothing could reach the fullscreen viewer's controls or start a drag.** The transparent
  click-to-close backdrop was painted above the toolbar and the diagram surface, so a press on a
  zoom button or on the diagram never left the backdrop: the controls looked dead and the diagram
  could not be dragged in the fullscreen viewer, while the inline pane was unaffected. The
  backdrop now sits under both (z-index 1, toolbar at 2), a press that starts on a control is no
  longer treated as a drag, and the drag handles a press it ignored.
- **The fullscreen zoom/fit controls did nothing at the centre of the diagram.** The stage was
  anchored at the viewport centre in CSS while the zoom maths put the diagram at the top-left,
  so every control changed the scale invisibly and moved the diagram off to the right and below
  the window; the image only came into view at high zoom, as if the buttons did nothing. The
  stage is now anchored at its top-left corner, where the maths puts it.
- **Export cropped the diagram.** `Download SVG` exported the on-screen `<svg>`, which carried the
  inline zoom styles, so the file showed only the visible part and had no natural size. The export
  now uses the pristine render result at its natural size and is identical whether or not the
  diagram was zoomed or panned.
- **The inline diagram was clipped and dragging misbehaved after zooming.** The anchored zoom could
  ask for a negative scroll offset, which a browser clamps to 0, and the pan mixed a scroll offset
  with a transform, so a diagram wider than the pane but shorter than the pane was scrolled
  horizontally and translated vertically. The pane now uses one pan model with clamped scroll
  offsets, and the stylesheet no longer fights the zoomed size.
- **Leaving the fullscreen viewer was not obvious.** The close control was a bare glyph among four
  other glyph buttons. The overlay now has a labelled "Exit fullscreen" button, closes on a
  backdrop click, and still closes on `Escape`.
- **Installing the plugin from GitHub failed under pnpm 11.** The package declared a `prepare`
  script, and pnpm refuses to install a git-hosted dependency whose package.json declares an
  install-time lifecycle script unless the consumer allowlists it in `pnpm-workspace.yaml`. The
  DSH CLI owns that workspace file, so an installer cannot approve the script there and the
  install aborted with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. The `prepare` script was never
  needed on the install path — the build outputs are committed precisely because a GitHub-source
  install runs no build — so it has been replaced by `prepack`: the install path now executes no
  script at all, while packing and publishing still rebuild fresh artifacts.

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
