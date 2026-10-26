import { icon, hydrateIcons } from './icons.js';
import { makeObject, validObject, fitCamera, worldPoint, zoomAt, normalizeStroke, snapshot, parseSnapshot, GRID_SIZE, snapToGrid, snapPoint, SHAPE_KINDS, connectorAnchor, connectorEndpoints, connectorPath, SIDES, CONNECTOR_STYLES, closestSide, matchSearch } from './board-model.js';
import { openBoard, initialize, allObjects, commitObject, readValue, writeMeta } from './board-storage.js';
import { fileKind, humanSize, imageSize, download, MAX_FILE, exportBoardSvg, exportBoardPng, copyBoardPng } from './board-files.js';
import * as backend from './board-backend.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const board = $('#board'), world = $('#world');
const objects = new Map(), elements = new Map(), urls = new Map(), peers = new Map();
const unsavedFiles = new Map();
const readBlob = id => unsavedFiles.has(id) ? Promise.resolve(unsavedFiles.get(id)) : readValue('files', id);
const actor = crypto.randomUUID(), channel = 'BroadcastChannel' in window ? new BroadcastChannel('ryadom-board-v1') : null;
let camera = { x: 0, y: 0, zoom: 1 }, selected, tool = 'select', color = 'mint', currentShapeKind = 'rect', currentConnectorStyle = 'curved', gesture, editing, space = false, ready = false;
const selectedIds = new Set();
let queue = Promise.resolve(), pending = 0, failure = false, toastTimer, lastBroadcast = 0;
const history = [], future = [], pointers = new Map();
let pinch;

let remoteBoardId = null;
let realtimeClient = null;
let currentUserId = null;
let currentUserRole = 'editor';
let serverSeq = 0;
const remotePeers = new Map();
const PEER_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#ea580c',
  '#16a34a', '#0891b2', '#d97706', '#e11d48',
  '#4f46e5', '#059669', '#b91c1c', '#0d9488'
];
function peerColor(id) {
  let hash = 0;
  for (let i = 0; i < (id || '').length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}
function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
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
  if (remoteBoardId) {
    $('#save-status').textContent = failure ? 'Ошибка сети · проверьте соединение' : pending ? 'Синхронизация…' : 'Сохранено на сервере';
  } else {
    $('#save-status').textContent = failure ? 'Не сохранено · скачайте доску' : pending ? 'Сохраняем…' : 'Сохранено в браузере';
  }
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

let searchMatches = [];
let searchIndex = -1;

function clearSearchHighlights() {
  for (const el of elements.values()) {
    el.classList.remove('search-match', 'search-active');
  }
}

function openSearch() {
  $('#board-menu').hidden = true;
  $('[data-action="menu"]')?.setAttribute('aria-expanded', 'false');
  const bar = $('#search-bar');
  if (!bar) return;
  bar.hidden = false;
  const input = $('#search-input');
  if (input) {
    input.focus();
    input.select();
    runSearch(input.value);
  }
}

function closeSearch() {
  const bar = $('#search-bar');
  if (bar) bar.hidden = true;
  clearSearchHighlights();
  searchMatches = [];
  searchIndex = -1;
  const countEl = $('#search-count');
  if (countEl) countEl.textContent = '0 из 0';
}

function runSearch(query = '') {
  clearSearchHighlights();
  const q = (query || '').trim().toLowerCase();
  const countEl = $('#search-count');
  if (!q) {
    searchMatches = [];
    searchIndex = -1;
    if (countEl) countEl.textContent = '0 из 0';
    return;
  }

  const items = active().filter(o => matchSearch(o, q));
  searchMatches = items;

  for (const obj of searchMatches) {
    elements.get(obj.id)?.classList.add('search-match');
  }

  if (searchMatches.length > 0) {
    searchIndex = 0;
    highlightActiveSearchMatch();
  } else {
    searchIndex = -1;
    if (countEl) countEl.textContent = '0 из 0';
  }
}

function navigateSearch(direction = 1) {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length;
  highlightActiveSearchMatch();
}

function highlightActiveSearchMatch() {
  for (const el of elements.values()) {
    el.classList.remove('search-active');
  }
  const countEl = $('#search-count');
  if (searchIndex < 0 || searchIndex >= searchMatches.length) {
    if (countEl) countEl.textContent = `0 из ${searchMatches.length}`;
    return;
  }

  if (countEl) {
    countEl.textContent = `${searchIndex + 1} из ${searchMatches.length}`;
  }

  const matchObj = searchMatches[searchIndex];
  const el = elements.get(matchObj.id);
  if (el) {
    el.classList.add('search-active');
  }
  select(matchObj.id);

  let targetWorldPoint;
  if (matchObj.type === 'connector') {
    const ep = connectorEndpoints(matchObj, id => objects.get(id));
    const pathInfo = connectorPath(ep.start, ep.end, matchObj.fromSide, matchObj.toSide, matchObj.style || 'curved');
    targetWorldPoint = pathInfo.midpoint;
  } else {
    targetWorldPoint = {
      x: matchObj.x + matchObj.w / 2,
      y: matchObj.y + matchObj.h / 2
    };
  }

  world.style.transition = 'transform 0.25s ease-out';
  setCamera({
    x: window.innerWidth / 2 - targetWorldPoint.x * camera.zoom,
    y: window.innerHeight / 2 - targetWorldPoint.y * camera.zoom,
    zoom: camera.zoom
  });
  setTimeout(() => {
    world.style.transition = '';
  }, 260);
}
function setTool(next) {
  finishEdit(); tool = next; board.dataset.tool = tool;
  $$('button[data-tool]').forEach(button => { button.classList.toggle('active', button.dataset.tool === tool); button.setAttribute('aria-pressed', String(button.dataset.tool === tool)); });
  const hints = { select: 'Место, где мысли встречаются', hand: 'Потяните полотно, чтобы переместиться', sticky: 'Нажмите на доску, чтобы оставить мысль', text: 'Нажмите на доску, чтобы написать', pen: 'Рисуйте свободно. Пробел — переместить доску', shape: 'Потяните, чтобы нарисовать прямоугольник', connector: 'Потяните от одного объекта к другому, чтобы создать связь' };
  $('#tool-hint').textContent = hints[tool];
  if (next !== 'select') select(null);
}
function select(id, multi = false, sync = false) {
  if (id === null) {
    selectedIds.clear();
    selected = null;
  } else if (multi) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      selected = selected === id ? ([...selectedIds][0] || null) : selected;
    } else {
      selectedIds.add(id);
      selected = id;
    }
  } else if (!sync) {
    selectedIds.clear();
    if (id) {
      selectedIds.add(id);
      selected = id;
    } else {
      selected = null;
    }
  } else {
    if (id && selectedIds.has(id)) selected = id;
    else selected = [...selectedIds][0] || null;
  }

  for (const [key, element] of elements) {
    const isSel = selectedIds.has(key);
    element.classList.toggle('selected', isSel);
    element.classList.toggle('multi-selected', selectedIds.size > 1);
  }
  for (const conn of active()) {
    if (conn.type === 'connector') {
      const el = elements.get(conn.id);
      if (el) el.classList.toggle('selected', selectedIds.has(conn.id));
    }
  }

  const hasSel = selectedIds.size > 0 && !!current() && !current()?.deleted && tool === 'select';
  $('#selection-tools').hidden = !hasSel;

  $$('button[data-color]').forEach(button => {
    const allMedia = [...selectedIds].every(key => ['image', 'file'].includes(objects.get(key)?.type));
    button.hidden = allMedia;
    button.setAttribute('aria-pressed', String(current()?.color === button.dataset.color));
  });

  const shapeKinds = $('#shape-kinds');
  if (shapeKinds) {
    const hasShape = [...selectedIds].some(key => objects.get(key)?.type === 'shape');
    shapeKinds.hidden = !hasShape;
    if (hasShape) {
      const activeKind = (current()?.type === 'shape' ? current()?.shapeKind : null) || 'rect';
      $$('#shape-kinds button[data-shape-kind]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.shapeKind === activeKind));
      });
    }
  }

  const connectorStyles = $('#connector-styles');
  if (connectorStyles) {
    const hasConnector = [...selectedIds].some(key => objects.get(key)?.type === 'connector');
    connectorStyles.hidden = !hasConnector;
    if (hasConnector) {
      const activeStyle = (current()?.type === 'connector' ? current()?.style : null) || 'curved';
      $$('#connector-styles button[data-connector-style]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.connectorStyle === activeStyle));
      });
    }
  }

  send({ type: 'selection', objectId: selected || null });
  if (realtimeClient) realtimeClient.sendSelection(selected);
}

function ensureConnectorMarkers() {
  const layer = $('#connectors-layer');
  if (!layer || layer.querySelector('defs')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const colors = {
    mint: 'var(--primary)',
    blue: 'var(--tertiary)',
    neutral: 'var(--on-surface)'
  };
  for (const [col, fill] of Object.entries(colors)) {
    const marker = document.createElementNS(defs.namespaceURI, 'marker');
    marker.setAttribute('id', `arrowhead-${col}`);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(defs.namespaceURI, 'path');
    path.setAttribute('d', 'M 0 1.5 L 8 5 L 0 8.5 z');
    path.setAttribute('fill', fill);
    marker.append(path);
    defs.append(marker);
  }
  layer.prepend(defs);
}

function renderConnector(object, ghost = false, liveResolver = null) {
  if (!ghost && object.deleted) {
    elements.get(object.id)?.remove();
    elements.delete(object.id);
    if (selectedIds.has(object.id)) {
      selectedIds.delete(object.id);
      if (selected === object.id) selected = [...selectedIds][0] || null;
      select(selected, false, true);
    }
    return null;
  }
  const layer = $('#connectors-layer');
  if (!layer) return null;
  ensureConnectorMarkers();

  let element = ghost ? layer.querySelector(`.connector.ghost[data-id="${object.id}"]`) : elements.get(object.id);
  if (!element) {
    element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    element.setAttribute('class', 'connector');
    element.setAttribute('role', 'group');
    if (!ghost) {
      element.tabIndex = 0;
      elements.set(object.id, element);
    }
    layer.append(element);
  }
  element.dataset.id = object.id;
  element.dataset.color = object.color;
  element.dataset.type = 'connector';
  element.classList.toggle('selected', !ghost && selectedIds.has(object.id));
  if (ghost) element.classList.add('ghost');

  const resolveObject = liveResolver || (id => (
    (gesture?.next && gesture.next.id === id)
      ? gesture.next
      : (gesture?.nextTargets?.get(id) || objects.get(id))
  ));
  const endpoints = connectorEndpoints(object, resolveObject);
  const path = connectorPath(endpoints.start, endpoints.end, object.fromSide, object.toSide, object.style || 'curved');

  element.replaceChildren();

  const hitbox = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hitbox.setAttribute('class', 'connector-hitbox');
  hitbox.setAttribute('d', path.d);
  hitbox.setAttribute('fill', 'none');
  hitbox.setAttribute('stroke', 'transparent');
  hitbox.setAttribute('stroke-width', '20');
  hitbox.setAttribute('pointer-events', 'stroke');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'connector-line');
  line.setAttribute('d', path.d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2.5');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('marker-end', `url(#arrowhead-${object.color || 'mint'})`);

  element.append(hitbox, line);

  if (object.text) {
    const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    textGroup.setAttribute('class', 'connector-label-group');

    const textWidth = Math.max(48, Math.round(object.text.length * 8) + 24);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('class', 'connector-label-bg');
    bg.setAttribute('x', String(path.midpoint.x - textWidth / 2));
    bg.setAttribute('y', String(path.midpoint.y - 12));
    bg.setAttribute('width', String(textWidth));
    bg.setAttribute('height', '24');
    bg.setAttribute('rx', '12');

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'connector-label-text');
    text.setAttribute('x', String(path.midpoint.x));
    text.setAttribute('y', String(path.midpoint.y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.textContent = object.text;

    textGroup.append(bg, text);
    element.append(textGroup);
  }

  return element;
}

function positionElement(element, object) {
  element.style.left = `${object.x}px`; element.style.top = `${object.y}px`;
  element.style.width = `${object.w}px`; element.style.height = `${object.h}px`;
  for (const conn of active()) {
    if (conn.type === 'connector' && (conn.fromId === object.id || conn.toId === object.id)) {
      renderConnector(conn);
    }
  }
}
function renderObject(object, ghost = false) {
  if (object.type === 'connector') return renderConnector(object, ghost);
  if (!ghost && object.deleted) {
    elements.get(object.id)?.remove();
    elements.delete(object.id);
    if (selectedIds.has(object.id)) {
      selectedIds.delete(object.id);
      if (selected === object.id) selected = [...selectedIds][0] || null;
      select(selected, false, true);
    }
    for (const conn of active()) {
      if (conn.type === 'connector' && (conn.fromId === object.id || conn.toId === object.id)) {
        renderConnector(conn);
      }
    }
    return;
  }
  let element = ghost ? null : elements.get(object.id);
  if (!element) {
    element = document.createElement('div'); element.className = 'object';
    if (!ghost) { element.dataset.id = object.id; element.tabIndex = 0; element.setAttribute('role', 'group'); elements.set(object.id, element); $('#objects').append(element); }
  }
  element.dataset.type = object.type; element.dataset.color = object.color;
  element.classList.toggle('headline', !!object.headline); element.classList.toggle('small', !!object.small);
  element.classList.toggle('selected', !ghost && selectedIds.has(object.id));
  element.classList.toggle('multi-selected', !ghost && selectedIds.size > 1);
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
    else {
      const fileId = object.blobId || object.attachmentId;
      if (fileId) {
        const img = new Image(); img.alt = object.text; element.append(img);
        const apply = url => { if (img.isConnected) img.src = url; };
        if (urls.has(fileId)) apply(urls.get(fileId));
        else if (object.attachmentId && remoteBoardId) {
          backend.fetchAttachment(`/api/v1/boards/${remoteBoardId}/attachments/${object.attachmentId}`).then(blob => {
            if (!blob) { img.remove(); missing(element); return; }
            if (!urls.has(fileId)) urls.set(fileId, URL.createObjectURL(blob));
            apply(urls.get(fileId));
          }).catch(() => { img.remove(); missing(element); });
        } else if (object.blobId) {
          readBlob(object.blobId).then(blob => {
            if (!blob) { img.remove(); missing(element); return; }
            if (!urls.has(fileId)) urls.set(fileId, URL.createObjectURL(blob));
            apply(urls.get(fileId));
          }).catch(() => { img.remove(); missing(element); });
        } else missing(element);
      } else missing(element);
    }
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
    element.setAttribute('aria-label', `${labels[kind] || 'Фигура'}${object.text ? ': ' + object.text.slice(0, 90) : ''}`);
    if (kind === 'diamond') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'diamond-shape');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
      polygon.setAttribute('points', '50,1 99,50 50,99 1,50');
      svg.append(polygon); element.append(svg);
    }
    const content = document.createElement('div');
    content.className = 'text-content shape-text';
    content.textContent = object.text;
    element.append(content);
  }
  if (!ghost && !['stroke', 'connector'].includes(object.type)) {
    const handle = document.createElement('button'); handle.className = 'resize-handle'; handle.dataset.resize = 'true'; handle.setAttribute('aria-label', 'Изменить размер объекта'); handle.title = 'Потяните для изменения размера'; element.append(handle);
    const quick = document.createElement('button'); quick.className = 'quick-connect-btn'; quick.dataset.quickConnect = 'true'; quick.setAttribute('aria-label', 'Создать связанный стикер'); quick.title = 'Создать связанный стикер'; quick.innerHTML = icon('arrow'); element.append(quick);
  }
  return element;
}
function missing(element) { const label = document.createElement('div'); label.className = 'missing-file'; label.textContent = 'Файл не включён в снимок. Добавьте оригинал.'; element.append(label); }
function remember(before, after) {
  history.push({ before: before ? structuredClone(before) : null, after: structuredClone(after) });
  if (history.length > 100) history.shift(); future.length = 0;
}
function rememberBatch(entries) {
  if (!entries.length) return;
  if (entries.length === 1) {
    remember(entries[0].before, entries[0].after);
    return;
  }
  history.push({
    batch: entries.map(e => ({
      before: e.before ? structuredClone(e.before) : null,
      after: structuredClone(e.after)
    }))
  });
  if (history.length > 100) history.shift();
  future.length = 0;
}
function prepareServerPayload(object) {
  const result = {
    id: object.id,
    type: object.type,
    x: Math.round(object.x),
    y: Math.round(object.y),
    w: Math.round(object.w),
    h: Math.round(object.h),
    text: object.text || '',
    color: object.color || 'mint'
  };
  if (object.type === 'stroke' && object.points) result.points = object.points;
  if (object.type === 'shape' && object.shapeKind) result.shapeKind = object.shapeKind;
  if (object.type === 'text') {
    if (object.headline !== undefined) result.headline = object.headline;
    if (object.small !== undefined) result.small = object.small;
  }
  if (object.type === 'connector') {
    if (object.fromId) result.fromId = object.fromId;
    if (object.toId) result.toId = object.toId;
    if (object.fromSide) result.fromSide = object.fromSide;
    if (object.toSide) result.toSide = object.toSide;
    if (Number.isFinite(object.startX)) result.startX = object.startX;
    if (Number.isFinite(object.startY)) result.startY = object.startY;
    if (Number.isFinite(object.endX)) result.endX = object.endX;
    if (Number.isFinite(object.endY)) result.endY = object.endY;
    if (object.style) result.style = object.style;
  }
  if (object.asset) result.asset = object.asset;
  if (object.attachmentId) result.attachmentId = object.attachmentId;
  return result;
}

function prepareServerPatch(before, after) {
  const patch = {};
  for (const key of ['x', 'y', 'w', 'h', 'text', 'color', 'points', 'shapeKind', 'headline', 'small', 'fromId', 'toId', 'fromSide', 'toSide', 'startX', 'startY', 'endX', 'endY', 'style']) {
    if (after[key] !== undefined && JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      patch[key] = after[key];
    }
  }
  return patch;
}

async function save(object, before, track = true, blob) {
  if (remoteBoardId) {
    let attachmentId = object.attachmentId;
    if (blob && !attachmentId) {
      const att = await backend.uploadAttachment(remoteBoardId, blob);
      attachmentId = att.id;
      object.attachmentId = attachmentId;
      object.blobId = attachmentId;
      urls.set(attachmentId, att.downloadUrl || `/api/v1/boards/${remoteBoardId}/attachments/${attachmentId}`);
    }
    const opId = crypto.randomUUID();
    let action = 'update';
    if (!before) action = 'create';
    else if (object.deleted && !before.deleted) action = 'delete';
    else if (!object.deleted && before.deleted) action = 'restore';

    const operation = {
      opId,
      objectId: object.id,
      action,
      baseRevision: before?.revision || 0
    };
    if (action === 'create') operation.object = prepareServerPayload(object);
    else if (action === 'update') operation.patch = prepareServerPatch(before, object);

    try {
      const ack = await backend.sendOperation(remoteBoardId, operation);
      const saved = { ...object, revision: ack.object.revision, ...(attachmentId ? { attachmentId, blobId: attachmentId } : {}) };
      serverSeq = ack.serverSeq || serverSeq;
      objects.set(saved.id, saved);
      renderObject(saved);
      if (track) remember(before, saved);
      return saved;
    } catch (err) {
      toast(`Ошибка синхронизации: ${err.message}`);
      return null;
    }
  }

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
  if (selectedIds.size > 1) {
    const targets = [...selectedIds].map(id => objects.get(id)).filter(o => o && !o.deleted);
    if (!targets.length) return;
    enqueue(async () => {
      const entries = [];
      for (const before of targets) {
        if (patch.shapeKind && before.type !== 'shape') continue;
        if (patch.style && before.type !== 'connector') continue;
        const saved = await save({ ...before, ...patch }, before, false);
        if (saved) entries.push({ before, after: saved });
      }
      if (entries.length) rememberBatch(entries);
      select(selected, false, true);
    });
    return;
  }
  const before = current(); if (!before || before.deleted) return;
  enqueue(async () => { if (!(await save({ ...before, ...patch }, before))) toast('Объект изменён в другой вкладке. Повторите действие.'); select(selected, false, true); });
}

function changeColor(nextColor) {
  if (!selectedIds.size) return;
  const targets = [...selectedIds].map(id => objects.get(id)).filter(o => o && !o.deleted && !['image', 'file'].includes(o.type));
  if (!targets.length) return;
  enqueue(async () => {
    const entries = [];
    for (const before of targets) {
      const saved = await save({ ...before, color: nextColor }, before, false);
      if (saved) entries.push({ before, after: saved });
    }
    if (entries.length) rememberBatch(entries);
    select(selected, false, true);
  });
}

function deleteSelected() {
  finishEdit();
  if (!selectedIds.size) return;
  const targets = [...selectedIds].map(id => objects.get(id)).filter(o => o && !o.deleted);
  if (!targets.length) return;
  enqueue(async () => {
    const entries = [];
    for (const before of targets) {
      const saved = await save({ ...before, deleted: true }, before, false);
      if (saved) entries.push({ before, after: saved });
    }
    if (entries.length) rememberBatch(entries);
    select(null);
  });
}

async function duplicateSelected() {
  finishEdit();
  if (!selectedIds.size) return;
  const targets = [...selectedIds].map(id => objects.get(id)).filter(o => o && !o.deleted);
  if (!targets.length) return;
  if (active().length + targets.length > 1000) {
    toast('На доске не может быть больше 1000 объектов.');
    return;
  }
  const newObjects = [];
  const entries = [];
  for (const obj of targets) {
    const copy = {
      ...obj,
      id: crypto.randomUUID(),
      revision: 0,
      x: obj.x + GRID_SIZE,
      y: obj.y + GRID_SIZE,
      created: Date.now()
    };
    if (copy.type === 'connector') {
      copy.startX = (obj.startX ?? obj.x) + GRID_SIZE;
      copy.startY = (obj.startY ?? obj.y) + GRID_SIZE;
      copy.endX = (obj.endX ?? (obj.x + obj.w)) + GRID_SIZE;
      copy.endY = (obj.endY ?? (obj.y + obj.h)) + GRID_SIZE;
    }
    const saved = await save(copy, null, false);
    if (saved) {
      newObjects.push(saved);
      entries.push({ before: null, after: saved });
    }
  }
  if (entries.length) rememberBatch(entries);
  selectedIds.clear();
  for (const o of newObjects) selectedIds.add(o.id);
  select(newObjects[0]?.id || null, false, true);
}

async function quickConnect(sourceId) {
  const source = objects.get(sourceId);
  if (!source || source.deleted) return;
  if (active().length + 2 > 1000) {
    toast('На доске не может быть больше 1000 объектов.');
    return;
  }
  finishEdit();
  const targetX = source.x + source.w + 80;
  const targetY = source.y;
  const target = makeObject('sticky', targetX, targetY, {
    w: 240,
    h: 180,
    color: source.color || 'mint'
  });
  const conn = makeObject('connector', Math.min(source.x + source.w, targetX), Math.min(source.y + source.h / 2, targetY + target.h / 2), {
    fromId: source.id,
    toId: target.id,
    fromSide: 'right',
    toSide: 'left',
    color: source.color || 'mint',
    style: currentConnectorStyle || 'curved'
  });
  const savedTarget = await save(target, null, false);
  const savedConn = await save(conn, null, false);
  if (savedTarget && savedConn) {
    rememberBatch([
      { before: null, after: savedTarget },
      { before: null, after: savedConn }
    ]);
    select(savedTarget.id);
    beginEdit(savedTarget.id);
  }
}

function draft(session) {
  try { sessionStorage.setItem('ryadom-board-draft', JSON.stringify({ ...objects.get(session.id), text: session.element.textContent })); } catch { /* beforeunload still protects failed writes. */ }
}
function beginEdit(id) {
  const object = objects.get(id);
  if (!object || object.deleted || !['text', 'sticky', 'shape'].includes(object.type)) return;
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
    const height = object.type === 'shape' ? Math.max(session.before.h, element.scrollHeight + 16) : Math.max(session.before.h, element.scrollHeight + (object.type === 'sticky' ? 54 : 8));
    const local = { ...objects.get(session.id), text, h: height };
    objects.set(session.id, local); positionElement(elements.get(session.id), local);
    broadcastPreview(local);
    enqueue(async () => {
      if (session.conflicted) return;
      const before = { ...session.before, revision: session.revision };
      const saved = await save({ ...local, revision: session.revision }, before, false);
      if (!saved) { session.conflicted = true; toast('Другой участник изменил этот текст. Ваш вариант будет сохранён рядом.'); return; }
      session.revision = saved.revision;
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

    if (entry.batch) {
      source.pop();
      const batch = entry.batch;
      for (const item of batch) {
        const expected = redo ? item.undone : item.after;
        const object = objects.get(item.after.id);
        if (!object || object.revision !== expected.revision) {
          toast('Часть объектов уже изменена в другой вкладке.');
        }
      }
      const updatedBatch = [];
      const restoredIds = [];
      for (const item of batch) {
        const expected = redo ? item.undone : item.after;
        const object = objects.get(item.after.id);
        if (!object || object.revision !== expected.revision) continue;
        const value = redo ? item.after : item.before || { ...object, deleted: true };
        const saved = await save({ ...value, id: object.id }, object, false);
        if (saved) {
          if (redo) item.after = saved; else item.undone = saved;
          updatedBatch.push(item);
          if (!saved.deleted) restoredIds.push(saved.id);

          const next = [...source].reverse().find(i => (i.after?.id === saved.id || i.batch?.some(b => b.after.id === saved.id)));
          if (next) {
            const nextItem = next.after?.id === saved.id ? next : next.batch.find(b => b.after.id === saved.id);
            if (nextItem) {
              if (redo && nextItem.undone) nextItem.undone.revision = saved.revision;
              else if (!redo) nextItem.after.revision = saved.revision;
            }
          }
        }
      }
      target.push({ batch: updatedBatch });
      selectedIds.clear();
      for (const id of restoredIds) selectedIds.add(id);
      select(restoredIds[0] || null, false, true);
      return;
    }

    const expected = redo ? entry.undone : entry.after;
    const object = objects.get(entry.after.id);
    if (!object || object.revision !== expected.revision) { toast('Объект уже изменён в другой вкладке. Чужое изменение не отменено.'); source.pop(); return; }
    const value = redo ? entry.after : entry.before || { ...object, deleted: true };
    const saved = await save({ ...value, id: object.id }, object, false);
    if (!saved) { toast('Не удалось отменить: объект изменился.'); return; }
    source.pop(); if (redo) entry.after = saved; else entry.undone = saved; target.push(entry);
    const next = [...source].reverse().find(item => item.after?.id === saved.id || item.batch?.some(b => b.after.id === saved.id));
    if (next) {
      const nextItem = next.after?.id === saved.id ? next : next.batch.find(b => b.after.id === saved.id);
      if (nextItem) {
        if (redo && nextItem.undone) nextItem.undone.revision = saved.revision;
        else if (!redo) nextItem.after.revision = saved.revision;
      }
    }
    select(saved.deleted ? null : saved.id);
  });
}

function preview(object) {
  $('#ghosts').replaceChildren();
  $('#connectors-layer .ghost')?.remove();
  const element = renderObject(object, true);
  element.classList.add('ghost');
  if (object.type !== 'connector') $('#ghosts').append(element);
  broadcastPreview(object);
}
function broadcastPreview(object) {
  if (performance.now() - lastBroadcast < 40) return;
  lastBroadcast = performance.now(); send({ type: 'preview', object });
}
function finishGesture(cancel = false) {
  const g = gesture; gesture = null; board.classList.remove('dragging');
  $('#ghosts').replaceChildren();
  $('#connectors-layer .ghost')?.remove();
  const marquee = $('#marquee');
  if (marquee) marquee.hidden = true;
  send({ type: 'preview-end' });
  if (realtimeClient) realtimeClient.sendStrokePreview([]);
  if (!g || g.type === 'pan') return;
  if (g.type === 'marquee') {
    select(selected, false, true);
    return;
  }
  if (g.type === 'move') {
    if (cancel) {
      for (const [id, before] of g.targets) {
        if (before.type === 'connector') renderConnector(before);
        else positionElement(elements.get(id), before);
      }
      for (const conn of active()) {
        if (conn.type === 'connector') renderConnector(conn);
      }
      return;
    }
    if (!g.moved && !cancel && !g.shiftKey && g.leadId) {
      select(g.leadId, false);
      return;
    }
    if (g.moved && g.nextTargets) {
      enqueue(async () => {
        const entries = [];
        for (const [id, next] of g.nextTargets) {
          const before = g.targets.get(id);
          const saved = await save(next, before, false);
          if (saved) entries.push({ before, after: saved });
          else toast('Часть объектов изменена в другой вкладке.');
        }
        if (entries.length) rememberBatch(entries);
      });
    }
    return;
  }
  if (g.type === 'resize') {
    if (cancel) { renderObject(g.before); return; }
    if (g.moved) enqueue(async () => { if (!(await save(g.next, g.before))) toast('Объект изменён в другой вкладке. Перемещение отменено.'); });
  } else if (!cancel && g.type === 'pen' && g.points.length > 1) {
    add(makeObject('stroke', 0, 0, { ...normalizeStroke(g.points), color }));
  } else if (!cancel && g.type === 'shape' && g.next?.w > 8 && g.next?.h > 8) {
    add(g.next);
  } else if (!cancel && g.type === 'connector' && g.next) {
    const dist = Math.hypot((g.next.endX ?? g.next.x) - (g.next.startX ?? g.next.x), (g.next.endY ?? g.next.y) - (g.next.startY ?? g.next.y));
    if (g.next.toId || dist > 15) {
      add(g.next);
      setTool('select');
      select(g.next.id);
    }
  }
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
  if (event.target.closest('[data-quick-connect]') && node) {
    event.stopPropagation();
    event.preventDefault();
    void quickConnect(node.dataset.id);
    return;
  }
  if (space || tool === 'hand' || event.button === 1 || (!node && tool === 'select' && !event.shiftKey)) {
    if (!node) select(null);
    gesture = { type: 'pan', x: event.clientX, y: event.clientY, camera: { ...camera } }; board.classList.add('dragging');
  } else if (!node && tool === 'select' && event.shiftKey) {
    gesture = { type: 'marquee', startX: p.x, startY: p.y, initialSelected: new Set(selectedIds) };
    const marquee = $('#marquee');
    if (marquee) {
      marquee.style.left = `${p.x}px`;
      marquee.style.top = `${p.y}px`;
      marquee.style.width = '0px';
      marquee.style.height = '0px';
      marquee.hidden = false;
    }
  } else if (tool === 'select' && node) {
    const clickedId = node.dataset.id;
    const isResize = !!event.target.closest('[data-resize]');
    if (event.shiftKey) {
      select(clickedId, true);
    } else if (!selectedIds.has(clickedId)) {
      select(clickedId, false);
    }
    if (isResize && current()) {
      const object = current();
      gesture = { type: event.target.closest('[data-resize]') ? 'resize' : 'move', x: p.x, y: p.y, before: structuredClone(object), next: object, moved: false };
    } else if (selectedIds.has(clickedId)) {
      const targets = new Map();
      for (const id of selectedIds) {
        const obj = objects.get(id);
        if (obj && !obj.deleted) targets.set(id, structuredClone(obj));
      }
      gesture = { type: 'move', x: p.x, y: p.y, leadId: clickedId, targets, moved: false, shiftKey: event.shiftKey };
    }
  } else if (tool === 'text' || tool === 'sticky') {
    const type = tool; setTool('select'); add(makeObject(type, p.x, p.y, { w: type === 'sticky' ? 240 : 300, h: type === 'sticky' ? 180 : 65, color }), undefined, true);
  } else if (tool === 'pen') gesture = { type: 'pen', points: [[p.x, p.y]] };
  else if (tool === 'shape') gesture = { type: 'shape', x: p.x, y: p.y, id: crypto.randomUUID() };
  else if (tool === 'connector') {
    const targetNode = event.target.closest('[data-id]');
    let fromId = undefined, fromSide = undefined;
    if (targetNode && objects.has(targetNode.dataset.id) && objects.get(targetNode.dataset.id).type !== 'connector') {
      const obj = objects.get(targetNode.dataset.id);
      fromId = obj.id;
      fromSide = closestSide(obj, p);
    }
    gesture = {
      type: 'connector',
      fromId,
      fromSide,
      startX: p.x,
      startY: p.y,
      id: crypto.randomUUID()
    };
  }
});
function updateMarquee(p) {
  const g = gesture;
  if (!g || g.type !== 'marquee') return;
  const minX = Math.min(g.startX, p.x), minY = Math.min(g.startY, p.y);
  const w = Math.abs(p.x - g.startX), h = Math.abs(p.y - g.startY);
  const marquee = $('#marquee');
  if (marquee) {
    marquee.style.left = `${minX}px`;
    marquee.style.top = `${minY}px`;
    marquee.style.width = `${w}px`;
    marquee.style.height = `${h}px`;
    marquee.hidden = false;
  }
  const nextSelected = new Set(g.initialSelected);
  for (const obj of active()) {
    let intersects = false;
    if (obj.type === 'connector') {
      const { start, end } = connectorEndpoints(obj, id => objects.get(id));
      const cMinX = Math.min(start.x, end.x), cMaxX = Math.max(start.x, end.x);
      const cMinY = Math.min(start.y, end.y), cMaxY = Math.max(start.y, end.y);
      intersects = !(cMinX > minX + w || cMaxX < minX || cMinY > minY + h || cMaxY < minY);
    } else {
      const objRight = obj.x + obj.w, objBottom = obj.y + obj.h;
      intersects = !(obj.x > minX + w || objRight < minX || obj.y > minY + h || objBottom < minY);
    }
    if (intersects) nextSelected.add(obj.id);
  }
  selectedIds.clear();
  for (const id of nextSelected) selectedIds.add(id);
  if (!selectedIds.has(selected)) selected = [...selectedIds][0] || null;
  for (const [key, el] of elements) {
    el.classList.toggle('selected', selectedIds.has(key));
    el.classList.toggle('multi-selected', selectedIds.size > 1);
  }
  for (const conn of active()) {
    if (conn.type === 'connector') {
      const el = elements.get(conn.id);
      if (el) el.classList.toggle('selected', selectedIds.has(conn.id));
    }
  }
}
board.addEventListener('pointermove', event => {
  const p = point(event);
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const next = zoomAt(pinch.camera, pinch.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance), pinch.midpoint);
    setCamera({ ...next, x: next.x + midpoint.x - pinch.midpoint.x, y: next.y + midpoint.y - pinch.midpoint.y }); return;
  }
  if (!gesture) {
    if (performance.now() - lastBroadcast > 50) { lastBroadcast = performance.now(); send({ type: 'cursor', x: p.x, y: p.y }); }
    if (realtimeClient) realtimeClient.sendCursor(p.x, p.y);
    return;
  }
  if (realtimeClient) realtimeClient.sendCursor(p.x, p.y);
  const g = gesture;
  if (g.type === 'pan') setCamera({ ...g.camera, x: g.camera.x + event.clientX - g.x, y: g.camera.y + event.clientY - g.y });
  else if (g.type === 'marquee') {
    updateMarquee(p);
  } else if (g.type === 'move') {
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    const leadBefore = g.targets.get(g.leadId) || [...g.targets.values()][0];
    const rawX = leadBefore.x + dx;
    const rawY = leadBefore.y + dy;
    const snapX = event.altKey ? rawX : snapToGrid(rawX);
    const snapY = event.altKey ? rawY : snapToGrid(rawY);
    const finalDx = snapX - leadBefore.x;
    const finalDy = snapY - leadBefore.y;

    g.nextTargets = new Map();
    for (const [id, before] of g.targets) {
      const nextX = before.x + finalDx;
      const nextY = before.y + finalDy;
      if (before.type === 'connector') {
        g.nextTargets.set(id, {
          ...before,
          x: nextX,
          y: nextY,
          startX: (before.startX ?? before.x) + finalDx,
          startY: (before.startY ?? before.y) + finalDy,
          endX: (before.endX ?? (before.x + before.w)) + finalDx,
          endY: (before.endY ?? (before.y + before.h)) + finalDy
        });
      } else {
        g.nextTargets.set(id, { ...before, x: nextX, y: nextY });
      }
    }

    for (const [id, next] of g.nextTargets) {
      if (next.type === 'connector') {
        renderConnector(next);
      } else {
        positionElement(elements.get(id), next);
      }
      broadcastPreview(next);
    }
    for (const conn of active()) {
      if (conn.type === 'connector') {
        renderConnector(g.nextTargets.get(conn.id) || conn);
      }
    }
    g.moved = Math.hypot(p.x - g.x, p.y - g.y) > 2;
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
    if (realtimeClient) realtimeClient.sendStrokePreview(g.points);
  } else if (g.type === 'shape') {
    const minX = Math.min(g.x, p.x), minY = Math.min(g.y, p.y);
    const rawW = Math.max(1, Math.abs(p.x - g.x)), rawH = Math.max(1, Math.abs(p.y - g.y));
    const snapX = event.altKey ? minX : snapToGrid(minX);
    const snapY = event.altKey ? minY : snapToGrid(minY);
    const snapW = event.altKey ? rawW : Math.max(GRID_SIZE, snapToGrid(rawW));
    const snapH = event.altKey ? rawH : Math.max(GRID_SIZE, snapToGrid(rawH));
    g.next = makeObject('shape', snapX, snapY, { id: g.id, w: snapW, h: snapH, color, shapeKind: currentShapeKind }); preview(g.next);
  } else if (g.type === 'connector') {
    const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-id]');
    let toId = undefined, toSide = undefined;
    if (hovered && objects.has(hovered.dataset.id) && hovered.dataset.id !== g.fromId && objects.get(hovered.dataset.id).type !== 'connector') {
      const obj = objects.get(hovered.dataset.id);
      toId = obj.id;
      toSide = closestSide(obj, p);
    }
    const start = g.fromId ? connectorAnchor(objects.get(g.fromId), g.fromSide) : { x: g.startX, y: g.startY };
    const end = toId ? connectorAnchor(objects.get(toId), toSide) : p;
    const minX = Math.min(start.x, end.x), minY = Math.min(start.y, end.y);
    const w = Math.max(1, Math.abs(end.x - start.x)), h = Math.max(1, Math.abs(end.y - start.y));
    g.next = makeObject('connector', minX, minY, {
      id: g.id, w, h, color,
      fromId: g.fromId, fromSide: g.fromSide,
      toId, toSide,
      startX: g.startX, startY: g.startY,
      endX: p.x, endY: p.y,
      style: currentConnectorStyle || 'curved'
    });
    preview(g.next);
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
  if (['text', 'sticky', 'shape'].includes(object.type)) beginEdit(id);
  else if (object.type === 'connector') {
    const nextText = prompt('Подпись к стрелке:', object.text || '');
    if (nextText !== null && nextText !== object.text) {
      change({ text: nextText.slice(0, 200) });
    }
  } else if (object.attachmentId && remoteBoardId) {
    try {
      const blob = await backend.fetchAttachment(`/api/v1/boards/${remoteBoardId}/attachments/${object.attachmentId}`);
      download(blob, object.text || 'attachment');
    } catch (err) {
      toast(`Не удалось скачать вложение: ${err.message}`);
    }
  } else if (object.blobId) {
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
  if (remoteBoardId) {
    for (const [sessionId, peer] of remotePeers) {
      if (Date.now() - (peer.seen || 0) > 10000) continue;
      if (!Number.isFinite(peer.x) || !Number.isFinite(peer.y)) continue;
      const node = document.createElement('div');
      node.className = 'peer-cursor';
      node.style.transform = `translate(${peer.x * camera.zoom + camera.x}px,${peer.y * camera.zoom + camera.y}px)`;
      node.style.color = peer.color;
      node.innerHTML = icon('cursor');
      const label = document.createElement('span');
      label.style.background = peer.color;
      label.style.color = '#fff';
      label.textContent = peer.displayName || 'Соавтор';
      node.append(label);
      $('#cursors').append(node);
    }
    const count = remotePeers.size + 1;
    const names = [...remotePeers.values()].map(p => p.displayName || 'Соавтор');
    names.push('Вы');
    const labelText = `В сети: ${count} (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})`;
    $('#presence').innerHTML = '<span class="live-dot online"></span>';
    $('#presence').append(document.createTextNode(labelText));
    $('#presence').title = names.join(', ');
  } else {
    for (const [id, peer] of peers) {
      if (Date.now() - peer.seen > 10000) { peers.delete(id); document.getElementById(`peer-${id}`)?.remove(); continue; }
      if (!Number.isFinite(peer.x) || !Number.isFinite(peer.y)) continue;
      const node = document.createElement('div'); node.className = 'peer-cursor'; node.style.transform = `translate(${peer.x * camera.zoom + camera.x}px,${peer.y * camera.zoom + camera.y}px)`;
      node.innerHTML = icon('cursor'); const label = document.createElement('span'); label.textContent = 'Другая вкладка'; node.append(label); $('#cursors').append(node);
    }
    $('#presence').innerHTML = '<span class="live-dot"></span>';
    $('#presence').append(document.createTextNode(peers.size ? `Локально · ${peers.size + 1} вкладки` : 'Локальная доска'));
    $('#presence').title = 'Локальная доска в этом браузере';
  }
}

function handleRealtimeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') {
    remotePeers.clear();
    for (const p of msg.participants || []) {
      remotePeers.set(p.sessionId, { ...p, color: peerColor(p.sessionId || p.userId) });
    }
    drawPeers();
  } else if (msg.type === 'presence.join') {
    if (msg.participant) {
      remotePeers.set(msg.participant.sessionId, {
        ...msg.participant,
        color: peerColor(msg.participant.sessionId || msg.participant.userId)
      });
      drawPeers();
    }
  } else if (msg.type === 'presence.leave') {
    const peer = remotePeers.get(msg.sessionId);
    if (peer?.selectedObjectId) {
      elements.get(peer.selectedObjectId)?.classList.remove('peer-selected');
      elements.get(peer.selectedObjectId)?.style.removeProperty('--peer-color');
    }
    document.getElementById(`peer-stroke-${msg.sessionId}`)?.remove();
    remotePeers.delete(msg.sessionId);
    drawPeers();
  } else if (msg.type === 'cursor') {
    const peer = remotePeers.get(msg.sessionId);
    if (peer) {
      peer.x = msg.x;
      peer.y = msg.y;
      peer.seen = Date.now();
      drawPeers();
    }
  } else if (msg.type === 'selection') {
    const peer = remotePeers.get(msg.sessionId);
    if (peer) {
      if (peer.selectedObjectId && peer.selectedObjectId !== msg.objectId) {
        elements.get(peer.selectedObjectId)?.classList.remove('peer-selected');
        elements.get(peer.selectedObjectId)?.style.removeProperty('--peer-color');
      }
      peer.selectedObjectId = msg.objectId || null;
      if (peer.selectedObjectId) {
        const el = elements.get(peer.selectedObjectId);
        if (el) {
          el.classList.add('peer-selected');
          el.style.setProperty('--peer-color', peer.color);
        }
      }
    }
  } else if (msg.type === 'stroke-preview') {
    const peer = remotePeers.get(msg.sessionId);
    if (peer) {
      let previewEl = document.getElementById(`peer-stroke-${msg.sessionId}`);
      if (!msg.points || !msg.points.length) {
        previewEl?.remove();
      } else {
        if (!previewEl) {
          previewEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          previewEl.id = `peer-stroke-${msg.sessionId}`;
          previewEl.setAttribute('class', 'board-object stroke ghost');
          previewEl.style.position = 'absolute';
          previewEl.style.overflow = 'visible';
          previewEl.style.pointerEvents = 'none';
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', peer.color || 'var(--primary)');
          path.setAttribute('stroke-width', '3');
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('stroke-linejoin', 'round');
          previewEl.append(path);
          world.append(previewEl);
        }
        const d = msg.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
        previewEl.firstElementChild?.setAttribute('d', d);
      }
    }
  } else if (msg.type === 'operation') {
    serverSeq = Math.max(serverSeq, msg.serverSeq || 0);
    const incoming = msg.object;
    if (incoming && validObject(incoming)) {
      if (incoming.attachmentId) incoming.blobId = incoming.attachmentId;
      document.getElementById(`peer-stroke-${msg.sessionId}`)?.remove();
      objects.set(incoming.id, incoming);
      if (editing?.id !== incoming.id && gesture?.before?.id !== incoming.id && !gesture?.targets?.has(incoming.id)) {
        renderObject(incoming);
      }
    }
  } else if (msg.type === 'board.updated') {
    if (document.activeElement !== $('#board-title')) {
      $('#board-title').value = msg.title;
    }
  } else if (msg.type === 'member.removed') {
    if (msg.userId === currentUserId) {
      toast('Ваш доступ к этой доске был отозван.');
      setTimeout(() => { location.href = location.pathname; }, 2000);
    }
  }
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
    $('#connectors-layer .peer-preview')?.remove();
    const node = renderObject(data.object, true); node.id = `peer-${data.actor}`; node.classList.add('ghost');
    if (data.object.type === 'connector') node.classList.add('peer-preview');
    else $('#world').append(node);
  }
  if (data.type === 'preview-end') {
    document.getElementById(`peer-${data.actor}`)?.remove();
    $('#connectors-layer .peer-preview')?.remove();
  }
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
  const idMap = new Map(imported.map(o => [o.id, crypto.randomUUID()]));
  const dx = p.x - minX, dy = p.y - minY;
  const prepared = [];
  for (const original of imported) {
    const blob = blobs.get(original.blobId), id = idMap.get(original.id);
    if (blob) fileKind(new File([blob], externalNames.get(original.blobId) || original.text, { type: blob.type }));
    const object = {
      ...original,
      id,
      revision: 0,
      created: Date.now(),
      x: original.x + dx,
      y: original.y + dy,
      ...(original.type === 'connector' ? {
        fromId: original.fromId ? (idMap.get(original.fromId) || original.fromId) : undefined,
        toId: original.toId ? (idMap.get(original.toId) || original.toId) : undefined,
        startX: Number.isFinite(original.startX) ? original.startX + dx : undefined,
        startY: Number.isFinite(original.startY) ? original.startY + dy : undefined,
        endX: Number.isFinite(original.endX) ? original.endX + dx : undefined,
        endY: Number.isFinite(original.endY) ? original.endY + dy : undefined
      } : {})
    };
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

async function showDialog(type = 'share') {
  finishEdit();
  if (type === 'help') {
    const content = `<h2 id="dialog-title">Больше места для идей</h2><p>V — выделение, H или Пробел — перемещение. N — стикер, T — текст, P — карандаш, R — прямоугольник, C — стрелка.</p><p>Двойной клик редактирует текст или скачивает вложение. Delete удаляет выбранное. Ctrl/⌘+Z отменяет, Ctrl/⌘+Shift+Z повторяет. Стрелки перемещают выбранный объект.</p><p>Колесо перемещает доску. Ctrl/⌘ + колесо меняет масштаб. На сенсорном экране потяните свободное место или используйте два пальца.</p><p>Перетащите файлы, вставьте Ctrl/⌘+V или нажмите загрузку. До 10 файлов за раз, 20 МБ на файл. PDF и Office хранятся как вложения, без встроенного редактора.</p><p class="info-box">Данные хранятся в этом браузере. Скачивайте доску для резервной копии: файл .ryadom включает вложения до 35 МБ суммарно. Старые заметки не удалены.</p>`;
    $('#dialog-content').innerHTML = `${content}<div class="dialog-actions"><button class="text-button" data-action="close-dialog">Закрыть</button></div>`;
    if (!$('#dialog').open) $('#dialog').showModal();
    return;
  }

  let me = null;
  if (backend.authenticated()) {
    try { me = await backend.getUserInfo(); } catch { backend.setToken(''); }
  }

  let content = '';
  if (me) {
    let boardsList = { items: [] };
    try { boardsList = await backend.listBoards(); } catch {}

    const directUrl = remoteBoardId ? `${location.origin}${location.pathname}?board=${remoteBoardId}` : '';

    content = `
      <h2 id="dialog-title">Совместная работа</h2>
      <p>Вы вошли как <strong>${escapeHtml(me.displayName || me.email)}</strong> <span style="color:var(--on-surface-variant);font-size:12px;">(${escapeHtml(me.email)})</span> <button class="text-button" data-action="logout" style="padding:2px 8px;font-size:12px;">Выйти</button></p>
      
      ${remoteBoardId ? `
        <div style="margin: 16px 0; padding: 14px; background: var(--surface-container-lowest); border-radius: 14px;">
          <strong>Текущая совместная доска</strong>
          <label style="margin-top:8px;">Прямая ссылка:</label>
          <div class="copy-row">
            <input id="share-direct-url" readonly value="${directUrl}">
            <button class="filled-button" data-action="copy-direct">Скопировать</button>
          </div>
          ${currentUserRole === 'owner' ? `
          <div style="margin-top: 10px;">
            <button class="text-button" data-action="create-invite" style="padding: 6px 12px; font-size: 13px;">Сгенерировать ссылку-приглашение (7 дней)</button>
            <div id="invite-result" class="invite-box" hidden></div>
          </div>
          ` : ''}
          <div style="margin-top: 10px;">
            <a href="${location.pathname}" class="text-button" style="text-decoration:none;display:inline-block;padding:6px 12px;font-size:13px;">← Вернуться на локальную доску</a>
          </div>
        </div>
      ` : `
        <p class="info-box">Сейчас открыта <strong>локальная доска</strong> (сохраняется в вашем браузере). Создайте онлайн-доску или выберите существующую из списка ниже, чтобы редактировать вместе в реальном времени.</p>
      `}

      <h3 style="margin-top: 20px; font-size: 16px;">Мои доски</h3>
      <div class="boards-list">
        ${boardsList.items.length === 0 ? '<p style="font-size:12px;color:var(--on-surface-variant);">У вас пока нет серверных досок.</p>' : boardsList.items.map(b => `
          <a class="board-item-row ${b.id === remoteBoardId ? 'active' : ''}" href="${location.pathname}?board=${b.id}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;">${escapeHtml(b.title)}</span>
            <span class="board-role-badge">${b.role === 'owner' ? 'Владелец' : 'Редактор'}</span>
          </a>
        `).join('')}
      </div>

      <form id="server-create-board" style="margin-top: 14px;">
        <label for="new-board-title">Создать новую онлайн-доску:</label>
        <div class="copy-row">
          <input id="new-board-title" placeholder="Название новой доски" required maxlength="180">
          <button class="filled-button" type="submit">Создать</button>
        </div>
      </form>

      <hr>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:var(--on-surface-variant);">Резервное сохранение</span>
        <button class="text-button" data-action="server-save" style="font-size:12px;">Сохранить снимок</button>
      </div>
      <div id="server-error" class="dialog-error" role="alert"></div>
    `;
  } else {
    content = `
      <h2 id="dialog-title">Вход для совместной работы</h2>
      <p>Войдите или создайте аккаунт, чтобы работать на общих досках, видеть курсоры коллег и делиться ссылками.</p>
      <form id="server-login" data-mode="login">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" required>
        <label id="display-name-label" for="display-name" hidden>Имя соавтора (displayName)</label>
        <input id="display-name" autocomplete="nickname" maxlength="80" hidden>
        <label for="password">Пароль</label>
        <input id="password" type="password" autocomplete="current-password" required minlength="1">
        <label id="admin-token-label" for="admin-setup-token" hidden>Код администратора (если требуется)</label>
        <input id="admin-setup-token" autocomplete="off" hidden>
        <div id="server-error" class="dialog-error" role="alert"></div>
        <div class="dialog-actions">
          <button class="text-button" type="button" data-action="register-mode">Создать аккаунт</button>
          <button class="filled-button" id="server-auth-submit" type="submit">Войти на сервер</button>
        </div>
      </form>
    `;
  }

  $('#dialog-content').innerHTML = `${content}<div class="dialog-actions"><button class="text-button" data-action="close-dialog">Закрыть</button></div>`;
  if (!$('#dialog').open) $('#dialog').showModal();

  $('#server-login')?.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      if (event.currentTarget.dataset.mode === 'register') {
        const dName = $('#display-name').value.trim() || 'Соавтор';
        await backend.register($('#email').value, $('#password').value, dName, $('#admin-setup-token').value);
      } else {
        await backend.login($('#email').value, $('#password').value);
      }
      const pendingInvite = sessionStorage.getItem('ryadom-pending-invite');
      if (pendingInvite) {
        sessionStorage.removeItem('ryadom-pending-invite');
        try {
          const accepted = await backend.acceptInvite(pendingInvite);
          location.href = `${location.pathname}?board=${accepted.boardId}`;
          return;
        } catch (invErr) {
          toast(`Ошибка принятия приглашения: ${invErr.message}`);
        }
      }
      if (remoteBoardId) {
        location.reload();
      } else {
        showDialog('share');
      }
    } catch (error) {
      $('#server-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#server-create-board')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#new-board-title');
    const title = input.value.trim();
    if (!title) return;
    event.submitter.disabled = true;
    try {
      const created = await backend.createBoard(title);
      location.href = `${location.pathname}?board=${created.id}`;
    } catch (err) {
      $('#server-error').textContent = err.message;
      event.submitter.disabled = false;
    }
  });
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.tool) { setTool(button.dataset.tool); return; }
  if (button.dataset.color) { color = button.dataset.color; changeColor(color); return; }
  if (button.dataset.shapeKind) {
    currentShapeKind = button.dataset.shapeKind;
    change({ shapeKind: currentShapeKind });
    return;
  }
  if (button.dataset.connectorStyle) {
    currentConnectorStyle = button.dataset.connectorStyle;
    change({ style: currentConnectorStyle });
    return;
  }
  const action = button.dataset.action;
  if (action !== 'menu') { $('#board-menu').hidden = true; $('[data-action="menu"]').setAttribute('aria-expanded', 'false'); }
  try {
    if (action === 'menu') { $('#board-menu').hidden = !$('#board-menu').hidden; button.setAttribute('aria-expanded', String(!$('#board-menu').hidden)); }
    else if (action === 'search') openSearch();
    else if (action === 'search-next') navigateSearch(1);
    else if (action === 'search-prev') navigateSearch(-1);
    else if (action === 'search-close') closeSearch();
    else if (action === 'export-svg') {
      await exportBoardSvg($('#board-title').value, active(), readBlob);
    }
    else if (action === 'export-png') {
      await exportBoardPng($('#board-title').value, active(), readBlob);
    }
    else if (action === 'export-copy-png') {
      try {
        await copyBoardPng($('#board-title').value, active(), readBlob);
        toast('Изображение скопировано в буфер обмена');
      } catch (err) {
        toast(`Не удалось скопировать: ${err.message}`);
      }
    }
    else if (action === 'print') {
      window.print();
    }
    else if (action === 'files') $('#file-input').click();
    else if (action === 'import') $('#import-input').click();
    else if (action === 'export') await exportBoard();
    else if (action === 'share' || action === 'help') showDialog(action);
    else if (action === 'copy-direct') {
      const input = $('#share-direct-url');
      if (input) {
        await navigator.clipboard.writeText(input.value);
        button.textContent = 'Скопировано!';
        setTimeout(() => { button.textContent = 'Скопировать'; }, 2000);
      }
    }
    else if (action === 'create-invite') {
      if (!remoteBoardId) return;
      button.disabled = true;
      try {
        const inv = await backend.createInvite(remoteBoardId);
        const resBox = $('#invite-result');
        if (resBox) {
          resBox.hidden = false;
          resBox.innerHTML = `
            <div><strong>Ссылка-приглашение (7 дней):</strong></div>
            <div class="copy-row" style="margin-top:6px;">
              <input id="invite-url-input" readonly value="${escapeHtml(inv.url)}">
              <button class="filled-button" data-action="copy-invite">Скопировать</button>
            </div>
          `;
        }
      } catch (err) {
        $('#server-error').textContent = err.message;
      } finally {
        button.disabled = false;
      }
    }
    else if (action === 'copy-invite') {
      const input = $('#invite-url-input');
      if (input) {
        await navigator.clipboard.writeText(input.value);
        button.textContent = 'Скопировано!';
        setTimeout(() => { button.textContent = 'Скопировать'; }, 2000);
      }
    }
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
    else if (action === 'delete') deleteSelected();
    else if (action === 'duplicate') await duplicateSelected();
    else if (action === 'undo' || action === 'redo') undo(action === 'redo');
    else if (action === 'fit') fit();
    else if (['zoom-in', 'zoom-out', 'reset-zoom'].includes(action)) setCamera(zoomAt(camera, action === 'reset-zoom' ? 1 : camera.zoom * (action === 'zoom-in' ? 1.2 : 1 / 1.2), { x: innerWidth / 2, y: innerHeight / 2 }));
    else if (action === 'theme') { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('ryadom.theme', theme); } catch {} }
    else if (action === 'logout') { await backend.logout(); showDialog('share'); }
    else if (action === 'server-save') {
      button.disabled = true; await queue;
      const result = await backend.saveSnapshot({ format: 'ryadom-board', version: 1, title: $('#board-title').value, objects: active() }, readBlob, progress => { $('#server-error').textContent = progress; });
      $('#server-error').textContent = `Создан серверный снимок ${result.id}: ${result.objects} объектов, ${result.files} вложений.`;
    }
  } catch (error) { if ($('#server-error') && $('#dialog').open) $('#server-error').textContent = error.message; else toast(error.message); }
  finally { if (action === 'server-save') button.disabled = false; }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.board-header')) { $('#board-menu').hidden = true; $('[data-action="menu"]').setAttribute('aria-expanded', 'false'); } });
$('#board-title').addEventListener('input', () => {
  const title = $('#board-title').value;
  enqueue(async () => {
    if (remoteBoardId) {
      if (currentUserRole === 'owner') await backend.renameBoard(remoteBoardId, title);
    } else {
      await writeMeta('title', title);
      send({ type: 'title' });
    }
  });
});
$('#board-title').addEventListener('blur', () => {
  if (!$('#board-title').value.trim()) {
    $('#board-title').value = 'Без названия';
    enqueue(async () => {
      if (remoteBoardId) {
        if (currentUserRole === 'owner') await backend.renameBoard(remoteBoardId, 'Без названия');
      } else {
        await writeMeta('title', 'Без названия');
      }
    });
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('#search-bar').hidden) {
      closeSearch();
      return;
    }
    finishEdit();
    setTool('select');
    select(null);
    $('#board-menu').hidden = true;
  }
  const isCmdOrCtrl = event.ctrlKey || event.metaKey;
  if (isCmdOrCtrl && (event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А' || event.code === 'KeyF')) {
    event.preventDefault();
    openSearch();
    return;
  }
  if (isCmdOrCtrl && event.shiftKey && (event.key === 'c' || event.key === 'C' || event.key === 'с' || event.key === 'С' || event.code === 'KeyC')) {
    event.preventDefault();
    enqueue(async () => {
      try {
        await copyBoardPng($('#board-title').value, active(), readBlob);
        toast('Изображение скопировано в буфер обмена');
      } catch (err) {
        toast(`Не удалось скопировать: ${err.message}`);
      }
    });
    return;
  }
  if (isCmdOrCtrl && (event.key === 'p' || event.key === 'P' || event.key === 'з' || event.key === 'З' || event.code === 'KeyP')) {
    event.preventDefault();
    window.print();
    return;
  }
  if ($('#dialog').open || event.target.closest('input,textarea') || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (isCmdOrCtrl && key === 'z') { event.preventDefault(); undo(event.shiftKey); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); space = true; board.style.cursor = 'grab'; }
  const shortcuts = { v: 'select', h: 'hand', n: 'sticky', t: 'text', p: 'pen', r: 'shape', c: 'connector', a: 'connector' };
  if (shortcuts[key]) setTool(shortcuts[key]);
  if (key === '1') fit();
  if (['delete', 'backspace'].includes(key) && selectedIds.size) { event.preventDefault(); deleteSelected(); }
  if (key === 'enter' && current()) { event.preventDefault(); void activate(selected); }
  if (event.target.closest('[data-id]') && !selectedIds.size) select(event.target.closest('[data-id]').dataset.id);
  if (selectedIds.size && event.key.startsWith('Arrow')) {
    event.preventDefault(); const distance = event.shiftKey ? GRID_SIZE : 1;
    const dx = event.key === 'ArrowRight' ? distance : event.key === 'ArrowLeft' ? -distance : 0;
    const dy = event.key === 'ArrowDown' ? distance : event.key === 'ArrowUp' ? -distance : 0;
    if (selectedIds.size === 1 && event.target.matches('[data-resize]')) {
      change({ w: Math.max(80, current().w + dx), h: Math.max(50, current().h + dy) });
    } else {
      const targets = [...selectedIds].map(id => objects.get(id)).filter(o => o && !o.deleted);
      enqueue(async () => {
        const entries = [];
        for (const before of targets) {
          let next;
          if (before.type === 'connector') {
            next = { ...before, x: before.x + dx, y: before.y + dy, startX: (before.startX ?? before.x) + dx, startY: (before.startY ?? before.y) + dy, endX: (before.endX ?? (before.x + before.w)) + dx, endY: (before.endY ?? (before.y + before.h)) + dy };
          } else {
            next = { ...before, x: before.x + dx, y: before.y + dy };
          }
          const saved = await save(next, before, false);
          if (saved) entries.push({ before, after: saved });
        }
        if (entries.length) rememberBatch(entries);
        select(selected, false, true);
      });
    }
  }
});
board.addEventListener('focusin', event => { const id = event.target.closest('[data-id]')?.dataset.id; if (id && !editing) select(id); });
document.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; board.style.cursor = ''; } });
window.addEventListener('blur', () => { space = false; board.style.cursor = ''; finishGesture(true); });
window.addEventListener('resize', () => { drawPeers(); });

$('#search-input')?.addEventListener('input', event => {
  runSearch(event.target.value);
});
$('#search-input')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    navigateSearch(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
  }
});
window.addEventListener('beforeprint', () => {
  fit();
});

hydrateIcons();
ensureConnectorMarkers();
$('#presence')?.addEventListener('click', () => showDialog('share'));
try { document.documentElement.dataset.theme = localStorage.getItem('ryadom.theme') === 'dark' ? 'dark' : 'light'; } catch {}

async function initBoard() {
  const inviteMatch = location.hash.match(/^#invite=([a-zA-Z0-9_-]+)/);
  if (inviteMatch) {
    const inviteToken = inviteMatch[1];
    if (backend.authenticated()) {
      try {
        const accepted = await backend.acceptInvite(inviteToken);
        toast('Приглашение принято!');
        history.replaceState(null, '', `${location.pathname}?board=${accepted.boardId}`);
        remoteBoardId = accepted.boardId;
      } catch (err) {
        toast(`Ошибка приглашения: ${err.message}`);
      }
    } else {
      sessionStorage.setItem('ryadom-pending-invite', inviteToken);
      history.replaceState(null, '', location.pathname + location.search);
      showDialog('share');
      toast('Войдите или зарегистрируйтесь, чтобы принять приглашение на доску.');
    }
  }

  if (!remoteBoardId) {
    const urlParams = new URLSearchParams(location.search);
    const boardParam = urlParams.get('board');
    if (boardParam && /^[0-9a-f-]{36}$/i.test(boardParam)) {
      remoteBoardId = boardParam;
    }
  }

  if (remoteBoardId) {
    if (!backend.authenticated()) {
      toast('Для доступа к совместной доске войдите в аккаунт.');
      showDialog('share');
      throw new Error('Требуется авторизация.');
    }
    const boardData = await backend.getBoard(remoteBoardId);
    const me = await backend.getUserInfo().catch(() => null);
    currentUserId = me?.id || null;
    currentUserRole = boardData.role || 'editor';
    const isOwner = currentUserRole === 'owner';
    $('#board-title').readOnly = !isOwner;
    $('#board-title').title = isOwner ? 'Название доски' : 'Только владелец доски может изменять её название';
    serverSeq = boardData.serverSeq || 0;
    $('#board-title').value = boardData.title || 'Совместная доска';

    objects.clear();
    elements.clear();
    world.replaceChildren();

    for (const obj of boardData.objects) {
      if (obj.attachmentId) obj.blobId = obj.attachmentId;
      objects.set(obj.id, obj);
      renderObject(obj);
    }

    realtimeClient = new backend.BoardRealtimeClient({
      boardId: remoteBoardId,
      getTicket: async () => {
        const res = await backend.createSessionTicket(remoteBoardId);
        return res.ticket;
      },
      onMessage: handleRealtimeMessage,
      onStatusChange: async s => {
        if (s === 'open') {
          drawPeers();
          try {
            const fresh = await backend.getBoard(remoteBoardId);
            serverSeq = Math.max(serverSeq, fresh.serverSeq || 0);
            if (fresh.title && document.activeElement !== $('#board-title')) {
              $('#board-title').value = fresh.title;
            }
            for (const obj of fresh.objects || []) {
              if (obj.attachmentId) obj.blobId = obj.attachmentId;
              const cur = objects.get(obj.id);
              if (!cur || (obj.revision >= cur.revision && editing?.id !== obj.id && gesture?.before?.id !== obj.id && !gesture?.targets?.has(obj.id))) {
                objects.set(obj.id, obj);
                renderObject(obj);
              }
            }
          } catch {}
        }
      }
    });

    ready = true; fit(); setTool('select'); status(); drawPeers();
  } else {
    currentUserRole = 'owner';
    $('#board-title').readOnly = false;
    $('#board-title').title = 'Название доски';
    await openBoard(); await initialize();
    for (const object of await allObjects()) { objects.set(object.id, object); renderObject(object); }
    $('#board-title').value = await readValue('meta', 'title') || 'Пространство идей';
    ready = true; fit(); setTool('select'); status(); send({ type: 'hello' });
    try {
      const raw = sessionStorage.getItem('ryadom-board-draft');
      if (raw) { const value = JSON.parse(raw); if (validObject(value) && value.text !== objects.get(value.id)?.text) { await add({ ...value, id: crypto.randomUUID(), revision: 0, x: value.x + 40 }); toast('Несохранённый черновик восстановлен отдельным объектом.'); } sessionStorage.removeItem('ryadom-board-draft'); }
    } catch { toast('Не удалось восстановить черновик.'); }
  }
}

try {
  await initBoard();
} catch (error) {
  failure = true; status(); toast(error.message);
  if (!remoteBoardId) {
    $$('.tools button, #board-title').forEach(el => { el.disabled = true; });
  }
}
