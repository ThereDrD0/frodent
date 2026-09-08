import { validObject, initialObjects } from './board-model.js';
let db;
export function openBoard() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ryadom-board-v1', 1);
    request.onupgradeneeded = () => {
      const connection = request.result;
      connection.createObjectStore('objects', { keyPath: 'id' });
      connection.createObjectStore('files');
      connection.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Закройте старую вкладку доски и обновите страницу.'));
    request.onsuccess = () => { db = request.result; db.onversionchange = () => db.close(); resolve(db); };
  });
}
export function initialize() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'objects'], 'readwrite');
    const meta = tx.objectStore('meta');
    meta.get('initialized').onsuccess = event => {
      if (event.target.result) return;
      for (const object of initialObjects()) tx.objectStore('objects').put(object);
      meta.put(true, 'initialized'); meta.put('Пространство идей', 'title');
    };
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
}
export function allObjects() {
  return new Promise((resolve, reject) => {
    const request = db.transaction('objects').objectStore('objects').getAll();
    request.onsuccess = () => {
      if (!request.result.every(validObject)) reject(new Error('Хранилище содержит повреждённые объекты. Данные не перезаписаны.'));
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
// Each object is committed atomically; a stale edit cannot overwrite another tab.
export function commitObject(object, expectedRevision, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['objects', 'files'], 'readwrite');
    const store = tx.objectStore('objects');
    let saved, conflict;
    store.get(object.id).onsuccess = event => {
      const actual = event.target.result;
      if ((actual?.revision || 0) !== expectedRevision) { conflict = actual; return; }
      saved = { ...object, revision: expectedRevision + 1 };
      if (!validObject(saved)) { tx.abort(); return; }
      if (blob && saved.blobId) tx.objectStore('files').put(blob, saved.blobId);
      store.put(saved);
    };
    tx.oncomplete = () => resolve(saved ? { saved } : { conflict });
    tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить объект.'));
  });
}
export function readValue(store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export function writeMeta(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(value, key);
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
}
