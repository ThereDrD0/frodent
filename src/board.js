import { icon, hydrateIcons } from './icons.js';
import { makeObject, validObject, fitCamera, worldPoint, zoomAt, normalizeStroke, snapshot, parseSnapshot, GRID_SIZE, snapToGrid, snapPoint, SHAPE_KINDS } from './board-model.js';
import { openBoard, initialize, allObjects, commitObject, readValue, writeMeta } from './board-storage.js';
import { fileKind, humanSize, imageSize, download, MAX_FILE } from './board-files.js';
import * as backend from './board-backend.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const board = $('#board'), world = $('#world');
const objects = new Map(), elements = new Map(), urls = new Map(), peers = new Map();
const unsavedFiles = new Map();
const readBlob = id => unsavedFiles.has(id) ? Promise.resolve(unsavedFiles.get(id)) : readValue('files', id);
const actor = crypto.randomUUID(), channel = 'BroadcastChannel' in window ? new BroadcastChannel('ryadom-board-v1') : null;
let camera = { x: 0, y: 0, zoom: 1 }, selected, tool = 'select', color = 'mint', currentShapeKind = 'rect', gesture, editing, space = false, ready = false;
let queue = Promise.resolve(), pending = 0, failure = false, toastTimer, lastBroadcast = 0;
const history = [], future = [], pointers = new Map();
let pinch;
const active = () => [...objects.values()].filter(o => !o.deleted);
const current = () => objects.get(selected);
const point = event => worldPoint({ x: event.clientX, y: event.clientY }, camera);
const center = () => worldPoint({ x: innerWidth / 2, y: innerHeight / 2 }, camera);
const send = message => channel?.postMessage({ ...message, actor });

function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500);
}
function status() {
  $('#save-status').textContent = failure ? 'Не сохранено · скачайте доску' : pending ? 'Сохраняем…' : 'Сохранено в браузере';
  $('#save-status').classList.toggle('error', failure);
  $('[data-action="undo"]').disabled = !history.length || !!editing || pending > 0;
  $('[data-action="redo"]').disabled = !future.length || !!editing || pending > 0;
}
function enqueue(job) {
  pending++; status();
  const task = queue.then(job);
  queue = task.catch(error => { failure = true; toast(error.message || 'Не удалось сохранить. Скачайте доску из меню.'); }).finally(() => { pending--; status(); });
  return queue;
}
function setCamera(next) {
  camera = next;
  world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  board.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  board.style.backgroundSize = `${GRID_SIZE * camera.zoom}px ${GRID_SIZE * camera.zoom}px`;
  $('#zoom').textContent = `${Math.round(camera.zoom * 100)}%`;
  drawPeers();
}
function fit() { setCamera(fitCamera(active(), innerWidth, innerHeight)); }
function setTool(next) {
  finishEdit(); tool = next; board.dataset.tool = tool;
  $$('button[data-tool]').forEach(button => { button.classList.toggle('active', button.dataset.tool === tool); button.setAttribute('aria-pressed', String(button.dataset.tool === tool)); });
  const hints = { select: 'Место, где мысли встречаются', hand: 'Потяните полотно, чтобы переместиться', sticky: 'Нажмите на доску, чтобы оставить мысль', text: 'Нажмите на доску, чтобы написать', pen: 'Рисуйте свободно. Пробел — переместить доску', shape: 'Потяните, чтобы нарисовать прямоугольник' };
  $('#tool-hint').textContent = hints[tool];
  if (next !== 'select') select(null);
}
function select(id) {
  selected = id;
  for (const [key, element] of elements) element.classList.toggle('selected', key === id);
  $('#selection-tools').hidden = !current() || current().deleted || tool !== 'select';
  $$('button[data-color]').forEach(button => { button.hidden = ['image', 'file'].includes(current()?.type); button.setAttribute('aria-pressed', String(current()?.color === button.dataset.color)); });
  const shapeKinds = $('#shape-kinds');
  if (shapeKinds) {
    const isShape = current()?.type === 'shape';
    shapeKinds.hidden = !isShape;
    if (isShape) {
      const activeKind = current()?.shapeKind || 'rect';
      $$('#shape-kinds button[data-shape-kind]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.shapeKind === activeKind));
      });
    }
  }
}

function positionElement(element, object) {
  element.style.left = `${object.x}px`; element.style.top = `${object.y}px`;
  element.style.width = `${object.w}px`; element.style.height = `${object.h}px`;
}
function renderObject(object, ghost = false) {
  if (!ghost && object.deleted) { elements.get(object.id)?.remove(); elements.delete(object.id); if (selected === object.id) select(null); return; }
  let element = ghost ? null : elements.get(object.id);
  if (!element) {
    element = document.createElement('div'); element.className = 'object';
    if (!ghost) { element.dataset.id = object.id; element.tabIndex = 0; element.setAttribute('role', 'group'); elements.set(object.id, element); $('#objects').append(element); }
  }
  element.dataset.type = object.type; element.dataset.color = object.color;
  element.classList.toggle('headline', !!object.headline); element.classList.toggle('small', !!object.small);
  element.classList.toggle('selected', !ghost && selected === object.id);
  positionElement(element, object);
  if (!ghost && editing?.id === object.id) return element;
  element.replaceChildren();
  if (object.type === 'text' || object.type === 'sticky') {
    const content = document.createElement('div'); content.className = 'text-content'; content.textContent = object.text;
    element.append(content); element.setAttribute('aria-label', `${object.type === 'sticky' ? 'Стикер' : 'Текст'}: ${object.text.slice(0, 90) || 'Без текста'}`);
  } else if (object.type === 'stroke') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${object.w} ${object.h}`);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', object.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' '));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path); element.append(svg); element.setAttribute('aria-label', 'Рисунок');
  } else if (object.type === 'image') {
    element.setAttribute('aria-label', `Изображение: ${object.text}`);
    if (object.asset === 'landscape') { const img = new Image(); img.src = 'assets/landscape.svg'; img.alt = object.text; element.append(img); }
    else if (object.blobId) {
      const img = new Image(); img.alt = object.text; element.append(img);
      const apply = url => { if (img.isConnected) img.src = url; };
      if (urls.has(object.blobId)) apply(urls.get(object.blobId));
      else readBlob(object.blobId).then(blob => {
        if (!blob) { img.remove(); missing(element); return; }
        if (!urls.has(object.blobId)) urls.set(object.blobId, URL.createObjectURL(blob));
        apply(urls.get(object.blobId));
      }).catch(() => missing(element));
    } else missing(element);
  } else if (object.type === 'file') {
    const symbol = document.createElement('span'); symbol.className = 'file-icon'; symbol.innerHTML = icon('document');
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('strong'); name.textContent = object.text;
    const detail = document.createElement('small'); detail.textContent = object.blobId ? `${humanSize(object.size || 0)} · Двойной клик — скачать` : 'Вложение не включено в снимок';
    info.append(name, detail); element.append(symbol, info); element.setAttribute('aria-label', `Документ: ${object.text}`);
  } else {
    const kind = object.shapeKind || 'rect';
    element.dataset.shapeKind = kind;
    const labels = { rect: 'Прямоугольник', ellipse: 'Эллипс', diamond: 'Ромб' };
    element.setAttribute('aria-label', labels[kind] || 'Фигура');
    if (kind === 'diamond') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'diamond-shape');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
      polygon.setAttribute('points', '50,1 99,50 50,99 1,50');
      svg.append(polygon); element.append(svg);
    }
  }
  if (!ghost && object.type !== 'stroke') {
    const handle = document.createElement('button'); handle.className = 'resize-handle'; handle.dataset.resize = 'true'; handle.setAttribute('aria-label', 'Изменить размер объекта'); handle.title = 'Потяните для изменения размера'; element.append(handle);
  }
  return element;
}
function missing(element) { const label = document.createElement('div'); label.className = 'missing-file'; label.textContent = 'Файл не включён в снимок. Добавьте оригинал.'; element.append(label); }
function remember(before, after) {
  history.push({ before: before ? structuredClone(before) : null, after: structuredClone(after) });
  if (history.length > 100) history.shift(); future.length = 0;
}
async function save(object, before, track = true, blob) {
  const result = await commitObject(object, before?.revision || 0, blob);
  if (!result.saved) {
    if (result.conflict) { objects.set(object.id, result.conflict); if (editing?.id !== object.id) renderObject(result.conflict); }
    return null;
  }
  objects.set(object.id, result.saved); renderObject(result.saved); send({ type: 'object', object: result.saved });
  if (track) remember(before, result.saved);
  return result.saved;
}
function add(object, blob, edit = false) {
  if (active().length >= 1000) { toast('На доске уже 1000 объектов. Скачайте её перед продолжением.'); return Promise.resolve(); }
  if (blob) unsavedFiles.set(object.blobId, blob);
  objects.set(object.id, object); renderObject(object); select(object.id);
  let result;
  return enqueue(async () => {
    result = await save(object, null, true, blob);
    if (result && blob) unsavedFiles.delete(object.blobId);
    if (result && edit) beginEdit(object.id);
  }).then(() => result);
}
function change(patch) {
  const before = current(); if (!before || before.deleted) return;
  enqueue(async () => { if (!(await save({ ...before, ...patch }, before))) toast('Объект изменён в другой вкладке. Повторите действие.'); select(selected); });
}

function draft(session) {
  try { sessionStorage.setItem('ryadom-board-draft', JSON.stringify({ ...objects.get(session.id), text: session.element.textContent })); } catch { /* beforeunload still protects failed writes. */ }
}
function beginEdit(id) {
  const object = objects.get(id);
  if (!object || object.deleted || !['text', 'sticky'].includes(object.type)) return;
  if (editing?.id === id) return;
  finishEdit(); select(id);
  const element = elements.get(id).querySelector('.text-content');
  const session = { id, element, before: structuredClone(object), revision: object.revision, conflicted: false };
  editing = session;
  element.contentEditable = 'plaintext-only'; element.setAttribute('role', 'textbox'); element.setAttribute('aria-label', 'Текст объекта');
  element.focus({ preventScroll: true });
  const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  element.addEventListener('input', () => {
    if (element.textContent.length > 20000) { element.textContent = element.textContent.slice(0, 20000); toast('Максимум 20 000 символов в одном объекте.'); }
    draft(session);
    const text = element.textContent;
    const height = Math.max(session.before.h, element.scrollHeight + (object.type === 'sticky' ? 54 : 8));
    const local = { ...objects.get(session.id), text, h: height };
    objects.set(session.id, local); positionElement(elements.get(session.id), local);
    broadcastPreview(local);
    enqueue(async () => {
      if (session.conflicted) return;
      const before = { ...session.before, revision: session.revision };
      const saved = await save({ ...local, revision: session.revision }, before, false);
      if (!saved) { session.conflicted = true; toast('Другой участник изменил этот текст. Ваш вариант будет сохранён рядом.'); return; }
      session.revision = saved.revision;
      // Newer input can be waiting behind this write; keep its visible draft.
      if (element.textContent === text) { try { sessionStorage.removeItem('ryadom-board-draft'); } catch {} }
    });
  });
  element.addEventListener('blur', finishEdit, { once: true });
  status();
}
function finishEdit() {
  const session = editing; if (!session) return;
  editing = null; session.element.contentEditable = 'false';
  const text = session.element.textContent;
  enqueue(async () => {
    if (session.conflicted) {
      const copy = { ...session.before, id: crypto.randomUUID(), revision: 0, x: session.before.x + 35, y: session.before.y + 35, text, created: Date.now() };
      const saved = await save(copy, null);
      if (saved) { select(copy.id); try { sessionStorage.removeItem('ryadom-board-draft'); } catch {} }
    } else {
      const object = objects.get(session.id);
      if (object && object.text !== session.before.text) remember(session.before, object);
      if (object) renderObject(object);
    }
    send({ type: 'preview-end' });
  });
}
function undo(redo = false) {
  finishEdit();
  enqueue(async () => {
    const source = redo ? future : history, target = redo ? history : future, entry = source.at(-1);
    if (!entry) return;
    const expected = redo ? entry.undone : entry.after;
    const object = objects.get(entry.after.id);
    if (!object || object.revision !== expected.revision) { toast('Объект уже изменён в другой вкладке. Чужое изменение не отменено.'); source.pop(); return; }
    const value = redo ? entry.after : entry.before || { ...object, deleted: true };
    const saved = await save({ ...value, id: object.id }, object, false);
    if (!saved) { toast('Не удалось отменить: объект изменился.'); return; }
    source.pop(); if (redo) entry.after = saved; else entry.undone = saved; target.push(entry);
    // Revision increments from our own undo must not look like a remote change
    // when walking further back through edits to the same object.
    const next = [...source].reverse().find(item => item.after.id === saved.id);
    if (next) { if (redo && next.undone) next.undone.revision = saved.revision; else if (!redo) next.after.revision = saved.revision; }
    select(saved.deleted ? null : saved.id);
  });
}

function preview(object) { $('#ghosts').replaceChildren(); const element = renderObject(object, true); element.classList.add('ghost'); $('#ghosts').append(element); broadcastPreview(object); }
function broadcastPreview(object) {
  if (performance.now() - lastBroadcast < 40) return;
  lastBroadcast = performance.now(); send({ type: 'preview', object });
}
function finishGesture(cancel = false) {
  const g = gesture; gesture = null; board.classList.remove('dragging'); $('#ghosts').replaceChildren(); send({ type: 'preview-end' });
  if (!g || g.type === 'pan') return;
  if (g.type === 'move' || g.type === 'resize') {
    if (cancel) { renderObject(g.before); return; }
    if (g.moved) enqueue(async () => { if (!(await save(g.next, g.before))) toast('Объект изменён в другой вкладке. Перемещение отменено.'); });
  } else if (!cancel && g.type === 'pen' && g.points.length > 1) {
    add(makeObject('stroke', 0, 0, { ...normalizeStroke(g.points), color }));
  } else if (!cancel && g.type === 'shape' && g.next?.w > 8 && g.next?.h > 8) add(g.next);
}
board.addEventListener('pointerdown', event => {
  if (!ready || event.button > 1 || $('#dialog').open) return;
  if (event.target.isContentEditable && !space) return;
  finishEdit(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); board.setPointerCapture(event.pointerId);
  if (pointers.size === 2) {
    finishGesture(true); const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), camera: { ...camera }, midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; return;
  }
  const p = point(event), node = event.target.closest('[data-id]');
  if (space || tool === 'hand' || event.button === 1 || (!node && tool === 'select')) {
    if (!node) select(null);
    gesture = { type: 'pan', x: event.clientX, y: event.clientY, camera: { ...camera } }; board.classList.add('dragging');
  } else if (tool === 'select' && node) {
    select(node.dataset.id); const object = current();
    gesture = { type: event.target.closest('[data-resize]') ? 'resize' : 'move', x: p.x, y: p.y, before: structuredClone(object), next: object, moved: false };
  } else if (tool === 'text' || tool === 'sticky') {
    const type = tool; setTool('select'); add(makeObject(type, p.x, p.y, { w: type === 'sticky' ? 240 : 300, h: type === 'sticky' ? 180 : 65, color }), undefined, true);
  } else if (tool === 'pen') gesture = { type: 'pen', points: [[p.x, p.y]] };
  else if (tool === 'shape') gesture = { type: 'shape', x: p.x, y: p.y, id: crypto.randomUUID() };
});
board.addEventListener('pointermove', event => {
  const p = point(event);
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const next = zoomAt(pinch.camera, pinch.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance), pinch.midpoint);
    setCamera({ ...next, x: next.x + midpoint.x - pinch.midpoint.x, y: next.y + midpoint.y - pinch.midpoint.y }); return;
  }
  if (!gesture) { if (performance.now() - lastBroadcast > 50) { lastBroadcast = performance.now(); send({ type: 'cursor', x: p.x, y: p.y }); } return; }
  const g = gesture;
  if (g.type === 'pan') setCamera({ ...g.camera, x: g.camera.x + event.clientX - g.x, y: g.camera.y + event.clientY - g.y });
  else if (g.type === 'move') {
    const rawX = g.before.x + p.x - g.x;
    const rawY = g.before.y + p.y - g.y;
    const nextX = event.altKey ? rawX : snapToGrid(rawX);
    const nextY = event.altKey ? rawY : snapToGrid(rawY);
    g.next = { ...g.before, x: nextX, y: nextY };
    g.moved = Math.hypot(p.x - g.x, p.y - g.y) > 2;
    positionElement(elements.get(g.before.id), g.next); broadcastPreview(g.next);
  } else if (g.type === 'resize') {
    const rawW = Math.max(GRID_SIZE, g.before.w + p.x - g.x);
    const rawH = g.before.type === 'image' ? rawW * g.before.h / g.before.w : Math.max(GRID_SIZE, g.before.h + p.y - g.y);
    const w = event.altKey ? rawW : Math.max(GRID_SIZE, snapToGrid(rawW));
    const h = g.before.type === 'image' ? rawH : (event.altKey ? rawH : Math.max(GRID_SIZE, snapToGrid(rawH)));
    g.next = { ...g.before, w, h }; g.moved = true; positionElement(elements.get(g.before.id), g.next); broadcastPreview(g.next);
  } else if (g.type === 'pen') {
    const last = g.points.at(-1);
    if (g.points.length < 10000 && Math.hypot(p.x - last[0], p.y - last[1]) > 1) g.points.push([p.x, p.y]);
    preview(makeObject('stroke', 0, 0, { ...normalizeStroke(g.points), color }));
  } else if (g.type === 'shape') {
    const minX = Math.min(g.x, p.x), minY = Math.min(g.y, p.y);
    const rawW = Math.max(1, Math.abs(p.x - g.x)), rawH = Math.max(1, Math.abs(p.y - g.y));
    const snapX = event.altKey ? minX : snapToGrid(minX);
    const snapY = event.altKey ? minY : snapToGrid(minY);
    const snapW = event.altKey ? rawW : Math.max(GRID_SIZE, snapToGrid(rawW));
    const snapH = event.altKey ? rawH : Math.max(GRID_SIZE, snapToGrid(rawH));
    g.next = makeObject('shape', snapX, snapY, { id: g.id, w: snapW, h: snapH, color, shapeKind: currentShapeKind }); preview(g.next);
  }
});
board.addEventListener('pointerup', event => { pointers.delete(event.pointerId); if (pinch) { if (pointers.size < 2) pinch = null; return; } finishGesture(); });
board.addEventListener('pointercancel', event => { pointers.delete(event.pointerId); pinch = null; finishGesture(true); });
board.addEventListener('dblclick', event => { if (tool !== 'select') return; const id = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-id]')?.dataset.id; if (id) activate(id); else { const p = point(event); add(makeObject('text', p.x, p.y, { h: 65, w: 300 }), undefined, true); } });
board.addEventListener('wheel', event => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) setCamera(zoomAt(camera, camera.zoom * Math.exp(-event.deltaY * .008), { x: event.clientX, y: event.clientY }));
  else setCamera({ ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY });
}, { passive: false });

async function activate(id) {
  const object = objects.get(id); if (!object) return;
  if (['text', 'sticky'].includes(object.type)) beginEdit(id);
  else if (object.blobId) {
    const blob = await readBlob(object.blobId);
    if (blob) download(blob, object.text); else toast('Оригинал вложения отсутствует.');
  } else if (['image', 'file'].includes(object.type)) toast('Это иллюстрация или снимок без оригинала файла.');
}
async function insertFiles(files, origin = center()) {
  if (!ready) return;
  finishEdit(); let added = 0; const errors = [];
  for (const file of [...files].slice(0, 10)) {
    try {
      const type = fileKind(file), size = type === 'image' ? await imageSize(file) : { w: 315, h: 103 };
      const object = makeObject(type, origin.x + added * 30, origin.y + added * 30, { ...size, text: file.name || 'Изображение.png', blobId: crypto.randomUUID(), size: file.size, mime: file.type });
      if (!(await add(object, file))) throw new Error(`«${file.name}» пока не сохранён. Скачайте доску для резервной копии.`);
      added++;
    } catch (error) { errors.push(error.message); }
  }
  if (files.length > 10) errors.push('За один раз можно добавить не больше 10 файлов.');
  toast(errors.length ? errors.join(' ') : `Добавлено файлов: ${added}`);
}
$('#file-input').addEventListener('change', async event => { await insertFiles(event.target.files); event.target.value = ''; });
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
  if ($('#dialog').open) return;
  if (event.dataTransfer?.files.length) void insertFiles(event.dataTransfer.files, point(event));
  else if (event.dataTransfer?.getData('text/plain')) { const p = point(event); add(makeObject('text', p.x, p.y, { text: event.dataTransfer.getData('text/plain').slice(0, 20000), w: 320, h: 100 })); }
});
document.addEventListener('paste', event => {
  if (!ready || $('#dialog').open || event.target.closest('input, textarea')) return;
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); void insertFiles(files); return; }
  if (editing) return; // plaintext-only contenteditable handles text insertion safely.
  const text = event.clipboardData?.getData('text/plain');
  if (text) { event.preventDefault(); const p = center(); add(makeObject('text', p.x, p.y, { text: text.slice(0, 20000), w: 320, h: 100 })); }
});

async function refresh() {
  for (const object of await allObjects()) {
    const current = objects.get(object.id);
    if (!current || object.revision > current.revision) { objects.set(object.id, object); if (editing?.id !== object.id && gesture?.before?.id !== object.id) renderObject(object); }
  }
}
function drawPeers() {
  $('#cursors').replaceChildren();
  for (const [id, peer] of peers) {
    if (Date.now() - peer.seen > 12000) { peers.delete(id); document.getElementById(`peer-${id}`)?.remove(); continue; }
    if (!Number.isFinite(peer.x) || !Number.isFinite(peer.y)) continue;
    const node = document.createElement('div'); node.className = 'peer-cursor'; node.style.transform = `translate(${peer.x * camera.zoom + camera.x}px,${peer.y * camera.zoom + camera.y}px)`;
    node.innerHTML = icon('cursor'); const label = document.createElement('span'); label.textContent = 'Другая вкладка'; node.append(label); $('#cursors').append(node);
  }
  $('#presence').innerHTML = '<span class="live-dot"></span>';
  $('#presence').append(document.createTextNode(peers.size ? `Локально · ${peers.size + 1} вкладки` : 'Локальная доска'));
}
if (channel) channel.onmessage = async ({ data }) => {
  if (!data || typeof data.actor !== 'string' || !/^[a-f0-9-]{36}$/.test(data.actor) || data.actor === actor) return;
  peers.set(data.actor, { ...peers.get(data.actor), seen: Date.now() });
  if (data.type === 'hello') send({ type: 'present' });
  if (data.type === 'bye') { peers.delete(data.actor); document.getElementById(`peer-${data.actor}`)?.remove(); }
  if (data.type === 'object' && validObject(data.object)) { await refresh().catch(error => toast(error.message)); document.getElementById(`peer-${data.actor}`)?.remove(); }
  if (data.type === 'title' && document.activeElement !== $('#board-title')) $('#board-title').value = await readValue('meta', 'title');
  if (data.type === 'cursor') peers.set(data.actor, { seen: Date.now(), x: data.x, y: data.y });
  if (data.type === 'preview' && validObject(data.object)) {
    document.getElementById(`peer-${data.actor}`)?.remove();
    const node = renderObject(data.object, true); node.id = `peer-${data.actor}`; node.classList.add('ghost'); $('#world').append(node);
  }
  if (data.type === 'preview-end') document.getElementById(`peer-${data.actor}`)?.remove();
  drawPeers();
};
setInterval(() => { if (ready) { send({ type: 'present' }); drawPeers(); } }, 4000);
document.addEventListener('visibilitychange', () => { if (ready && !document.hidden) void refresh().catch(error => toast(error.message)); });
window.addEventListener('beforeunload', event => { send({ type: 'bye' }); if (pending || failure) { event.preventDefault(); event.returnValue = ''; } });

async function exportBoard() {
  finishEdit(); await queue;
  const data = { format: 'ryadom-board', version: 1, title: $('#board-title').value, objects: active(), files: [] };
  let total = 0;
  for (const id of new Set(active().map(o => o.blobId).filter(Boolean))) {
    const blob = await readBlob(id); if (!blob) continue;
    total += blob.size; if (total > 35 * 1024 * 1024) throw new Error('Для экспорта доски вложения должны занимать не больше 35 МБ. Скачайте крупные файлы отдельно.');
    const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    data.files.push({ id, data: encoded });
  }
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${data.title || 'Доска'}.ryadom`);
}
async function importBoard(data, externalBlobs = new Map(), externalNames = new Map()) {
  const parsed = parseSnapshot(data), p = center(), imported = parsed.objects.filter(o => !o.deleted);
  if (active().length + imported.length > 1000) throw new Error('После импорта на доске будет больше 1000 объектов.');
  const minX = Math.min(...imported.map(o => o.x)), minY = Math.min(...imported.map(o => o.y));
  const blobs = new Map(externalBlobs);
  for (const file of parsed.files || []) {
    if (typeof file.id !== 'string' || typeof file.data !== 'string' || !/^data:[^;,]*;base64,[a-zA-Z0-9+/=]*$/.test(file.data) || file.data.length > MAX_FILE * 1.4) throw new Error('Недопустимое вложение в файле доски.');
    const [header, content] = file.data.split(',');
    const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
    blobs.set(file.id, new Blob([bytes], { type: header.slice(5, -7) }));
  }
  const prepared = [];
  for (const original of imported) {
    const blob = blobs.get(original.blobId), id = crypto.randomUUID();
    if (blob) fileKind(new File([blob], externalNames.get(original.blobId) || original.text, { type: blob.type }));
    const object = { ...original, id, revision: 0, created: Date.now(), x: p.x + original.x - minX, y: p.y + original.y - minY };
    delete object.blobId;
    if (blob) object.blobId = crypto.randomUUID();
    if (!validObject(object)) throw new Error('Импорт выходит за допустимые размеры доски.');
    prepared.push({ object, blob });
  }
  for (const { object, blob } of prepared) if (!(await add(object, blob))) throw new Error('Импорт остановлен: не удалось сохранить объект. Уже добавленные объекты доступны на доске.');
  fit(); toast('Объекты добавлены на доску. Существующие объекты сохранены.');
}
$('#import-input').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 50 * 1024 * 1024) throw new Error('Файл доски должен быть меньше 50 МБ.'); await importBoard(await file.text()); } catch (error) { toast(error.message); }
  event.target.value = '';
});

function showDialog(type = 'share') {
  finishEdit();
  const content = type === 'help' ? `<h2 id="dialog-title">Больше места для идей</h2><p>V — выделение, H или Пробел — перемещение. N — стикер, T — текст, P — карандаш, R — прямоугольник.</p><p>Двойной клик редактирует текст или скачивает вложение. Delete удаляет выбранное. Ctrl/⌘+Z отменяет, Ctrl/⌘+Shift+Z повторяет. Стрелки перемещают выбранный объект.</p><p>Колесо перемещает доску. Ctrl/⌘ + колесо меняет масштаб. На сенсорном экране потяните свободное место или используйте два пальца.</p><p>Перетащите файлы, вставьте Ctrl/⌘+V или нажмите загрузку. До 10 файлов за раз, 20 МБ на файл. PDF и Office хранятся как вложения, без встроенного редактора.</p><p class="info-box">Данные хранятся в этом браузере. Скачивайте доску для резервной копии: файл .ryadom включает вложения до 35 МБ суммарно. Старые заметки не удалены.</p>` : `<h2 id="dialog-title">Думать вместе</h2><p>Откройте эту страницу в другой вкладке того же браузера: рисуйте и пишите параллельно, следите за курсорами.</p><p class="info-box">Локальная синхронизация работает между вкладками этого браузера. Python API сохраняет серверные снимки вместе с оригиналами вложений. Совместное редактирование между устройствами пока не подключено.</p><hr><h3>Снимки на сервере</h3><p>Снимок создаёт отдельную копию объектов и файлов, не меняя текущую доску.</p>${backend.authenticated() ? '<div class="dialog-actions"><button class="text-button" data-action="logout">Выйти</button><button class="filled-button" data-action="server-save">Сохранить новый снимок</button></div><form id="server-load"><label for="snapshot-id">Числовой ID старого снимка или UUID серверной доски</label><input id="snapshot-id" maxlength="36" required><div class="dialog-actions"><button class="text-button" type="submit">Добавить снимок</button></div></form>' : '<form id="server-login" data-mode="login"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required><label id="display-name-label" for="display-name" hidden>Имя</label><input id="display-name" name="displayName" autocomplete="name" maxlength="80" hidden><label id="admin-token-label" for="admin-setup-token" hidden>Код администратора</label><input id="admin-setup-token" name="adminSetupToken" autocomplete="off" hidden><label for="password">Пароль</label><input id="password" type="password" autocomplete="current-password" required><div class="dialog-actions"><button id="server-auth-submit" class="filled-button" type="submit">Войти на сервер</button><button class="text-button" data-action="register-mode" type="button">Создать аккаунт</button></div></form>'}<div class="dialog-error" id="server-error" role="alert"></div>`;
  $('#dialog-content').innerHTML = `${content}<div class="dialog-actions"><button class="text-button" data-action="close-dialog">Закрыть</button></div>`;
  if (!$('#dialog').open) $('#dialog').showModal();
  $('#server-login')?.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      if (event.currentTarget.dataset.mode === 'register') await backend.register($('#email').value, $('#password').value, $('#display-name').value, $('#admin-setup-token').value);
      else await backend.login($('#email').value, $('#password').value);
      showDialog();
    } catch (error) { $('#server-error').textContent = error.message; } finally { button.disabled = false; }
  });
  $('#server-load')?.addEventListener('submit', async event => {
    event.preventDefault(); event.submitter.disabled = true;
    try {
      const snapshot = await backend.loadSnapshot($('#snapshot-id').value);
      if (snapshot.kind === 'legacy') await importBoard(snapshot.content);
      else {
        const data = {
          format: 'ryadom-board', version: 1, title: snapshot.board.title,
          objects: snapshot.board.objects.map(source => {
            const { attachmentId, originalName, mime, size, sha256, downloadUrl, ...object } = source;
            return { ...object, revision: 0, deleted: false, ...(attachmentId ? { blobId: attachmentId } : {}) };
          }), files: []
        };
        await importBoard(JSON.stringify(data), snapshot.files, snapshot.names);
      }
      $('#dialog').close();
    } catch (error) { $('#server-error').textContent = error.message; } finally { event.submitter.disabled = false; }
  });
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.tool) { setTool(button.dataset.tool); return; }
  if (button.dataset.color) { color = button.dataset.color; change({ color }); return; }
  if (button.dataset.shapeKind) {
    currentShapeKind = button.dataset.shapeKind;
    if (current()?.type === 'shape') change({ shapeKind: currentShapeKind });
    select(selected);
    return;
  }
  const action = button.dataset.action;
  if (action !== 'menu') { $('#board-menu').hidden = true; $('[data-action="menu"]').setAttribute('aria-expanded', 'false'); }
  try {
    if (action === 'menu') { $('#board-menu').hidden = !$('#board-menu').hidden; button.setAttribute('aria-expanded', String(!$('#board-menu').hidden)); }
    else if (action === 'files') $('#file-input').click();
    else if (action === 'import') $('#import-input').click();
    else if (action === 'export') await exportBoard();
    else if (action === 'share' || action === 'help') showDialog(action);
    else if (action === 'register-mode') {
      const form = $('#server-login'); const registering = form.dataset.mode !== 'register';
      form.dataset.mode = registering ? 'register' : 'login';
      $('#display-name-label').hidden = !registering; $('#display-name').hidden = !registering; $('#display-name').required = registering;
      $('#admin-token-label').hidden = !registering; $('#admin-setup-token').hidden = !registering;
      $('#password').minLength = registering ? 10 : 1;
      $('#server-auth-submit').textContent = registering ? 'Создать аккаунт' : 'Войти на сервер';
      button.textContent = registering ? 'Уже есть аккаунт' : 'Создать аккаунт'; $('#server-error').textContent = '';
    }
    else if (action === 'close-dialog') $('#dialog').close();
    else if (action === 'edit') await activate(selected);
    else if (action === 'delete') { finishEdit(); change({ deleted: true }); }
    else if (action === 'duplicate' && current()) { finishEdit(); const object = current(); await add({ ...object, id: crypto.randomUUID(), revision: 0, x: object.x + GRID_SIZE, y: object.y + GRID_SIZE, created: Date.now() }); }
    else if (action === 'undo' || action === 'redo') undo(action === 'redo');
    else if (action === 'fit') fit();
    else if (['zoom-in', 'zoom-out', 'reset-zoom'].includes(action)) setCamera(zoomAt(camera, action === 'reset-zoom' ? 1 : camera.zoom * (action === 'zoom-in' ? 1.2 : 1 / 1.2), { x: innerWidth / 2, y: innerHeight / 2 }));
    else if (action === 'theme') { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('ryadom.theme', theme); } catch {} }
    else if (action === 'logout') { await backend.logout(); showDialog(); }
    else if (action === 'server-save') {
      button.disabled = true; await queue;
      const result = await backend.saveSnapshot({ format: 'ryadom-board', version: 1, title: $('#board-title').value, objects: active() }, readBlob, progress => { $('#server-error').textContent = progress; });
      $('#server-error').textContent = `Создан серверный снимок ${result.id}: ${result.objects} объектов, ${result.files} вложений.`;
    }
  } catch (error) { if ($('#server-error') && $('#dialog').open) $('#server-error').textContent = error.message; else toast(error.message); }
  finally { if (action === 'server-save') button.disabled = false; }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.board-header')) { $('#board-menu').hidden = true; $('[data-action="menu"]').setAttribute('aria-expanded', 'false'); } });
$('#board-title').addEventListener('input', () => { const title = $('#board-title').value; enqueue(async () => { await writeMeta('title', title); send({ type: 'title' }); }); });
$('#board-title').addEventListener('blur', () => { if (!$('#board-title').value.trim()) { $('#board-title').value = 'Без названия'; enqueue(() => writeMeta('title', 'Без названия')); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { finishEdit(); setTool('select'); select(null); $('#board-menu').hidden = true; }
  if ($('#dialog').open || event.target.closest('input,textarea') || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); undo(event.shiftKey); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); space = true; board.style.cursor = 'grab'; }
  const shortcuts = { v: 'select', h: 'hand', n: 'sticky', t: 'text', p: 'pen', r: 'shape' };
  if (shortcuts[key]) setTool(shortcuts[key]);
  if (key === '1') fit();
  if (['delete', 'backspace'].includes(key) && current()) { event.preventDefault(); change({ deleted: true }); }
  if (key === 'enter' && current()) { event.preventDefault(); void activate(selected); }
  if (event.target.closest('[data-id]') && !current()) select(event.target.closest('[data-id]').dataset.id);
  if (current() && event.key.startsWith('Arrow')) {
    event.preventDefault(); const distance = event.shiftKey ? GRID_SIZE : 1;
    const dx = event.key === 'ArrowRight' ? distance : event.key === 'ArrowLeft' ? -distance : 0;
    const dy = event.key === 'ArrowDown' ? distance : event.key === 'ArrowUp' ? -distance : 0;
    if (event.target.matches('[data-resize]')) change({ w: Math.max(80, current().w + dx), h: Math.max(50, current().h + dy) });
    else change({ x: current().x + dx, y: current().y + dy });
  }
});
board.addEventListener('focusin', event => { const id = event.target.closest('[data-id]')?.dataset.id; if (id && !editing) select(id); });
document.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; board.style.cursor = ''; } });
window.addEventListener('blur', () => { space = false; board.style.cursor = ''; finishGesture(true); });
window.addEventListener('resize', () => { drawPeers(); });

hydrateIcons();
try { document.documentElement.dataset.theme = localStorage.getItem('ryadom.theme') === 'dark' ? 'dark' : 'light'; } catch {}
try {
  await openBoard(); await initialize();
  for (const object of await allObjects()) { objects.set(object.id, object); renderObject(object); }
  $('#board-title').value = await readValue('meta', 'title') || 'Пространство идей';
  ready = true; fit(); setTool('select'); status(); send({ type: 'hello' });
  try {
    const raw = sessionStorage.getItem('ryadom-board-draft');
    if (raw) { const value = JSON.parse(raw); if (validObject(value) && value.text !== objects.get(value.id)?.text) { await add({ ...value, id: crypto.randomUUID(), revision: 0, x: value.x + 40 }); toast('Несохранённый черновик восстановлен отдельным объектом.'); } sessionStorage.removeItem('ryadom-board-draft'); }
  } catch { toast('Не удалось восстановить черновик.'); }
} catch (error) {
  failure = true; status(); toast(`Не удалось открыть хранилище: ${error.message}`);
  $$('.tools button, #board-title').forEach(el => { el.disabled = true; });
}
