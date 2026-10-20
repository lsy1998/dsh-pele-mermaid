// test/unit-zoom.test.mjs - the shared zoom/pan module (SPEC R9). It owns the scale/translate
// state, the clamping, the zoom-at-point, the pan, fit-to-window, reset and the transform
// application, and it is used by BOTH the inline pane and the fullscreen overlay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryImportSource } from './harness.mjs';

const loaded = await tryImportSource('src/zoom.js');
const zoomMod = loaded ? loaded.mod : null;

if (!zoomMod) {
  test('unit-zoom suite', { skip: 'src/zoom.js not present yet - rerun after it lands' }, () => {});
} else {
  const { createZoomState, applyTransform, measureSvg, clamp, round, MIN_SCALE, MAX_SCALE, ZOOM_STEP } = zoomMod;

  test('the module exports the shared vocabulary', () => {
    for (const name of ['createZoomState', 'applyTransform', 'measureSvg', 'clamp', 'round']) {
      assert.equal(typeof zoomMod[name], 'function', name + ' must be exported');
    }
    assert.equal(MIN_SCALE, 0.1);
    assert.equal(MAX_SCALE, 8);
    assert.equal(ZOOM_STEP, 1.25);
  });

  test('clamp keeps the scale inside [MIN_SCALE, MAX_SCALE]', () => {
    assert.equal(clamp(0.01, MIN_SCALE, MAX_SCALE), MIN_SCALE);
    assert.equal(clamp(100, MIN_SCALE, MAX_SCALE), MAX_SCALE);
    assert.equal(clamp(2, MIN_SCALE, MAX_SCALE), 2);
    assert.equal(clamp(NaN, MIN_SCALE, MAX_SCALE), MIN_SCALE);
  });

  test('round rounds to the requested number of decimals', () => {
    assert.equal(round(1.23456, 2), 1.23);
    assert.equal(round(1.23456, 4), 1.2346);
  });

  test('createZoomState starts at the identity transform and clamps the initial scale', () => {
    const zoom = createZoomState();
    assert.equal(zoom.scale, 1);
    assert.equal(zoom.tx, 0);
    assert.equal(zoom.ty, 0);
    assert.equal(createZoomState({ scale: 100 }).scale, MAX_SCALE);
    assert.equal(createZoomState({ scale: 0.0001 }).scale, MIN_SCALE);
  });

  test('zoomAtPoint keeps the content point under the pointer', () => {
    const zoom = createZoomState({ tx: 10, ty: 20 });
    zoom.zoomAtPoint(2, 100, 50);
    assert.equal(zoom.scale, 2);
    const beforeX = (100 - 10) / 1;
    const afterX = (100 - zoom.tx) / 2;
    assert.ok(Math.abs(afterX - beforeX) < 1e-9, 'the x anchor moved: ' + zoom.tx);
    const beforeY = (50 - 20) / 1;
    const afterY = (50 - zoom.ty) / 2;
    assert.ok(Math.abs(afterY - beforeY) < 1e-9, 'the y anchor moved: ' + zoom.ty);
  });

  test('zoomAtPoint reports whether the scale changed and refuses invalid factors', () => {
    const zoom = createZoomState();
    assert.equal(zoom.zoomAtPoint(1, 0, 0), false, 'a factor of 1 changes nothing');
    assert.equal(zoom.zoomAtPoint(0, 0, 0), false, 'a factor of 0 is invalid');
    assert.equal(zoom.zoomAtPoint(-1, 0, 0), false, 'a negative factor is invalid');
    assert.equal(zoom.zoomAtPoint(2, 0, 0), true);
  });

  test('panBy translates and reset clears the state', () => {
    const zoom = createZoomState({ scale: 2, tx: 5, ty: 6 });
    zoom.panBy(10, -3);
    assert.equal(zoom.tx, 15);
    assert.equal(zoom.ty, 3);
    zoom.reset();
    assert.equal(zoom.scale, 1);
    assert.equal(zoom.tx, 0);
    assert.equal(zoom.ty, 0);
  });

  test('fitToWindow scales the diagram into the viewport and centers it', () => {
    const zoom = createZoomState({ naturalWidth: 1000, naturalHeight: 500 });
    zoom.fitToWindow(500, 500);
    assert.equal(zoom.scale, 0.5);
    assert.equal(zoom.tx, 0, 'the diagram is exactly as wide as the viewport');
    assert.equal(zoom.ty, 125, 'the diagram is centered vertically');
  });

  test('resetToNatural returns to 100% and centers', () => {
    const zoom = createZoomState({ naturalWidth: 400, naturalHeight: 200 });
    zoom.resetToNatural(400, 200);
    assert.equal(zoom.scale, 1);
    assert.equal(zoom.tx, 0);
    assert.equal(zoom.ty, 0);
  });

  test('snapshot and restore round-trip the state', () => {
    const zoom = createZoomState({ scale: 3, tx: 12, ty: -4 });
    const saved = zoom.snapshot();
    zoom.reset();
    zoom.restore(saved);
    assert.equal(zoom.scale, 3);
    assert.equal(zoom.tx, 12);
    assert.equal(zoom.ty, -4);
  });

  test('measureSvg reads the width/height attributes, then the viewBox', () => {
    const element = {
      getAttribute(name) {
        return { width: '320', height: '180', viewBox: '0 0 640 360' }[name] || null;
      },
    };
    const size = measureSvg(element);
    assert.equal(size.width, 320);
    assert.equal(size.height, 180);
    const onlyViewBox = { getAttribute: (n) => (n === 'viewBox' ? '0 0 640 360' : null) };
    assert.deepEqual(measureSvg(onlyViewBox), { width: 640, height: 360 });
  });

  test('measureSvg ignores percentage sizes (they are not an intrinsic size)', () => {
    const element = { getAttribute: (n) => ({ width: '100%', height: '100%' }[n] || null) };
    assert.deepEqual(measureSvg(element), { width: 0, height: 0 });
  });

  test('applyTransform writes a transform and a transform-origin', () => {
    const target = { style: {} };
    const zoom = createZoomState({ scale: 2, tx: 10, ty: 20 });
    applyTransform(target, zoom, { mode: 'transform' });
    assert.equal(target.style.transform, 'translate(10px, 20px) scale(2)');
    assert.equal(target.style.transformOrigin, '0 0');
  });

  test('applyTransform in size mode sets the layout size instead of a scale', () => {
    const target = { style: {} };
    const zoom = createZoomState({ scale: 1.5, tx: 4, ty: 5 });
    applyTransform(target, zoom, { mode: 'size', natural: { width: 200, height: 100 } });
    assert.equal(target.style.width, '300px');
    assert.equal(target.style.height, '150px');
    assert.equal(target.style.maxWidth, 'none');
    assert.equal(target.style.transform, undefined, 'the size mode must not use a transform');
  });
}
