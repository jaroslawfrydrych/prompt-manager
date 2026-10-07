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
let editing = null; // { id, draft, isNew, caret, hist }
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

// ---------- markdown: ``` blocks, `inline` code and lists ----------

const LIST = /^( *)([-*]|\d+[.)]) /; // indent, marker
const FENCE = /^ *```/;

function inline(text) {
  return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// Consecutive list lines become nested lists; everything else stays inline text.
function blocks(text) {
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length;) {
    const from = i;
    const isList = LIST.test(lines[i]);
    while (i < lines.length && LIST.test(lines[i]) === isList) i++;
    // A newline right before a block element does not render, so text followed by a list
    // gets one more to keep the user's blank line (the one ending the text is dropped).
    out += isList ? listHtml(lines.slice(from, i)) : inline(lines.slice(from, i).join('\n') + (i < lines.length ? '\n' : ''));
  }
  return out;
}

// Nesting follows indent length, so any deeper indent nests (not only multiples of two).
function listHtml(lines) {
  const open = []; // { indent, tag }, innermost last
  const top = () => open[open.length - 1];
  let html = '';
  for (const line of lines) {
    const [all, ind, mk] = LIST.exec(line);
    const tag = /\d/.test(mk) ? 'ol' : 'ul';
    while (open.length && (ind.length < top().indent || (ind.length === top().indent && top().tag !== tag))) {
      html += `</li></${open.pop().tag}>`;
    }
    if (open.length && top().indent === ind.length) html += '</li>';
    else {
      const n = parseInt(mk, 10);
      html += tag === 'ol' && n !== 1 ? `<ol start="${n}">` : `<${tag}>`;
      open.push({ indent: ind.length, tag });
    }
    html += `<li>${inline(line.slice(all.length))}`;
  }
  while (open.length) html += `</li></${open.pop().tag}>`;
  return html;
}

function renderMarkdown(src) {
  const re = /```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(?:\n?```|$)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out += blocks(src.slice(last, m.index).replace(/\n+$/, ''));
    out += `<div class="codeblock"><div class="cb-head"><span>${esc(m[1] || 'code')}</span>`
      + `<button class="cb-copy" title="Copy code">${ICONS.copy}</button></div>`
      + `<pre><code>${esc(m[2])}</code></pre></div>`;
    last = re.lastIndex;
    while (src[last] === '\n') last++;
  }
  return out + blocks(src.slice(last));
}

// ---------- live editor ----------
// A contenteditable showing the markdown source, one <div class="ln"> per line, decorated with spans.
// Its text (readText) always equals editing.draft; every input re-decorates the changed lines and
// restores the selection by plain-text offset. Rewriting the DOM breaks native undo, so the editor
// keeps its own undo stack in editing.hist.

function decorate(src) {
  if (!src) return ''; // truly empty, so the :empty placeholder shows
  let fence = false;
  return src.split('\n').map((line) => {
    const m = !fence && LIST.exec(line);
    if (FENCE.test(line)) fence = !fence;
    if (!m) return `<div class="ln">${line ? esc(line) : '<br>'}</div>`;
    // w<n>: marker width in (monospace) characters, for the hanging indent in CSS.
    return `<div class="ln li w${Math.min(m[0].length, 20)}"><span class="mk">${esc(m[0])}</span>${esc(line.slice(m[0].length))}</div>`;
  }).join('');
}

// Text of whatever DOM native editing left: blocks are lines, <br> is a newline,
// except the placeholder <br> that ends a block.
function readText(node) {
  let s = '';
  for (const c of node.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) s += c.data;
    else if (c.nodeName === 'BR') s += '\n';
    else if (c.nodeName === 'DIV' || c.nodeName === 'P') s += `${s && !s.endsWith('\n') ? '\n' : ''}${readText(c)}\n`;
    else s += readText(c);
  }
  return s.replace(/\n$/, '');
}

// Replaces only the lines whose decorated DOM differs, so untouched lines keep their
// nodes (and spelling underlines). Returns true when anything changed.
function paint(ed, text) {
  const t = document.createElement('template');
  t.innerHTML = decorate(text);
  const next = [...t.content.childNodes];
  const old = [...ed.childNodes];
  let changed = false;
  next.forEach((n, i) => {
    if (old[i] && old[i].isEqualNode(n)) return;
    changed = true;
    if (old[i]) old[i].replaceWith(n); else ed.append(n);
  });
  old.slice(next.length).forEach((n) => { n.remove(); changed = true; });
  return changed;
}

// Selection as plain-text offsets ({ start, end }), or null when it is outside the editor.
function selOf(ed) {
  const s = getSelection();
  const r = s.rangeCount && s.getRangeAt(0);
  if (!r || !ed.contains(r.startContainer) || !ed.contains(r.endContainer)) return null;
  // Clone everything before the point and mark the point with a sentinel, so a <br> right
  // before the caret still counts as a newline (readText drops a block's trailing <br>).
  const at = (node, off) => {
    const x = document.createRange();
    x.setStart(ed, 0);
    x.setEnd(node, off);
    const d = document.createElement('div');
    d.append(x.cloneContents());
    let el = d; // the clone of the point's container is the last child at each level
    for (let n = node.nodeType === Node.TEXT_NODE ? node.parentNode : node; n !== ed; n = n.parentNode) el = el.lastChild;
    el.append('\u0000');
    return readText(d).indexOf('\u0000');
  };
  const start = at(r.startContainer, r.startOffset);
  return { start, end: r.collapsed ? start : at(r.endContainer, r.endOffset) };
}

// DOM point for a text offset in the decorated editor. At a span boundary it prefers the start
// of the next node, so typing after a list marker lands in the text, not in the marker.
function pointAt(ed, n) {
  for (const ln of ed.children) {
    const len = ln.textContent.length;
    if (n <= len) {
      let at = [ln, 0];
      const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode()); n -= t.length) {
        at = [t, Math.min(n, t.length)];
        if (n < t.length) break;
      }
      return at;
    }
    n -= len + 1;
  }
  return [ed, ed.childNodes.length];
}

function setSel(ed, { start, end }) {
  const r = document.createRange();
  r.setStart(...pointAt(ed, start));
  r.setEnd(...pointAt(ed, end));
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// Undo history: snapshots of { text, sel }. Typing (same input kind, caret where the last step
// left it, under 1 s apart) is coalesced into one step, like macOS.
function record(text, sel, kind, before) {
  const h = editing.hist;
  const cur = h.stack[h.i];
  if (text === cur.text) return;
  h.stack.length = h.i + 1;
  const sameSpot = before && before.start === cur.sel.start && before.end === cur.sel.end;
  if (kind && kind === h.kind && sameSpot && h.i > 0 && Date.now() - h.at < 1000) h.stack[h.i] = { text, sel };
  else {
    if (before) cur.sel = before; // undo puts the caret back where this edit started
    h.stack.push({ text, sel });
    h.i++;
    if (h.stack.length > 200) { h.stack.shift(); h.i--; }
  }
  Object.assign(h, { kind, at: Date.now() });
}

function show(ed, text, sel) {
  editing.draft = text;
  editing.caret = sel.start;
  paint(ed, text);
  setSel(ed, sel);
}

// Edits made by our own key handling (Enter, Tab, paste, cut) are one undo step each.
function applyEdit(ed, [text, sel]) {
  record(text, sel, null, selOf(ed));
  show(ed, text, sel);
}

function replaceSel(ed, str) {
  const { start, end } = selOf(ed) || { start: editing.draft.length, end: editing.draft.length };
  const pos = start + str.length;
  applyEdit(ed, relist(editing.draft, editing.draft.slice(0, start) + str + editing.draft.slice(end), { start: pos, end: pos }));
}

const lineCount = (s) => s.split('\n').length;
// An edit that adds or removes lines (deleting, cutting or pasting items) renumbers the list
// around the caret so it has no gaps (code in fences is left alone). Edits within a line are left alone, so a typed number sticks.
const relist = (old, text, sel) => (lineCount(old) === lineCount(text) ? [text, sel] : renumber(text, sel));

function undoRedo(ed, dir) {
  const h = editing.hist;
  if (!h.stack[h.i + dir]) return;
  h.i += dir;
  h.kind = null;
  show(ed, h.stack[h.i].text, h.stack[h.i].sel);
}

const inFence = (text, at) => (text.slice(0, at).match(/^ *```/gm) || []).length % 2 === 1;

// Enter: a list item continues the list (next number for numbered ones); an empty item ends it.
function enterEdit(text, { start, end }, plain) {
  text = text.slice(0, start) + text.slice(end);
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const le = text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start);
  const m = !plain && !inFence(text, ls) && LIST.exec(text.slice(ls, le));
  let ins = '\n';
  if (m && start >= ls + m[0].length) {
    if (!text.slice(ls + m[0].length, le).trim()) {
      // An empty nested item moves up a level (like Notes); an empty top-level one ends the list,
      // and numbered items after it start a new list at 1.
      if (m[1]) return tabEdit(text, { start, end: start }, true);
      return [restart(text.slice(0, ls), text.slice(le)), { start: ls, end: ls }];
    }
    const n = parseInt(m[2], 10);
    ins += m[1] + (Number.isNaN(n) ? m[2] : `${n + 1}${m[2].slice(-1)}`) + ' ';
    const pos = start + ins.length;
    return renumber(text.slice(0, start) + ins + text.slice(start), { start: pos, end: pos });
  }
  const pos = start + ins.length;
  return [text.slice(0, start) + ins + text.slice(start), { start: pos, end: pos }];
}

// Joins head + rest, restarting numbered items at the start of rest (top level) at 1.
function restart(head, rest) {
  const r = rest.replace(/^\n\d+(?=[.)] )/, '\n1');
  return r === rest ? head + rest : renumber(head + r, { start: head.length + 1, end: head.length + 1 })[0];
}

// Backspace right after a list marker (like Notes): a nested item moves up a level, a top-level
// one loses its marker and numbered items after it start a new list at 1. null: browser handles it.
function backEdit(text, { start, end }) {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const m = start === end && !inFence(text, ls) && LIST.exec(text.slice(ls));
  if (!m || start !== ls + m[0].length) return null;
  if (m[1]) return tabEdit(text, { start, end }, true);
  const le = text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start);
  return [restart(text.slice(0, ls) + text.slice(start, le), text.slice(le)), { start: ls, end: ls }];
}

// Numbered items in the list block around the caret continue from their first sibling's number,
// so an inserted, nested or outdented item leaves no duplicates or gaps. A first item keeps its number.
// Lines inside fenced code blocks are code, never touched.
function renumber(text, { start, end }) {
  const lines = text.split('\n');
  const row = text.slice(0, start).split('\n').length - 1;
  let a = row;
  let b = text.slice(0, end).split('\n').length - 1;
  while (a > 0 && LIST.test(lines[a - 1])) a--;
  while (b < lines.length - 1 && LIST.test(lines[b + 1])) b++;
  const prev = []; // last number seen per indent, for the siblings that follow
  let off = 0; // offset of the current line in the old text
  let ds = 0;
  let de = 0;
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^ *```/.test(line)) fenced = !fenced;
    const m = !fenced && i >= a && i <= b && LIST.exec(line);
    if (m) {
      const d = m[1].length;
      prev.length = Math.min(prev.length, d + 1); // deeper levels end here
      if (/\d/.test(m[2])) {
        const n = prev[d] != null ? prev[d] + 1 : parseInt(m[2], 10);
        prev[d] = n;
        const mk = `${m[1]}${n}${m[2].slice(-1)} `;
        const delta = mk.length - m[0].length;
        // Positions after the marker move with it; the caret is never left inside the number.
        if (start >= off + m[0].length) ds += delta;
        if (end >= off + m[0].length) de += delta;
        lines[i] = mk + line.slice(m[0].length);
      } else prev[d] = null;
    } else prev.length = 0; // a non-list line ends the list
    off += line.length + 1;
  });
  return [lines.join('\n'), { start: start + ds, end: end + de }];
}

// Number for a numbered item at this indent: continues the previous sibling, else starts at 1.
function nextNumber(lines, i, indent) {
  for (let j = i - 1; j >= 0; j--) {
    const m = LIST.exec(lines[j]);
    if (!m || m[1].length < indent) return 1;
    if (m[1].length === indent) return /\d/.test(m[2]) ? parseInt(m[2], 10) + 1 : 1;
  }
  return 1;
}

// Tab / Shift+Tab on list lines indents / outdents them one level (two spaces).
// Elsewhere Tab inserts two spaces and Shift+Tab is left to the browser (returns null).
function tabEdit(text, { start, end }, outdent) {
  const lines = text.split('\n');
  const first = text.slice(0, start).split('\n').length - 1;
  const last = text.slice(0, end).split('\n').length - 1;
  if (!LIST.test(lines[first]) || inFence(text, start)) {
    if (outdent) return null;
    return [text.slice(0, start) + '  ' + text.slice(end), { start: start + 2, end: start + 2 }];
  }
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  let firstDelta = 0;
  let delta = 0;
  for (let i = first; i <= last; i++) {
    const m = LIST.exec(lines[i]);
    if (!m) continue;
    const ind = outdent ? m[1].slice(2) : `${m[1]}  `;
    const mk = /\d/.test(m[2]) ? nextNumber(lines, i, ind.length) + m[2].slice(-1) : m[2];
    const line = `${ind}${mk} ${lines[i].slice(m[0].length)}`;
    if (i === first) firstDelta = line.length - lines[i].length;
    delta += line.length - lines[i].length;
    lines[i] = line;
  }
  return renumber(lines.join('\n'), { start: Math.max(ls, start + firstDelta), end: Math.max(ls, end + delta) });
}

function mountEditor(ed) {
  const pos = editing.caret == null ? editing.draft.length : editing.caret;
  editing.hist = editing.hist || { stack: [{ text: editing.draft, sel: { start: pos, end: pos } }], i: 0 };
  paint(ed, editing.draft);
  ed.focus();
  setSel(ed, { start: pos, end: pos });

  let before = null; // selection before the current native edit
  let composing = false;
  const sync = (kind) => {
    const read = readText(ed);
    const [text, sel] = relist(editing.draft, read, selOf(ed) || { start: read.length, end: read.length });
    record(text, sel, kind, before);
    editing.draft = text;
    editing.caret = sel.start;
    if (paint(ed, text) || text !== read) setSel(ed, sel);
  };
  ed.addEventListener('beforeinput', (e) => {
    // The browser's own undo knows nothing of our re-decorated DOM. The Edit menu sends an 'undo'
    // command instead, so this is only a safety net for any other path to native undo.
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      undoRedo(ed, e.inputType === 'historyUndo' ? -1 : 1);
      return;
    }
    if (!composing) before = selOf(ed);
  });
  // Leave the DOM alone while an IME (dead keys, accents) composes; re-decorate when it commits.
  ed.addEventListener('compositionstart', () => { composing = true; before = selOf(ed); });
  ed.addEventListener('compositionend', () => { composing = false; sync('insertText'); });
  ed.addEventListener('input', (e) => {
    if (composing || e.isComposing) editing.draft = readText(ed);
    else sync(e.inputType);
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData.getData('text/plain');
    if (t) replaceSel(ed, t.replace(/\r\n?/g, '\n')); // no text (e.g. an image): ignore, keep the selection
  });
  // Copy the exact markdown source rather than the browser's serialisation of the line divs.
  const copy = (e) => {
    const s = selOf(ed);
    if (!s || s.start === s.end) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', editing.draft.slice(s.start, s.end));
    if (e.type === 'cut') replaceSel(ed, '');
  };
  ed.addEventListener('copy', copy);
  ed.addEventListener('cut', copy);
  ed.addEventListener('keydown', editorKeys);
  // Switching to another app blurs too; keep editing then, the editor refocuses on return.
  // A re-render removes the editor and blurs it as well; that edit was already handled
  // (e.g. newPrompt committed it), so committing here would discard the next editor.
  ed.addEventListener('blur', () => setTimeout(() => { if (document.hasFocus() && ed.isConnected) commitEdit(true); }, 0));
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
    ? `<div class="editor" contenteditable="plaintext-only" spellcheck="true" role="textbox" aria-multiline="true" data-placeholder="What are we working on?"></div>
       <div class="edit-hint"><kbd>⌘</kbd><kbd>↩</kbd> save &nbsp;·&nbsp; <kbd>esc</kbd> cancel &nbsp;·&nbsp; <code>\`code\`</code> &nbsp; <code>\`\`\`block\`\`\`</code> &nbsp; <code>- list</code> &nbsp; <code>1. list</code> &nbsp; <kbd>⇥</kbd> nest</div>`
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

  const ed = $('#list .editor');
  if (ed) mountEditor(ed);
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
  const ed = e.currentTarget;
  if (e.isComposing || e.keyCode === 229) return; // keys belong to the IME while it composes
  const sel = () => selOf(ed) || { start: editing.draft.length, end: editing.draft.length };
  if (e.key === 'Escape') { e.preventDefault(); commitEdit(true, true); }
  else if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commitEdit(true); }
  else if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); // ⇧↩ is a plain newline that does not continue a list
    applyEdit(ed, enterEdit(editing.draft, sel(), e.shiftKey));
  } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const r = tabEdit(editing.draft, sel(), e.shiftKey);
    if (r) { e.preventDefault(); applyEdit(ed, r); }
  } else if (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const r = backEdit(editing.draft, sel());
    if (r) { e.preventDefault(); applyEdit(ed, r); }
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
  // Text dragged inside the open editor is the editor's own drag, not a card move.
  if (card && !(editing && card.dataset.id === editing.id)) dragStart(e, 'prompt', card, card.dataset.id);
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
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
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
  // Edit ▸ Undo / Redo (⌘Z / ⇧⌘Z): the editor has its own history, other fields use the browser's.
  if (cmd === 'undo' || cmd === 'redo') {
    const ed = document.activeElement;
    if (editing && ed.classList.contains('editor')) undoRedo(ed, cmd === 'undo' ? -1 : 1);
    else document.execCommand(cmd);
  }
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
