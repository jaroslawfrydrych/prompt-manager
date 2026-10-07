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
      await js(`const t = document.querySelector('textarea'); t.value = 'edited'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const byId = (d, id) => d.prompts.find((p) => p.id === id);
      assert.strictEqual(byId(await until((d) => byId(d, 'a').text === 'edited'), 'a').text, 'edited');

      // ⌘N new prompt lands in current project
      await js(`newPrompt(); const t = document.querySelector('textarea'); t.value = 'brand new'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const created = (await until((d) => d.prompts.some((p) => p.text === 'brand new'))).prompts.find((p) => p.text === 'brand new');
      assert.ok(created && created.projectId === 'p1');
      assert.strictEqual(await js(`document.querySelector('.nav-item[data-view=p1] .badge').textContent`), '2');

      // ⌘N then Esc leaves nothing behind
      await js(`newPrompt(); document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(1500);
      assert.strictEqual(read().prompts.length, 3);

      // a single ⌘N while editing saves the edit and opens one focused new editor
      await js(`document.querySelector('.card[data-id=a] .body').click()`);
      await wait(100);
      await js(`const t = document.querySelector('textarea'); t.value = 'saved by cmd-n'; t.dispatchEvent(new Event('input'))`);
      win.webContents.send('command', 'new-prompt');
      await wait(300);
      assert.strictEqual(await js(`document.querySelectorAll('textarea.editor').length`), 1);
      assert.ok(await js(`document.activeElement === document.querySelector('textarea.editor')`));
      assert.ok(await js(`editing && editing.isNew`));
      assert.strictEqual(byId(await until((d) => byId(d, 'a').text === 'saved by cmd-n'), 'a').text, 'saved by cmd-n');
      await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
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
      await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

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
      await js(`document.querySelector('[data-act=new-prompt]').click(); const t = document.querySelector('textarea'); t.value = 'urgent'; t.dispatchEvent(new Event('input'));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))`);
      const urgent = (await until((d) => d.prompts.some((p) => p.text === 'urgent'))).prompts.find((p) => p.text === 'urgent');
      assert.ok(urgent.flag);
      assert.strictEqual(await js(`document.querySelectorAll('.card').length`), 1);

      // rename via double-click on a project
      await js(`${nav('p1')}.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))`);
      await js(`const i = document.querySelector('.rename'); i.value = 'renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      assert.strictEqual((await until((d) => d.projects[1].name === 'renamed')).projects[1].name, 'renamed');

      console.log('SMOKE OK');
      app.exit(0);
    } catch (err) {
      console.error('SMOKE FAIL', err);
      app.exit(1);
    }
  });
});
