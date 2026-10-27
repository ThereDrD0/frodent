// Server snapshots use immutable board copies; live editing remains local-first.
let token = '';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mimeExtensions = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp', 'application/rtf': '.rtf'
};

async function request(path, options = {}) {
  const { timeout = 15000, headers: suppliedHeaders = {}, ...init } = options;
  const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers = {
    ...(!multipart ? { 'Content-Type': 'application/json' } : {}),
    ...suppliedHeaders,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  const response = await fetch(`/api/v1/${path}`, { ...init, headers, signal: AbortSignal.timeout(timeout) });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Сервер вернул некорректный ответ (${response.status}).`); }
  if (!response.ok || body.status !== 'Success') {
    if (response.status === 401) token = '';
    throw new Error(body.message || `Ошибка сервера ${response.status}`);
  }
  return body.data;
}

export async function fetchAttachment(url) {
  if (typeof url !== 'string' || !/^\/api\/v1\/boards\/[0-9a-f-]+\/attachments\/[0-9a-f-]+$/i.test(url)) {
    throw new Error('Сервер вернул недопустимую ссылку на вложение.');
  }
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401) setToken('');
    throw new Error(body?.message || `Не удалось скачать вложение (${response.status}).`);
  }
  return response.blob();
}

export function getAuthToken() {
  return token;
}

export function setToken(t) {
  token = typeof t === 'string' ? t.trim() : '';
}

export async function getUserInfo() {
  return request('users/me');
}

export async function login(email, password) {
  const result = await request('users/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (typeof result?.access_token !== 'string') throw new Error('Сервер не вернул access_token.');
  setToken(result.access_token);
}

export async function register(email, password, displayName, adminSetupToken = '') {
  const result = await request('users/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, ...(adminSetupToken ? { adminSetupToken } : {}) }) });
  if (typeof result?.access_token !== 'string') throw new Error('Сервер не создал сессию аккаунта.');
  setToken(result.access_token);
}

export const authenticated = () => !!token;

export async function logout() {
  try { if (token) await request('auth/logout', { method: 'POST' }); }
  catch { /* Local access ends even if the API is unreachable; its access token expires soon. */ }
  finally { setToken(''); }
}

function uploadName(object, blob) {
  const supplied = typeof object.text === 'string' ? object.text.trim() : '';
  if (/\.[a-z0-9]{1,8}$/i.test(supplied)) return supplied;
  return `attachment${mimeExtensions[blob.type] || '.bin'}`;
}

function objectPayload(object, id, attachments, ids) {
  const result = {
    id, type: object.type, x: object.x, y: object.y, w: object.w, h: object.h,
    text: object.text, color: object.color
  };
  if (object.type === 'stroke') result.points = object.points;
  if (object.type === 'shape' && object.shapeKind) result.shapeKind = object.shapeKind;
  if (object.type === 'text') {
    if (object.headline !== undefined) result.headline = object.headline;
    if (object.small !== undefined) result.small = object.small;
  }
  if (object.type === 'connector') {
    if (object.fromId) result.fromId = ids?.get(object.fromId) || object.fromId;
    if (object.toId) result.toId = ids?.get(object.toId) || object.toId;
    if (object.fromSide) result.fromSide = object.fromSide;
    if (object.toSide) result.toSide = object.toSide;
    if (Number.isFinite(object.startX)) result.startX = object.startX;
    if (Number.isFinite(object.startY)) result.startY = object.startY;
    if (Number.isFinite(object.endX)) result.endX = object.endX;
    if (Number.isFinite(object.endY)) result.endY = object.endY;
    if (object.style) result.style = object.style;
  }
  if (object.asset) result.asset = object.asset;
  if (object.blobId) {
    const attachmentId = attachments.get(object.blobId);
    if (!attachmentId) throw new Error(`Не найдено вложение «${object.text || 'без имени'}».`);
    result.attachmentId = attachmentId;
  }
  return result;
}

export async function saveSnapshot(data, readBlob, onProgress = () => {}) {
  const board = await request('boards', { method: 'POST', body: JSON.stringify({ title: data.title }) });
  try {
    const files = new Map();
    for (const object of data.objects) {
      if (object.blobId && !files.has(object.blobId)) files.set(object.blobId, object);
    }
    const attachments = new Map();
    let uploaded = 0;
    for (const [blobId, object] of files) {
      const blob = await readBlob(blobId);
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error(`Не удалось прочитать файл «${object.text || 'без имени'}».`);
      const form = new FormData();
      form.append('file', blob, uploadName(object, blob));
      const saved = await request(`boards/${board.id}/attachments`, {
        method: 'POST', body: form, headers: { 'Idempotency-Key': crypto.randomUUID() }, timeout: 120000
      });
      attachments.set(blobId, saved.id);
      uploaded++;
      onProgress(`Загружены вложения: ${uploaded}/${files.size}.`);
    }

    const ids = new Map(data.objects.map(object => [object.id, crypto.randomUUID()]));
    for (let index = 0; index < data.objects.length; index++) {
      const object = data.objects[index], objectId = ids.get(object.id);
      const payload = objectPayload(object, objectId, attachments, ids);
      await request(`boards/${board.id}/operations`, {
        method: 'POST',
        body: JSON.stringify({ opId: crypto.randomUUID(), objectId, action: 'create', baseRevision: 0, object: payload }),
        timeout: 30000
      });
      onProgress(`Сохранены объекты: ${index + 1}/${data.objects.length}.`);
    }
    return { id: board.id, title: board.title, files: files.size, objects: data.objects.length };
  } catch (error) {
    throw new Error(`Не удалось полностью сохранить снимок ${board.id}: ${error.message} На сервере могла остаться неполная копия.`);
  }
}

export async function loadSnapshot(id) {
  const value = String(id).trim();
  if (/^\d+$/.test(value)) return { kind: 'legacy', ...(await request(`notes/${value}`)) };
  if (!uuidPattern.test(value)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  const board = await request(`boards/${value}`);
  const files = new Map(), names = new Map();
  let total = 0;
  for (const attachment of board.attachments) {
    const blob = await fetchAttachment(attachment.downloadUrl);
    if (blob.size !== attachment.size) throw new Error(`Размер вложения «${attachment.originalName}» не совпадает с серверным.`);
    total += blob.size;
    if (total > 200 * 1024 * 1024) throw new Error('Общий размер файлов серверной доски превышает 200 МБ.');
    files.set(attachment.id, blob);
    names.set(attachment.id, attachment.originalName);
  }
  return { kind: 'board', board, files, names };
}

export async function createBoard(title) {
  return request('boards', {
    method: 'POST',
    body: JSON.stringify({ title: typeof title === 'string' && title.trim() ? title.trim() : 'Пространство идей' })
  });
}

export async function listBoards(limit = 50, offset = 0) {
  return request(`boards?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
}

export async function getBoard(boardId) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  return request(`boards/${boardId}`);
}

export async function createInvite(boardId) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  return request(`boards/${boardId}/invite`, { method: 'POST' });
}

export async function acceptInvite(inviteToken) {
  const tokenValue = String(inviteToken || '').trim();
  if (!tokenValue) throw new Error('Укажите токен приглашения.');
  return request('board-invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token: tokenValue })
  });
}

export async function createSessionTicket(boardId) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  return request(`boards/${boardId}/session`, { method: 'POST' });
}

export async function sendOperation(boardId, operation) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  return request(`boards/${boardId}/operations`, {
    method: 'POST',
    body: JSON.stringify(operation),
    timeout: 30000
  });
}

export async function uploadAttachment(boardId, file) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  const form = new FormData();
  const name = file.name || (typeof file.text === 'string' && file.text.trim()) || 'attachment.bin';
  form.append('file', file, name);
  return request(`boards/${boardId}/attachments`, {
    method: 'POST',
    body: form,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    timeout: 120000
  });
}

export async function renameBoard(boardId, title) {
  if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
  return request(`boards/${boardId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  });
}

export class BoardRealtimeClient {
  constructor({ boardId, getTicket, onMessage, onStatusChange, WebSocket: CustomSocket }) {
    if (!uuidPattern.test(boardId)) throw new Error('Укажите числовой ID старого снимка или UUID серверной доски.');
    this.boardId = boardId;
    this.getTicket = getTicket;
    this.onMessage = onMessage || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.SocketClass = CustomSocket || (typeof WebSocket !== 'undefined' ? WebSocket : globalThis.WebSocket);
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.lastCursorTime = 0;
    this.pendingCursor = null;
    this.cursorTimer = null;
    if (this.SocketClass) this.connect();
  }

  async connect() {
    if (this.closed || !this.SocketClass) return;
    this.onStatusChange('connecting');
    try {
      const ticket = typeof this.getTicket === 'function' ? await this.getTicket() : '';
      if (this.closed) return;
      const host = (typeof location !== 'undefined' && location.host) || 'localhost';
      const protocol = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
      const url = `${protocol}//${host}/api/v1/boards/${this.boardId}/events?ticket=${encodeURIComponent(ticket || '')}`;

      const ws = new this.SocketClass(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.onStatusChange('open');
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          this.onMessage(data);
        } catch {
          // Игнорируем некорректный JSON
        }
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.onStatusChange('closed');
        if (!this.closed) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), 1500);
        }
      };

      ws.onerror = () => {
        this.onStatusChange('error');
      };
    } catch {
      this.onStatusChange('error');
      if (!this.closed) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === (this.SocketClass?.OPEN ?? 1)) {
      try {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        this.ws.send(payload);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  sendCursor(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) > 1000000 || Math.abs(y) > 1000000) return;

    const now = Date.now();
    const interval = 30; // троттлинг 30 мс
    const cursorMsg = { type: 'cursor', x: Math.round(x), y: Math.round(y) };

    if (now - this.lastCursorTime >= interval) {
      this.lastCursorTime = now;
      clearTimeout(this.cursorTimer);
      this.pendingCursor = null;
      this.send(cursorMsg);
    } else {
      this.pendingCursor = cursorMsg;
      if (!this.cursorTimer) {
        const delay = Math.max(interval - (now - this.lastCursorTime), 5);
        this.cursorTimer = setTimeout(() => {
          this.cursorTimer = null;
          if (this.pendingCursor) {
            this.lastCursorTime = Date.now();
            this.send(this.pendingCursor);
            this.pendingCursor = null;
          }
        }, delay);
      }
    }
  }

  sendSelection(objectId) {
    const valid = typeof objectId === 'string' && uuidPattern.test(objectId);
    this.send({ type: 'selection', objectId: valid ? objectId : null });
  }

  sendStrokePreview(points) {
    if (!Array.isArray(points)) return;
    const trimmed = points.slice(0, 200).filter(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 1000000 && Math.abs(p[1]) <= 1000000);
    this.send({ type: 'stroke-preview', points: trimmed });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.cursorTimer);
    this.pendingCursor = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.onStatusChange('closed');
  }
}
