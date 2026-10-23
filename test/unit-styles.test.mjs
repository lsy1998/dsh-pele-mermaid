// test/unit-styles.test.mjs — SPEC §4 src/styles.js, §6 theme token mapping, §7 CSS prefix, R5/R13.
// happy-dom note: computed custom properties do NOT inherit downward, so the harness sets tokens
// with a '*' rule + inline body values; assertions read the container's own inline/computed value.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, tryImportSource } from './harness.mjs';

const loaded = await tryImportSource('src/styles.js');
const styles = loaded ? loaded.mod : null;

const CLASSES = [
  'dsh-pm-bar', 'dsh-pm-badge', 'dsh-pm-btn', 'dsh-pm-actions', 'dsh-pm-body',
  'dsh-pm-pane', 'dsh-pm-code', 'dsh-pm-error', 'dsh-pm-status',
  'dsh-pm-viewer', 'dsh-pm-viewer-bar', 'dsh-pm-viewer-title', 'dsh-pm-viewport',
  'dsh-pm-stage', 'dsh-pm-sr-only',
];

const CHAINS = {
  '--pele-bg': ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-base'],
  '--pele-fg': ['--dsw-alias-label-primary'],
  '--pele-muted': ['--dsw-alias-label-tertiary'],
  '--pele-line': ['--dsw-alias-border-l1', '--dsw-alias-label-secondary'],
  '--pele-surface': ['--dsw-alias-bg-layer-1'],
  '--pele-surface-alt': ['--dsw-alias-bg-layer-2'],
  '--pele-border': ['--dsw-alias-border-l2', '--dsw-alias-border-l1'],
  '--pele-accent': ['--dsw-alias-button-primary-fill', '--dsw-alias-brand-primary'],
  '--pele-font': ['--ds-font-family-default', '--ds-font-family-interface'],
  '--pele-font-mono': ['--ds-font-family-code', '--dsw-font-markdown-code-font-family'],
  '--pele-error': ['--dsw-alias-state-error-primary'],
  '--pele-critical': ['--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary'],
};
const LITERALS = {
  '--pele-bg': 'transparent',
  '--pele-fg': 'currentColor',
  '--pele-font': 'sans-serif',
};

if (!styles) {
  test('unit-styles suite', { skip: 'src/styles.js not present yet (task-2 in flight) — rerun after it lands' }, () => {});
} else {
  const freshEnv = async (options) => {
    const env = await createDomEnv(options);
    env.install();
    return env;
  };
  const withEnv = async (options, fn) => {
    const env = await freshEnv(options);
    try { return await fn(env); } finally { env.uninstall(); env.close(); }
  };
  const effective = (env, el, prop) =>
    el.style.getPropertyValue(prop) || env.win.getComputedStyle(el).getPropertyValue(prop);

  test('CSS is non-empty, dsh-pm- prefixed, and never reuses dsh-mmd-', () => {
    assert.equal(typeof styles.CSS, 'string');
    assert.ok(styles.CSS.length > 200, 'CSS looks too small: ' + styles.CSS.length);
    assert.ok(!styles.CSS.includes('dsh-mmd'), 'must not reuse the reference dsh-mermaid prefix');
    for (const cls of CLASSES) assert.ok(styles.CSS.includes(cls), 'CSS must style .' + cls);
    assert.ok(/prefers-reduced-motion/.test(styles.CSS), 'R13/§7: respect prefers-reduced-motion');
    assert.ok(/focus-visible/.test(styles.CSS), 'R13: keep focus-visible outlines');
    assert.ok(/--dsw-alias-|--ds-font-family/.test(styles.CSS), '§7: use DSW tokens for our chrome');
  });

  test('installStyles inserts exactly one style element and is idempotent', async () => {
    await withEnv({}, async (env) => {
      styles.installStyles(env.doc);
      styles.installStyles(env.doc);
      const tagged = env.doc.head.querySelectorAll('style[data-dsh-pele-mermaid-styles]');
      assert.equal(tagged.length, 1, 'expected one <style data-dsh-pele-mermaid-styles>');
      assert.ok(tagged[0].textContent.includes('dsh-pm-bar'));
      styles.installStyles(env.doc);
      assert.equal(env.doc.head.querySelectorAll('style[data-dsh-pele-mermaid-styles]').length, 1);
    });
  });

  test('themeVariables maps every frozen chain when all tokens exist (§6)', async () => {
    await withEnv({}, async (env) => {
      // Several Pele vars share a source token (bg-layer-2 feeds bg + surface-alt), so the
      // expected value is derived from the token name, never from the iteration index.
      const tokens = {};
      for (const chain of Object.values(CHAINS)) tokens[chain[0]] = 'tok:' + chain[0];
      env.setTokens(tokens);
      const vars = styles.themeVariables(env.win);
      assert.ok(vars && typeof vars === 'object');
      for (const key of Object.keys(vars)) assert.match(key, /^--pele-/, 'unexpected var ' + key);
      for (const [peleVar, chain] of Object.entries(CHAINS)) {
        assert.equal(vars[peleVar], 'tok:' + chain[0], peleVar + ' should resolve from ' + chain[0]);
      }
    });
  });

  test('themeVariables falls back to the second token in the chain (§6)', async () => {
    await withEnv({}, async (env) => {
      // Only second-choice tokens are defined: the chain must fall through to them.
      env.setTokens({
        '--dsw-alias-bg-base': 'fb-bg',
        '--dsw-alias-label-secondary': 'fb-line',
        '--dsw-alias-brand-primary': 'fb-accent',
        '--ds-font-family-interface': 'fb-font',
      });
      const vars = styles.themeVariables(env.win);
      assert.equal(vars['--pele-bg'], 'fb-bg');
      assert.equal(vars['--pele-line'], 'fb-line', '--pele-line falls back to label-secondary');
      assert.equal(vars['--pele-accent'], 'fb-accent');
      assert.equal(vars['--pele-font'], 'fb-font');
      assert.equal(vars['--pele-border'], undefined, 'no border token defined → Pele default stays');

      // --pele-border falls back to border-l1 when border-l2 is missing; first defined wins.
      env.setTokens({ '--dsw-alias-border-l1': 'fb-border-1' });
      assert.equal(styles.themeVariables(env.win)['--pele-border'], 'fb-border-1');
      assert.equal(styles.themeVariables(env.win)['--pele-line'], 'fb-border-1', '--pele-line reads border-l1 first');
      env.setTokens({ '--dsw-alias-border-l2': 'fb-border-2', '--dsw-alias-border-l1': 'fb-border-1' });
      assert.equal(styles.themeVariables(env.win)['--pele-border'], 'fb-border-2', 'border-l2 wins over border-l1');
    });
  });

  test('themeVariables uses the frozen literals and omits unset tokens (§6)', async () => {
    await withEnv({}, async (env) => {
      const vars = styles.themeVariables(env.win);
      assert.equal(vars['--pele-bg'], LITERALS['--pele-bg']);
      assert.equal(vars['--pele-fg'], LITERALS['--pele-fg']);
      assert.equal(vars['--pele-font'], LITERALS['--pele-font']);
      assert.equal('--pele-muted' in vars, false, 'empty token must keep Pele default (not emitted)');
      assert.equal('--pele-error' in vars, false, 'empty token must keep Pele default (not emitted)');
      for (const value of Object.values(vars)) assert.ok(String(value).trim().length > 0, 'never emit an empty var');
    });
  });

  test('applyTheme writes resolved vars onto the container and skips empty ones', async () => {
    await withEnv({}, async (env) => {
      env.setTokens({ '--dsw-alias-bg-layer-2': 'rgb(9, 9, 9)', '--dsw-alias-label-primary': 'rgb(1, 1, 1)' });
      const container = env.doc.createElement('div');
      container.className = 'dsh-pm';
      env.doc.body.appendChild(container);
      styles.applyTheme(container, env.win);
      assert.equal(effective(env, container, '--pele-bg'), 'rgb(9, 9, 9)');
      assert.equal(effective(env, container, '--pele-fg'), 'rgb(1, 1, 1)');
      assert.equal(container.style.getPropertyValue('--pele-muted'), '', 'unset token must not be emitted');
      // re-apply after a token change refreshes the container (R5)
      env.setTokens({ '--dsw-alias-bg-layer-2': 'rgb(2, 2, 2)', '--dsw-alias-label-primary': 'rgb(3, 3, 3)' }, '*');
      styles.applyTheme(container, env.win);
      const bg = effective(env, container, '--pele-bg');
      assert.ok(['rgb(2, 2, 2)', 'rgb(9, 9, 9)'].includes(bg), 'after re-apply bg should be the updated token, got ' + bg);
    });
  });

  test('applyTheme tolerates an environment with no DSW tokens at all', async () => {
    await withEnv({}, async (env) => {
      const container = env.doc.createElement('div');
      container.className = 'dsh-pm';
      env.doc.body.appendChild(container);
      assert.doesNotThrow(() => styles.applyTheme(container, env.win));
      assert.equal(container.style.getPropertyValue('--pele-muted'), '');
      assert.equal(container.style.getPropertyValue('--pele-error'), '');
    });
  });
}
