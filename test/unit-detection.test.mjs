// test/unit-detection.test.mjs — SPEC §4 src/detection.js, R1 (detection matrix), R7 (limits).
// Skips with a clear message while src/detection.js (task-2) does not exist yet.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, tryImportSource, fakeDetectType } from './harness.mjs';

const loaded = await tryImportSource('src/detection.js');
const detection = loaded ? loaded.mod : null;

if (!detection) {
  test('unit-detection suite', { skip: 'src/detection.js not present yet (task-2 in flight) — rerun after it lands' }, () => {});
} else {
  let env;
  let doc;
  before(async () => {
    env = await createDomEnv();
    env.install();
    doc = env.doc;
  });
  after(() => env && env.uninstall());

  const codeOf = (className, text) => {
    const code = doc.createElement('code');
    if (className) code.className = className;
    code.textContent = text;
    return code;
  };
  const preOf = (code) => {
    const pre = doc.createElement('pre');
    pre.appendChild(code);
    return pre;
  };
  const detect = (source) => fakeDetectType(source);

  test('LANG_CLASS matches the three fenced languages, case-insensitively', () => {
    assert.ok(detection.LANG_CLASS instanceof RegExp, 'LANG_CLASS must be a RegExp');
    for (const cls of ['language-mermaid', 'language-mermaidjs', 'language-mmd', 'language-Mermaid', 'language-MermaidJS', 'language-MMD']) {
      assert.equal(detection.LANG_CLASS.test(cls), true, 'should match ' + cls);
    }
    for (const cls of ['language-js', 'language-json', 'mermaid', 'language-mermaidx', 'language-mermaidjs-extra', 'lang-mermaid']) {
      assert.equal(detection.LANG_CLASS.test(cls), false, 'should not match ' + cls);
    }
  });

  test('codeSource returns textContent, including Shiki token spans', () => {
    assert.equal(detection.codeSource(codeOf('language-mermaid', 'flowchart LR\n  A-->B')), 'flowchart LR\n  A-->B');
    const code = doc.createElement('code');
    code.className = 'language-mermaid';
    const line = doc.createElement('span');
    line.className = 'line';
    line.textContent = 'flowchart LR';
    code.appendChild(line);
    assert.equal(detection.codeSource(code), 'flowchart LR');
    assert.equal(detection.codeSource(codeOf(null, '')), '');
  });

  test('hasForeignLanguageClass ignores mermaid language classes', () => {
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-js', '')), true);
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-python hljs', '')), true);
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-mermaid language-js', '')), true);
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-mermaid', '')), false);
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-mermaidjs', '')), false);
    assert.equal(detection.hasForeignLanguageClass(codeOf('language-mmd', '')), false);
    assert.equal(detection.hasForeignLanguageClass(codeOf('hljs', '')), false);
    assert.equal(detection.hasForeignLanguageClass(codeOf(null, '')), false);
  });

  test('isMermaidCodeBlock: language-* matrix (R1)', () => {
    const rows = [
      ['language-mermaid', 'flowchart LR\n  A-->B', true],
      ['language-mermaidjs', 'sequenceDiagram\n  A->>B: hi', true],
      ['language-mmd', 'pie title P\n  "a": 1', true],
      ['language-Mermaid', 'classDiagram\n  class A', true],
      ['language-mermaid hljs', 'flowchart LR\n  A-->B', true],
      ['hljs language-mmd', 'gantt\n  title T', true],
      // a language-mermaid block whose body Pele cannot detect is still a mermaid fence (R1 first clause)
      ['language-mermaid', 'not a diagram at all', true],
      ['language-js', 'flowchart LR\n  A-->B', false],
      ['language-json', 'graph TD\n  A-->B', false],
      ['language-mermaid language-js', 'flowchart LR\n  A-->B', false],
      ['language-mermaidx', 'flowchart LR\n  A-->B', false],
    ];
    for (const [cls, src, expected] of rows) {
      const code = codeOf(cls, src);
      assert.equal(
        detection.isMermaidCodeBlock(preOf(code), code, detect),
        expected,
        cls + ' => ' + expected,
      );
    }
  });

  test('isMermaidCodeBlock: plain fallback needs a detected type AND a mermaid first token (R1)', () => {
    const rows = [
      ['flowchart LR\n  A-->B', true],
      ['graph TD\n  A-->B', true],
      ['\n  flowchart LR\n  A-->B', true],
      ['%%{init: {}}%%\nflowchart LR\n  A-->B', true],
      ['sequenceDiagram\n  A->>B: hi', true],
      ['hello world', false],
      ['const x = 1;', false],
      ['', false],
    ];
    for (const [src, expected] of rows) {
      const code = codeOf(null, src);
      assert.equal(detection.isMermaidCodeBlock(preOf(code), code, detect), expected, JSON.stringify(src));
    }
    // detectType lying about a non-keyword source must not enable the plain fallback
    const lying = () => 'flowchart';
    const code = codeOf(null, 'hello world');
    assert.equal(detection.isMermaidCodeBlock(preOf(code), code, lying), false);
    // ... but a real keyword with a lying detectType is still a mermaid block
    const code2 = codeOf(null, 'flowchart LR\n  A-->B');
    assert.equal(detection.isMermaidCodeBlock(preOf(code2), code2, lying), true);
  });

  test('diagramLabel returns the detected type or the mermaid fallback', () => {
    assert.equal(detection.diagramLabel('flowchart LR\n  A-->B', detect), 'flowchart');
    assert.equal(detection.diagramLabel('sequenceDiagram\n  A->>B: hi', detect), 'sequence');
    assert.equal(detection.diagramLabel('hello world', detect), 'mermaid');
    assert.equal(detection.diagramLabel('hello world', () => null), 'mermaid');
    const fallback = detection.diagramLabel('hello world');
    assert.equal(typeof fallback, 'string');
    assert.ok(fallback.length > 0, 'diagramLabel must always return a non-empty label');
  });

  test('checkLimits: defaults are 50000 chars / 2000 lines (R7)', () => {
    assert.deepEqual(detection.checkLimits('flowchart LR'), { ok: true });

    const charsOver = detection.checkLimits('a'.repeat(50001));
    assert.equal(charsOver.ok, false);
    assert.equal(charsOver.reason, 'chars');
    assert.equal(charsOver.actual, 50001);
    assert.equal(charsOver.limit, 50000);

    assert.deepEqual(detection.checkLimits('a'.repeat(50000)), { ok: true });

    const linesOver = detection.checkLimits(Array.from({ length: 2001 }, () => 'a').join('\n'));
    assert.equal(linesOver.ok, false);
    assert.equal(linesOver.reason, 'lines');
    assert.equal(linesOver.actual, 2001);
    assert.equal(linesOver.limit, 2000);

    assert.deepEqual(detection.checkLimits(Array.from({ length: 2000 }, () => 'a').join('\n')), { ok: true });
  });

  test('checkLimits: custom limits and the both-exceeded case', () => {
    assert.equal(detection.checkLimits('a'.repeat(11), { maxChars: 10, maxLines: 5 }).reason, 'chars');
    assert.equal(detection.checkLimits('a\nb\nc\nd\ne\nf', { maxChars: 100, maxLines: 5 }).reason, 'lines');
    const ambiguous = detection.checkLimits('a\nb\nc\nd\ne\nf', { maxChars: 10, maxLines: 5 });
    assert.equal(ambiguous.ok, false, 'both limits exceeded must still be rejected');
    assert.ok(['chars', 'lines'].includes(ambiguous.reason), 'precedence is not frozen; got ' + ambiguous.reason);
    assert.deepEqual(detection.checkLimits('', { maxChars: 0, maxLines: 0 }), { ok: true });
    assert.deepEqual(detection.checkLimits('a', { maxChars: 1, maxLines: 1 }), { ok: true });
    const both = detection.checkLimits('a'.repeat(11) + '\n'.repeat(10), { maxChars: 10, maxLines: 5 });
    assert.equal(both.ok, false);
    assert.ok(['chars', 'lines'].includes(both.reason), 'reason must be chars|lines, got ' + both.reason);
  });
}
