import test from 'node:test';
import assert from 'node:assert/strict';
import { makeObject, validObject, initialObjects, worldPoint, zoomAt, fitCamera, normalizeStroke, snapshot, parseSnapshot, GRID_SIZE, snapToGrid, snapPoint, SHAPE_KINDS, SIDES, CONNECTOR_STYLES, connectorAnchor, connectorEndpoints, connectorPath, closestSide } from '../src/board-model.js';
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
test('Grid snapping and shape kind validation', () => {
  assert.equal(GRID_SIZE, 24);
  assert.equal(snapToGrid(25), 24);
  assert.equal(snapToGrid(35), 24);
  assert.equal(snapToGrid(36), 48);
  assert.deepEqual(snapPoint({ x: 25, y: 50 }), { x: 24, y: 48 });

  for (const kind of ['rect', 'ellipse', 'diamond']) {
    assert.ok(validObject(makeObject('shape', 0, 0, { shapeKind: kind })));
  }
  assert.equal(validObject(makeObject('shape', 0, 0, { shapeKind: 'hexagon' })), false);
  assert.equal(validObject(makeObject('sticky', 0, 0, { shapeKind: 'rect' })), false);
});
test('Connector validation, endpoint resolution and path calculation', () => {
  assert.deepEqual(SIDES, ['top', 'right', 'bottom', 'left']);
  assert.deepEqual(CONNECTOR_STYLES, ['curved', 'straight']);

  const conn = makeObject('connector', 10, 20);
  assert.equal(conn.type, 'connector');
  assert.equal(conn.style, 'curved');
  assert.ok(validObject(conn));

  const fullConn = makeObject('connector', 0, 0, {
    fromId: 'obj-1',
    toId: 'obj-2',
    fromSide: 'right',
    toSide: 'left',
    startX: 10,
    startY: 20,
    endX: 100,
    endY: 200,
    style: 'straight'
  });
  assert.ok(validObject(fullConn));

  assert.equal(validObject(makeObject('connector', 0, 0, { fromSide: 'diagonal' })), false);
  assert.equal(validObject(makeObject('connector', 0, 0, { toSide: 'center' })), false);
  assert.equal(validObject(makeObject('connector', 0, 0, { style: 'zigzag' })), false);
  assert.equal(validObject(makeObject('connector', 0, 0, { startX: Infinity })), false);
  assert.equal(validObject(makeObject('connector', 0, 0, { startX: 1_500_000 })), false);
  assert.equal(validObject(makeObject('connector', 0, 0, { shapeKind: 'rect' })), false);

  assert.equal(validObject(makeObject('sticky', 0, 0, { fromId: 'obj-1' })), false);
  assert.equal(validObject(makeObject('text', 0, 0, { style: 'curved' })), false);
  assert.equal(validObject(makeObject('shape', 0, 0, { startX: 50 })), false);

  const box = { x: 100, y: 50, w: 200, h: 100 };
  assert.deepEqual(connectorAnchor(box, 'top'), { x: 200, y: 50 });
  assert.deepEqual(connectorAnchor(box, 'bottom'), { x: 200, y: 150 });
  assert.deepEqual(connectorAnchor(box, 'left'), { x: 100, y: 100 });
  assert.deepEqual(connectorAnchor(box, 'right'), { x: 300, y: 100 });
  assert.deepEqual(connectorAnchor(box, 'other'), { x: 200, y: 100 });

  const objMap = {
    'box-a': { x: 0, y: 0, w: 100, h: 100 },
    'box-b': { x: 300, y: 200, w: 100, h: 100 }
  };
  const getObject = id => objMap[id];

  const boundEndpoints = connectorEndpoints({
    fromId: 'box-a', fromSide: 'right',
    toId: 'box-b', toSide: 'left'
  }, getObject);
  assert.deepEqual(boundEndpoints, {
    start: { x: 100, y: 50 },
    end: { x: 300, y: 250 }
  });

  const freeEndpoints = connectorEndpoints({
    startX: 15, startY: 25, endX: 150, endY: 250
  }, getObject);
  assert.deepEqual(freeEndpoints, {
    start: { x: 15, y: 25 },
    end: { x: 150, y: 250 }
  });

  const fallbackEndpoints = connectorEndpoints({ x: 50, y: 60, w: 200, h: 100 }, getObject);
  assert.deepEqual(fallbackEndpoints, {
    start: { x: 50, y: 60 },
    end: { x: 250, y: 160 }
  });

  const straightPath = connectorPath({ x: 0, y: 0 }, { x: 100, y: 100 }, 'right', 'left', 'straight');
  assert.equal(straightPath.path, 'M 0 0 L 100 100');
  assert.deepEqual(straightPath.midpoint, { x: 50, y: 50 });

  const curvedPath = connectorPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 'right', 'left', 'curved');
  assert.ok(curvedPath.path.startsWith('M 0 0 C '));
  assert.ok(curvedPath.path.endsWith(', 200 0'));
  assert.ok(Number.isFinite(curvedPath.midpoint.x) && Number.isFinite(curvedPath.midpoint.y));

  // Null and undefined checks for free connectors
  const nullConnector = makeObject('connector', 0, 0, {
    fromId: null,
    toId: null,
    fromSide: null,
    toSide: null,
    startX: 10,
    startY: 20,
    endX: null,
    endY: undefined,
    style: null
  });
  assert.ok(validObject(nullConnector));

  const undefinedConnector = makeObject('connector', 0, 0, {
    fromId: undefined,
    toId: undefined,
    fromSide: undefined,
    toSide: undefined,
    startX: 10,
    startY: 20,
    endX: 100,
    endY: 200,
    style: undefined
  });
  assert.ok(validObject(undefinedConnector));

  // closestSide checks
  const targetBox = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(closestSide(targetBox, { x: 200, y: 50 }), 'top');
  assert.equal(closestSide(targetBox, { x: 200, y: 250 }), 'bottom');
  assert.equal(closestSide(targetBox, { x: 50, y: 150 }), 'left');
  assert.equal(closestSide(targetBox, { x: 350, y: 150 }), 'right');

  // Deleted endpoint targets fallback to free coordinates
  const deletedObjMap = {
    'box-active': { x: 0, y: 0, w: 100, h: 100, deleted: false },
    'box-deleted': { x: 300, y: 200, w: 100, h: 100, deleted: true }
  };
  const deletedEndpoints = connectorEndpoints({
    fromId: 'box-active', fromSide: 'right',
    toId: 'box-deleted', toSide: 'left',
    endX: 500, endY: 400
  }, id => deletedObjMap[id]);
  assert.deepEqual(deletedEndpoints, {
    start: { x: 100, y: 50 },
    end: { x: 500, y: 400 }
  });
});
