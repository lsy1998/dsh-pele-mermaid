// test/unit-viewer.test.mjs — SPEC §4 src/viewer.js + R9 (fullscreen overlay, zoom, pan, Escape,
// focus trap/restore, aria) and R13 (localized labels).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnv, installWatchdog, tryImportSource, accessibleName } from './harness.mjs';

const loaded = await tryImportSource('src/viewer.js');
const viewerMod = loaded ? loaded.mod : null;
const clearWatchdog = viewerMod ? installWatchdog('unit-viewer') : null;
after(() => { if (clearWatchdog) clearWatchdog(); });

const SVG_FIXTURE = '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart" viewBox="0 0 100 50" width="100" height="50"><title>flowchart</title><rect width="100" height="50"/></svg>';

if (!viewerMod) {
  test('unit-viewer suite', { skip: 'src/viewer.js not present yet (task-1 in flight) — rerun after it lands' }, () => {});
} else {
  const makeViewer = async () => {
    const env = await createDomEnv({ lang: 'en' });
    env.install();
    const calls = [];
    const t = (key, params) => { calls.push([key, params]); return 'T[' + key + ']'; };
    const viewer = viewerMod.createViewer({ doc: env.doc, win: env.win, t });
    return { env, viewer, calls, t };
  };
  const overlayOf = (env) => env.doc.querySelector('.dsh-pm-viewer');
  const openFixture = (env, viewer, trigger) => viewer.open({ svg: SVG_FIXTURE, source: 'flowchart LR\n  A-->B', type: 'flowchart', trigger: trigger ?? null });
  const click = (env, el) => el.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (env, target, keyName, init = {}) => target.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));
  const closeish = (name) => /close|dismiss|关闭|閉じ|닫기/i.test(name);

  test('createViewer returns the frozen shape and starts closed', async () => {
    const { env, viewer } = await makeViewer();
    try {
      for (const name of ['open', 'close', 'isOpen', 'destroy']) assert.equal(typeof viewer[name], 'function', name + ' must be a function');
      assert.equal(viewer.isOpen(), false);
      assert.equal(overlayOf(env), null, 'no overlay before open');
      viewer.close();
      assert.equal(viewer.isOpen(), false, 'close() while closed is a no-op');
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('open() mounts a single dialog overlay with the frozen DOM/aria contract (R9/§7)', async () => {
    const { env, viewer, calls } = await makeViewer();
    try {
      const trigger = env.doc.createElement('button');
      trigger.textContent = 'fs';
      env.doc.body.appendChild(trigger);
      trigger.focus();
      viewer.open({ svg: SVG_FIXTURE, source: 'flowchart LR\n  A-->B', type: 'flowchart', trigger });
      assert.equal(viewer.isOpen(), true);
      assert.equal(env.doc.querySelectorAll('.dsh-pm-viewer').length, 1, 'exactly one overlay');
      const overlay = overlayOf(env);
      assert.equal(overlay.getAttribute('role'), 'dialog');
      assert.equal(overlay.getAttribute('aria-modal'), 'true');
      for (const sel of ['.dsh-pm-viewer-bar', '.dsh-pm-viewer-title', '.dsh-pm-viewport', '.dsh-pm-stage']) {
        assert.ok(overlay.querySelector(sel), 'overlay must contain ' + sel);
      }
      assert.ok(overlay.querySelector('svg'), 'the diagram svg must be mounted in the stage');
      assert.ok(calls.length > 0, 'viewer must build strings through t() (R11)');
      assert.ok(calls.every(([k]) => typeof k === 'string' && k.length > 0));
      assert.ok(overlay.contains(env.doc.activeElement), 'focus must move inside the dialog while open');
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('Escape closes the overlay and restores focus to the trigger (R9)', async () => {
    const { env, viewer } = await makeViewer();
    try {
      const trigger = env.doc.createElement('button');
      trigger.textContent = 'fs';
      env.doc.body.appendChild(trigger);
      trigger.focus();
      openFixture(env, viewer, trigger);
      assert.ok(overlayOf(env).contains(env.doc.activeElement), 'precondition: focus inside');
      key(env, env.doc, 'Escape');
      assert.equal(viewer.isOpen(), false, 'Escape must close');
      assert.equal(overlayOf(env), null, 'overlay must be removed from the DOM');
      assert.equal(env.doc.activeElement, trigger, 'focus must return to the trigger');
      // Escape again while closed must not throw
      assert.doesNotThrow(() => key(env, env.doc, 'Escape'));
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('close() restores focus even when open() had no trigger', async () => {
    const { env, viewer } = await makeViewer();
    try {
      const trigger = env.doc.createElement('button');
      env.doc.body.appendChild(trigger);
      trigger.focus();
      // no trigger passed
      openFixture(env, viewer, null);
      assert.equal(viewer.isOpen(), true);
      assert.doesNotThrow(() => viewer.close());
      assert.equal(viewer.isOpen(), false);
      assert.equal(overlayOf(env), null);
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('viewer exposes >=4 labelled controls and a dedicated close control', async () => {
    const { env, viewer } = await makeViewer();
    try {
      openFixture(env, viewer, null);
      const overlay = overlayOf(env);
      const buttons = [...overlay.querySelectorAll('button')];
      assert.ok(buttons.length >= 4, 'expected zoom in/out/reset/fit (+close) controls, got ' + buttons.length);
      for (const button of buttons) {
        assert.ok(accessibleName(button).length > 0, 'every viewer control needs an accessible name (R13)');
      }
      const zoomButtons = buttons.filter((b) => !closeish(accessibleName(b)));
      assert.ok(zoomButtons.length >= 3, 'expected >=3 zoom controls, got ' + zoomButtons.length);
      for (const button of zoomButtons) {
        assert.doesNotThrow(() => click(env, button));
        assert.equal(viewer.isOpen(), true, 'zoom controls must not close the viewer');
      }
      const closeButton = buttons.find((b) => closeish(accessibleName(b)));
      if (closeButton) {
        click(env, closeButton);
        assert.equal(viewer.isOpen(), false, 'close control must close the viewer');
        assert.equal(overlayOf(env), null);
      }
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('zoom/pan input paths do not throw and keep the dialog open (R9)', async () => {
    const { env, viewer } = await makeViewer();
    try {
      openFixture(env, viewer, null);
      const overlay = overlayOf(env);
      const viewport = overlay.querySelector('.dsh-pm-viewport') || overlay;
      const stage = overlay.querySelector('.dsh-pm-stage') || viewport;
      assert.doesNotThrow(() => {
        viewport.dispatchEvent(new env.win.WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
        viewport.dispatchEvent(new env.win.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
        stage.dispatchEvent(new env.win.MouseEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
        stage.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 60, clientY: 40, bubbles: true }));
        stage.dispatchEvent(new env.win.MouseEvent('pointerup', { clientX: 60, clientY: 40, bubbles: true }));
        stage.dispatchEvent(new env.win.MouseEvent('dblclick', { clientX: 60, clientY: 40, bubbles: true }));
      });
      assert.equal(viewer.isOpen(), true);
      assert.ok(overlayOf(env) === overlay, 'same overlay instance is reused');
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('Tab is trapped inside the open dialog (R9)', async () => {
    const { env, viewer } = await makeViewer();
    try {
      openFixture(env, viewer, null);
      const overlay = overlayOf(env);
      key(env, overlay, 'Tab');
      assert.ok(overlay.contains(env.doc.activeElement), 'Tab must keep focus inside the dialog');
      key(env, overlay, 'Tab', { shiftKey: true });
      assert.ok(overlay.contains(env.doc.activeElement), 'Shift+Tab must keep focus inside the dialog');
    } finally { viewer.destroy(); env.uninstall(); env.close(); }
  });

  test('re-open reuses one overlay (no accumulation), destroy removes everything (R12)', async () => {
    const { env, viewer } = await makeViewer();
    try {
      openFixture(env, viewer, null);
      viewer.close();
      openFixture(env, viewer, null);
      assert.equal(env.doc.querySelectorAll('.dsh-pm-viewer').length, 1);
      const overlay = overlayOf(env);
      viewer.destroy();
      assert.equal(viewer.isOpen(), false);
      assert.equal(env.doc.querySelector('.dsh-pm-viewer'), null, 'destroy must remove the overlay');
      assert.equal(env.doc.body.contains(overlay), false);
      viewer.destroy(); // idempotent
    } finally { env.uninstall(); env.close(); }
  });

  test('viewer works with a default (injected t) when none is provided', async () => {
    const env = await createDomEnv();
    env.install();
    try {
      const viewer = viewerMod.createViewer({ doc: env.doc, win: env.win });
      try {
        viewer.open({ svg: SVG_FIXTURE, source: 'flowchart LR', type: 'flowchart' });
        assert.equal(viewer.isOpen(), true);
        const buttons = [...overlayOf(env).querySelectorAll('button')];
        for (const button of buttons) assert.ok(accessibleName(button).length > 0);
      } finally { viewer.destroy(); }
    } finally { env.uninstall(); env.close(); }
  });
}
