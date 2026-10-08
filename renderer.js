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
  send: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  restore: '<svg viewBox="0 0 16 16"><path d="M3 6.5h7a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 4 3 6.5 5.5 9"/></svg>',
};

let state = { version: 2, projects: [], prompts: [], view: 'all', tab: 'pending' };
let editing = null; // { id, draft, orig, isNew, caret, hist, at }
// Undo history per prompt for this session (not saved): reopening a prompt resumes it, and ⌘Z with
// no editor open reopens the last edited prompt and undoes there.
const hists = new Map(); // prompt id → { stack: [{ text, sel }], i, kind, at }
let lastEdited = null; // prompt id
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

// ---------- markdown: ``` blocks, `inline` code, lists, **bold**, *italic*, <u>underline</u> ----------

const LIST = /^( *)([-*]|\d+[.)]) /; // indent, marker
// A fence line: 3+ backticks (each one toggles; run lengths are not matched) after optional spaces, and no backtick
// after them (CommonMark's info string rule), so ```npm install``` on its own line is inline code, not a block.
const FENCE = /^ *`{3,}[^`\n]*$/;
const fences = (s) => (s.match(new RegExp(FENCE.source, 'gm')) || []).length;
// Inline code: a backtick run, then the same run closing it (`x`, ``x``, ```x```), never part of a longer run.
const CODE = /(?<!`)(`+)([^`\n]+?)\1(?!`)/g;
// text / code span pieces, alternating (text first), like split() with a capture group
function codeSplit(s) {
  const out = [];
  let at = 0;
  for (const m of s.matchAll(CODE)) { out.push(s.slice(at, m.index), m[0]); at = m.index + m[0].length; }
  return [...out, s.slice(at)];
}

// Emphasis runs on escaped text, so <u> is only ever the literal tag pair, never other HTML.
// Each pass swaps its markers for private-use placeholders (odd = open, even = close) so later
// passes can't see them; a match is kept only when it nests cleanly with earlier ones.
// Spans never cross a line, so preview and the line-by-line editor agree.
// An opening _ must not follow a letter, digit, / or . (snake_case, /_tmp_dir_); an opening * may follow a
// letter only when a letter or digit comes next (plain**bold**, but README*, fix* and H*-search stay plain), and
// never a digit, / or . (2*3*4, src/*.js, foo.*). A closing one must not be followed
// by a letter or digit, and a closing * neither follows a / nor is followed by .ext, so globs on one line
// (*.md, docs/*.md, **/node_modules/**) stay plain.
const EMPHASIS = [
  [/&lt;u&gt;([^\n]+?)&lt;\/u&gt;/g, '', ''],
  // _ only at word edges, so snake_case_words stay as they are. It goes before the * passes so that
  // _**Note:** text_ (what ⌘I gives when a * marker would touch another *) nests.
  [/(?<![\p{L}\p{N}_\/.])_(?=[^\s_])([^\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '', ''],
  [/(?<![\p{N}_\/.*])(?!(?<=\p{L})\*\*\*[^\p{L}\p{N}])\*\*\*(?=\S)([^\n]*?[^\s\/])\*\*\*(?![\p{L}\p{N}_*]|\.[\p{L}\p{N}])/gu, '', ''], // ***x***: bold + italic
  [/(?<![\p{N}_\/.*])(?!(?<=\p{L})\*\*[^\p{L}\p{N}])\*\*(?=\S)([^\n]*?[^\s\/])\*\*(?![\p{L}\p{N}_*]|\.[\p{L}\p{N}])/gu, '', ''],
  [/(?<![\p{N}_\/.*])(?!(?<=\p{L})\*[^\p{L}\p{N}])\*(?=[^\s*])([^\n]*?[^\s*\/])\*(?![\p{L}\p{N}_*]|\.[\p{L}\p{N}])/gu, '', ''],
];
const EM_TAGS = [null, ['strong', '**'], ['em', '*'], ['em', '_'], ['u', '&lt;u&gt;', '&lt;/u&gt;']];

function balanced(s) {
  const open = [];
  for (const ch of s) {
    const k = ch.charCodeAt(0) - 0xE000;
    if (k < 1 || k > 8) continue;
    if (k % 2) open.push(k);
    else if (open.pop() !== k - 1) return false;
  }
  return !open.length;
}

// The emphasis passes on escaped text: markers swapped for placeholders, or null when the text is left plain.
function marks(html) {
  if (/[-]/.test(html)) return null; // text already has placeholder chars
  // ponytail: the lazy patterns are quadratic on a long line without closing markers, and paint
  // re-decorates every line per keystroke; lines over 2000 chars stay plain. A linear scanner lifts it.
  if (/[^\n]{2001}/.test(html)) return null;
  for (const [re, open, close] of EMPHASIS) html = html.replace(re, (all, t) => (balanced(t) ? open + t + close : all));
  return html;
}

// keep: the editor keeps the markers in the text, as dimmed .fm spans around the formatted run.
function emphasis(html, keep) {
  const h = marks(html);
  if (!h) return html;
  return h.replace(/[-]/g, (ch) => {
    const k = ch.charCodeAt(0) - 0xE000;
    const [tag, mo, mc = mo] = EM_TAGS[(k + 1) >> 1];
    if (k % 2) return keep ? `<span class="fm">${mo}</span><${tag}>` : `<${tag}>`;
    return keep ? `</${tag}><span class="fm">${mc}</span>` : `</${tag}>`;
  });
}

// Inline code is never formatted; in the editor (keep) its backticks stay in the text inside the pill,
// invisible (CSS) so they read as its padding, and it is not spell checked (identifiers would all be underlined).
function inline(text, keep) {
  return codeSplit(text).map((s, i) => {
    if (i % 2 === 0) return emphasis(esc(s), keep);
    const t = /^`+/.exec(s)[0];
    const code = esc(s.slice(t.length, -t.length));
    return keep ? `<code spellcheck="false"><span class="fm">${t}</span>${code}<span class="fm">${t}</span></code>` : `<code>${code}</code>`;
  }).join('');
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

// A fence is a line starting with ``` (FENCE), the same rule the editor, lists and ⌘B use, so a ``` mid-line
// is never a block. An unclosed fence runs to the end.
function renderMarkdown(src) {
  const lines = src.split('\n');
  let out = '';
  let text = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE.test(lines[i])) { text.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !FENCE.test(lines[j])) j++;
    out += blocks(text.join('\n').replace(/\n+$/, ''));
    const code = esc(lines.slice(i + 1, j).join('\n'));
    text = [];
    for (i = j; lines[i + 1] === ''; i++); // blank lines after a block don't render
    out += `<div class="codeblock${i >= lines.length - 1 ? ' end' : ''}"><pre><code>${code}</code></pre></div>`; // .end: nothing follows
  }
  return out + blocks(text.join('\n'));
}

// ---------- live editor ----------
// A contenteditable showing the markdown source, one <div class="ln"> per line, decorated with spans.
// Its text (readText) always equals editing.draft; every input re-decorates the changed lines and
// restores the selection by plain-text offset. Rewriting the DOM breaks native undo, so the editor
// keeps its own undo stack in editing.hist.

function decorate(src) {
  if (!src) return ''; // truly empty, so the :empty placeholder shows
  let fence = false;
  let closer = -1; // index of the last closing fence
  return src.split('\n').map((line, i, all) => {
    const isFence = FENCE.test(line);
    if (fence && isFence) closer = i;
    const code = fence || isFence; // fences and the code between them are left unformatted
    if (code) {
      // A block like the preview's: .cb-first is the opener, .cb-last the closer, or the last line while the fence is still open.
      const cls = `${isFence ? ' fence' : ''}${!fence ? ' cb-first' : ''}${(fence && isFence) || i === all.length - 1 ? ' cb-last' : ''}`;
      if (isFence) fence = !fence;
      // A fence line (``` and any text after it) is invisible (CSS): the line is drawn as the block's top / bottom edge.
      const body = isFence ? `<span class="fm">${esc(line)}</span>`
        : !line ? '<br>' : esc(line);
      return `<div class="ln cb${cls}" spellcheck="false">${body}</div>`;
    }
    // The preview drops blank lines next to a block, so one right before an opener or after a closer
    // is drawn as the block's margin (.gap) instead of a full line.
    if (!line && (closer === i - 1 || FENCE.test(all[i + 1] || ''))) return '<div class="ln gap"><br></div>';
    const m = LIST.exec(line);
    if (!m) return `<div class="ln">${!line ? '<br>' : inline(line, true)}</div>`;
    // w<n>: marker width in (monospace) characters, l<n>: nesting level (2 spaces per level), for the hanging
    // indent in CSS. ul/ol (+ data-n) let CSS draw the preview's bullet or number over the marker; the text stays markdown.
    const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
    return `<div class="ln li ${kind} l${Math.min(m[1].length >> 1, 5)} w${Math.min(m[0].length, 20)}"${kind === 'ol' ? ` data-n="${parseInt(m[2], 10)}"` : ''}><span class="mk">${esc(m[0])}</span>${inline(line.slice(m[0].length), true)}</div>`;
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
  lastEdited = editing.id; // only a real change makes this the prompt ⌘Z reopens
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
  saveDraft();
  paint(ed, text);
  setSel(ed, sel);
}

// Edits are saved as you type. An emptied prompt keeps its old text (delete is explicit).
function saveDraft() {
  const p = state.prompts.find((x) => x.id === editing.id);
  if (!p) return;
  const text = editing.draft.replace(/\s+$/, '');
  p.text = text.trim() ? text : editing.orig;
  persist();
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

function undoClosed(dir) {
  const h = hists.get(lastEdited);
  const p = state.prompts.find((x) => x.id === lastEdited);
  if (!p || !h?.stack[h.i + dir]) return;
  if (!visiblePrompts().includes(p)) {
    state.tab = p.doneAt ? 'done' : 'pending';
    selectView(p.projectId);
  }
  startEdit(p.id);
  const ed = $('#list .editor');
  if (ed) undoRedo(ed, dir);
}

function undoRedo(ed, dir) {
  const h = editing.hist;
  if (!h.stack[h.i + dir]) return;
  h.i += dir;
  h.kind = null;
  lastEdited = editing.id;
  show(ed, h.stack[h.i].text, h.stack[h.i].sel);
}

const inFence = (text, at) => fences(text.slice(0, at)) % 2 === 1;
const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
const onFence = (text, at) => FENCE.test(text.slice(lineStart(text, at)).split('\n', 1)[0]);

// Fence lines are drawn as a block's top / bottom edge, not as text, so the caret never rests on one.
// The offset of the nearest non-fence line from the fence line at `at` going dir (1 down: its start,
// -1 up: its end), or null when there is none that way.
function offFence(text, at, dir) {
  const lines = text.split('\n');
  const starts = [];
  lines.reduce((o, l) => starts.push(o) && o + l.length + 1, 0);
  for (let j = text.slice(0, at).split('\n').length - 1 + dir; j >= 0 && j < lines.length; j += dir) {
    if (!FENCE.test(lines[j])) return starts[j] + (dir > 0 ? 0 : lines[j].length);
  }
  return null;
}

// Moves a caret that landed at `at` on a fence line, coming from `from`, past the line the way it was going;
// with only fences that way the prompt gets a new empty line there, the way out of a block that starts or
// ends it. x: the column to keep (↑ / ↓), at the target line's nearest visual row.
function leaveFence(ed, at, from, x) {
  const text = editing.draft;
  const dir = at > from ? 1 : -1;
  const to = offFence(text, at, dir);
  if (to == null) {
    applyEdit(ed, dir > 0 ? [`${text}\n`, { start: text.length + 1, end: text.length + 1 }] : [`\n${text}`, { start: 0, end: 0 }]);
    return;
  }
  const ln = ed.children[text.slice(0, to).split('\n').length - 1];
  const b = ln.getBoundingClientRect();
  const cs = getComputedStyle(ln);
  const half = parseFloat(cs.lineHeight) / 2;
  const r = x != null && document.caretRangeFromPoint(x, dir > 0 ? b.top + parseFloat(cs.paddingTop) + half : b.bottom - parseFloat(cs.paddingBottom) - half);
  if (r && ln.contains(r.startContainer)) {
    getSelection().setBaseAndExtent(r.startContainer, r.startOffset, r.startContainer, r.startOffset);
    editing.caret = selOf(ed).start;
  } else setSel(ed, { start: editing.caret = to, end: to });
}

// Typing the third backtick of a bare ``` line acts as ↩ there: an opener gets its closer and the caret
// goes on the line between, a closer typed in a block steps out of it (enterEdit), so the caret never
// stays on the fence line, where the text would be hidden. null: not such a keystroke.
function fenceTyped(text, { start, end }) {
  const ls = lineStart(text, start);
  if (start !== end || text[start] && text[start] !== '\n' || !/^ *```$/.test(text.slice(ls, start))) return null;
  return enterEdit(text, { start, end }, false);
}

// Backspace / Delete (dir -1 / 1, any modifier) at the edge of a line next to a fence line would join the
// line into the hidden fence (or the fence into text). An empty line goes instead (an empty block goes
// whole); text is left alone (null). undefined: not at such an edge, the browser deletes.
function fenceJoin(text, { start: at }, dir) {
  const lines = text.split('\n');
  const i = text.slice(0, at).split('\n').length - 1;
  const ls = lineStart(text, at);
  const le = ls + lines[i].length;
  if (at !== (dir < 0 ? ls : le) || FENCE.test(lines[i]) || !FENCE.test(lines[i + dir] || '')) return undefined;
  if (lines[i]) return null;
  const os = i > 0 ? ls - lines[i - 1].length - 1 : 0; // the previous line's start
  if (FENCE.test(lines[i - 1] || '') && FENCE.test(lines[i + 1] || '') && !inFence(text, os)) {
    const out = [...lines.slice(0, i - 1), ...lines.slice(i + 2)].join('\n');
    return [out, { start: Math.max(os - 1, 0), end: Math.max(os - 1, 0) }];
  }
  const out = dir < 0 ? text.slice(0, ls - 1) + text.slice(le) : text.slice(0, ls) + text.slice(le + 1);
  const p = dir < 0 ? ls - 1 : ls;
  const to = offFence(out, p, dir) ?? offFence(out, p, -dir) ?? p;
  return [out, { start: to, end: to }];
}

// Enter: a list item continues the list (next number for numbered ones); an empty item ends it.
function enterEdit(text, { start, end }, plain) {
  text = text.slice(0, start) + text.slice(end);
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const le = text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start);
  const line = text.slice(ls, le);
  const fenced = inFence(text, ls);
  // ``` + ↩ (not ⇧↩) at the end of an opener that nothing closes yet adds the closing fence, caret on the line between.
  if (!plain && !fenced && start === le && /^ *```[\w+#.-]*$/.test(line)
    && fences(text.slice(le)) % 2 === 0) {
    const ind = /^ */.exec(line)[0];
    return [`${text.slice(0, le)}\n${ind}\n${ind}\`\`\`${text.slice(le)}`, { start: le + 1 + ind.length, end: le + 1 + ind.length }];
  }
  // Typing the closer by habit right above the auto-inserted one steps over it: the duplicate goes,
  // the caret lands on the line after the closer (a new empty one at the end). Not when the next line
  // opens another block (an odd number of fences after it).
  const nl = text.indexOf('\n', le + 1);
  if (!plain && fenced && start === le && /^ *```$/.test(line) && le < text.length
    && /^ *```$/.test(text.slice(le + 1, nl < 0 ? text.length : nl))
    && fences(text.slice(nl < 0 ? text.length : nl)) % 2 === 0) {
    const rest = nl < 0 ? '\n' : text.slice(nl);
    return [text.slice(0, le) + rest, { start: le + 1, end: le + 1 }];
  }
  const m = !plain && !fenced && LIST.exec(line);
  // In a code block a new line keeps the current line's indentation, like a code editor (⇧↩ doesn't).
  let ins = fenced && !plain ? `\n${/^[ \t]*/.exec(text.slice(ls, start))[0]}` : '\n';
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
    if (FENCE.test(line)) fenced = !fenced;
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

const WRAP = { bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'] };

// Emphasis runs of a raw line, in raw offsets, from the same passes the renderer uses:
// { k: 1 bold | 2 * | 3 _ | 4 u, os, oe, cs, ce } (open marker os–oe, close marker cs–ce, ol / cl: marker
// lengths). ***x*** gives a bold and an italic run that share the three stars on each side.
function emRuns(line) {
  const out = [];
  const m = LIST.exec(line);
  let r = m ? m[0].length : 0;
  codeSplit(line.slice(r)).forEach((s, i) => {
    const h = i % 2 ? null : marks(esc(s));
    if (!h) { r += s.length; return; }
    const open = [];
    for (let j = 0; j < h.length; j++) {
      const k = h.charCodeAt(j) - 0xE000;
      if (k < 1 || k > 8) {
        if (h[j] === '&') j = h.indexOf(';', j); // an entity is one raw char
        r++;
      } else if (k === 1 && h.charCodeAt(j + 1) === 0xE003) {
        open.push({ k: 1, os: r, oe: r + 3, ol: 2 }, { k: 2, os: r, oe: r + 3, ol: 1 });
        r += 3; j++;
      } else if (k === 4 && h.charCodeAt(j + 1) === 0xE002) {
        out.push({ ...open.pop(), cs: r, ce: r + 3, cl: 1 }, { ...open.pop(), cs: r, ce: r + 3, cl: 2 });
        r += 3; j++;
      } else {
        const len = [0, 2, 1, 1, 3][(k + 1) >> 1] + (k === 8);
        if (k % 2) open.push({ k: (k + 1) >> 1, os: r, oe: r + len, ol: len });
        else out.push({ ...open.pop(), cs: r, ce: r + len, cl: len });
        r += len;
      }
    }
  });
  return out;
}

// Does a..b overlap a `code` span of the line? With a === b: is the caret strictly inside one?
const inCode = (line, a, b = a) => [...line.matchAll(CODE)].some((m) => m.index < b && a < m.index + m[0].length);

// ⌘B / ⌘I / ⌘U, like Notes: each selected line is formatted on its own (past the list marker, without the
// whitespace at the edges, never in code). When every part already sits in a run of that kind the runs are
// split around it (`**hello world**` with hello selected → `hello **world**`); otherwise the parts that
// aren't formatted get wrapped, absorbing runs of that kind they overlap or touch. A caret inside a word toggles
// the word; elsewhere it inserts an empty pair with the caret in between, which a second press removes.
function fmtRuns(text, { start, end }, kind, [o, c] = WRAP[kind]) {
  const ks = { bold: [1], italic: [2, 3], underline: [4] }[kind];
  let fence = false;
  let ls = 0;
  const lines = text.split('\n').map((line) => {
    const l = { line, ls, code: fence || FENCE.test(line) };
    if (FENCE.test(line)) fence = !fence;
    ls += line.length + 1;
    return l;
  });
  if (start === end) {
    const l = lines.findLast((x) => x.ls <= start);
    const rs = emRuns(l.line);
    if (l.code || inCode(l.line, start - l.ls)) return [text, { start, end }];
    // A caret before or in a list marker works past it, so the marker stays a list marker.
    const m = LIST.exec(l.line);
    if (m && start - l.ls < m[0].length) start = end = l.ls + m[0].length;
    // A caret inside any run's marker steps out of it; for a run of that kind that's all it does.
    for (const r of rs) {
      const p = start - l.ls;
      const to = r.os < p && p < r.oe ? r.os : r.cs < p && p < r.ce ? r.ce : -1;
      if (to < 0) continue;
      start = end = l.ls + to;
      if (ks.includes(r.k)) return [text, { start, end }];
    }
    // A caret against a run's own marker toggles what's typed next by stepping across the marker, out of the
    // run or into it, instead of nesting an empty pair in it (an empty pair at its edge would break it).
    for (const r of rs) {
      if (!ks.includes(r.k)) continue;
      const to = { [r.cs]: r.ce, [r.oe]: r.os, [r.ce]: r.cs, [r.os]: r.oe }[start - l.ls];
      if (to != null) return [text, { start: to + l.ls, end: to + l.ls }];
    }
    // `**bold |**`: a closer can't follow whitespace, so the run isn't one yet. Toggling off moves the
    // whitespace out past the markers after the caret (`**bold** |`), if a run of that kind then closes there
    // and typing on keeps as many runs as typing in place would.
    const p = start - l.ls;
    const ws = /[^\S\n]+$/.exec(l.line.slice(0, p))?.[0];
    const cl = /^(?:[*_]+|<\/u>)/.exec(l.line.slice(p))?.[0];
    if (ws && cl) {
      const q = p - ws.length;
      const at = q + cl.length + ws.length;
      const line = l.line.slice(0, q) + cl + l.line.slice(q, p) + l.line.slice(p + cl.length);
      const typed = (s, i) => emRuns(s.slice(0, i) + 'x' + s.slice(i));
      const rs2 = typed(line, at);
      if (rs2.length >= typed(l.line, p).length && rs2.some((r) => ks.includes(r.k) && r.cs >= q && r.ce <= q + cl.length)) {
        return [text.slice(0, l.ls) + line + text.slice(l.ls + l.line.length), { start: l.ls + at, end: l.ls + at }];
      }
    }
    let a = start;
    let b = end;
    while (a > 0 && /[\p{L}\p{N}_]/u.test(text[a - 1])) a--;
    while (b < text.length && /[\p{L}\p{N}_]/u.test(text[b])) b++;
    if (a < start && b > start) {
      const [t, s] = fmtEdit(text, { start: a, end: b }, kind);
      const pos = start + s.start - a;
      return [t, { start: pos, end: pos }];
    }
    // Inside a run of that kind but not in a word: an empty pair here would break the run, so do nothing.
    if (rs.some((r) => ks.includes(r.k) && r.oe + l.ls < start && start < r.cs + l.ls)) {
      return [text, { start, end }];
    }
    const pre = text.slice(0, start);
    const post = text.slice(end);
    if (pre.endsWith(o) && post.startsWith(c)) {
      // Stars are counted one by one, so a run of four is bold, three is both.
      const n = Math.min(pre.length - pre.replace(/\*+$/, '').length, post.length - post.replace(/^\*+/, '').length);
      if (kind === 'underline' || (kind === 'bold' ? n >= 2 : n % 2 === 1)) {
        return [pre.slice(0, -o.length) + post.slice(c.length), { start: start - o.length, end: start - o.length }];
      }
    }
    return [pre + o + c + post, { start: start + o.length, end: start + o.length }];
  }
  const parts = [];
  const runsOf = (l) => (l.runs ??= emRuns(l.line));
  for (const l of lines) {
    const le = l.ls + l.line.length;
    if (l.code || l.ls > end || le < start) continue;
    const m = LIST.exec(l.line);
    let a = Math.max(start, l.ls + (m ? m[0].length : 0));
    let b = Math.min(end, le);
    // Code spans can't be formatted, and a run can't cross one (inline() formats each side on its own),
    // so each gap between the spans is a part of its own.
    const gaps = [];
    for (const g of l.line.matchAll(CODE)) {
      gaps.push([a, Math.min(b, l.ls + g.index)]);
      a = Math.max(a, l.ls + g.index + g[0].length);
    }
    gaps.push([a, b]);
    for (let [a, b] of gaps) {
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (a >= b) continue;
      // Like Notes, a selection starting or ending mid-word takes the whole word (markers can't open or
      // close inside one).
      const w = (i) => /[\p{L}\p{N}_]/u.test(text[i] || '');
      while (w(a - 1) && w(a)) a--;
      while (w(b) && w(b - 1)) b++;
      // A part that cuts into a run of another kind takes the whole run, so that run stays intact.
      for (let grew = true; grew;) {
        grew = false;
        for (const r of runsOf(l)) {
          const [os, oe, cs, ce] = [r.os + l.ls, r.oe + l.ls, r.cs + l.ls, r.ce + l.ls];
          if (ks.includes(r.k) || b <= os || a >= ce || (a <= os && ce <= b) || (oe <= a && b <= cs)) continue;
          a = Math.min(a, os);
          b = Math.max(b, ce);
          grew = true;
        }
      }
      const runs = runsOf(l).filter((r) => ks.includes(r.k))
        .map((r) => ({ ...r, os: r.os + l.ls, oe: r.oe + l.ls, cs: r.cs + l.ls, ce: r.ce + l.ls }));
      // A run touching the part (`**Note:**text`) isn't one on the full line, since a closing marker can't be
      // followed by a letter; find it on the text before / after the part so wrapping merges into it.
      const shift = (rs, d, keep) => rs.filter((r) => ks.includes(r.k) && keep(r))
        .map((r) => ({ ...r, os: r.os + d, oe: r.oe + d, cs: r.cs + d, ce: r.ce + d }))
        .filter((r) => !runs.some((x) => x.k === r.k && x.os === r.os));
      const touch = [...shift(emRuns(l.line.slice(0, a - l.ls)), l.ls, (r) => r.ce === a - l.ls),
        ...shift(emRuns(l.line.slice(b - l.ls)), b, (r) => r.os === 0)];
      // The run the part sits in may be wrapped in markers of other kinds (`<u>**x**</u>` all selected),
      // so look for it from past those.
      let [ia, ib] = [a, b];
      for (let moved = true; moved;) {
        moved = false;
        for (const r of runsOf(l)) {
          if (ks.includes(r.k)) continue;
          if (r.os + l.ls === ia && r.ce + l.ls <= ib) { ia = r.oe + l.ls; moved = true; }
          if (r.ce + l.ls === ib && r.os + l.ls >= a) { ib = r.cs + l.ls; moved = true; }
        }
      }
      const p = { a, b, runs: [...runs, ...touch], in: runs.find((r) => r.os <= ia && ib <= r.ce) }; // innermost run first
      // A plain wrap that wouldn't render as a run (`foo.**js**`) is skipped, so a second press can't double it.
      const x = [a - l.ls, b - l.ls];
      if (!p.in && !p.runs.some((r) => r.os <= b && r.ce >= a)
        && !emRuns(l.line.slice(0, x[0]) + o + l.line.slice(...x) + c + l.line.slice(x[1]))
          .some((r) => ks.includes(r.k) && r.os <= x[0] && x[0] + o.length <= r.oe // markers may be shared: ***x***
            && r.cs <= x[1] + o.length && x[1] + o.length + c.length <= r.ce)) continue;
      parts.push(p);
    }
  }
  if (!parts.length) return [text, { start, end }];
  const edits = []; // [pos, delete count, insert]
  const strip = (r) => edits.push([r.os, r.ol, ''], [r.ce - r.cl, r.cl, '']);
  const unwrap = parts.every((p) => p.in);
  for (const p of parts) {
    if (p.in) { // the selection covers the run's text, not its markers
      p.a = Math.max(p.a, p.in.oe);
      p.b = Math.max(p.a, Math.min(p.b, p.in.cs));
    }
    if (unwrap) {
      // Close the run before the part and reopen it after, with whitespace outside the markers;
      // a side left empty loses its marker instead.
      const r = p.in;
      const [mo, mc] = [text.slice(r.os, r.os + r.ol), text.slice(r.ce - r.cl, r.ce)];
      const left = text.slice(r.oe, p.a);
      const right = text.slice(p.b, r.cs);
      if (left) edits.push([r.oe + left.trimEnd().length, 0, mc]); else edits.push([r.os, r.ol, '']);
      if (right) edits.push([r.cs - right.trimStart().length, 0, mo]); else edits.push([r.ce - r.cl, r.cl, '']);
    } else if (!p.in) {
      for (let grew = true; grew;) {
        grew = false;
        for (const r of p.runs) {
          if (r.done || r.os > p.b || r.ce < p.a) continue; // overlapping or touching
          r.done = grew = true;
          strip(r);
          p.a = Math.min(p.a, r.os);
          p.b = Math.max(p.b, r.ce);
        }
      }
      edits.push([p.a, 0, o], [p.b, 0, c]);
    }
  }
  edits.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // at one offset, insert before deleting
  let out = '';
  let at = 0;
  for (const [q, d, s] of edits) {
    out += text.slice(at, q) + s;
    at = Math.max(at, q + d);
  }
  out += text.slice(at);
  // A boundary moves with the edits before it; one exactly at it moves the start (not the end) past an insert.
  const map = (pos, after) => edits.reduce((n, [q, d, s]) => n + (q < pos || (q === pos && after) ? s.length - Math.min(d, pos - q) : 0), pos);
  const s = map(parts[0].a, true);
  return [out, { start: s, end: Math.max(s, map(parts[parts.length - 1].b, false)) }];
}

// Marker chars a line shows as plain text (past its list marker, outside code).
function literals(line) {
  const m = LIST.exec(line);
  return codeSplit(line.slice(m ? m[0].length : 0))
    .reduce((n, s, i) => n + (i % 2 ? 0 : ((marks(esc(s)) || esc(s)).match(/\*|_|&lt;\/?u&gt;/g) || []).length), 0);
}

// An italic wrap with * that does nothing, since its * would merge into a * next to it (`***Note:** do*`),
// is done with _ instead: `_**Note:** do_`.
function fmtEdit(text, sel, kind) {
  const r = checked(text, sel, kind);
  if (r[0] !== text || kind !== 'italic' || sel.start === sel.end) return r;
  return checked(text, sel, kind, ['_', '_']);
}

// Safety net: an edit that leaves more markers as plain text on a line than before (beyond a fresh empty
// pair at a caret, which shows its markers until typed into) broke some run, so it's dropped instead.
function checked(text, sel, kind, wrap) {
  const [out, s] = fmtRuns(text, sel, kind, wrap);
  const [o, c] = WRAP[kind];
  const pair = sel.start === sel.end && out.length > text.length ? (kind === 'underline' ? 2 : o.length + c.length) : 0;
  const before = text.split('\n');
  const after = out.split('\n');
  if (after.some((x, i) => x !== before[i] && literals(x) > literals(before[i]) + pair)) return [text, sel];
  // A pair is only let through if typing into it keeps the line's runs rendering (`**b**|` ⌘I would give
  // `**b****`, and the first letter typed would unbold b).
  if (pair) {
    const i = out.slice(0, s.start).split('\n').length - 1;
    const col = s.start - (out.lastIndexOf('\n', s.start - 1) + 1);
    if (emRuns(after[i].slice(0, col) + 'x' + after[i].slice(col)).length < emRuns(before[i]).length) return [text, sel];
  }
  return [out, s];
}

function mountEditor(ed) {
  paint(ed, editing.draft);
  // A click in the preview puts the caret at the same point in the editor: both lay the text out
  // alike once the emphasis markers (the only visible ones) are hidden for the hit test.
  const { at } = editing;
  delete editing.at;
  ed.classList.add('hit');
  const b = ed.getBoundingClientRect();
  const r = at && document.caretRangeFromPoint(b.left + at.dx, b.top + at.dy);
  ed.focus({ preventScroll: !!at });
  if (r) getSelection().setBaseAndExtent(r.startContainer, r.startOffset, r.startContainer, r.startOffset);
  const hit = r && selOf(ed);
  ed.classList.remove('hit');
  let pos = hit ? hit.start : editing.caret == null ? editing.draft.length : editing.caret;
  // A click on a block's top edge (the opener) lands in the code, on its bottom edge (the closer) at the code's end.
  if (onFence(editing.draft, pos)) {
    const dir = inFence(editing.draft, lineStart(editing.draft, pos)) ? -1 : 1;
    pos = offFence(editing.draft, pos, dir) ?? offFence(editing.draft, pos, -dir) ?? pos;
  }
  editing.caret = pos;
  const h = editing.hist = hists.get(editing.id) || { stack: [{ text: editing.draft, sel: { start: pos, end: pos } }], i: 0 };
  hists.set(editing.id, h);
  // Saving trims trailing whitespace and an emptied prompt keeps its old text, so the step may differ.
  if (h.stack[h.i].text !== editing.draft) h.stack[h.i] = { text: editing.draft, sel: { start: pos, end: pos } };
  setSel(ed, { start: pos, end: pos });

  let before = null; // selection before the current native edit
  let composing = false;
  const sync = (kind) => {
    const read = readText(ed);
    let [text, sel] = relist(editing.draft, read, selOf(ed) || { start: read.length, end: read.length });
    if (kind === 'insertText') [text, sel] = fenceTyped(text, sel) || [text, sel];
    record(text, sel, kind, before);
    editing.draft = text;
    editing.caret = sel.start;
    saveDraft();
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
    if (composing) return;
    before = selOf(ed);
    if (before && before.start === before.end && e.inputType.startsWith('delete')) {
      const r = fenceJoin(editing.draft, before, e.inputType.includes('Backward') ? -1 : 1);
      if (r !== undefined) e.preventDefault();
      if (r) applyEdit(ed, r);
    }
  });
  // A caret moved onto a fence line from another line by anything but the arrow keys (editorKeys), such as
  // a click on a block's edge, skips past it. Edits set editing.caret themselves, so moving within a fence
  // line (a pasted ```js) leaves the caret alone.
  const onSel = () => {
    if (!ed.isConnected) return document.removeEventListener('selectionchange', onSel);
    const s = !composing && selOf(ed);
    if (!s || s.start !== s.end || s.start === editing.caret) return;
    const text = editing.draft;
    const from = editing.caret;
    editing.caret = s.start;
    if (!onFence(text, s.start) || lineStart(text, from) === lineStart(text, s.start)) return;
    leaveFence(ed, s.start, from);
  };
  document.addEventListener('selectionchange', onSel);
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
    ${draggable ? `<button class="act more" data-act="more" title="More">${ICONS.more}</button>` : ''}
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
       <div class="edit-hint"><span>saved as you type</span> · <span><kbd>⌘</kbd><kbd>↩</kbd> done</span> · <span><kbd>esc</kbd> close</span> · <span><code>\`code\`</code> <code>\`\`\`block\`\`\`</code></span> <span><code>- list</code> <code>1. list</code> <kbd>⇥</kbd> nest</span> · <span><kbd>⌘B</kbd> <kbd>⌘I</kbd> <kbd>⌘U</kbd> format</span> · <span><kbd>⌘Z</kbd> undo</span></div>`
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
          : `<button class="act pill send" data-act="send" title="Send to Claude Code as a new session">${ICONS.send}<span>Send to Claude</span></button>
             <button class="act pill copy" data-act="copy" title="Copy prompt  ·  ⌥-click: copy and mark as done">${ICONS.copy}<span>Copy</span></button>`}
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
  const proj = project(view);
  const folder = $('#folder');
  folder.hidden = !proj;
  if (proj) {
    folder.textContent = proj.path || 'Set folder…';
    folder.title = proj.path ? 'Change the project folder' : 'Choose the project folder';
    folder.classList.toggle('none', !proj.path);
  }
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

async function newProject() {
  const r = await projectDialog();
  if (!r) return;
  if (editing) commitEdit(false);
  const p = { id: uid(), name: r.name, createdAt: Date.now(), ...(r.path && { path: r.path }) };
  state.projects.push(p);
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
  editing = { id: p.id, draft: '', orig: '', isNew: true };
  state.tab = 'pending';
  query = '';
  $('#search').value = '';
  render();
  $('#list').scrollTop = 0;
}

function startEdit(id, at) {
  if (editing && editing.id === id) return;
  if (editing) commitEdit(false);
  const p = state.prompts.find((x) => x.id === id);
  editing = { id, draft: p.text, orig: p.text, isNew: false, at };
  render();
}

function commitEdit(rerender = true) {
  if (!editing) return;
  saveDraft(); // catches a draft typed mid-IME composition
  const { id, isNew, hist } = editing;
  editing = null;
  if (hist) hist.kind = null; // typing in the next session is a new undo step
  const p = state.prompts.find((x) => x.id === id);
  if (p) {
    // An empty new prompt is discarded.
    if (isNew && !p.text.trim()) dropPrompts((x) => x.id === id);
  }
  persist();
  if (rerender) render();
}

function editorKeys(e) {
  const ed = e.currentTarget;
  if (e.isComposing || e.keyCode === 229) return; // keys belong to the IME while it composes
  const sel = () => selOf(ed) || { start: editing.draft.length, end: editing.draft.length };
  if (e.key === 'Escape' || e.key === 'Enter' && e.metaKey) { e.preventDefault(); commitEdit(true); }
  else if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); // ⇧↩ is a plain newline that does not continue a list
    applyEdit(ed, enterEdit(editing.draft, sel(), e.shiftKey));
  } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const r = tabEdit(editing.draft, sel(), e.shiftKey);
    if (r) { e.preventDefault(); applyEdit(ed, r); }
  } else if (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const r = backEdit(editing.draft, sel());
    if (r) { e.preventDefault(); applyEdit(ed, r); }
  } else if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    // The key's own move, made here (Selection.modify) so that one landing on a fence line is moved past it
    // before the next paint: the caret never shows on a block's edge.
    const s = getSelection();
    const from = selOf(ed);
    if (!from || from.start !== from.end) return; // collapsing a selection never lands on a fence
    const vert = /Up|Down/.test(e.key);
    const rc = s.getRangeAt(0).getClientRects()[0];
    e.preventDefault();
    s.modify('move', /Down|Right/.test(e.key) ? 'forward' : 'backward', vert ? 'line' : e.altKey ? 'word' : 'character');
    const at = selOf(ed).start;
    if (onFence(editing.draft, at) && lineStart(editing.draft, at) !== lineStart(editing.draft, from.start)) {
      leaveFence(ed, at, from.start, vert && rc ? rc.left : null);
    }
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

// Removes prompts along with their undo history.
function dropPrompts(gone) {
  for (const p of state.prompts.filter(gone)) hists.delete(p.id);
  state.prompts = state.prompts.filter((p) => !gone(p));
}

async function deletePrompt(p) {
  const ok = await window.api.confirm('Delete this prompt?', 'This cannot be undone.', 'Delete');
  if (!ok) return;
  dropPrompts((x) => x.id === p.id);
  persist();
  render();
}

// One item list for the right-click menu (native) and the sidebar ⋯ menu (popMenu, Delete in red).
const PROJECT_ITEMS = [{ id: 'rename', label: 'Rename' }, { id: 'folder', label: 'Set Folder…' }, '-', { id: 'delete', label: 'Delete Project…' }];

async function projectMenu(p) {
  projectAction(p, await window.api.menu(PROJECT_ITEMS));
}

async function projectAction(p, id) {
  if (id === 'rename') { renaming = p.id; render(); }
  if (id === 'folder') setFolder(p);
  if (id === 'delete') {
    const n = state.prompts.filter((x) => x.projectId === p.id).length;
    const ok = await window.api.confirm(`Delete project “${p.name}”?`,
      n ? `Its ${n} prompt${n === 1 ? '' : 's'} (including done ones) will be deleted too. This cannot be undone.` : 'The project is empty.',
      'Delete');
    if (!ok) return;
    state.projects = state.projects.filter((x) => x.id !== p.id);
    dropPrompts((x) => x.projectId === p.id);
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

async function setFolder(p) {
  const r = await window.api.pickFolder(p.path);
  if (!r || !project(p.id)) return;
  p.path = r.path;
  persist();
  render();
}

// Opens the prompt as a new Claude Code session in the project folder and marks it done.
// Without a usable folder nothing is sent: the project dialog asks for one instead.
async function sendToClaude(p) {
  const proj = project(p.projectId);
  if (!proj) return;
  const r = await window.api.sendToClaude(p.text, proj.path);
  if (r === 'no-folder') {
    const hint = proj.path
      ? `The folder ${proj.path} no longer exists. Choose the project folder on disk to send prompts to Claude.`
      : 'Choose the project folder on disk to send prompts to Claude.';
    const s = await projectDialog(proj, hint);
    if (s && project(proj.id)) {
      proj.name = s.name;
      if (s.path) proj.path = s.path;
      persist();
      render();
    }
    return;
  }
  if (r !== 'sent' || p.doneAt) return;
  if (editing && editing.id === p.id) commitEdit(false);
  toggleDone(p);
}

// ---------- project dialog and ⋯ menu ----------

// New Project, and Send to Claude without a folder. Resolves { name, path } or null when cancelled.
// The name follows the chosen folder while it is empty or still the previous folder's name.
function projectDialog(proj, hint) {
  const dlg = $('#project-dialog');
  if (dlg.open) return Promise.resolve(null);
  const name = $('#pd-name');
  let path = (proj && proj.path) || '';
  let auto = null;
  const showPath = () => {
    $('#pd-path').textContent = path || 'No folder';
    $('#pd-path').classList.toggle('none', !path);
  };
  $('#pd-title').textContent = proj ? 'Project Settings' : 'New Project';
  $('#pd-ok').textContent = proj ? 'Save' : 'Create';
  $('#pd-hint').textContent = hint || '';
  $('#pd-hint').hidden = !hint;
  name.value = proj ? proj.name : '';
  showPath();
  $('#pd-choose').onclick = async () => {
    const r = await window.api.pickFolder(path);
    if (!r) return;
    path = r.path;
    if (!name.value.trim() || name.value === auto) name.value = auto = r.name;
    showPath();
  };
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok'
      ? { name: name.value.trim() || path.split('/').filter(Boolean).pop() || 'New Project', path }
      : null);
  });
}

// HTML menu under an anchor (native menus cannot colour an item): Delete shows in red.
function popMenu(anchor, items, pick) {
  const m = $('#popmenu');
  m.innerHTML = items.map((it) => (it === '-' ? '<hr>'
    : `<button data-id="${it.id}"${it.id === 'delete' ? ' class="danger"' : ''}>${esc(it.label)}</button>`)).join('');
  m.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    m.hidePopover();
    pick(b.dataset.id);
  };
  m.showPopover();
  const r = anchor.getBoundingClientRect();
  m.style.left = `${r.left}px`;
  m.style.top = `${r.bottom + 4}px`;
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
  pressed = null; // a drag ends without mouseup, so the press must not open the editor on the next click elsewhere
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
  const more = item && e.target.closest('[data-act=more]');
  if (more) return popMenu(more, PROJECT_ITEMS, (id) => projectAction(project(item.dataset.view), id));
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
$('#folder').addEventListener('click', () => { if (project(state.view)) setFolder(project(state.view)); });

// Installing quits the app; it only resolves when the update was refused or failed, so put the button back.
$('#update').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Updating…';
  try {
    await window.api.update();
  } finally {
    btn.querySelector('span').textContent = 'Update available';
    btn.disabled = false;
  }
});

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
    if (act === 'send') { actEl.disabled = true; return sendToClaude(p).finally(() => { actEl.disabled = false; }); }
    if (act === 'toggle-done') return toggleDone(p);
    if (act === 'more') return promptMenu(p);
    if (act === 'project') return projectPicker(p);
  }

  // Click on text enters edit mode, unless the user is selecting text.
  if (p && e.target.closest('.body') && window.getSelection().isCollapsed && !pressed) startEdit(p.id);
});
// A real click opens the editor once the mouseup is done, at the point pressed. The press is kept relative to the text box:
// closing another editor on mousedown re-renders the list (cards shift, and the click may not reach the card).
let pressed = null; // { id, dx, dy }
$('#list').addEventListener('mousedown', (e) => {
  // Copy works while editing: keep the editor focused so its blur does not close it and re-render the button away.
  if (e.target.closest('.card.editing :is([data-act=copy], [data-act=send])')) e.preventDefault();
  const body = e.button === 0 && !e.ctrlKey && !e.target.closest('[data-act]') && e.target.closest('.card:not(.editing) .body');
  const r = body && body.getBoundingClientRect();
  pressed = body && { id: body.closest('.card').dataset.id, dx: e.clientX - r.left, dy: e.clientY - r.top };
});
document.addEventListener('mouseup', () => setTimeout(() => {
  if (pressed && window.getSelection().isCollapsed && state.prompts.some((x) => x.id === pressed.id)) startEdit(pressed.id, pressed);
  pressed = null;
}, 0));
$('#list').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  const p = card && state.prompts.find((x) => x.id === card.dataset.id);
  if (p && !card.classList.contains('editing')) { e.preventDefault(); promptMenu(p); }
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
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
  // An update check found a newer version; the install starts only when the button is clicked.
  if (cmd === 'update-available') $('#update').hidden = false;
  // Edit ▸ Undo / Redo (⌘Z / ⇧⌘Z): the editor has its own history, other fields use the browser's.
  // With no field focused, it reopens the last edited prompt and undoes there (never another prompt while editing).
  if (cmd === 'undo' || cmd === 'redo') {
    const f = document.activeElement;
    const ed = $('#list .editor');
    const dir = cmd === 'undo' ? -1 : 1;
    if (f !== ed && f?.matches('input, textarea, [contenteditable]')) document.execCommand(cmd);
    else if (editing) { if (ed) undoRedo(ed, dir); }
    else undoClosed(dir);
  }
  // Format ▸ Bold / Italic / Underline (⌘B / ⌘I / ⌘U): only the prompt editor has markdown to format.
  if (WRAP[cmd]) {
    const ed = document.activeElement;
    if (editing && ed?.classList.contains('editor')) {
      applyEdit(ed, fmtEdit(editing.draft, selOf(ed) || { start: editing.draft.length, end: editing.draft.length }, cmd));
    }
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
