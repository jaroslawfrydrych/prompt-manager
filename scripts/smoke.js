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

      console.log('SMOKE OK');
      app.exit(0);
    } catch (err) {
      console.error('SMOKE FAIL', err);
      app.exit(1);
    }
  });
});
