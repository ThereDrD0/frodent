import test from 'node:test';
import assert from 'node:assert/strict';
import { makeObject, validObject, initialObjects, worldPoint, zoomAt, fitCamera, normalizeStroke, snapshot, parseSnapshot, GRID_SIZE, snapToGrid, snapPoint, SHAPE_KINDS, SIDES, CONNECTOR_STYLES, connectorAnchor, connectorEndpoints, connectorPath, closestSide, matchSearch, getMinimapWorldBounds, getMinimapProjection, worldToMinimap, minimapToWorld, getMinimapViewportRect } from '../src/board-model.js';
import { icon } from '../src/icons.js';
import { fileKind, MAX_FILE, renderBoardSvg, escapeXml } from '../src/board-files.js';

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
  assert.deepEqual(CONNECTOR_STYLES, ['curved', 'straight', 'orthogonal']);

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

  const orthoPath = connectorPath({ x: 0, y: 0 }, { x: 100, y: 100 }, 'right', 'left', 'orthogonal');
  assert.ok(orthoPath.path.startsWith('M 0 0 L '));
  assert.ok(orthoPath.path.endsWith(' 100 100'));
  assert.ok(Number.isFinite(orthoPath.midpoint.x) && Number.isFinite(orthoPath.midpoint.y));

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

  // Orthogonal style connector validation and path segment checks
  const orthoConn = makeObject('connector', 0, 0, { style: 'orthogonal', startX: 10, startY: 20, endX: 200, endY: 150 });
  assert.ok(validObject(orthoConn));
  assert.equal(orthoConn.style, 'orthogonal');

  const testCases = [
    { start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, fromSide: 'right', toSide: 'left' },
    { start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, fromSide: 'bottom', toSide: 'top' },
    { start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, fromSide: 'right', toSide: 'top' },
    { start: { x: 100, y: 100 }, end: { x: 0, y: 0 }, fromSide: 'left', toSide: 'right' }
  ];

  for (const tc of testCases) {
    const res = connectorPath(tc.start, tc.end, tc.fromSide, tc.toSide, 'orthogonal');
    assert.ok(res.path.startsWith('M '));
    // Все сегменты должны быть строго горизонтальными или вертикальными
    const coords = res.path.replace(/[ML]/g, '').trim().split(/\s+/).map(Number);
    for (let i = 0; i < coords.length - 2; i += 2) {
      const x1 = coords[i], y1 = coords[i + 1], x2 = coords[i + 2], y2 = coords[i + 3];
      assert.ok(x1 === x2 || y1 === y2, `Segment (${x1},${y1})-(${x2},${y2}) is not orthogonal`);
    }
    assert.ok(Number.isFinite(res.midpoint.x) && Number.isFinite(res.midpoint.y));
  }

  // Bounds for marquee intersection using connectorEndpoints
  const testConn = makeObject('connector', 0, 0, { startX: 150, startY: 250, endX: 50, endY: 50 });
  const ep = connectorEndpoints(testConn, () => null);
  const bMinX = Math.min(ep.start.x, ep.end.x), bMaxX = Math.max(ep.start.x, ep.end.x);
  const bMinY = Math.min(ep.start.y, ep.end.y), bMaxY = Math.max(ep.start.y, ep.end.y);
  assert.equal(bMinX, 50);
  assert.equal(bMaxX, 150);
  assert.equal(bMinY, 50);
  assert.equal(bMaxY, 250);
});

test('Vector SVG export generates clean standalone SVG with all element types and escaping', async () => {
  assert.equal(escapeXml('Hello & <world> "test" \'single\''), 'Hello &amp; &lt;world&gt; &quot;test&quot; &apos;single&apos;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');

  // Пустая доска
  const emptySvgRes = await renderBoardSvg('Пустая доска', []);
  assert.ok(emptySvgRes.svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(emptySvgRes.svg.includes('<title>Пустая доска</title>'));
  assert.ok(Number.isFinite(emptySvgRes.width) && emptySvgRes.width > 0);
  assert.ok(Number.isFinite(emptySvgRes.height) && emptySvgRes.height > 0);

  // Набор объектов всех типов
  const sampleObjects = [
    makeObject('sticky', 100, 100, { text: 'Стикер с идеей & заметкой', color: 'mint', w: 200, h: 150 }),
    makeObject('text', 350, 100, { text: 'Заголовок проекта', headline: true, w: 300, h: 80 }),
    makeObject('shape', 100, 300, { shapeKind: 'rect', text: 'Прямоугольник', color: 'blue', w: 180, h: 100 }),
    makeObject('shape', 320, 300, { shapeKind: 'ellipse', text: 'Эллипс', color: 'neutral', w: 120, h: 100 }),
    makeObject('shape', 480, 300, { shapeKind: 'diamond', text: 'Ромб', color: 'mint', w: 100, h: 100 }),
    makeObject('stroke', 100, 450, { points: [[0, 0], [50, 20], [100, 10]], color: 'mint', w: 100, h: 20 }),
    makeObject('connector', 0, 0, { startX: 200, startY: 175, endX: 350, endY: 350, style: 'curved', color: 'mint', text: 'Связь 1' }),
    makeObject('connector', 0, 0, { startX: 280, startY: 350, endX: 320, endY: 350, style: 'orthogonal', color: 'blue', text: 'Поток' }),
    makeObject('file', 100, 500, { text: 'document.pdf', w: 220, h: 60 }),
    makeObject('image', 350, 500, { text: 'landscape.svg', asset: 'landscape', w: 200, h: 120 }),
    makeObject('sticky', 800, 800, { text: 'Удаленный стикер', deleted: true })
  ];

  const res = await renderBoardSvg('Тестовая доска <Экспорт>', sampleObjects);
  const svg = res.svg;

  // XML и заголовок
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes('<title>Тестовая доска &lt;Экспорт&gt;</title>'));
  assert.ok(svg.includes('viewBox="'));

  // Defs с маркерами стрелок
  assert.ok(svg.includes('id="arrowhead-mint"'));
  assert.ok(svg.includes('id="arrowhead-blue"'));
  assert.ok(svg.includes('id="arrowhead-neutral"'));

  // Объекты
  assert.ok(svg.includes('Стикер с идеей &amp;'));
  assert.ok(svg.includes('заметкой'));
  assert.ok(svg.includes('Заголовок'));
  assert.ok(svg.includes('проекта'));
  assert.ok(svg.includes('Прямоугольник'));
  assert.ok(svg.includes('Эллипс'));
  assert.ok(svg.includes('Ромб'));
  assert.ok(svg.includes('document.pdf'));
  assert.ok(svg.includes('Связь 1'));
  assert.ok(svg.includes('Поток'));
  assert.ok(svg.includes('marker-end="url(#arrowhead-mint)"'));
  assert.ok(svg.includes('marker-end="url(#arrowhead-blue)"'));

  // Удаленный объект не должен попадать в SVG
  assert.equal(svg.includes('Удаленный стикер'), false);

  // Размеры
  assert.ok(res.width >= 580);
  assert.ok(res.height >= 520);
});

test('Full-text search matching across sticks, shapes, connectors, texts, files and images', () => {
  const sticky = makeObject('sticky', 0, 0, { text: 'План запуска проекта' });
  const shape = makeObject('shape', 0, 0, { text: 'Блок-схема авторизации' });
  const text = makeObject('text', 0, 0, { text: 'Важное уведомление для команды' });
  const connector = makeObject('connector', 0, 0, { text: 'Связь с базой данных' });
  const file = makeObject('file', 0, 0, { text: 'отчет_финал_2026.pdf' });
  const image = makeObject('image', 0, 0, { text: 'Архитектура_системы.png' });
  const deletedSticky = makeObject('sticky', 0, 0, { text: 'Секретный удаленный план', deleted: true });

  assert.equal(matchSearch(sticky, 'план'), true);
  assert.equal(matchSearch(sticky, 'ПРОЕКТА'), true);
  assert.equal(matchSearch(shape, 'авторизац'), true);
  assert.equal(matchSearch(text, 'команды'), true);
  assert.equal(matchSearch(connector, 'базой данных'), true);
  assert.equal(matchSearch(file, '2026.pdf'), true);
  assert.equal(matchSearch(image, 'архитектура'), true);

  // Удаленный объект
  assert.equal(matchSearch(deletedSticky, 'план'), false);

  // Пустой запрос или пробелы
  assert.equal(matchSearch(sticky, ''), false);
  assert.equal(matchSearch(sticky, '   '), false);
  assert.equal(matchSearch(sticky, null), false);
  assert.equal(matchSearch(null, 'план'), false);

  // Несовпадающий запрос
  assert.equal(matchSearch(sticky, 'несуществующий текст'), false);
});

test('Minimap world bounds, projection and coordinate conversions', () => {
  // Проверка иконки
  const mapSvg = icon('map');
  assert.ok(mapSvg.includes('<svg'));
  assert.ok(mapSvg.includes('d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15"'));

  // Проверка getMinimapWorldBounds без viewport
  const objs = [
    { x: 100, y: 100, w: 200, h: 100 }
  ];
  // bounds: x: 100, y: 100, w: 200, h: 100 -> minX=100-120=-20, minY=100-120=-20, maxX=300+120=420, maxY=200+120=320
  // spanX: 440 < minSpanX(1600) => w = 1600; spanY: 340 < minSpanY(1000) => h = 1000
  // cx = (-20 + 420) / 2 = 200; cy = (-20 + 320) / 2 = 150
  const b1 = getMinimapWorldBounds(objs);
  assert.equal(b1.w, 1600);
  assert.equal(b1.h, 1000);
  assert.equal(b1.minX, 200 - 800); // -600
  assert.equal(b1.maxX, 200 + 800); // 1000
  assert.equal(b1.minY, 150 - 500); // -350
  assert.equal(b1.maxY, 150 + 500); // 650

  // Проверка с viewport
  const vp = { x: -500, y: -400, w: 2000, h: 1200 };
  const b2 = getMinimapWorldBounds(objs, vp, 50, 1000, 800);
  // minX = Math.min(100, -500) - 50 = -550
  // minY = Math.min(100, -400) - 50 = -450
  // maxX = Math.max(300, 1500) + 50 = 1550
  // maxY = Math.max(200, 800) + 50 = 850
  // w = Math.max(2100, 1000) = 2100; h = Math.max(1300, 800) = 1300
  // cx = (-550 + 1550) / 2 = 500; cy = (-450 + 850) / 2 = 200
  assert.equal(b2.w, 2100);
  assert.equal(b2.h, 1300);
  assert.equal(b2.minX, 500 - 1050);
  assert.equal(b2.maxX, 500 + 1050);

  // Проверка getMinimapProjection
  const proj = getMinimapProjection(b1, 200, 150, 10);
  // availW = 180, availH = 130, worldW = 1600, worldH = 1000
  // scale = Math.min(180/1600, 130/1000) = Math.min(0.1125, 0.13) = 0.1125
  assert.equal(proj.scale, 180 / 1600);
  assert.equal(proj.worldMinX, b1.minX);
  assert.equal(proj.worldMinY, b1.minY);

  // Проверка worldToMinimap и minimapToWorld
  const worldPt = { x: 120, y: 250 };
  const miniPt = worldToMinimap(worldPt, proj);
  const revertedWorldPt = minimapToWorld(miniPt, proj);
  assert.ok(Math.abs(revertedWorldPt.x - worldPt.x) < 1e-9);
  assert.ok(Math.abs(revertedWorldPt.y - worldPt.y) < 1e-9);

  // Проверка getMinimapViewportRect
  const camera = { x: -200, y: -100, zoom: 1 };
  const vpRect = getMinimapViewportRect(camera, 800, 600, proj);
  assert.ok(vpRect.w >= 6);
  assert.ok(vpRect.h >= 6);
  assert.equal(vpRect.w, 800 * proj.scale);
  assert.equal(vpRect.h, 600 * proj.scale);

  // Проверка минимального размера рамки viewport при большом зуме
  const tinyVpRect = getMinimapViewportRect({ x: 0, y: 0, zoom: 100 }, 10, 10, proj);
  assert.equal(tinyVpRect.w, 6);
  assert.equal(tinyVpRect.h, 6);

  // Проверка пустой доски
  const emptyBounds = getMinimapWorldBounds([]);
  assert.ok(emptyBounds.w >= 1600);
  assert.ok(emptyBounds.h >= 1000);
  const emptyProj = getMinimapProjection(emptyBounds, 220, 140);
  assert.ok(emptyProj.scale > 0);

  // Фолбэк зума для миникарты (zoom <= 0, zoom undefined, camera null)
  const fallbackVp1 = getMinimapViewportRect(null, 800, 600, emptyProj);
  assert.ok(fallbackVp1.w >= 6);
  assert.ok(fallbackVp1.h >= 6);
  assert.equal(fallbackVp1.w, 800 * emptyProj.scale);

  const fallbackVp2 = getMinimapViewportRect({ x: 0, y: 0, zoom: 0 }, 800, 600, emptyProj);
  assert.ok(fallbackVp2.w >= 6);
  assert.ok(fallbackVp2.h >= 6);
  assert.equal(fallbackVp2.w, 800 * emptyProj.scale);

  const fallbackVp3 = getMinimapViewportRect({ x: 0, y: 0, zoom: -5 }, 800, 600, emptyProj);
  assert.ok(fallbackVp3.w >= 6);
  assert.ok(fallbackVp3.h >= 6);
  assert.equal(fallbackVp3.w, 800 * emptyProj.scale);
});
