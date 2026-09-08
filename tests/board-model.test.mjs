import test from 'node:test';
import assert from 'node:assert/strict';
import { makeObject, validObject, initialObjects, worldPoint, zoomAt, fitCamera, normalizeStroke, snapshot, parseSnapshot } from '../src/board-model.js';
import { fileKind, MAX_FILE } from '../src/board-files.js';

test('Seed and newly created objects pass schema validation', () => {
  assert.ok(initialObjects().every(validObject));
  assert.ok(validObject(makeObject('text', -100, 200)));
  assert.notEqual(makeObject('text', 0, 0).id, makeObject('text', 0, 0).id);
});
test('Malformed coordinates, points and oversized text are rejected', () => {
  assert.equal(validObject(makeObject('text', NaN, 0)), false);
  assert.equal(validObject(makeObject('text', 0, 0, { text: 'x'.repeat(20001) })), false);
  assert.equal(validObject(makeObject('stroke', 0, 0, { points: [[Infinity, 0]] })), false);
});
test('Zoom keeps the point under the cursor stationary and clamps limits', () => {
  const camera = { x: 100, y: -25, zoom: .8 }, p = { x: 700, y: 300 };
  assert.deepEqual(worldPoint(p, zoomAt(camera, 2, p)), worldPoint(p, camera));
  assert.equal(zoomAt(camera, 100, p).zoom, 3);
  assert.equal(zoomAt(camera, -1, p).zoom, .2);
});
test('Fit bounds are finite on an empty board and a small viewport', () => {
  assert.ok(Object.values(fitCamera([], 320, 600)).every(Number.isFinite));
  assert.ok(fitCamera(initialObjects(), 1440, 900).zoom > .5);
});
test('Stroke normalization preserves world positions', () => {
  const points = [[-50, 20], [60, -30]], stroke = normalizeStroke(points);
  assert.deepEqual(stroke.points.map(p => [p[0] + stroke.x, p[1] + stroke.y]), points);
  assert.ok(stroke.w > 0 && stroke.h > 0);
});
test('Server snapshots intentionally omit local blobs and retain missing markers', () => {
  const o = makeObject('image', 0, 0, { blobId: 'private-blob' });
  const data = snapshot('Board', [o]);
  assert.equal(data.objects[0].blobId, undefined);
  assert.equal(data.objects[0].missingFile, true);
  assert.equal(parseSnapshot(JSON.stringify(data)).title, 'Board');
});
test('Snapshot parser rejects other formats and duplicate object IDs', () => {
  assert.throws(() => parseSnapshot('{"format":"notes"}'));
  const o = makeObject('text', 0, 0);
  assert.throws(() => parseSnapshot(JSON.stringify({ ...snapshot('x', [o]), objects: [o, o] })));
});
test('Files accept common images and documents, reject active SVG and size overflow', () => {
  assert.equal(fileKind({ name: 'image.png', type: 'image/png', size: 100 }), 'image');
  assert.equal(fileKind({ name: 'report.PDF', type: '', size: 100 }), 'file');
  assert.equal(fileKind({ name: 'table.xlsx', type: '', size: 100 }), 'file');
  assert.throws(() => fileKind({ name: 'active.svg', type: 'image/svg+xml', size: 100 }));
  assert.throws(() => fileKind({ name: 'large.pdf', size: MAX_FILE + 1 }));
  assert.throws(() => fileKind({ name: 'empty.txt', size: 0 }));
});
