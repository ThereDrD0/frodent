export const STORAGE_KEY = 'ryadom.notes.v1';
export function isValidNotes(notes) {
  return Array.isArray(notes) && notes.every(n => n && typeof n.id === 'string' && typeof n.title === 'string' && typeof n.content === 'string' && typeof n.starred === 'boolean' && typeof n.deleted === 'boolean' && Number.isFinite(n.updated) && Number.isFinite(n.created)) && new Set(notes.map(n => n.id)).size === notes.length;
}
export function readNotes(storage, seed) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return structuredClone(seed);
  const notes = JSON.parse(raw);
  if (!isValidNotes(notes)) throw new Error('Invalid notes storage');
  return notes;
}
export function visibleNotes(notes, filter, query, sort) {
  const q = query.toLocaleLowerCase('ru').trim();
  return notes.filter(n => (filter === 'trash' ? n.deleted : !n.deleted && (filter !== 'starred' || n.starred)) && `${n.title} ${n.content}`.toLocaleLowerCase('ru').includes(q)).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ru') : b[sort] - a[sort]);
}
export function createNote(title = 'Без названия', content = '') {
  return { id: crypto.randomUUID(), title, content, starred: false, deleted: false, created: Date.now(), updated: Date.now() };
}
