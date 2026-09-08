export const BOARD_ID = 'workspace';
export const COLORS = ['mint', 'blue', 'neutral'];
export const TYPES = ['sticky', 'text', 'shape', 'stroke', 'image', 'file'];
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function makeObject(type, x, y, extra = {}) {
  return { id: crypto.randomUUID(), type, x, y, w: 240, h: 180, text: '', color: 'mint', revision: 0, deleted: false, created: Date.now(), ...extra };
}
export function validObject(o) {
  return !!o && typeof o.id === 'string' && o.id.length < 100 && TYPES.includes(o.type) &&
    ['x', 'y', 'w', 'h'].every(k => Number.isFinite(o[k]) && Math.abs(o[k]) <= 1000000) && o.w > 0 && o.h > 0 &&
    typeof o.text === 'string' && o.text.length <= 20000 && COLORS.includes(o.color) &&
    Number.isInteger(o.revision) && o.revision >= 0 && typeof o.deleted === 'boolean' && Number.isFinite(o.created) &&
    (o.blobId === undefined || (typeof o.blobId === 'string' && o.blobId.length < 100)) &&
    (o.type !== 'stroke' || (Array.isArray(o.points) && o.points.length <= 10000 && o.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1000000))));
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
