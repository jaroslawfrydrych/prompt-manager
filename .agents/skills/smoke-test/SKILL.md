---
name: smoke-test
description: How the Prompt Manager end-to-end smoke test (scripts/smoke.js) works and how to extend it. Use when adding a check for new behaviour, when `npm run smoke` fails, or when CI's smoke step is red.
---

# Smoke test

`npm run smoke` runs `electron scripts/smoke.js`. It is the only test suite: it starts the real app
against a temporary data file and drives the real UI. CI runs it before building the DMG.

## How it works

1. Creates a temp dir, points `app.setPath('userData', dir)` at it and writes a seed `data.json`
   (projects `p1` "alpha", `p2` "beta"; prompt `a` in `p1` that is 5 days old with inline code and a code block,
   prompt `b` in `p2`).
2. `require('../main.js')` boots the real app.
3. On the window's `did-finish-load`, runs the checks in order. Each step builds on the state left by the previous one.
4. Prints `SMOKE OK` and exits `0`, or `SMOKE FAIL <error>` and exits `1`. Renderer `console` output is
   forwarded as `renderer: ...`.

## Helpers

- `js(code)` — `executeJavaScript` in the renderer. Code containing `;` is wrapped in a block, so
  multi-statement snippets work; the value of the last expression is returned. Renderer functions are globals,
  so you can call `newPrompt()`, `selectView('all')`, `promptAction(p, 'flag:red')` or read `state` directly.
- `read()` — parses the data file.
- `until(check)` — polls the data file (up to 5 s) until `check(data)` is true and returns that data; it throws
  on timeout (never returns stale data). Saves are debounced (300 ms) and timers in a background window are throttled, so **always assert on
  persisted data through `until`**, never right after an action.
- `poll(expr)` — the renderer-side `until`: evaluates `expr` with `js()` (up to 5 s) until it is truthy, throws on timeout.
  Use it to wait for the effect of real input (caret moved, editor opened, element focused).
- `wait(ms)` — only for things that are not persisted (DOM updates, clipboard).
- `dnd(src, dst, 'before' | 'after')` — defined in the renderer by the test; fires `dragstart`, `dragover`,
  `drop`, `dragend` at the top or bottom edge of the target.
- `nav(id)` / `card(id)` — selector strings for a sidebar item / prompt card.

## Writing a check

```js
// <what is being checked>
await js(`<drive the UI the way a user would>`);
assert.strictEqual(byId(await until((d) => byId(d, 'a').flag === 'blue'), 'a').flag, 'blue');
```

- Drive the UI through real events where possible: `.click()`, `dispatchEvent(new KeyboardEvent('keydown',
  { key, metaKey, bubbles: true }))`, and type into the editor with `document.execCommand('insertText', false, 'text')` (or set its `textContent`
  followed by an `input` event); read the result from `editing.draft`.
  `execCommand` fires no `beforeinput`, so undo cannot put the caret back where such an edit started; when a check
  asserts the caret after ⌘Z, type with `win.webContents.sendInputEvent({ type: 'char', keyCode: c })` instead.
  Undo history is per prompt for the whole run (`hists`), so reopening a prompt resumes it: undo counts assume that.
- Keys the browser handles itself (arrows, caret movement) need real input: `win.webContents.focus()`, then
  `win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })` (and `keyUp`). It bypasses the app menu,
  so menu accelerators (⌘Z, ⌘N) are tested by sending their command: `win.webContents.send('command', 'undo')`.
- `sendInputEvent` is async and not ordered with `js()` / `cmd()` (separate channels), so on a slow machine a later
  `js()` can run before the input landed. After real input, wait for its effect — persisted text via `until`, or DOM
  state via `poll` — before the next `js()` action; never a fixed `wait`. The app opens the editor in a `setTimeout(0)`
  after `mouseup`; to assert that a click did *not* open it, register your own `mouseup` listener first and `poll` for
  a flag it sets in a `setTimeout(0)` (it runs after the app's), then assert.
- Native menus and dialogs cannot be clicked from the renderer. Call the action they resolve to instead
  (e.g. `promptAction(p, 'move:p2')`), and do not add steps that open a `confirm` dialog — it would block the test.
- A double-click is `new MouseEvent('click', { bubbles: true, detail: 2 })`.
- Add the step before `console.log('SMOKE OK')`, and keep in mind later steps rely on earlier state
  (counts, order, which view is selected).

## Debugging failures

- The assertion message shows actual vs expected; `renderer:` lines show errors from the page.
- A step that times out in `until` usually means the action did not call `persist()`, or the selector
  matched nothing because `render()` rebuilt the DOM.
- Run it locally exactly like CI: `npm ci && npm run smoke`.
