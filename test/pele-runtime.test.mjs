// test/pele-runtime.test.mjs — real Pele ESM (node_modules/pele/dist/pele.js) corpus.
// Proves the renderer this plugin relies on without any DOM, network, or build artifacts.
// Also supplies the real-world evidence behind R5 (var(--pele-*)) and R13 (svg role/a11y).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, importRealPele } from './harness.mjs';

const pele = await importRealPele();

const CORPUS = [
  { type: 'flowchart', source: 'flowchart LR\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]' },
  { type: 'sequence', source: 'sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello' },
  { type: 'class', source: 'classDiagram\n  class Animal {\n    +String name\n    +speak()\n  }\n  Animal <|-- Dog' },
  { type: 'state', source: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start' },
  { type: 'er', source: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER { string name }' },
  { type: 'gantt', source: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  Task A :a1, 2024-01-01, 30d' },
  { type: 'pie', source: 'pie title Pets\n  "Dogs" : 60\n  "Cats" : 40' },
  { type: 'journey', source: 'journey\n  title Day\n  section Morning\n    Wake: 5: Me' },
  { type: 'timeline', source: 'timeline\n  title History\n  2020 : Alpha\n  2021 : Beta' },
  { type: 'mindmap', source: 'mindmap\n  root((Core))\n    Branch\n      Leaf' },
  { type: 'gitGraph', source: 'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"' },
  { type: 'quadrantChart', source: 'quadrantChart\n  title Q\n  x-axis Low --> High\n  y-axis Low --> High\n  Fig1: [0.3, 0.6]' },
  { type: 'requirement', source: 'requirementDiagram\n  requirement r1 {\n    id: 1\n    text: must work\n    risk: low\n    verifymethod: test\n  }' },
  { type: 'c4', source: 'C4Context\n  Person(user, "User")\n  System(sys, "System")\n  Rel(user, sys, "Uses")' },
  { type: 'block', source: 'block-beta\n  columns 2\n  A B\n  C D' },
  { type: 'packet', source: 'packet-beta\n  0-7: "A"\n  8-15: "B"' },
  { type: 'sankey', source: 'sankey-beta\n  A,B,10\n  B,C,5' },
  { type: 'xychart', source: 'xychart-beta\n  title Sales\n  x-axis [a, b, c]\n  y-axis "v" 0 --> 100\n  bar [30, 60, 90]' },
];

if (!pele) {
  test('pele-runtime suite', { skip: 'node_modules/pele/dist/pele.js not installed' }, () => {});
} else {
  let env;
  let doc;
  before(async () => {
    env = await createDomEnv();
    env.install();
    doc = env.doc;
  });
  after(() => env && env.uninstall());

  test('exports the documented API surface (SPEC §1)', () => {
    for (const name of ['PeleError', 'detectType', 'enableZoom', 'forgetTextWidths', 'mount', 'parse', 'register', 'registered', 'render', 'supports']) {
      assert.equal(typeof pele[name], 'function', 'missing export ' + name);
    }
  });

  test('detectType / supports identify the corpus', () => {
    for (const { type, source } of CORPUS) {
      assert.equal(pele.detectType(source), type, 'detectType(' + type + ')');
      assert.equal(pele.supports(source), true, 'supports(' + type + ')');
    }
    assert.equal(pele.detectType('Hello'), null);
    assert.equal(pele.supports('Hello'), false);
    assert.equal(pele.detectType('graph TD\n  A --> B'), 'flowchart');
    assert.equal(pele.detectType('sequenceDiagram\n  A->>B: Hi'), 'sequence');
  });

  test('render() returns valid pele SVG for all 18 diagram types', () => {
    for (const { type, source } of CORPUS) {
      const result = pele.render(source);
      assert.equal(result.type, type, type + ': RenderResult.type');
      assert.ok(Number.isFinite(result.width) && result.width > 0, type + ': width');
      assert.ok(Number.isFinite(result.height) && result.height > 0, type + ': height');
      assert.ok(Array.isArray(result.links), type + ': links array');
      assert.equal(typeof result.svg, 'string');
      assert.ok(result.svg.startsWith('<svg'), type + ': svg must start with <svg');
      assert.ok(result.svg.trimEnd().endsWith('</svg>'), type + ': svg must end with </svg>');
      assert.match(result.svg, /class="[^"]*pele[^"]*"/, type + ': must carry the pele class');
      assert.ok(result.svg.includes('pele-' + type), type + ': must carry pele-' + type);
      assert.ok(result.svg.includes('xmlns="http://www.w3.org/2000/svg"'), type + ': svg namespace');
      // parse the string back into the DOM: "valid SVG" without a browser
      const host = doc.createElement('div');
      host.innerHTML = result.svg;
      const root = host.querySelector('svg');
      assert.ok(root, type + ': output must parse to an <svg> element');
      assert.equal(root.tagName.toLowerCase(), 'svg');
      assert.ok((root.getAttribute('class') || '').split(/\s+/).includes('pele'), type + ': root class');
    }
  });

  test('render() is deterministic for the same source', () => {
    const source = CORPUS[0].source;
    assert.equal(pele.render(source).svg, pele.render(source).svg);
  });

  test('real pele SVG is themeable and exposes an accessible role (R5/R13 evidence)', () => {
    const result = pele.render(CORPUS[0].source);
    assert.ok(result.svg.includes('var(--pele-'), 'root style must consume --pele-* variables');
    for (const variable of ['--pele-bg', '--pele-fg', '--pele-line', '--pele-accent']) {
      assert.ok(result.svg.includes(variable), 'expected ' + variable + ' in the generated svg');
    }
    const svgTag = /<svg[^>]*>/.exec(result.svg)[0];
    assert.match(svgTag, /role="[^"]*document[^"]*"/, 'diagram must expose an accessible document role');
    assert.match(svgTag, /aria-roledescription="[^"]+"/, 'diagram must describe its role');
    assert.match(svgTag, /viewBox="[^"]*"/, 'viewBox required for scalable standalone export');
  });

  test('PeleError carries code/type/line/column/snippet for broken input', () => {
    let syntaxError = null;
    try {
      pele.render('flowchart LR\n  A -->');
    } catch (error) {
      syntaxError = error;
    }
    assert.ok(syntaxError, 'broken flowchart must throw');
    assert.ok(syntaxError instanceof pele.PeleError, 'must be a PeleError instance');
    assert.ok(syntaxError instanceof Error);
    assert.equal(syntaxError.code, 'syntax');
    assert.equal(syntaxError.type, 'flowchart');
    assert.ok(Number.isInteger(syntaxError.line) && syntaxError.line > 0, 'line: ' + syntaxError.line);
    assert.ok(Number.isInteger(syntaxError.column) && syntaxError.column > 0, 'column: ' + syntaxError.column);
    assert.ok(typeof syntaxError.snippet === 'string' && syntaxError.snippet.length > 0, 'snippet must be present');
    assert.ok(typeof syntaxError.message === 'string' && syntaxError.message.length > 0);
    // Real pele (devDependency, currently 1.9.0): an EOF error points past the last line, so the
    // quoted source is empty here ("Parse error on line 3:\n\n^"). The source line is embedded
    // whenever the failing line exists.
    assert.match(syntaxError.message, /line \d+/i);
    assert.ok(syntaxError.snippet.includes('^'), 'snippet must carry the caret marker');

    let inlineError = null;
    try {
      pele.render('sequenceDiagram\n  Alice->>Alice: x\n  bad line here');
    } catch (error) {
      inlineError = error;
    }
    assert.ok(inlineError instanceof pele.PeleError);
    assert.equal(inlineError.code, 'syntax');
    assert.equal(inlineError.type, 'sequence');
    assert.equal(inlineError.line, 3);
    assert.equal(inlineError.column, 16);
    assert.ok(inlineError.message.includes('bad line here'), 'message must embed the offending source line');
    assert.ok(inlineError.snippet.includes('bad line here'), 'snippet must embed the offending source line');

    let unsupported = null;
    try {
      pele.render('not a diagram at all');
    } catch (error) {
      unsupported = error;
    }
    assert.ok(unsupported instanceof pele.PeleError);
    assert.equal(unsupported.code, 'unsupported-diagram');
    assert.equal(unsupported.type, null);
    assert.equal(unsupported.line, 0);
    assert.equal(unsupported.column, 0);
  });

  test('PeleError reports the limit code for over-limit sources', () => {
    let limited = null;
    try {
      pele.render('flowchart LR\n  A --> B', { limit: 5 });
    } catch (error) {
      limited = error;
    }
    assert.ok(limited instanceof pele.PeleError, 'over-limit render must throw');
    assert.equal(limited.code, 'limit');
    assert.match(limited.message, /limit/i);
  });

  test('the runtime that ships as lib/pele-runtime.js is the classic script defining var pele', async () => {
    const { promises: fs } = await import('node:fs');
    const { workspacePath } = await import('./harness.mjs');
    const path = workspacePath('node_modules', 'pele', 'dist', 'pele.global.js');
    const source = await fs.readFile(path, 'utf8');
    assert.ok(source.length > 100_000, 'pele.global.js should be a substantial bundle');
    assert.match(source, /var pele\s*=/, 'the classic script must define the global var pele (SPEC §1)');
  });
}
