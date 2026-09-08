import test from 'node:test';
import assert from 'node:assert/strict';
import { readNotes, visibleNotes, createNote, isValidNotes } from '../src/store.js';

const notes = [
  { ...createNote('Бета', 'Искать ВНУТРИ'), id: 'a', updated: 1, created: 2 },
  { ...createNote('Альфа', ''), id: 'b', starred: true, updated: 3, created: 1 },
  { ...createNote('Корзина', ''), id: 'c', starred: true, deleted: true, updated: 4, created: 3 }
];
test('Search is case insensitive and includes contents', () => {
  assert.deepEqual(visibleNotes(notes, 'all', 'внутри', 'updated').map(n => n.id), ['a']);
});
test('Favorites exclude trash; sort modes are deterministic', () => {
  assert.deepEqual(visibleNotes(notes, 'starred', '', 'updated').map(n => n.id), ['b']);
  assert.deepEqual(visibleNotes(notes, 'trash', '', 'updated').map(n => n.id), ['c']);
  assert.deepEqual(visibleNotes(notes, 'all', '', 'title').map(n => n.id), ['b', 'a']);
  assert.deepEqual(visibleNotes(notes, 'all', '', 'created').map(n => n.id), ['a', 'b']);
});
test('Empty persisted collection stays empty, seed is cloned', () => {
  assert.deepEqual(readNotes({ getItem: () => '[]' }, notes), []);
  const initial = readNotes({ getItem: () => null }, notes);
  initial[0].title = 'Changed';
  assert.equal(notes[0].title, 'Бета');
});
test('Corrupt or duplicate storage is rejected without writes', () => {
  assert.throws(() => readNotes({ getItem: () => '{broken' }, notes));
  assert.throws(() => readNotes({ getItem: () => '[{}]' }, notes));
  assert.equal(isValidNotes([notes[0], notes[0]]), false);
});
test('New notes have distinct identities and remain editable', () => {
  const a = createNote(), b = createNote();
  assert.notEqual(a.id, b.id);
  assert.equal(isValidNotes([a, b]), true);
  assert.equal(a.deleted, false);
});
