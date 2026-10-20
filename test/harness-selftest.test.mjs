// test/harness-selftest.test.mjs — guards the offline harness itself (fake Pele contract, env
// bootstrap/teardown, ctx disposers, i18n matchers, missing-artifact behaviour).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDomEnv, createFakePele, createCtx, fakeDetectType, matchMessage, messageToRegExp,
  MissingArtifactError, loadClientBundle, flushAsync, workspacePath, SKIP_MESSAGES,
} from './harness.mjs';

test('createDomEnv installs and uninstalls the DOM globals via defineProperty', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const env = await createDomEnv({ url: 'http://127.0.0.1:50661/' });
  assert.equal(env.installed, false);
  env.install();
  assert.equal(globalThis.window, env.win, 'window global');
  assert.equal(globalThis.document, env.doc, 'document global');
  assert.equal(globalThis.navigator, env.win.navigator, 'navigator global (defineProperty, never assignment)');
  assert.equal(typeof globalThis.getComputedStyle, 'function');
  assert.equal(typeof globalThis.MutationObserver, 'function');
  assert.equal(env.url, 'http://127.0.0.1:50661/');
  env.uninstall();
  assert.equal(env.installed, false);
  const after = Object.getOwnPropertyDescriptor(globalThis, 'window');
  assert.equal(after && after.value, before && before.value, 'previous window global restored');
  env.close();
});

test('createDomEnv: tokens resolve through the "*" rule for any element', async () => {
  const env = await createDomEnv();
  env.install();
  try {
    env.setTokens({ '--dsw-alias-bg-layer-2': 'rgb(1, 2, 3)' });
    const el = env.doc.createElement('div');
    env.doc.body.appendChild(el);
    assert.equal(env.win.getComputedStyle(el).getPropertyValue('--dsw-alias-bg-layer-2'), 'rgb(1, 2, 3)');
    assert.equal(env.win.getComputedStyle(env.doc.body).getPropertyValue('--dsw-alias-bg-layer-2'), 'rgb(1, 2, 3)');
  } finally { env.uninstall(); env.close(); }
});

test('createDomEnv tracks MutationObservers and document/window listeners', async () => {
  const env = await createDomEnv();
  env.install();
  try {
    const observer = new globalThis.MutationObserver(() => {});
    observer.observe(env.doc.body, { childList: true });
    assert.equal(env.observers.length, 1);
    assert.equal(env.observers[0].__dshDisconnected, false);
    observer.disconnect();
    assert.equal(env.observers[0].__dshDisconnected, true);
    env.listenerStart();
    const handler = () => {};
    env.doc.addEventListener('keydown', handler);
    assert.equal(env.listenerLeaks().length, 1);
    env.doc.removeEventListener('keydown', handler);
    assert.equal(env.listenerLeaks().length, 0);
    const controller = new AbortController();
    env.win.addEventListener('resize', handler, { signal: controller.signal });
    assert.equal(env.listenerLeaks().length, 1);
    controller.abort();
    assert.equal(env.listenerLeaks().length, 0, 'aborted listeners count as removed');
  } finally { env.uninstall(); env.close(); }
});

test('fakeDetectType covers frontmatter, directives and all 18 corpus types', () => {
  assert.equal(fakeDetectType('flowchart LR\n A-->B'), 'flowchart');
  assert.equal(fakeDetectType('---\nconfig:\n  theme: dark\n---\nflowchart LR\n A-->B'), 'flowchart');
  assert.equal(fakeDetectType('%%{init: {}}%%\nsequenceDiagram\n A->>B: hi'), 'sequence');
  assert.equal(fakeDetectType('Hello'), null);
  const expected = ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie', 'journey', 'timeline', 'mindmap', 'gitGraph', 'quadrantChart', 'requirement', 'c4', 'block', 'packet', 'sankey', 'xychart'];
  const probes = {
    flowchart: 'flowchart LR', sequence: 'sequenceDiagram\n A->>B: x', class: 'classDiagram\n class A',
    state: 'stateDiagram-v2\n [*]-->A', er: 'erDiagram\n A ||--o{ B : x', gantt: 'gantt\n title T',
    pie: 'pie title P', journey: 'journey\n title J', timeline: 'timeline\n 2020 : A',
    mindmap: 'mindmap\n root', gitGraph: 'gitGraph\n commit', quadrantChart: 'quadrantChart\n title Q',
    requirement: 'requirementDiagram\n requirement r1 {}', c4: 'C4Context\n Person(u, "U")',
    block: 'block-beta\n A', packet: 'packet-beta\n 0-7: "A"', sankey: 'sankey-beta\n A,B,1',
    xychart: 'xychart-beta\n x-axis [a]',
  };
  for (const type of expected) assert.equal(fakeDetectType(probes[type]), type, type);
});

test('createFakePele mount honours render/onRender/onError/update/destroy', async () => {
  const env = await createDomEnv();
  env.install();
  try {
    const fake = createFakePele({ fail: (source) => (source.includes('BAD') ? new Error('boom') : null) });
    const host = env.doc.createElement('div');
    env.doc.body.appendChild(host);
    const renders = [];
    const errors = [];
    const instance = fake.mount(host, 'flowchart LR\n A-->B', { onRender: (r) => renders.push(r), onError: (e) => errors.push(e), icons: () => null, links: true, linkRel: 'noopener' });
    assert.equal(renders.length, 1);
    assert.equal(renders[0].type, 'flowchart');
    assert.ok(host.querySelector('svg.pele.pele-flowchart'), 'fake svg inserted');
    assert.equal(instance.result.type, 'flowchart');
    assert.equal(fake.state.mounts.length, 1);
    instance.update('sequenceDiagram\n A->>B: hi');
    assert.equal(fake.state.updates.length, 1);
    assert.ok(host.querySelector('svg.pele-sequence'));
    instance.refresh();
    assert.equal(fake.state.refreshes.length, 1);
    instance.destroy();
    assert.deepEqual(fake.state.destroyed, [1]);
    // error path: never throws, writes textContent, reports via onError
    const bad = env.doc.createElement('div');
    assert.doesNotThrow(() => fake.mount(bad, 'flowchart LR\n BAD', { onError: (e) => errors.push(e) }));
    assert.equal(errors.length, 1);
    assert.equal(bad.textContent, 'boom');
    assert.equal(bad.querySelector('svg'), null);
  } finally { env.uninstall(); env.close(); }
});

test('createCtx runs effects immediately and disposes LIFO with error collection', () => {
  const handle = createCtx();
  const order = [];
  handle.ctx.effect(() => { order.push('a'); return () => order.push('a-clean'); }, 'a');
  handle.ctx.effect(() => { order.push('b'); return () => order.push('b-clean'); }, 'b');
  assert.deepEqual(order, ['a', 'b'], 'effects run immediately');
  assert.equal(handle.effectCount(), 2);
  handle.dispose();
  assert.deepEqual(order, ['a', 'b', 'b-clean', 'a-clean'], 'LIFO disposal');
  assert.equal(handle.isDisposed(), true);
  const failing = createCtx();
  failing.ctx.effect(() => () => { throw new Error('cleanup blew up'); });
  assert.throws(() => failing.dispose(), AggregateError);
});

test('loadClientBundle raises MissingArtifactError for a missing bundle path', async () => {
  const env = await createDomEnv();
  env.install();
  try {
    await assert.rejects(
      () => loadClientBundle(env, { path: workspacePath('lib', 'definitely-not-here.js') }),
      (error) => error instanceof MissingArtifactError && error.name === 'MissingArtifactError',
    );
    assert.match(SKIP_MESSAGES.client, /lib\/client\.js/);
  } finally { env.uninstall(); env.close(); }
});

test('message matchers are key-agnostic but template-aware', () => {
  assert.ok(messageToRegExp('{type} · Pele').test('flowchart · Pele'));
  assert.ok(messageToRegExp('{type} · Pele').test('gitGraph · Pele'));
  assert.equal(messageToRegExp('{type} · Pele').test('Pele'), false);
  const messages = { en: { toggleCode: 'Code', toggleDiagram: 'Diagram', badge: '{type} · Pele' }, other: {} };
  assert.equal(matchMessage('flowchart · Pele', messages.en), 'badge');
  assert.equal(matchMessage('Code', messages.en), 'toggleCode');
  assert.equal(matchMessage('Nope', messages.en), null);
  assert.equal(matchMessage('Code', null), null);
});

test('flushAsync drains macrotasks and microtasks deterministically', async () => {
  let done = false;
  queueMicrotask(() => { done = true; });
  await flushAsync(1);
  assert.equal(done, true);
});
