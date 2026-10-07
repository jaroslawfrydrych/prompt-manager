'use strict';

const FLAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const FLAG_NAMES = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', gray: 'Gray' };
// Finder tag colours (dark appearance); mirrored in styles.css.
const FLAG_HEX = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#32d74b', blue: '#0a84ff', purple: '#bf5af2', gray: '#98989d' };
const STALE_DAYS = 3;
const DAY = 86400000;

const ICONS = {
  tray: '<svg viewBox="0 0 16 16"><path d="M2 9.5 3.6 3.4A1.2 1.2 0 0 1 4.8 2.5h6.4a1.2 1.2 0 0 1 1.2.9L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/></svg>',
  flag: '<svg viewBox="0 0 16 16"><path d="M3.5 14V2.5M3.5 3h8.2l-1.9 3 1.9 3H3.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1.8 4.3c0-.7.5-1.3 1.2-1.3h3.2l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.5c0 .7-.5 1.3-1.2 1.3H3c-.7 0-1.2-.6-1.2-1.3z"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.6"/><path d="M11 5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.8c0 .9.7 1.6 1.6 1.6H5"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
  restore: '<svg viewBox="0 0 16 16"><path d="M3 6.5h7a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 4 3 6.5 5.5 9"/></svg>',
};

let state = { version: 2, projects: [], prompts: [], view: 'all', tab: 'pending' };
let editing = null; // { id, draft, isNew }
let renaming = null; // project id
let query = '';

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- persistence ----------

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveTimer);
  window.api.save(state);
}
window.addEventListener('beforeunload', () => {
  if (editing) commitEdit(false);
  flush();
});

// ---------- markdown: ``` blocks and `inline` only ----------

function inline(text) {
  return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function renderMarkdown(src) {
  const re = /```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(?:\n?```|$)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out += inline(src.slice(last, m.index).replace(/\n+$/, ''));
    out += `<div class="codeblock"><div class="cb-head"><span>${esc(m[1] || 'code')}</span>`
      + `<button class="cb-copy" title="Copy code">${ICONS.copy}</button></div>`
      + `<pre><code>${esc(m[2])}</code></pre></div>`;
    last = re.lastIndex;
    while (src[last] === '\n') last++;
  }
  return out + inline(src.slice(last));
}

// ---------- time ----------

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });

function ago(ts) {
  const s = (ts - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return rtf.format(Math.round(s / (86400 * 30)), 'month');
}
const isStale = (p) => !p.doneAt && Date.now() - p.createdAt > STALE_DAYS * DAY;

// ---------- selectors ----------

const project = (id) => state.projects.find((p) => p.id === id);
const pendingCount = (pred) => state.prompts.filter((p) => !p.doneAt && pred(p)).length;

function visiblePrompts() {
  const { view, tab } = state;
  const q = query.trim().toLowerCase();
  return state.prompts
    .filter((p) => (tab === 'done' ? p.doneAt : !p.doneAt))
    .filter((p) => view === 'all' || (view === 'flagged' ? p.flag : p.projectId === view))
    .filter((p) => !q || p.text.toLowerCase().includes(q) || (editing && editing.id === p.id))
    .sort((a, b) => (tab === 'done' ? b.doneAt - a.doneAt : 0)); // pending: manual order = array order
}

// Project a new prompt lands in when the current view is not a project.
function targetProjectId() {
  if (project(state.view)) return state.view;
  if (project(state.lastProject)) return state.lastProject;
  return state.projects[0] && state.projects[0].id;
}

// ---------- sidebar ----------

function navItem({ id, icon, label, count, cls = '' }) {
  const active = state.view === id ? ' active' : '';
  const name = renaming === id
    ? `<input class="rename" value="${esc(label)}" spellcheck="false">`
    : `<span class="label">${esc(label)}</span>`;
  const draggable = project(id) && renaming !== id ? ' draggable="true"' : '';
  return `<div class="nav-item${active} ${cls}" data-view="${id}"${draggable}>
    <span class="nav-icon">${icon}</span>${name}
    ${count ? `<span class="badge">${count}</span>` : ''}
  </div>`;
}

function renderSidebar() {
  const projects = state.projects.map((p, i) => navItem({
    id: p.id, icon: ICONS.folder, label: p.name, count: pendingCount((x) => x.projectId === p.id),
    cls: i < 9 ? `kb-${i + 1}` : '',
  })).join('');
  $('#nav').innerHTML = `
    <div class="nav-section">
      ${navItem({ id: 'all', icon: ICONS.tray, label: 'All', count: pendingCount(() => true) })}
      ${navItem({ id: 'flagged', icon: ICONS.flag, label: 'Flagged', count: pendingCount((p) => p.flag), cls: 'flagged' })}
    </div>
    <div class="nav-heading"><span>Projects</span>
      <button class="icon-btn small" id="add-project" title="New Project (⇧⌘N)">${ICONS.plus}</button>
    </div>
    <div class="nav-section">${projects || '<div class="nav-empty">No projects</div>'}</div>`;

  const input = $('#nav .rename');
  if (input) {
    input.focus();
    input.select();
    const done = (ok) => {
      if (renaming === null) return;
      const p = project(renaming);
      renaming = null;
      if (ok && p && input.value.trim()) p.name = input.value.trim();
      persist();
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }
}

// ---------- prompt list ----------

function cardHtml(p) {
  const isEditing = editing && editing.id === p.id;
  const stale = isStale(p);
  const showProject = state.view === 'all' || state.view === 'flagged';
  const proj = project(p.projectId);
  const doneLabel = p.doneAt ? `done ${ago(p.doneAt)}` : '';
  const body = isEditing
    ? `<textarea class="editor" placeholder="What are we working on?" spellcheck="false"></textarea>
       <div class="edit-hint"><kbd>⌘</kbd><kbd>↩</kbd> save &nbsp;·&nbsp; <kbd>esc</kbd> cancel &nbsp;·&nbsp; <code>\`code\`</code> &nbsp; <code>\`\`\`block\`\`\`</code></div>`
    : `<div class="body">${renderMarkdown(p.text)}</div>`;

  const draggable = !isEditing && !p.doneAt ? ' draggable="true"' : '';
  return `<article${draggable} class="card${stale ? ' stale' : ''}${p.doneAt ? ' done' : ''}${isEditing ? ' editing' : ''}${p.flag ? ` flag-${p.flag}` : ''}" data-id="${p.id}">
    <button class="check" data-act="toggle-done" title="${p.doneAt ? 'Move back to pending' : 'Mark as done'}">${ICONS.check}</button>
    <div class="card-main">
      <div class="meta">
        ${p.flag ? `<span class="flag-dot" title="${FLAG_NAMES[p.flag]}"></span>` : ''}
        ${showProject && proj ? `<button class="chip" data-act="project" title="Move to another project">${esc(proj.name)}</button>` : ''}
        <span class="age${stale ? ' warn' : ''}" title="Created ${dtf.format(p.createdAt)}" data-ts="${p.createdAt}">${stale ? ICONS.clock : ''}<span>${ago(p.createdAt)}</span></span>
        ${doneLabel ? `<span class="age">· ${doneLabel}</span>` : ''}
        <span class="spacer"></span>
        <button class="act more" data-act="more" title="More">${ICONS.more}</button>
        ${p.doneAt
          ? `<button class="act pill" data-act="toggle-done">${ICONS.restore}<span>Restore</span></button>`
          : `<button class="act pill copy" data-act="copy" title="Copy prompt  ·  ⌥-click: copy and mark as done">${ICONS.copy}<span>Copy</span></button>`}
      </div>
      ${body}
    </div>
  </article>`;
}

function emptyHtml() {
  if (query) return `<div class="empty"><h2>No results</h2><p>Nothing matches “${esc(query)}”.</p></div>`;
  if (!state.projects.length) {
    return `<div class="empty"><h2>Start with a project</h2><p>Projects group your prompts — e.g. one per repository.</p>
      <button class="primary" data-act="new-project">New Project</button></div>`;
  }
  if (state.view === 'flagged' && state.tab !== 'done') {
    return `<div class="empty"><h2>No flagged prompts</h2><p>Flag a prompt to mark it as a priority.</p>
      <button class="primary" data-act="new-prompt">New Flagged Prompt <kbd>⌘N</kbd></button></div>`;
  }
  if (state.tab === 'done') return '<div class="empty"><h2>Nothing done yet</h2><p>Completed prompts land here.</p></div>';
  return `<div class="empty"><h2>Queue is empty</h2><p>Write down the next idea while the agent finishes the current one.</p>
    <button class="primary" data-act="new-prompt">New Prompt <kbd>⌘N</kbd></button></div>`;
}

function renderList() {
  const items = visiblePrompts();
  $('#list').innerHTML = items.length
    ? `<div class="cards">${items.map(cardHtml).join('')}</div>`
    : emptyHtml();

  const ta = $('#list textarea.editor');
  if (ta) {
    ta.value = editing.draft;
    autosize(ta);
    ta.focus();
    const pos = editing.caret == null ? ta.value.length : editing.caret;
    ta.setSelectionRange(pos, pos);
    ta.addEventListener('input', () => { editing.draft = ta.value; editing.caret = ta.selectionStart; autosize(ta); });
    ta.addEventListener('keydown', editorKeys);
    // Switching to another app blurs too; keep editing then, the textarea refocuses on return.
    // A re-render removes the textarea and blurs it as well; that edit was already handled
    // (e.g. newPrompt committed it), so committing here would discard the next editor.
    ta.addEventListener('blur', () => setTimeout(() => { if (document.hasFocus() && ta.isConnected) commitEdit(true); }, 0));
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function renderHeader() {
  const { view, tab } = state;
  const title = view === 'all' ? 'All' : view === 'flagged' ? 'Flagged' : (project(view) || {}).name || '';
  const n = visiblePrompts().length;
  $('#title').textContent = title;
  $('#subtitle').textContent = `${n} ${tab === 'done' ? 'done' : 'pending'}`;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#new-prompt').disabled = !state.projects.length;
}

function render() {
  if (!project(state.view) && !['all', 'flagged'].includes(state.view)) state.view = 'all';
  renderSidebar();
  renderHeader();
  renderList();
}

// ---------- actions ----------

function selectView(id) {
  if (editing) commitEdit(false);
  state.view = id;
  if (project(id)) state.lastProject = id;
  persist();
  render();
  $('#list').scrollTop = 0;
}

function newProject() {
  const p = { id: uid(), name: 'New Project', createdAt: Date.now() };
  state.projects.push(p);
  renaming = p.id;
  state.view = p.id;
  state.lastProject = p.id;
  state.tab = 'pending';
  persist();
  render();
}

function newPrompt() {
  const projectId = targetProjectId();
  if (!projectId) return newProject();
  if (editing) commitEdit(false);
  // In Flagged, a new prompt is born flagged so it stays in view (like Reminders).
  const p = { id: uid(), projectId, text: '', createdAt: Date.now(), doneAt: null, flag: state.view === 'flagged' ? 'red' : null };
  state.prompts.unshift(p);
  editing = { id: p.id, draft: '', isNew: true };
  state.tab = 'pending';
  query = '';
  $('#search').value = '';
  render();
  $('#list').scrollTop = 0;
}

function startEdit(id) {
  if (editing && editing.id === id) return;
  if (editing) commitEdit(false);
  const p = state.prompts.find((x) => x.id === id);
  editing = { id, draft: p.text, isNew: false };
  render();
}

function commitEdit(rerender = true, cancel = false) {
  if (!editing) return;
  const { id, draft, isNew } = editing;
  editing = null;
  const p = state.prompts.find((x) => x.id === id);
  if (p) {
    const text = cancel ? p.text : draft.replace(/\s+$/, '');
    // Empty new prompt is discarded; clearing an existing one keeps the old text (delete is explicit).
    if (text.trim()) p.text = text;
    else if (isNew) state.prompts = state.prompts.filter((x) => x.id !== id);
  }
  persist();
  if (rerender) render();
}

function editorKeys(e) {
  const ta = e.target;
  if (e.key === 'Escape') { e.preventDefault(); commitEdit(true, true); }
  else if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commitEdit(true); }
  else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
}

async function copyPrompt(p, btn, alsoDone) {
  await window.api.copy(p.text);
  btn.classList.add('copied');
  btn.querySelector('span').textContent = 'Copied';
  if (alsoDone) return setTimeout(() => toggleDone(p), 450);
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.querySelector('span').textContent = 'Copy';
  }, 1400);
}

function toggleDone(p) {
  const card = document.querySelector(`.card[data-id="${p.id}"]`);
  const apply = () => {
    p.doneAt = p.doneAt ? null : Date.now();
    persist();
    render();
  };
  if (!card) return apply();
  card.classList.add('leaving');
  setTimeout(apply, 260);
}

async function deletePrompt(p) {
  const ok = await window.api.confirm('Delete this prompt?', 'This cannot be undone.', 'Delete');
  if (!ok) return;
  state.prompts = state.prompts.filter((x) => x.id !== p.id);
  persist();
  render();
}

async function projectMenu(p) {
  const choice = await window.api.menu(['Rename', '-', 'Delete Project…']);
  if (choice === 0) { renaming = p.id; render(); }
  if (choice === 2) {
    const n = state.prompts.filter((x) => x.projectId === p.id).length;
    const ok = await window.api.confirm(`Delete project “${p.name}”?`,
      n ? `Its ${n} prompt${n === 1 ? '' : 's'} (including done ones) will be deleted too. This cannot be undone.` : 'The project is empty.',
      'Delete');
    if (!ok) return;
    state.projects = state.projects.filter((x) => x.id !== p.id);
    state.prompts = state.prompts.filter((x) => x.projectId !== p.id);
    persist();
    render();
  }
}

// Finder-style: flags and moves live in the context menu. Menu items carry ids like 'flag:red'.
async function promptMenu(p) {
  const id = await window.api.menu([
    { id: 'edit', label: 'Edit' },
    { id: 'done', label: p.doneAt ? 'Move Back to Pending' : 'Mark as Done' },
    '-',
    ...FLAGS.map((f) => ({ id: `flag:${f}`, label: FLAG_NAMES[f], icon: FLAG_HEX[f], checked: p.flag === f })),
    { id: 'flag:', label: 'No Flag', enabled: !!p.flag },
    '-',
    { label: 'Move to', submenu: state.projects.map((x) => ({ id: `move:${x.id}`, label: x.name, checked: x.id === p.projectId })) },
    '-',
    { id: 'delete', label: 'Delete…' },
  ]);
  promptAction(p, id);
}

function promptAction(p, id) {
  if (typeof id !== 'string') return;
  if (id === 'edit') return startEdit(p.id);
  if (id === 'done') return toggleDone(p);
  if (id === 'delete') return deletePrompt(p);
  const [kind, value] = id.split(':');
  if (kind === 'flag') p.flag = value || null;
  if (kind === 'move') p.projectId = value;
  persist();
  render();
}

async function projectPicker(p) {
  promptAction(p, await window.api.menu(state.projects.map((x) => ({ id: `move:${x.id}`, label: x.name, checked: x.id === p.projectId }))));
}

// ---------- drag & drop ----------
// Projects reorder in the sidebar; prompts reorder in the list or drop onto a project to move there.

let drag = null; // { kind: 'project' | 'prompt', id }

function clearDrop() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function dropSide(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

function moveItem(arr, id, targetId, side) {
  const [item] = arr.splice(arr.findIndex((x) => x.id === id), 1);
  const to = arr.findIndex((x) => x.id === targetId) + (side === 'after' ? 1 : 0);
  arr.splice(to, 0, item);
}

function dragStart(e, kind, el, id) {
  drag = { kind, id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => el.classList.add('dragging'), 0); // after the browser snapshots the drag image
}

document.addEventListener('dragend', () => {
  drag = null;
  clearDrop();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
});

// Returns the drop target in the sidebar for the current drag, or null.
function navTarget(e) {
  const item = e.target.closest('.nav-item');
  if (!drag || !item || !project(item.dataset.view)) return null;
  if (drag.kind === 'project') return item.dataset.view === drag.id ? null : { item, mode: dropSide(e, item) };
  const p = state.prompts.find((x) => x.id === drag.id);
  return p && p.projectId !== item.dataset.view ? { item, mode: 'into' } : null;
}

$('#nav').addEventListener('dragstart', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) dragStart(e, 'project', item, item.dataset.view);
});
$('#nav').addEventListener('dragover', (e) => {
  const t = navTarget(e);
  clearDrop();
  if (!t) return;
  e.preventDefault();
  t.item.classList.add(`drop-${t.mode}`);
});
$('#nav').addEventListener('drop', (e) => {
  const t = navTarget(e);
  if (!t) return;
  e.preventDefault();
  if (t.mode === 'into') state.prompts.find((x) => x.id === drag.id).projectId = t.item.dataset.view;
  else moveItem(state.projects, drag.id, t.item.dataset.view, t.mode);
  persist();
  render();
});

$('#list').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (card) dragStart(e, 'prompt', card, card.dataset.id);
});
$('#list').addEventListener('dragover', (e) => {
  const card = e.target.closest('.card');
  clearDrop();
  if (!drag || drag.kind !== 'prompt' || !card || card.dataset.id === drag.id) return;
  e.preventDefault();
  card.classList.add(`drop-${dropSide(e, card)}`);
});
$('#list').addEventListener('drop', (e) => {
  const card = e.target.closest('.card');
  if (!drag || drag.kind !== 'prompt' || !card || card.dataset.id === drag.id) return;
  e.preventDefault();
  moveItem(state.prompts, drag.id, card.dataset.id, dropSide(e, card));
  persist();
  render();
});

// ---------- events ----------

$('#nav').addEventListener('click', (e) => {
  if (e.target.closest('#add-project')) return newProject();
  const item = e.target.closest('.nav-item');
  if (!item || e.target.closest('.rename')) return;
  // The sidebar is rebuilt on the first click, so a native dblclick never reaches the new node.
  if (e.detail === 2 && project(item.dataset.view)) { renaming = item.dataset.view; render(); return; }
  if (state.view !== item.dataset.view) selectView(item.dataset.view);
});
$('#nav').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.nav-item');
  const p = item && project(item.dataset.view);
  if (p) { e.preventDefault(); projectMenu(p); }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (editing) commitEdit(false);
  state.tab = b.dataset.tab;
  persist();
  render();
});

$('#search').addEventListener('input', (e) => { query = e.target.value; renderHeader(); renderList(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; query = ''; render(); e.target.blur(); } });
$('#new-prompt').addEventListener('click', newPrompt);

$('#list').addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  const p = card && state.prompts.find((x) => x.id === card.dataset.id);

  if (actEl) {
    const act = actEl.dataset.act;
    if (act === 'new-project') return newProject();
    if (act === 'new-prompt') return newPrompt();
    if (!p) return;
    if (act === 'copy') return copyPrompt(p, actEl, e.altKey);
    if (act === 'toggle-done') return toggleDone(p);
    if (act === 'more') return promptMenu(p);
    if (act === 'project') return projectPicker(p);
  }

  const cbCopy = e.target.closest('.cb-copy');
  if (cbCopy) {
    window.api.copy(cbCopy.closest('.codeblock').querySelector('code').textContent);
    cbCopy.innerHTML = ICONS.check;
    setTimeout(() => { cbCopy.innerHTML = ICONS.copy; }, 1200);
    return;
  }

  // Click on text enters edit mode, unless the user is selecting text.
  if (p && e.target.closest('.body') && window.getSelection().isCollapsed) startEdit(p.id);
});
$('#list').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  const p = card && state.prompts.find((x) => x.id === card.dataset.id);
  if (p && !card.classList.contains('editing')) { e.preventDefault(); promptMenu(p); }
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (!e.metaKey || typing && !/^[0-9]$/.test(e.key)) return;
  if (e.key === '0') { e.preventDefault(); selectView('all'); }
  if (/^[1-9]$/.test(e.key)) {
    const p = state.projects[Number(e.key) - 1];
    if (p) { e.preventDefault(); selectView(p.id); }
  }
});

window.api.onCommand((cmd) => {
  if (cmd === 'new-prompt') newPrompt();
  if (cmd === 'new-project') newProject();
  if (cmd === 'search') { $('#search').focus(); $('#search').select(); }
});

// Keep "x minutes ago" labels fresh without re-rendering (which would disturb an open editor).
setInterval(() => {
  document.querySelectorAll('.age[data-ts] span').forEach((el) => {
    el.textContent = ago(Number(el.parentElement.dataset.ts));
  });
}, 60000);

(async () => {
  const saved = await window.api.load();
  if (saved) state = { ...state, ...saved };
  if (state.version < 2) {
    // v1 sorted by date; v2 keeps manual order in the array.
    state.prompts.sort((a, b) => b.createdAt - a.createdAt);
    state.version = 2;
  }
  render();
})();
