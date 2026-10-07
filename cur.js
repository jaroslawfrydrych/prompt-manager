const ICONS={copy:""};
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LIST = /^( *)([-*]|\d+[.)]) /; // indent, marker
const FENCE = /^ *```/;

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

// Inline code is never formatted; in the editor (keep) it stays plain source text.
function inline(text, keep) {
  return text.split(/(`[^`\n]+`)/).map((s, i) => {
    if (i % 2 === 0) return emphasis(esc(s), keep);
    return keep ? esc(s) : `<code>${esc(s.slice(1, -1))}</code>`;
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
    const code = fence || FENCE.test(line); // fences and the code between them are left unformatted
    if (FENCE.test(line)) fence = !fence;
    const m = !code && LIST.exec(line);
    if (!m) return `<div class="ln">${!line ? '<br>' : code ? esc(line) : inline(line, true)}</div>`;
    // w<n>: marker width in (monospace) characters, for the hanging indent in CSS.
    return `<div class="ln li w${Math.min(m[0].length, 20)}"><span class="mk">${esc(m[0])}</span>${inline(line.slice(m[0].length), true)}</div>`;
  }).join('');
}

// Text of whatever DOM native editing left: blocks are lines, <br> is a newline,
// except the placeholder <br> that ends a block.
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

const WRAP = { bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'] };

// Emphasis runs of a raw line, in raw offsets, from the same passes the renderer uses:
// { k: 1 bold | 2 * | 3 _ | 4 u, os, oe, cs, ce } (open marker os–oe, close marker cs–ce, ol / cl: marker
// lengths). ***x*** gives a bold and an italic run that share the three stars on each side.
function emRuns(line) {
  const out = [];
  const m = LIST.exec(line);
  let r = m ? m[0].length : 0;
  line.slice(r).split(/(`[^`\n]+`)/).forEach((s, i) => {
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
const inCode = (line, a, b = a) => [...line.matchAll(/`[^`\n]+`/g)].some((m) => m.index < b && a < m.index + m[0].length);

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
    for (const g of l.line.matchAll(/`[^`\n]+`/g)) {
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
      const p = { a, b, runs: [...runs, ...touch], in: runs.find((r) => r.os <= a && b <= r.ce) }; // innermost run first
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
  return line.slice(m ? m[0].length : 0).split(/(`[^`\n]+`)/)
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

module.exports={checked,fmtEdit,fmtRuns,literals,renderMarkdown,decorate,emRuns,inline,esc,marks};