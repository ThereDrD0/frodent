export const BOARD_ID = 'workspace';
export const COLORS = ['mint', 'blue', 'neutral'];
export const TYPES = ['sticky', 'text', 'shape', 'stroke', 'image', 'file', 'connector'];
export const SIDES = ['top', 'right', 'bottom', 'left'];
export const CONNECTOR_STYLES = ['curved', 'straight'];
export const GRID_SIZE = 24;
export const SHAPE_KINDS = ['rect', 'ellipse', 'diamond'];
export function snapToGrid(value, step = GRID_SIZE) {
  return Math.round(value / step) * step;
}
export function snapPoint(point, step = GRID_SIZE) {
  return { x: snapToGrid(point.x, step), y: snapToGrid(point.y, step) };
}
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function makeObject(type, x, y, extra = {}) {
  const base = { id: crypto.randomUUID(), type, x, y, w: 240, h: 180, text: '', color: 'mint', revision: 0, deleted: false, created: Date.now() };
  if (type === 'shape' && !extra.shapeKind) base.shapeKind = 'rect';
  if (type === 'connector') base.style = extra.style || 'curved';
  return { ...base, ...extra };
}
export function validObject(o) {
  return !!o && typeof o.id === 'string' && o.id.length < 100 && TYPES.includes(o.type) &&
    ['x', 'y', 'w', 'h'].every(k => Number.isFinite(o[k]) && Math.abs(o[k]) <= 1000000) && o.w > 0 && o.h > 0 &&
    typeof o.text === 'string' && o.text.length <= 20000 && COLORS.includes(o.color) &&
    Number.isInteger(o.revision) && o.revision >= 0 && typeof o.deleted === 'boolean' && Number.isFinite(o.created) &&
    (o.blobId === undefined || (typeof o.blobId === 'string' && o.blobId.length < 100)) &&
    (o.type === 'shape' ? (o.shapeKind === undefined || SHAPE_KINDS.includes(o.shapeKind)) : o.shapeKind === undefined) &&
    (o.type !== 'stroke' || (Array.isArray(o.points) && o.points.length <= 10000 && o.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1000000)))) &&
    (o.type === 'connector'
      ? ((o.fromId == null || (typeof o.fromId === 'string' && o.fromId.length < 100)) &&
         (o.toId == null || (typeof o.toId === 'string' && o.toId.length < 100)) &&
         (o.fromSide == null || SIDES.includes(o.fromSide)) &&
         (o.toSide == null || SIDES.includes(o.toSide)) &&
         ['startX', 'startY', 'endX', 'endY'].every(k => o[k] == null || (Number.isFinite(o[k]) && Math.abs(o[k]) <= 1000000)) &&
         (o.style == null || CONNECTOR_STYLES.includes(o.style)))
      : (o.fromId == null && o.toId == null && o.fromSide == null && o.toSide == null &&
         o.startX == null && o.startY == null && o.endX == null && o.endY == null && o.style == null));
}
export function worldPoint(screen, camera) { return { x: (screen.x - camera.x) / camera.zoom, y: (screen.y - camera.y) / camera.zoom }; }
export function zoomAt(camera, next, point) {
  const zoom = clamp(next, .2, 3);
  const before = worldPoint(point, camera);
  return { x: point.x - before.x * zoom, y: point.y - before.y * zoom, zoom };
}
export function bounds(objects) {
  if (!objects.length) return { x: 0, y: 0, w: 1000, h: 600 };
  const x = Math.min(...objects.map(o => o.x)), y = Math.min(...objects.map(o => o.y));
  return { x, y, w: Math.max(...objects.map(o => o.x + o.w)) - x, h: Math.max(...objects.map(o => o.y + o.h)) - y };
}
export function fitCamera(objects, width, height) {
  const box = bounds(objects);
  const horizontalPadding = width <= 560 ? 48 : 180;
  const zoom = clamp(Math.min((width - horizontalPadding) / Math.max(box.w, 1), (height - 220) / Math.max(box.h, 1)), .2, 1.2);
  return { x: width / 2 - (box.x + box.w / 2) * zoom, y: height / 2 - (box.y + box.h / 2) * zoom + 12, zoom };
}
export function normalizeStroke(points) {
  const x = Math.min(...points.map(p => p[0])) - 4, y = Math.min(...points.map(p => p[1])) - 4;
  return { x, y, w: Math.max(...points.map(p => p[0])) - x + 4, h: Math.max(...points.map(p => p[1])) - y + 4, points: points.map(p => [p[0] - x, p[1] - y]) };
}
export function snapshot(title, objects) {
  return { format: 'ryadom-board', version: 1, title, objects: objects.filter(o => !o.deleted).map(o => {
    const { blobId, ...portable } = o;
    return blobId ? { ...portable, missingFile: true } : portable;
  }) };
}
export function parseSnapshot(text) {
  const data = JSON.parse(text);
  if (data.format !== 'ryadom-board' || data.version !== 1 || typeof data.title !== 'string' || data.title.length > 180 || !Array.isArray(data.objects) || data.objects.length > 1000 || !data.objects.every(validObject) || new Set(data.objects.map(o => o.id)).size !== data.objects.length) throw new Error('Это не поддерживаемый файл доски.');
  return data;
}
export function initialObjects() {
  const base = { revision: 1, created: 1 };
  return [
    makeObject('text', 110, 90, { ...base, id: 'intro', w: 680, h: 130, text: 'Хорошие идеи\nстановятся ближе.', headline: true }),
    makeObject('sticky', 115, 290, { ...base, id: 'idea', w: 245, h: 225, text: 'А что, если…\n\nНачать с одной смелой мысли, а дальше посмотреть, куда она приведёт?', color: 'mint' }),
    makeObject('sticky', 408, 300, { ...base, id: 'plan', w: 245, h: 225, text: 'Меньше слов.\nБольше набросков.\n\nНарисуйте то, что сложно объяснить.', color: 'blue' }),
    makeObject('image', 735, 125, { ...base, id: 'landscape', w: 315, h: 265, text: 'Немного пространства для вдохновения', asset: 'landscape' }),
    makeObject('text', 740, 415, { ...base, id: 'caption', w: 320, h: 100, text: 'Соберите всё в одном месте.\nКартинки, документы, мысли.' }),
    makeObject('stroke', 325, 220, { ...base, id: 'curve', w: 370, h: 58, color: 'mint', text: '', points: [[4,40],[40,28],[85,17],[135,12],[185,15],[235,24],[283,34],[340,38],[322,23],[340,38],[320,51]] }),
    makeObject('text', 120, 560, { ...base, id: 'hint', w: 520, h: 45, text: 'Двойной клик — редактировать. Перетащите файл — добавить.', small: true })
  ];
}

export function connectorAnchor(object, side) {
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  if (side === 'top') return { x: cx, y: object.y };
  if (side === 'bottom') return { x: cx, y: object.y + object.h };
  if (side === 'left') return { x: object.x, y: cy };
  if (side === 'right') return { x: object.x + object.w, y: cy };
  return { x: cx, y: cy };
}

export function closestSide(object, p) {
  const distances = {
    top: Math.hypot(p.x - (object.x + object.w / 2), p.y - object.y),
    bottom: Math.hypot(p.x - (object.x + object.w / 2), p.y - (object.y + object.h)),
    left: Math.hypot(p.x - object.x, p.y - (object.y + object.h / 2)),
    right: Math.hypot(p.x - (object.x + object.w), p.y - (object.y + object.h / 2))
  };
  return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
}

export function connectorEndpoints(connector, getObject) {
  const rawFrom = connector?.fromId && typeof getObject === 'function' ? getObject(connector.fromId) : null;
  const fromObj = rawFrom && !rawFrom.deleted ? rawFrom : null;
  const rawTo = connector?.toId && typeof getObject === 'function' ? getObject(connector.toId) : null;
  const toObj = rawTo && !rawTo.deleted ? rawTo : null;

  let start;
  if (fromObj) {
    start = connectorAnchor(fromObj, connector.fromSide);
  } else if (Number.isFinite(connector?.startX) && Number.isFinite(connector?.startY)) {
    start = { x: connector.startX, y: connector.startY };
  } else {
    start = { x: connector?.x ?? 0, y: connector?.y ?? 0 };
  }

  let end;
  if (toObj) {
    end = connectorAnchor(toObj, connector.toSide);
  } else if (Number.isFinite(connector?.endX) && Number.isFinite(connector?.endY)) {
    end = { x: connector.endX, y: connector.endY };
  } else {
    end = { x: (connector?.x ?? 0) + (connector?.w ?? 0), y: (connector?.y ?? 0) + (connector?.h ?? 0) };
  }

  return { start, end };
}

const SIDE_NORMALS = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

export function connectorPath(start, end, fromSide, toSide, style = 'curved') {
  if (style === 'straight') {
    const d = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    return {
      path: d,
      d,
      midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    };
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);

  const n1 = SIDE_NORMALS[fromSide] || (Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 });
  const n2 = SIDE_NORMALS[toSide] || (Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? -1 : 1, y: 0 } : { x: 0, y: dy >= 0 ? -1 : 1 });

  const offset = Math.max(dist * 0.4, 24);
  const c1 = { x: start.x + n1.x * offset, y: start.y + n1.y * offset };
  const c2 = { x: end.x + n2.x * offset, y: end.y + n2.y * offset };

  const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
  const midpoint = {
    x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * end.x,
    y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * end.y
  };

  return { path: d, d, midpoint, c1, c2 };
}
