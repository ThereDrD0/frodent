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

async function fetchAttachment(url) {
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
    if (response.status === 401) token = '';
    throw new Error(body?.message || `Не удалось скачать вложение (${response.status}).`);
  }
  return response.blob();
}

export async function login(email, password) {
  const result = await request('users/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (typeof result?.access_token !== 'string') throw new Error('Сервер не вернул access_token.');
  token = result.access_token;
}

export async function register(email, password, displayName, adminSetupToken = '') {
  const result = await request('users/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, ...(adminSetupToken ? { adminSetupToken } : {}) }) });
  if (typeof result?.access_token !== 'string') throw new Error('Сервер не создал сессию аккаунта.');
  token = result.access_token;
}

export const authenticated = () => !!token;

export async function logout() {
  try { if (token) await request('auth/logout', { method: 'POST' }); }
  catch { /* Local access ends even if the API is unreachable; its access token expires soon. */ }
  finally { token = ''; }
}

function uploadName(object, blob) {
  const supplied = typeof object.text === 'string' ? object.text.trim() : '';
  if (/\.[a-z0-9]{1,8}$/i.test(supplied)) return supplied;
  return `attachment${mimeExtensions[blob.type] || '.bin'}`;
}

function objectPayload(object, id, attachments) {
  const result = {
    id, type: object.type, x: object.x, y: object.y, w: object.w, h: object.h,
    text: object.text, color: object.color
  };
  if (object.type === 'stroke') result.points = object.points;
  if (object.type === 'text') {
    if (object.headline !== undefined) result.headline = object.headline;
    if (object.small !== undefined) result.small = object.small;
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
      const payload = objectPayload(object, objectId, attachments);
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
