// Smoke test: `npx electron scripts/smoke.js` — drives the real UI against a temp data file.
const { app, clipboard, Menu } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-smoke-'));
app.setPath('userData', dir);
const file = path.join(dir, 'data.json');
const now = Date.now();
fs.writeFileSync(file, JSON.stringify({
  view: 'p1', tab: 'pending',
  projects: [{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }],
  prompts: [
    { id: 'a', projectId: 'p1', text: 'Fix `x`\n```js\nlet a = 1;\n```', createdAt: now - 5 * 86400000, doneAt: null, flag: null },
    { id: 'b', projectId: 'p2', text: 'second', createdAt: now, doneAt: null, flag: null },
  ],
}));

require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
// Saves are debounced and timers in a background window are throttled, so poll the file.
async function until(check) {
  for (let i = 0; i < 50 && !check(read()); i++) await wait(100);
  return read();
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => console.log('renderer:', e.message));
  win.webContents.once('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c.includes(';') ? `{ ${c} }` : c);
    try {
      await wait(500);

      // markdown render
      assert.strictEqual(await js(`document.querySelectorAll('.codeblock').length`), 1);
      assert.strictEqual(await js(`document.querySelector('.body > code').textContent`), 'x');
      assert.ok(await js(`document.querySelector('.card').classList.contains('stale')`));

      // edit existing + ⌘↩
      await js(`document.querySelector('.card .body').click()`);
      await wait(100);
      await js(`const t = document.querySelector('.editor'); t.textContent = 'edited'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const byId = (d, id) => d.prompts.find((p) => p.id === id);
      assert.strictEqual(byId(await until((d) => byId(d, 'a').text === 'edited'), 'a').text, 'edited');

      // ⌘N new prompt lands in current project
      await js(`newPrompt(); const t = document.querySelector('.editor'); t.textContent = 'brand new'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const created = (await until((d) => d.prompts.some((p) => p.text === 'brand new'))).prompts.find((p) => p.text === 'brand new');
      assert.ok(created && created.projectId === 'p1');
      assert.strictEqual(await js(`document.querySelector('.nav-item[data-view=p1] .badge').textContent`), '2');

      // ⌘N then Esc leaves nothing behind
      await js(`newPrompt(); document.querySelector('.editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(1500);
      assert.strictEqual(read().prompts.length, 3);

      // a single ⌘N while editing saves the edit and opens one focused new editor
      await js(`document.querySelector('.card[data-id=a] .body').click()`);
      await wait(100);
      await js(`const t = document.querySelector('.editor'); t.textContent = 'saved by cmd-n'; t.dispatchEvent(new Event('input'))`);
      win.webContents.send('command', 'new-prompt');
      await wait(300);
      assert.strictEqual(await js(`document.querySelectorAll('.editor').length`), 1);
      assert.ok(await js(`document.activeElement === document.querySelector('.editor')`));
      assert.ok(await js(`editing && editing.isNew`));
      assert.strictEqual(byId(await until((d) => byId(d, 'a').text === 'saved by cmd-n'), 'a').text, 'saved by cmd-n');
      await js(`document.querySelector('.editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(1500);
      assert.strictEqual(read().prompts.length, 3);

      // spell checking: editor is checked, right-click on a misspelling offers suggestions (popup captured, not shown)
      await js(`newPrompt()`);
      assert.ok(await js(`document.querySelector('.editor').spellcheck`));
      assert.ok(win.webContents.session.isSpellCheckerEnabled());
      const { popup } = Menu.prototype;
      let shown;
      Menu.prototype.popup = function () { shown = this; };
      const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
      win.webContents.emit('context-menu', {}, { isEditable: true, misspelledWord: 'promtp', dictionarySuggestions: ['prompt'], editFlags: flags });
      assert.deepStrictEqual(shown.items.map((i) => i.label || i.role || i.type),
        ['prompt', 'separator', 'Learn Spelling', 'separator', 'Cut', 'Copy', 'Paste', 'separator', 'Select All']);
      shown = null;
      win.webContents.emit('context-menu', {}, { isEditable: false, editFlags: flags });
      assert.strictEqual(shown, null);
      Menu.prototype.popup = popup;
      await js(`document.querySelector('.editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

      // flag, copy, done
      // context menu actions (the native menu itself can't be clicked from here)
      await js(`promptAction(state.prompts.find((p) => p.text === 'brand new'), 'flag:red')`);
      assert.strictEqual(await js(`document.querySelectorAll('.flag-dot').length`), 1);
      await js(`document.querySelector('[data-act=copy]').click()`);
      await wait(200);
      assert.strictEqual(await clipboard.readText(), 'brand new');
      await js(`document.querySelector('[data-act=toggle-done]').click()`);
      const done = (await until((d) => d.prompts.find((p) => p.id === created.id).doneAt)).prompts.find((p) => p.id === created.id);
      assert.ok(done.doneAt && done.flag === 'red');

      // drag & drop: synthetic events at the top/bottom edge of the target
      await js(`window.dnd = (src, dst, where) => { const dt = new DataTransfer(); const r = dst.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: where === 'before' ? r.top + 2 : r.bottom - 2 };
        src.dispatchEvent(new DragEvent('dragstart', o)); dst.dispatchEvent(new DragEvent('dragover', o));
        dst.dispatchEvent(new DragEvent('drop', o)); src.dispatchEvent(new DragEvent('dragend', o)); }; 1`);
      const nav = (id) => `document.querySelector('.nav-item[data-view=${id}]')`;
      const card = (id) => `document.querySelector('.card[data-id=${id}]')`;

      await js(`dnd(${nav('p2')}, ${nav('p1')}, 'before')`);
      assert.strictEqual((await until((d) => d.projects[0].id === 'p2')).projects.map((p) => p.id).join(), 'p2,p1');

      await js(`selectView('all')`);
      await js(`dnd(${card('a')}, ${card('b')}, 'before')`);
      const pendingIds = (d) => d.prompts.filter((p) => !p.doneAt).map((p) => p.id).join();
      assert.strictEqual(pendingIds(await until((d) => pendingIds(d) === 'a,b')), 'a,b');

      await js(`dnd(${card('a')}, ${nav('p2')}, 'before')`);
      assert.strictEqual(byId(await until((d) => byId(d, 'a').projectId === 'p2'), 'a').projectId, 'p2');

      // Flagged: empty-state button creates a flagged prompt that stays visible
      await js(`selectView('flagged')`);
      await js(`document.querySelector('[data-act=new-prompt]').click(); const t = document.querySelector('.editor'); t.textContent = 'urgent'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const urgent = (await until((d) => d.prompts.some((p) => p.text === 'urgent'))).prompts.find((p) => p.text === 'urgent');
      assert.ok(urgent.flag);
      assert.strictEqual(await js(`document.querySelectorAll('.card').length`), 1);

      // rename via double-click on a project
      await js(`${nav('p1')}.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))`);
      await js(`const i = document.querySelector('.rename'); i.value = 'renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      assert.strictEqual((await until((d) => d.projects[1].name === 'renamed')).projects[1].name, 'renamed');

      // lists: live editing in the contenteditable editor (Enter continues/ends, Tab nests, undo), then preview
      await js(`selectView('p1'); newPrompt()`);
      const ed = `document.querySelector('.editor')`;
      const key = (k, o = {}) => js(`${ed}.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true, ...${JSON.stringify(o)} }))`);
      const type = (s) => js(`document.execCommand('insertText', false, ${JSON.stringify(s)})`);
      const draft = () => js('editing.draft');
      await type('- a');
      assert.strictEqual(await js(`${ed}.querySelector('.ln.li .mk').textContent`), '- ');
      await key('Enter');
      assert.strictEqual(await draft(), '- a\n- ');
      await key('Enter');
      assert.strictEqual(await draft(), '- a\n');
      await type('- b');
      await key('Tab');
      assert.strictEqual(await draft(), '- a\n  - b');
      await key('Tab', { shiftKey: true });
      assert.strictEqual(await draft(), '- a\n- b');
      // Edit ▸ Undo / Redo (⌘Z / ⇧⌘Z are their accelerators) send a command that uses the editor's own history
      const cmd = async (c) => { win.webContents.send('command', c); await wait(100); };
      await cmd('undo');
      assert.strictEqual(await draft(), '- a\n  - b');
      await cmd('redo');
      assert.strictEqual(await draft(), '- a\n- b');
      await cmd('undo');
      assert.strictEqual(await draft(), '- a\n  - b');
      await key('Tab', { shiftKey: true });
      // Enter on an empty nested item outdents it; on an empty top-level item it ends the list
      assert.deepStrictEqual(await js(`enterEdit('- a\\n  - ', { start: 8, end: 8 })`), ['- a\n- ', { start: 6, end: 6 }]);
      await key('Enter');
      await key('Enter');
      await key('Enter', { shiftKey: true });
      await type('3. c');
      await key('Enter');
      assert.strictEqual(await draft(), '- a\n- b\n\n3. c\n4. ');
      await type('d');
      await key('Tab');
      await key('Enter');
      await key('Enter');
      assert.strictEqual(await draft(), '- a\n- b\n\n3. c\n  1. d\n4. ');
      await key('Enter');
      assert.strictEqual(await draft(), '- a\n- b\n\n3. c\n  1. d\n');
      // a native line break (⌥↩, ⌃O) right before the caret still counts: text goes after it
      await js(`document.execCommand('insertText', false, 'e'); document.execCommand('insertLineBreak'); document.execCommand('insertText', false, 'q')`);
      assert.strictEqual(await draft(), '- a\n- b\n\n3. c\n  1. d\ne\nq');
      await cmd('undo');
      await cmd('undo');
      await cmd('undo');
      assert.strictEqual(await draft(), '- a\n- b\n\n3. c\n  1. d\n');
      // the editor's text is exactly the draft, one line div per line (empty and trailing lines too)
      assert.ok(await js(`readText(${ed}) === editing.draft`));
      assert.strictEqual(await js(`${ed}.querySelectorAll('.ln').length`), 6);
      await key('Enter', { metaKey: true });
      const listText = '- a\n- b\n\n3. c\n  1. d';
      assert.ok((await until((d) => d.prompts.some((p) => p.text === listText))).prompts.some((p) => p.text === listText));
      const body = `document.querySelector('.card .body')`;
      assert.strictEqual(await js(`${body}.querySelectorAll(':scope > ul > li').length`), 2);
      assert.strictEqual(await js(`${body}.querySelector(':scope > ol').getAttribute('start')`), '3');
      assert.strictEqual(await js(`${body}.querySelector('ol > li > ol > li').textContent`), 'd');
      // numbered items keep consecutive numbers through Enter, Tab and Shift+Tab (caret follows a wider number)
      const edit = async (f, t, s, ...a) => js(`${f}(${JSON.stringify(t)}, { start: ${s}, end: ${s} }${a.map((x) => `, ${x}`).join('')})`);
      assert.deepStrictEqual(await edit('enterEdit', '1. a\n2. b', 4), ['1. a\n2. \n3. b', { start: 8, end: 8 }]);
      assert.deepStrictEqual(await edit('tabEdit', '1. a\n2. b\n3. c', 6, false), ['1. a\n  1. b\n2. c', { start: 8, end: 8 }]);
      assert.deepStrictEqual(await edit('tabEdit', '1. a\n  1. b\n2. c', 8, true), ['1. a\n2. b\n3. c', { start: 6, end: 6 }]);
      assert.deepStrictEqual(await edit('enterEdit', '8. a\n9. b', 4), ['8. a\n9. \n10. b', { start: 8, end: 8 }]);
      assert.deepStrictEqual(await edit('tabEdit', '9. a\n10. b\n11. c', 9, false), ['9. a\n  1. b\n10. c', { start: 10, end: 10 }]);
      // an empty item mid-list ends it; the items after it start again at 1
      assert.deepStrictEqual(await edit('enterEdit', '1. a\n2. \n3. b\n4. c', 8), ['1. a\n\n1. b\n2. c', { start: 5, end: 5 }]);
      // deleting or cutting whole items renumbers the rest (one undo step); retyping a number is left alone
      await js(`newPrompt(); document.execCommand('insertText', false, '1. a\\n2. b\\n3. c\\n4. d')`);
      await js(`setSel(${ed}, { start: 5, end: 10 }); document.execCommand('delete')`);
      assert.strictEqual(await draft(), '1. a\n2. c\n3. d');
      assert.deepStrictEqual(await js(`selOf(${ed})`), { start: 5, end: 5 });
      await cmd('undo');
      assert.strictEqual(await draft(), '1. a\n2. b\n3. c\n4. d');
      await js(`setSel(${ed}, { start: 5, end: 10 }); ${ed}.dispatchEvent(new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))`);
      assert.strictEqual(await draft(), '1. a\n2. c\n3. d');
      await js(`setSel(${ed}, { start: 5, end: 6 }); document.execCommand('insertText', false, '7')`);
      assert.strictEqual(await draft(), '1. a\n7. c\n3. d');
      // numbered lines inside a code block are code: pasting or deleting lines there never renumbers them
      const code = 'Steps:\n```\n1. clone\n1. build\n```';
      await js(`editing.draft = ${JSON.stringify(code)}; paint(${ed}, editing.draft); setSel(${ed}, { start: 25, end: 25 }); const dt = new DataTransfer(); dt.setData('text/plain', '\\n1. test'); ${ed}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))`);
      assert.strictEqual(await draft(), 'Steps:\n```\n1. clone\n1. bu\n1. testild\n```');
      await js(`editing.draft = '\`\`\`\\n1. x\\n1. y\\n\\nz\\n\`\`\`'; paint(${ed}, editing.draft); setSel(${ed}, { start: 14, end: 14 }); document.execCommand('delete')`);
      assert.strictEqual(await draft(), '```\n1. x\n1. y\nz\n```');
      // Backspace right after a marker: a nested item outdents, a top-level one loses its marker (one undo step)
      await js(`editing.draft = '1. a\\n  1. b\\n2. c\\n3. d'; paint(${ed}, editing.draft); setSel(${ed}, { start: 10, end: 10 })`);
      await key('Backspace');
      assert.strictEqual(await draft(), '1. a\n2. b\n3. c\n4. d');
      await js(`setSel(${ed}, { start: 13, end: 13 })`);
      await key('Backspace');
      assert.strictEqual(await draft(), '1. a\n2. b\nc\n1. d');
      assert.deepStrictEqual(await js(`selOf(${ed})`), { start: 10, end: 10 });
      await cmd('undo');
      assert.strictEqual(await draft(), '1. a\n2. b\n3. c\n4. d');
      assert.strictEqual(await edit('backEdit', '```\n- x\n```', 6), null);
      await key('Escape');
      // ↓ into a list line keeps the caret's column instead of jumping to the item start (real key events)
      await js(`newPrompt(); document.execCommand('insertText', false, 'abcdef\\n- one\\n  - two two\\n- three\\nxyz'); setSel(${ed}, { start: 6, end: 6 })`);
      win.webContents.focus();
      const downs = [];
      for (let i = 0; i < 3; i++) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
        await wait(100);
        downs.push(await js(`selOf(${ed}).start`));
      }
      assert.ok(downs[1] > 17 && downs[2] > 27, `caret after ↓: ${downs}`);
      // native undo still works in other fields (Edit ▸ Undo falls back to the browser's)
      await key('Escape');
      await js(`const s = document.querySelector('#search'); s.focus(); document.execCommand('insertText', false, 'zzz')`);
      await cmd('undo');
      assert.strictEqual(await js(`document.querySelector('#search').value`), '');
      await js(`document.querySelector('#search').blur()`);
      // list markers inside a code block are not a list
      assert.strictEqual(await js(`const d = document.createElement('div'); d.innerHTML = renderMarkdown('x\\n\`\`\`\\n- no\\n\`\`\`'); d.querySelectorAll('ul').length`), 0);

      // bold / italic / underline in preview: not in code, not for snake_case or list markers, <u> never passes other HTML
      const md = (s) => js(`const d = document.createElement('div'); d.innerHTML = renderMarkdown(${JSON.stringify(s)}); d.innerHTML`);
      assert.strictEqual(await md('**b** *i* _j_ <u>u</u> ***bi*** **a *n* b** snake_case_words'),
        '<strong>b</strong> <em>i</em> <em>j</em> <u>u</u> <strong><em>bi</em></strong> <strong>a <em>n</em> b</strong> snake_case_words');
      assert.strictEqual(await md('* item *x*'), '<ul><li>item <em>x</em></li></ul>');
      assert.strictEqual(await md('`a*b*c` **d**'), '<code>a*b*c</code> <strong>d</strong>');
      assert.ok(!(await md('```\n**no** _no_\n```')).includes('<strong>'));
      assert.strictEqual(await md('<u><img src=x onerror=alert(1)></u>'), '<u>&lt;img src=x onerror=alert(1)&gt;</u>');
      // ... and live in the editor: formatted runs with the markers kept (dimmed), text still equals the draft
      await js(`newPrompt(); document.execCommand('insertText', false, '**b** *i* <u>u</u> x\\n\`*c*\`')`);
      const style = (sel, prop) => js(`getComputedStyle(${ed}.querySelector('${sel}')).${prop}`);
      assert.strictEqual(await style('strong', 'fontWeight'), '600');
      assert.strictEqual(await style('em', 'fontStyle'), 'italic');
      assert.ok((await style('u', 'textDecorationLine')).includes('underline'));
      assert.strictEqual(await js(`[...${ed}.querySelectorAll('.fm')].map((e) => e.textContent).join(' ')`), '** ** * * <u> </u> ` `');
      assert.ok(await js(`readText(${ed}) === editing.draft`));
      // Format ▸ Bold (⌘B) wraps the selection, again unwraps it; a bare caret gets an empty pair; one undo step each
      await js(`setSel(${ed}, { start: 19, end: 20 })`);
      await cmd('bold');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> **x**\n`*c*`');
      assert.deepStrictEqual(await js(`selOf(${ed})`), { start: 21, end: 22 });
      await cmd('bold');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> x\n`*c*`');
      await js(`setSel(${ed}, { start: 20, end: 20 })`);
      await cmd('bold');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> x****\n`*c*`');
      assert.deepStrictEqual(await js(`selOf(${ed})`), { start: 22, end: 22 });
      await cmd('undo');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> x\n`*c*`');
      await cmd('underline');
      await cmd('italic');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> x<u>**</u>\n`*c*`');
      await js(`setSel(${ed}, { start: 3, end: 3 })`); // caret at **b|** steps out of the run
      await cmd('bold');
      assert.strictEqual(await draft(), '**b** *i* <u>u</u> x<u>**</u>\n`*c*`');
      assert.deepStrictEqual(await js(`selOf(${ed})`), { start: 5, end: 5 });
      // a space typed before toggling off moves out past the closer, so what's typed next is plain
      for (const [k, o] of [['bold', '**'], ['italic', '*']]) {
        await js(`document.execCommand('selectAll'); document.execCommand('insertText', false, 'Text ')`);
        await cmd(k);
        await type('it ');
        await cmd(k);
        await type('rest');
        assert.strictEqual(await draft(), `Text ${o}it${o} rest`);
      }
      assert.deepStrictEqual(await js(`fmtEdit('Text _it _', { start: 9, end: 9 }, 'italic')`), ['Text _it_ ', { start: 10, end: 10 }]);
      // a pair right after a letter renders once typed into
      await cmd('bold');
      await type('more');
      assert.strictEqual(await draft(), 'Text *it* rest**more**');
      assert.strictEqual(await js(`${ed}.querySelector('strong').textContent`), 'more');
      // ⌘A then the inner format's key removes it from a line with two formats
      await js(`document.execCommand('selectAll'); document.execCommand('insertText', false, 'Fix the bug')`);
      for (const k of ['bold', 'underline', 'bold']) {
        await js(`document.execCommand('selectAll')`);
        await cmd(k);
      }
      assert.strictEqual(await draft(), '<u>Fix the bug</u>');
      await key('Escape');
      assert.deepStrictEqual(await edit('fmtEdit', '**bold**', 4, "'bold'"), ['bold', { start: 2, end: 2 }]);
      assert.deepStrictEqual(await js(`fmtEdit('**bold**', { start: 2, end: 6 }, 'italic')`), ['***bold***', { start: 3, end: 7 }]);
      assert.deepStrictEqual(await js(`fmtEdit('***x***', { start: 0, end: 7 }, 'bold')`), ['*x*', { start: 1, end: 2 }]);
      for (const [t, k, out] of [['<u>**Fix the bug**</u>', 'bold', '<u>Fix the bug</u>'], ['**<u>x</u>**', 'underline', '**x**'],
        ['<u>*x*</u>', 'italic', '<u>x</u>'], ['<u>***x***</u>', 'bold', '<u>*x*</u>'],
        ['Say <u>**Fix**</u> now', 'bold', '**Say <u>Fix</u> now**']]) {
        assert.strictEqual((await js(`fmtEdit(${JSON.stringify(t)}, { start: 0, end: ${t.length} }, '${k}')`))[0], out);
      }
      assert.deepStrictEqual(await js(`fmtEdit('a _x_ b', { start: 3, end: 4 }, 'italic')`), ['a x b', { start: 2, end: 3 }]);
      // each selected line is formatted on its own, past the list marker, never with whitespace at the edges
      const fmt = (t, a, b, k) => js(`fmtEdit(${JSON.stringify(t)}, { start: ${a}, end: ${b} }, '${k}')`);
      assert.deepStrictEqual(await fmt('a\n- b\n', 0, 6, 'bold'), ['**a**\n- **b**\n', { start: 2, end: 11 }]);
      assert.deepStrictEqual(await fmt('**a**\n- **b**\n', 2, 11, 'bold'), ['a\n- b\n', { start: 0, end: 5 }]);
      assert.deepStrictEqual(await fmt('**a**\nb', 0, 7, 'bold'), ['**a**\n**b**', { start: 2, end: 9 }]);
      assert.deepStrictEqual(await fmt(' foo ', 0, 5, 'italic'), [' *foo* ', { start: 2, end: 5 }]);
      assert.deepStrictEqual(await fmt('```\n**x**\n```', 0, 13, 'bold'), ['```\n**x**\n```', { start: 0, end: 13 }]);
      // toggling part of a run splits it instead of nesting markers
      assert.deepStrictEqual(await fmt('**hello world**', 2, 7, 'bold'), ['hello **world**', { start: 0, end: 5 }]);
      assert.deepStrictEqual(await fmt('**hello world**', 4, 4, 'bold'), ['hello **world**', { start: 2, end: 2 }]);
      assert.deepStrictEqual(await fmt('*hello world*', 7, 12, 'italic'), ['*hello* world', { start: 8, end: 13 }]);
      assert.deepStrictEqual(await fmt('a _b c d_', 5, 6, 'italic'), ['a _b_ c _d_', { start: 6, end: 7 }]);
      assert.deepStrictEqual(await fmt('<u>hello world</u>', 3, 8, 'underline'), ['hello <u>world</u>', { start: 0, end: 5 }]);
      assert.deepStrictEqual(await fmt('a **b** c', 0, 9, 'bold'), ['**a b c**', { start: 2, end: 7 }]);
      // a caret against a run's marker steps out of it; a selection touching a run merges into it
      assert.deepStrictEqual(await fmt('a **b**', 5, 5, 'bold'), ['a **b**', { start: 7, end: 7 }]);
      assert.deepStrictEqual(await fmt('a **b**', 4, 4, 'bold'), ['a **b**', { start: 2, end: 2 }]);
      assert.deepStrictEqual(await fmt('this is *it*', 11, 11, 'italic'), ['this is *it*', { start: 12, end: 12 }]);
      assert.deepStrictEqual(await fmt('this is <u>u</u>', 12, 12, 'underline'), ['this is <u>u</u>', { start: 16, end: 16 }]);
      assert.deepStrictEqual(await fmt('***x***', 4, 4, 'italic'), ['***x***', { start: 7, end: 7 }]);
      // a caret inside a run of that kind but outside a word never nests a pair in the run
      assert.deepStrictEqual(await fmt('**hello world**', 7, 7, 'bold'), ['**hello world**', { start: 7, end: 7 }]);
      assert.deepStrictEqual(await fmt('**a *b* c**', 6, 6, 'bold'), ['**a *b* c**', { start: 6, end: 6 }]);
      assert.deepStrictEqual(await fmt('<u>hello world</u>', 8, 8, 'underline'), ['<u>hello world</u>', { start: 8, end: 8 }]);
      assert.deepStrictEqual(await fmt('**Note:**text', 9, 13, 'bold'), ['**Note:text**', { start: 2, end: 11 }]);
      assert.deepStrictEqual(await fmt('text**More**', 0, 4, 'bold'), ['**textMore**', { start: 2, end: 10 }]);
      assert.deepStrictEqual(await fmt('**a**,', 5, 6, 'bold'), ['**a,**', { start: 2, end: 4 }]);
      // a caret just outside a run's marker steps into the run (⌘B toggles what's typed next), never an empty pair
      // at its edge, which would break the run
      assert.deepStrictEqual(await fmt('**b**', 5, 5, 'bold'), ['**b**', { start: 3, end: 3 }]);
      assert.deepStrictEqual(await fmt('**b**', 0, 0, 'bold'), ['**b**', { start: 2, end: 2 }]);
      assert.deepStrictEqual(await fmt('<u>w</u>', 8, 8, 'underline'), ['<u>w</u>', { start: 4, end: 4 }]);
      assert.deepStrictEqual(await fmt('**b**', 5, 5, 'italic'), ['**b**', { start: 5, end: 5 }]);
      // an italic marker that would touch a * is an underscore, and a second press unwraps it
      assert.deepStrictEqual(await fmt('**Note:** do the thing', 0, 22, 'italic'), ['_**Note:** do the thing_', { start: 1, end: 23 }]);
      assert.deepStrictEqual(await fmt('_**Note:** do the thing_', 1, 23, 'italic'), ['**Note:** do the thing', { start: 0, end: 22 }]);
      assert.strictEqual(await md('_**Note:** do the thing_'), '<em><strong>Note:</strong> do the thing</em>');
      // nothing to format inside `code`
      assert.deepStrictEqual(await fmt('x `a b` y', 4, 4, 'bold'), ['x `a b` y', { start: 4, end: 4 }]);
      assert.deepStrictEqual(await fmt('**a**`c`', 5, 8, 'bold'), ['**a**`c`', { start: 5, end: 8 }]);
      // a selection across code formats the text around it, and a second press unwraps it again
      assert.deepStrictEqual(await fmt('x `a b` y', 0, 9, 'bold'), ['**x** `a b` **y**', { start: 2, end: 15 }]);
      assert.deepStrictEqual(await fmt('**x** `a b` **y**', 2, 15, 'bold'), ['x `a b` y', { start: 0, end: 9 }]);
      const two = 'line one `c`\nline two `d`';
      const [twoB, twoS] = await fmt(two, 0, two.length, 'bold');
      assert.strictEqual(twoB, '**line one** `c`\n**line two** `d`');
      assert.strictEqual((await fmt(twoB, 0, twoB.length, 'bold'))[0], two);
      assert.strictEqual((await fmt(twoB, twoS.start, twoS.end, 'bold'))[0], two);
      // a wrap that wouldn't render is skipped (never doubled); a mid-word selection takes the whole word
      assert.deepStrictEqual(await fmt('foo.js', 5, 5, 'bold'), ['foo.js', { start: 5, end: 5 }]);
      assert.deepStrictEqual(await fmt('foo.js', 4, 6, 'bold'), ['foo.js', { start: 4, end: 6 }]);
      assert.deepStrictEqual(await fmt('hello world', 1, 11, 'bold'), ['**hello world**', { start: 2, end: 13 }]);
      assert.deepStrictEqual(await fmt('foo', 0, 2, 'bold'), ['**foo**', { start: 2, end: 5 }]);
      assert.deepStrictEqual(await fmt('x `a b` y', 3, 6, 'italic'), ['x `a b` y', { start: 3, end: 6 }]);
      // a selection cutting into a run of another kind takes the whole run; a second press restores it
      assert.deepStrictEqual(await fmt('hello *world foo* bar', 0, 12, 'underline'), ['<u>hello *world foo*</u> bar', { start: 3, end: 20 }]);
      assert.deepStrictEqual(await fmt('<u>hello *world foo*</u> bar', 3, 20, 'underline'), ['hello *world foo* bar', { start: 0, end: 17 }]);
      assert.deepStrictEqual(await fmt('see <u>w</u> x', 5, 6, 'bold'), ['see **<u>w</u>** x', { start: 6, end: 14 }]);
      // a caret before or in a list marker works past it; one inside any run's marker steps out of it
      assert.deepStrictEqual(await fmt('- item', 0, 0, 'bold'), ['- ****item', { start: 4, end: 4 }]);
      assert.deepStrictEqual(await fmt('1. item', 1, 1, 'bold'), ['1. ****item', { start: 5, end: 5 }]);
      assert.deepStrictEqual(await fmt('  - item', 2, 2, 'italic'), ['  - **item', { start: 5, end: 5 }]);
      assert.deepStrictEqual(await fmt('**bold**', 1, 1, 'bold'), ['**bold**', { start: 0, end: 0 }]);
      assert.deepStrictEqual(await fmt('<u>w</u>', 6, 6, 'underline'), ['<u>w</u>', { start: 8, end: 8 }]);
      assert.deepStrictEqual(await fmt('<u>w</u>', 2, 2, 'bold'), ['****<u>w</u>', { start: 2, end: 2 }]);
      // an edit that would leave markers as plain text is dropped
      assert.deepStrictEqual(await fmt('*i* x', 0, 0, 'bold'), ['*i* x', { start: 0, end: 0 }]);
      // globs and paths stay plain
      assert.strictEqual(await md('src/*.js and lib/*.ts /_foo_bar_ src/**/*.js *it* _it_'),
        'src/*.js and lib/*.ts /_foo_bar_ src/**/*.js <em>it</em> <em>it</em>');
      for (const t of ['Patterns: *.md, docs/*.md', 'Search *.ts, *.tsx and **/*.js', 'Run on *.py/*.pyi',
        'Exclude **/node_modules/** and *.min.js', 'a*b + c*d', '2*3*4', 'foo.*',
        'Files: README*, LICENSE*, CHANGELOG*', 'Branches feature*, fix* and release*', 'Match log*, tmp* and cache*',
        'Delete test*; keep main*', 'Prefixes (api*, web*) only', 'Tables user*, order*', 'The H*-algorithm and A*-search']) assert.strictEqual(await md(t), t);

      // code live in the editor: inline code in the code face with dimmed backticks, not spell checked
      await js(`newPrompt(); document.execCommand('insertText', false, 'say \`x *y*\` now')`);
      assert.strictEqual(await js(`${ed}.querySelector('code').textContent`), 'x *y*');
      assert.ok(/mono|menlo/i.test(await style('code', 'fontFamily')));
      assert.strictEqual(await js(`[...${ed}.querySelectorAll('.fm')].map((e) => e.textContent).join('')`), '``');
      assert.strictEqual(await js(`${ed}.querySelector('code').spellcheck`), false);
      assert.ok(await js(`readText(${ed}) === editing.draft`));
      // a fenced block: opener / inner / closer lines, no list or emphasis inside, language dimmed, whitespace kept
      const block = 'a\n```js\n- not list\n\t**no**  x\n```\nb';
      await js(`document.execCommand('selectAll'); document.execCommand('insertText', false, ${JSON.stringify(block)})`);
      assert.deepStrictEqual(await js(`[...${ed}.children].map((l) => l.className)`),
        ['ln', 'ln cb cb-first', 'ln cb', 'ln cb', 'ln cb cb-last', 'ln']);
      assert.strictEqual(await js(`${ed}.querySelectorAll('.cb strong, .cb .mk, .cb.li').length`), 0);
      assert.strictEqual(await js(`${ed}.querySelectorAll('.cb')[2].textContent`), '\t**no**  x');
      assert.strictEqual(await js(`${ed}.querySelector('.cb').spellcheck`), false);
      assert.strictEqual(await style('.cb-first', 'color'), await style('.fm', 'color'));
      assert.notStrictEqual(await style('.cb + .cb', 'color'), await style('.fm', 'color'));
      assert.ok(/mono|menlo/i.test(await style('.cb', 'fontFamily')));
      assert.ok(await js(`readText(${ed}) === editing.draft`));
      // an unclosed fence is code to the end
      await js(`document.execCommand('selectAll'); document.execCommand('insertText', false, 'x\\n\`\`\`\\ny')`);
      assert.deepStrictEqual(await js(`[...${ed}.children].map((l) => l.className)`), ['ln', 'ln cb cb-first', 'ln cb cb-last']);
      // ``` + ↩ closes the fence (one undo step); ↩ in a block keeps the line's indentation
      await js(`document.execCommand('selectAll'); document.execCommand('insertText', false, 'run:\\n\`\`\`sh')`);
      await key('Enter');
      assert.strictEqual(await draft(), 'run:\n```sh\n\n```');
      await type('  ls');
      await key('Enter');
      await type('pwd');
      assert.strictEqual(await draft(), 'run:\n```sh\n  ls\n  pwd\n```');
      await cmd('undo');
      await cmd('undo');
      await cmd('undo');
      await cmd('undo');
      assert.strictEqual(await draft(), 'run:\n```sh');
      assert.deepStrictEqual(await edit('enterEdit', '```js\n```', 5), ['```js\n\n```', { start: 6, end: 6 }]);
      assert.deepStrictEqual(await edit('enterEdit', '```\n  - x', 9), ['```\n  - x\n  ', { start: 12, end: 12 }]);
      await cmd('redo');
      await cmd('redo');
      await cmd('redo');
      await cmd('redo');
      await key('Enter', { metaKey: true });
      const sh = 'run:\n```sh\n  ls\n  pwd\n```';
      assert.ok((await until((d) => d.prompts.some((p) => p.text === sh))).prompts.some((p) => p.text === sh));
      // typing the closer by habit above the auto-inserted one steps over it: one closer, caret after the block
      await js('newPrompt()');
      await type('```js');
      await key('Enter');
      await type('x');
      await key('Enter');
      await type('```');
      await key('Enter');
      assert.strictEqual(await draft(), '```js\nx\n```\n');
      assert.strictEqual(await js(`selOf(${ed}).start`), 12);
      await type('after');
      assert.deepStrictEqual(await js(`[...${ed}.children].map((l) => l.className)`), ['ln cb cb-first', 'ln cb', 'ln cb cb-last', 'ln']);
      await cmd('undo');
      await cmd('undo');
      assert.strictEqual(await draft(), '```js\nx\n```\n```');
      await cmd('redo');
      await cmd('redo');
      await key('Enter', { metaKey: true });
      assert.ok(await until((d) => d.prompts.some((p) => p.text === '```js\nx\n```\nafter')));
      // ...but not over the opener of a following block
      assert.deepStrictEqual(await edit('enterEdit', '```\na\n```\n```\nb\n```', 9), ['```\na\n```\n\n```\nb\n```', { start: 10, end: 10 }]);
      assert.deepStrictEqual(await edit('enterEdit', '```\n```\n```\nb\n```', 7), ['```\n```\n\n```\nb\n```', { start: 8, end: 8 }]);
      // preview and editor agree: a ``` mid-line is not a fence, an indented one is
      const mid = '- item ```x``` here\n- next';
      assert.strictEqual(await js(`const d = document.createElement('div'); d.innerHTML = renderMarkdown(${JSON.stringify(mid)}); d.querySelectorAll('.codeblock').length + ',' + d.querySelectorAll('li').length`), '0,2');
      assert.strictEqual(await js(`const d = document.createElement('div'); d.innerHTML = decorate(${JSON.stringify(mid)}); d.querySelectorAll('.cb').length + ',' + d.querySelectorAll('.li').length`), '0,2');
      assert.strictEqual(await js(`const d = document.createElement('div'); d.innerHTML = renderMarkdown('x\\n  \`\`\`py\\n  a = 1\\n\`\`\`\\n\\ny');
        [d.firstChild.textContent, d.querySelector('.cb-head').textContent, d.querySelector('pre').textContent, d.lastChild.textContent].join('|')`), 'x|py|  a = 1|y');

      // app menu: Format sits after Edit, and no two items share an accelerator
      const items = (m) => m.items.flatMap((i) => [i, ...(i.submenu ? items(i.submenu) : [])]);
      const accs = items(Menu.getApplicationMenu()).map((i) => i.accelerator).filter(Boolean);
      assert.strictEqual(new Set(accs).size, accs.length, `duplicate accelerator: ${accs}`);
      assert.deepStrictEqual(Menu.getApplicationMenu().items.map((i) => i.label).slice(1, 4), ['File', 'Edit', 'Format']);

      // updates: version compare, asset pick, menu item (no network: the automatic check is off in dev runs)
      const { compare, pickAsset, assetUrl, dmgPath, auto } = require('../updater.js');
      assert.strictEqual(auto(win), false, 'the automatic update check must not run unpackaged');
      const dl = 'https://github.com/jaroslawfrydrych/prompt-manager/releases/download/v1.1.0/Prompt-Manager-1.1.0-arm64.dmg';
      assert.strictEqual(assetUrl({ browser_download_url: dl }), dl);
      for (const bad of [
        'https://github.com/jaroslawfrydrych/prompt-manager/releases/download/../../../evil/x/releases/download/a.dmg',
        'https://github.com/jaroslawfrydrych/prompt-manager/releases/download/%2e%2e/%2E%2e/%2e%2e/evil/a.dmg',
        'https://evil.example/jaroslawfrydrych/prompt-manager/releases/download/v1/a.dmg',
        'http://github.com/jaroslawfrydrych/prompt-manager/releases/download/v1/a.dmg',
        'https://github.com/someone/prompt-manager/releases/download/v1/a.dmg',
      ]) assert.throws(() => assetUrl({ browser_download_url: bad }), /Unexpected download location/, bad);
      assert.strictEqual(dmgPath('/t'), '/t/update.dmg');
      assert.ok(compare('1.1.0', '1.0.0') > 0 && compare('1.0.0', '1.1.0') < 0);
      assert.ok(compare('1.10.0', '1.9.9') > 0 && compare('v2.0.0', '1.99.99') > 0);
      assert.strictEqual(compare('v1.2.3', '1.2.3'), 0);
      assert.strictEqual(compare('1.3.0-beta.1', '1.2.0'), 0);
      const assets = [{ name: 'Prompt-Manager-1.1.0-x64.dmg' }, { name: 'Prompt-Manager-1.1.0-arm64.dmg' }, { name: 'notes.txt' }];
      assert.strictEqual(pickAsset(assets, 'arm64').name, 'Prompt-Manager-1.1.0-arm64.dmg');
      assert.strictEqual(pickAsset([{ name: 'notes.txt' }], 'arm64'), undefined);
      assert.deepStrictEqual(Menu.getApplicationMenu().items[0].submenu.items.slice(0, 2).map((i) => i.label), ['About Prompt Manager', 'Check for Updates…']);

      console.log('SMOKE OK');
      app.exit(0);
    } catch (err) {
      console.error('SMOKE FAIL', err);
      app.exit(1);
    }
  });
});
