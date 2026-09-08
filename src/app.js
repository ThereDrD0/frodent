import { hydrateIcons, icon } from './icons.js';
import { escapeHTML, renderMarkdown, wordCount } from './markdown.js';
import { STORAGE_KEY, readNotes, visibleNotes, createNote } from './store.js';
import { seed } from './seed.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let notes, storageBlocked = false, dirty = false, filter = 'all', query = '', sort = 'updated', view = 'preview', selected;
let snackTimer;
try { notes = readNotes(localStorage, seed); }
catch { notes = structuredClone(seed); storageBlocked = true; }
selected = notes.find(n => !n.deleted)?.id;
try { document.documentElement.dataset.theme = localStorage.getItem('ryadom.theme') === 'dark' ? 'dark' : 'light'; } catch { /* Theme is optional. */ }
const current = () => notes.find(n => n.id === selected);
const list = () => visibleNotes(notes, filter, query, sort);
const date = time => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(time);
const time = timestamp => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
const plural = (count, forms) => count % 10 === 1 && count % 100 !== 11 ? forms[0] : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? forms[1] : forms[2];

function snack(message, action, label = 'Отменить') {
  clearTimeout(snackTimer);
  const el = $('#snackbar');
  el.replaceChildren(document.createTextNode(message));
  if (action) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { action(); el.hidden = true; }; el.append(button); }
  el.hidden = false;
  snackTimer = setTimeout(() => { el.hidden = true; }, action ? 12000 : 5000);
}

function save() {
  dirty = true;
  if (!storageBlocked) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notes)); dirty = false; }
    catch { /* Preserve the in-memory draft and offer Markdown export. */ }
  }
  $('#save-state').textContent = dirty ? 'Не сохранено' : 'Сохранено';
  $('#save-state').classList.toggle('error', dirty);
  $('#save-state').title = dirty ? 'Не удалось записать данные. Скачайте Markdown через меню заметки.' : 'Сохранено в этом браузере';
  if (dirty) snack('Не удалось сохранить. Скачайте заметку, чтобы не потерять текст.', exportNote, 'Скачать');
}

function renderList() {
  const shown = list();
  const active = notes.filter(n => !n.deleted);
  $('#all-count').textContent = active.length;
  $('#star-count').textContent = active.filter(n => n.starred).length || '';
  $('#trash-count').textContent = notes.filter(n => n.deleted).length || '';
  $('#list-count').textContent = `${shown.length} ${plural(shown.length, ['заметка', 'заметки', 'заметок'])}`;
  $('#notes-list').innerHTML = shown.length ? shown.map(n => `<button class="note-card ${n.id === selected ? 'selected' : ''}" data-note="${escapeHTML(n.id)}" aria-pressed="${n.id === selected}"><span class="card-top">${icon(n.id === 'welcome' ? 'sprout' : 'document')}${n.starred ? icon('star').replace('<svg ', '<svg class="card-star" ') : ''}</span><h3>${escapeHTML(n.title || 'Без названия')}</h3><p>${escapeHTML(n.content.replace(/[#*>`\[\]\n-]/g, ' ').trim() || 'Пока чистый лист')}</p><span class="card-date">${date(n.updated)} · ${wordCount(n.content)} ${plural(wordCount(n.content), ['слово', 'слова', 'слов'])}</span></button>`).join('') : `<div class="list-empty">${icon(query ? 'search' : filter === 'trash' ? 'trash' : 'notes')}<strong>${query ? 'Ничего не найдено' : filter === 'trash' ? 'В корзине пусто' : filter === 'starred' ? 'Важное будет здесь' : 'Начните с одной мысли'}</strong><p>${query ? 'Попробуйте другое слово.' : filter === 'starred' ? 'Нажмите на звёздочку у заметки.' : filter === 'trash' ? 'Удалённые заметки можно восстановить.' : 'Создайте вашу первую заметку.'}</p>${query ? '<button data-action="clear-search">Сбросить поиск</button>' : filter === 'all' ? '<button data-action="new">Создать заметку</button>' : ''}</div>`;
  $('#pinned').innerHTML = active.filter(n => n.starred).slice(0, 5).map(n => `<button data-note="${escapeHTML(n.id)}" title="${escapeHTML(n.title)}">${icon('document')}<span>${escapeHTML(n.title || 'Без названия')}</span></button>`).join('') || '<p>Добавьте важное в избранное</p>';
}

function renderMeta() {
  const n = current();
  if (!n) return;
  $('#updated-at').textContent = `Изменено ${date(n.updated)}, ${time(n.updated)}`;
  const words = wordCount(n.content);
  $('#word-count').textContent = `${words} ${plural(words, ['слово', 'слова', 'слов'])} · ${n.content.length} ${plural(n.content.length, ['знак', 'знака', 'знаков'])}`;
}

function setView(next) {
  view = next;
  $('#note-content').hidden = view !== 'edit';
  $('#preview').hidden = view !== 'preview';
  $('[data-view="edit"]').classList.toggle('selected', view === 'edit');
  $('[data-view="preview"]').classList.toggle('selected', view === 'preview');
  $$('[data-view]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.view === view)));
  $('#editor-mode').textContent = current()?.deleted ? 'В корзине · только чтение' : view === 'edit' ? 'Режим редактирования' : 'Режим чтения';
  if (view === 'preview') renderPreview();
}

function renderPreview() {
  $('#preview').innerHTML = current()?.content ? renderMarkdown(current().content) : '<p>Здесь пока тихо. Нажмите на карандаш, чтобы записать первую мысль.</p>';
  if (current()?.deleted) $$('#preview input').forEach(el => { el.disabled = true; });
}

function renderEditor() {
  const n = current();
  $('#editor-panel').hidden = !n;
  $('#empty-editor').hidden = !!n;
  $('#more-menu').hidden = true;
  $('[data-action="more"]').setAttribute('aria-expanded', 'false');
  if (!n) return;
  $('#note-title').value = n.title;
  $('#note-content').value = n.content;
  $('#note-title').readOnly = n.deleted;
  $('#note-content').readOnly = n.deleted;
  $('[data-action="star"]').disabled = n.deleted;
  $('[data-action="star"]').classList.toggle('is-starred', n.starred);
  $('[data-action="star"]').setAttribute('aria-pressed', String(n.starred));
  $('[data-action="star"]').setAttribute('aria-label', n.starred ? 'Убрать из избранного' : 'В избранное');
  $('[data-action="star"]').title = n.starred ? 'Убрать из избранного' : 'В избранное';
  $('[data-action="share"]').disabled = n.deleted;
  $$('[data-format], [data-view="edit"]').forEach(el => { el.disabled = n.deleted; });
  $('#document-label').textContent = n.deleted ? 'В корзине' : 'Заметка';
  $('#more-menu').innerHTML = n.deleted ? `<button data-action="restore">${icon('arrow')}Восстановить заметку</button><button data-action="export">${icon('download')}Скачать Markdown</button>` : `<button data-action="export">${icon('download')}Скачать Markdown</button><button data-action="duplicate">${icon('copy')}Создать копию</button><button data-action="delete" class="danger">${icon('trash')}В корзину</button>`;
  setView(n.deleted ? 'preview' : view);
  renderMeta();
  $('#editor-content').scrollTop = 0;
}

function changeFilter(next) {
  filter = next;
  const titles = { all: 'Все заметки', starred: 'Избранное', trash: 'Корзина' };
  const descriptions = { all: 'Собирайте идеи. Находите главное. Создавайте своё.', starred: 'Самое важное — всегда под рукой.', trash: 'Передумали? Любую заметку можно восстановить.' };
  $('#breadcrumb').textContent = titles[filter];
  $('#page-title').innerHTML = `${titles[filter]}<span class="heading-dot">.</span>`;
  $('#page-description').textContent = descriptions[filter];
  $$('[data-filter]').forEach(el => { el.classList.toggle('active', el.dataset.filter === filter); el.setAttribute('aria-current', el.dataset.filter === filter ? 'page' : 'false'); });
  if (!list().some(n => n.id === selected)) selected = list()[0]?.id;
  renderList(); renderEditor();
  closeSidebar();
}

function selectNote(id) {
  const n = notes.find(item => item.id === id);
  if (!n) return;
  if (n.deleted !== (filter === 'trash') || (filter === 'starred' && !n.starred) || !list().some(item => item.id === id)) {
    query = ''; $('#search').value = ''; changeFilter(n.deleted ? 'trash' : 'all');
  }
  selected = id;
  renderList(); renderEditor(); closeSidebar();
}

function newNote(title, content) {
  const n = createNote(title, content);
  notes.unshift(n); selected = n.id; query = ''; $('#search').value = ''; view = 'edit';
  save(); changeFilter('all');
  $('#note-title').focus(); $('#note-title').select();
}

function exportNote() {
  const n = current();
  if (!n) return;
  const blob = new Blob([`# ${n.title || 'Без названия'}\n\n${n.content}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${(n.title || 'Заметка').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 100) || 'Заметка'}.md`;
  document.body.append(link);
  link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function dialog(type) {
  const content = type === 'share' ? {
    icon: 'share', title: 'Мысли лучше вместе',
    body: '<p>Пока это личное пространство: заметка хранится только в вашем браузере.</p><p class="dialog-note">Совместный доступ появится после подключения сервера. Уже сейчас можно скачать заметку в Markdown и передать её любым удобным способом.</p>',
    actions: '<button class="text-button" data-action="close-dialog">Понятно</button><button class="filled-button" data-action="download-dialog">Скачать заметку</button>'
  } : {
    icon: 'sprout', title: 'Пусть мысли будут рядом',
    body: '<p>Создавайте заметки, отмечайте важное звёздочкой и находите текст через поиск. Карандаш включает редактор, значок глаза — чтение.</p><p><strong>Markdown:</strong> ## заголовок, **жирный**, *курсив*, - список, - [ ] задача. Галочки можно ставить прямо при чтении.</p><p><strong>Клавиши:</strong> Ctrl/⌘ + K — поиск, Ctrl/⌘ + B — жирный, Ctrl/⌘ + I — курсив, Escape — закрыть окно.</p><p class="dialog-note">Автосохранение работает в этом браузере. Очистка данных сайта удалит заметки. Скачивайте важное через меню «⋯». Синхронизация между устройствами и совместное редактирование пока не подключены.</p>',
    actions: '<button class="filled-button" data-action="close-dialog">Всё понятно</button>'
  };
  $('#dialog-content').innerHTML = `<div class="dialog-icon">${icon(content.icon)}</div><h2 id="dialog-title">${content.title}</h2>${content.body}<div class="dialog-actions">${content.actions}</div>`;
  $('#dialog').showModal();
}

function format(kind) {
  if (!current() || current().deleted) return;
  setView('edit');
  const el = $('#note-content');
  const start = el.selectionStart, end = el.selectionEnd;
  const picked = el.value.slice(start, end);
  const options = { heading: ['## ', '', 'Заголовок'], bold: ['**', '**', 'текст'], italic: ['*', '*', 'текст'], list: ['- ', '', 'Пункт списка'], check: ['- [ ] ', '', 'Задача'], quote: ['> ', '', 'Цитата'], link: ['[', '](https://example.com)', 'текст ссылки'] };
  const [before, after, fallback] = options[kind];
  const block = ['heading', 'list', 'check', 'quote'].includes(kind);
  const prefix = block && start > 0 && el.value[start - 1] !== '\n' ? '\n' : '';
  const insertion = prefix + before + (picked || fallback) + after;
  el.setRangeText(insertion, start, end, 'end');
  el.focus();
  el.setSelectionRange(start + prefix.length + before.length, start + prefix.length + before.length + (picked || fallback).length);
  updateContent();
}

function updateContent() {
  const n = current(); if (!n || n.deleted) return;
  n.content = $('#note-content').value; n.updated = Date.now();
  save(); renderList(); renderMeta();
}

const narrowScreen = matchMedia('(max-width: 760px)');
function syncSidebar() {
  const open = document.body.classList.contains('menu-open');
  $('#sidebar').inert = narrowScreen.matches && !open;
  $('.mobile-menu').setAttribute('aria-expanded', String(open));
  $('.mobile-menu').setAttribute('aria-controls', 'sidebar');
}
function closeSidebar() {
  const focusedInside = $('#sidebar').contains(document.activeElement);
  document.body.classList.remove('menu-open'); syncSidebar();
  if (narrowScreen.matches && focusedInside) $('.mobile-menu').focus();
}
narrowScreen.addEventListener('change', closeSidebar);

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.note) { selectNote(target.dataset.note); return; }
  if (target.dataset.filter) { changeFilter(target.dataset.filter); return; }
  if (target.dataset.view) { setView(target.dataset.view); if (view === 'edit') $('#note-content').focus(); return; }
  if (target.dataset.format) { format(target.dataset.format); return; }
  const n = current();
  switch (target.dataset.action) {
    case 'new': newNote(); break;
    case 'star':
      if (!n || n.deleted) break;
      n.starred = !n.starred; save();
      if (filter === 'starred' && !n.starred) selected = list()[0]?.id;
      renderList(); renderEditor(); break;
    case 'theme': {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('ryadom.theme', next); } catch { snack('Тема изменена на время этой сессии.'); }
      break;
    }
    case 'menu':
      document.body.classList.toggle('menu-open'); syncSidebar();
      if (document.body.classList.contains('menu-open')) $('#sidebar .new-note').focus();
      break;
    case 'help': dialog('help'); break;
    case 'share': dialog('share'); break;
    case 'close-dialog': $('#dialog').close(); break;
    case 'download-dialog': exportNote(); $('#dialog').close(); break;
    case 'more': {
      $('#more-menu').hidden = !$('#more-menu').hidden;
      target.setAttribute('aria-expanded', String(!$('#more-menu').hidden));
      if (!$('#more-menu').hidden) $('#more-menu button').focus();
      break;
    }
    case 'clear-search': query = ''; $('#search').value = ''; selected = list()[0]?.id; renderList(); renderEditor(); $('#search').focus(); break;
    case 'export': exportNote(); break;
    case 'duplicate': if (n) newNote(`${n.title} — копия`, n.content); break;
    case 'delete':
      if (!n) break;
      n.deleted = true; save(); selected = list()[0]?.id; renderList(); renderEditor();
      snack('Заметка перемещена в корзину', () => { n.deleted = false; save(); selectNote(n.id); }); break;
    case 'restore':
      if (!n) break;
      n.deleted = false; save(); selectNote(n.id); snack('Заметка восстановлена'); break;
  }
  if (target.dataset.action !== 'more') { $('#more-menu').hidden = true; $('[data-action="more"]').setAttribute('aria-expanded', 'false'); }
});

document.addEventListener('click', event => {
  if (!event.target.closest('#more-menu, [data-action="more"]')) { $('#more-menu').hidden = true; $('[data-action="more"]').setAttribute('aria-expanded', 'false'); }
});
$('#note-title').addEventListener('input', () => {
  const n = current(); if (!n || n.deleted) return;
  if ($('#note-title').value.includes('\n')) $('#note-title').value = $('#note-title').value.replace(/\n/g, ' ');
  n.title = $('#note-title').value; n.updated = Date.now(); save(); renderList(); renderMeta();
});
$('#note-title').addEventListener('blur', () => {
  const n = current(); if (!n || n.deleted || n.title.trim()) return;
  n.title = 'Без названия'; $('#note-title').value = n.title; save(); renderList();
});
$('#note-content').addEventListener('input', updateContent);
$('#preview').addEventListener('change', event => {
  const n = current(); if (!n || n.deleted || !event.target.matches('[data-line]')) return;
  const lines = n.content.split('\n');
  const i = Number(event.target.dataset.line);
  lines[i] = lines[i].replace(/^([-*] )\[[ xX]\]/, `$1[${event.target.checked ? 'x' : ' '}]`);
  n.content = lines.join('\n'); n.updated = Date.now(); $('#note-content').value = n.content;
  save(); renderList(); renderMeta();
});
$('#search').addEventListener('input', event => {
  query = event.target.value;
  if (!list().some(n => n.id === selected)) selected = list()[0]?.id;
  renderList(); renderEditor();
});
$('#sort').addEventListener('change', event => { sort = event.target.value; renderList(); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); }
  if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase()) && document.activeElement === $('#note-content')) { event.preventDefault(); format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic'); }
  if (event.key === 'Escape') {
    closeSidebar();
    if (!$('#more-menu').hidden) { $('#more-menu').hidden = true; $('[data-action="more"]').setAttribute('aria-expanded', 'false'); $('[data-action="more"]').focus(); }
  }
});
// A second tab must not silently replace an active local draft.
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  storageBlocked = true; dirty = true;
  $('#save-state').textContent = 'Конфликт вкладок'; $('#save-state').classList.add('error');
  snack('Данные изменены в другой вкладке. Скачайте текущую заметку и обновите страницу.', exportNote, 'Скачать');
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
hydrateIcons(); renderList(); renderEditor(); syncSidebar();
$('.search kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
if (storageBlocked) snack('Не удалось прочитать хранилище. Существующие данные не перезаписаны.', () => dialog('help'), 'Подробнее');
