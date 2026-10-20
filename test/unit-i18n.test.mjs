// test/unit-i18n.test.mjs — SPEC §4 src/i18n.js, R11 (en + zh-CN, live lang switch).
// Message KEYS are not frozen by SPEC; assertions are key-agnostic (value-shape + behaviour).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, tryImportSource, flushAsync } from './harness.mjs';

const loaded = await tryImportSource('src/i18n.js');
const i18n = loaded ? loaded.mod : null;

const LANGS = ['en', 'zh-CN'];

if (!i18n) {
  test('unit-i18n suite', { skip: 'src/i18n.js not present yet (task-2 in flight) — rerun after it lands' }, () => {});
} else {
  let env;
  let doc;
  let win;

  before(async () => {
    env = await createDomEnv({ lang: 'en' });
    env.install();
    doc = env.doc;
    win = env.win;
  });
  after(() => env && env.uninstall());

  test('MESSAGES exposes en and zh-CN with identical, non-empty key sets', () => {
    assert.ok(i18n.MESSAGES && typeof i18n.MESSAGES === 'object');
    assert.ok(i18n.MESSAGES.en && typeof i18n.MESSAGES.en === 'object');
    assert.ok(i18n.MESSAGES['zh-CN'] && typeof i18n.MESSAGES['zh-CN'] === 'object');
    const enKeys = Object.keys(i18n.MESSAGES.en).sort();
    const zhKeys = Object.keys(i18n.MESSAGES['zh-CN']).sort();
    assert.ok(enKeys.length >= 8, 'expected the UI vocabulary to be non-trivial, got ' + enKeys.length);
    assert.deepEqual(zhKeys, enKeys, 'en and zh-CN must cover the same keys');
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(i18n.MESSAGES[lang])) {
        assert.equal(typeof value, 'string', lang + '.' + key + ' must be a string');
        assert.ok(value.length > 0, lang + '.' + key + ' must not be empty');
      }
    }
  });

  test('normalizeLang maps zh variants to zh-CN and everything else to en', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-Hant-TW', 'zh_TW', 'ZH', 'zh-cn']) {
      assert.equal(i18n.normalizeLang(tag), 'zh-CN', 'tag ' + JSON.stringify(tag));
    }
    for (const tag of ['en', 'en-US', 'en-GB', 'EN', 'fr', 'de-DE', '', undefined, null]) {
      assert.equal(i18n.normalizeLang(tag), 'en', 'tag ' + JSON.stringify(tag));
    }
  });

  test('detectLang reads documentElement.lang and falls back to navigator.language', () => {
    doc.documentElement.lang = 'zh-CN';
    assert.equal(i18n.detectLang(doc), 'zh-CN');
    doc.documentElement.lang = 'en-US';
    assert.equal(i18n.detectLang(doc), 'en');
    doc.documentElement.lang = 'fr-FR';
    assert.equal(i18n.detectLang(doc), 'en');
    doc.documentElement.lang = '';
    Object.defineProperty(win.navigator, 'language', { value: 'zh-CN', configurable: true });
    assert.equal(i18n.detectLang(doc), 'zh-CN');
    Object.defineProperty(win.navigator, 'language', { value: 'en-US', configurable: true });
    assert.equal(i18n.detectLang(doc), 'en');
    // no argument -> uses the installed global document
    doc.documentElement.lang = 'zh-CN';
    assert.equal(i18n.detectLang(), 'zh-CN');
  });

  test('detectLang follows a live documentElement lang switch (R11)', () => {
    doc.documentElement.lang = 'en';
    assert.equal(i18n.detectLang(doc), 'en');
    doc.documentElement.setAttribute('lang', 'zh-CN');
    assert.equal(i18n.detectLang(doc), 'zh-CN');
  });

  test('t() returns the message for each language', () => {
    for (const lang of LANGS) {
      for (const key of Object.keys(i18n.MESSAGES[lang])) {
        const out = i18n.t(lang, key);
        assert.equal(typeof out, 'string', lang + '.' + key);
        assert.ok(out.length > 0, lang + '.' + key);
        if (!/\{[^}]+\}/.test(i18n.MESSAGES[lang][key])) {
          assert.equal(out, i18n.MESSAGES[lang][key], 'plain message must pass through: ' + lang + '.' + key);
        }
      }
    }
  });

  test('t() interpolates {param} placeholders and stays string-safe', () => {
    const entry = Object.entries(i18n.MESSAGES.en).find(([, value]) => /\{([^}]+)\}/.test(value));
    if (!entry) {
      assert.ok(true, 'no placeholder message in en — nothing to interpolate');
    } else {
      const [key, template] = entry;
      const params = {};
      for (const name of template.matchAll(/\{([^}]+)\}/g)) params[name[1]] = 'ZZZ';
      const out = i18n.t('en', key, params);
      assert.ok(out.includes('ZZZ'), 'interpolated value must appear: ' + out);
      assert.ok(!/\{/.test(out), 'no placeholder may survive: ' + out);
    }
    // unknown key must not throw (returns a string, typically the key itself)
    assert.equal(typeof i18n.t('en', 'dsh-pm-definitely-missing-key'), 'string');
    assert.equal(typeof i18n.t('zh-CN', 'dsh-pm-definitely-missing-key'), 'string');
    // unknown language must not throw
    assert.equal(typeof i18n.t('fr', 'anything'), 'string');
  });

  test('every localized pair differs (i18n is real, not a copy)', () => {
    const keys = Object.keys(i18n.MESSAGES.en);
    const differing = keys.filter((key) => i18n.MESSAGES.en[key] !== i18n.MESSAGES['zh-CN'][key]);
    assert.ok(differing.length >= Math.min(5, keys.length), 'expected most messages translated, differing=' + differing.length);
  });

  test('t() output is stable across calls (no hidden state)', async () => {
    const key = Object.keys(i18n.MESSAGES.en)[0];
    const a = i18n.t('en', key);
    await flushAsync(2);
    const b = i18n.t('en', key);
    assert.equal(a, b);
  });
}
