// Existing C++ API: explicit immutable snapshots, never background whole-board PATCH.
let token = '';
async function request(path, options = {}) {
  const response = await fetch(`/api/v1/${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || body.status !== 'Success') {
    if (response.status === 401) token = '';
    throw new Error(body.message || `Ошибка сервера ${response.status}`);
  }
  return body.data;
}
export async function login(email, password) {
  const result = await request('users/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (typeof result?.access_token !== 'string') throw new Error('Сервер не вернул access_token.');
  token = result.access_token;
}
export const authenticated = () => !!token;
export const logout = () => { token = ''; };
export async function saveSnapshot(data) {
  const content = JSON.stringify(data);
  if (new TextEncoder().encode(content).length > 800000) throw new Error('Снимок слишком большой для текущего API. Скачайте файл доски.');
  return request('notes', { method: 'POST', body: JSON.stringify({ title: `[Доска] ${data.title}`, content }) });
}
export const loadSnapshot = id => {
  if (!/^\d+$/.test(String(id))) throw new Error('Нужен числовой ID снимка.');
  return request(`notes/${id}`);
};
