---
name: app-architecture
description: How Prompt Manager is built (Electron main/preload/renderer split, state shape in data.json, render and persist cycle, data-act event delegation, native menus, security rules, styling tokens). Use before changing or adding any app behaviour, UI, data field, keyboard shortcut or IPC call.
---

# Prompt Manager architecture

Plain Electron, vanilla HTML/CSS/JS, zero runtime dependencies. Keep it that way: reach for an Electron API,
DOM or CSS feature before writing code, and never add a package for something a few lines can do.

## Processes

- `main.js` — main process. Owns `data.json` (`load`, atomic `save` via `.tmp` + `rename`, unreadable files are
  copied to `data.json.corrupt-<ts>` instead of being overwritten), the app menu, native context menus, dialogs,
  the About window and single-instance lock.
- `preload.js` — the only bridge. Exposes `window.api`:
  - `load()` → saved state or `null`
  - `save(state)` → **synchronous** (`sendSync`) so a save from `beforeunload` completes
  - `copy(text)` → clipboard
  - `confirm(message, detail, okLabel)` → native warning dialog, resolves `true` on OK
  - `menu(items)` → native popup menu, resolves the clicked item's `id` (or index), `-1` when dismissed
  - `onCommand(fn)` → commands sent from the app menu (`'new-prompt'`, `'new-project'`, `'search'`)
- `renderer.js` — the entire UI in one file, sectioned with `// ---------- name ----------` comments.

New IPC: add `ipcMain.handle` in `main.js`, expose it in `preload.js`, call `window.api.x()` in the renderer.
Never enable `nodeIntegration` or pass Node objects to the renderer.

## Security (do not weaken)

- Every `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `lockDown(win)`
  (blocks navigation, opens only `https://github.com/` links externally).
- Every HTML file has a CSP meta tag with `default-src 'self'`; no inline scripts or styles, no remote assets.
- The app makes no network requests.

## State (`data.json`)

```js
state = {
  version: 2,                 // bump + migrate in the load IIFE at the bottom of renderer.js
  projects: [{ id, name, createdAt }],               // array order = sidebar order
  prompts: [{ id, projectId, text, createdAt, doneAt /* ts | null */, flag /* 'red'…'gray' | null */ }],
                              // array order = manual order of pending prompts
  view: 'all' | 'flagged' | <projectId>,
  tab: 'pending' | 'done',
  lastProject,                // where ⌘N lands when the view is All/Flagged
}
```

- UI-only state lives in module variables, not in `state`: `editing` (`{ id, draft, isNew, caret }`),
  `renaming` (project id), `query`.
- IDs come from `uid()`. Timestamps are `Date.now()` numbers.
- Changing the shape: increment `version`, migrate older files in the load IIFE (see the v1 → v2 sort),
  and keep reading files written by older versions.

## Render and persist cycle

1. Mutate `state` directly.
2. Call `persist()` (300 ms debounce → `flush()` → `window.api.save(state)`).
3. Call `render()`, which rebuilds sidebar, header and list with `innerHTML` template strings.

Rules that follow from the full rebuild:
- Escape every user string with `esc()` before it goes into HTML.
- Attach listeners by **delegation** on `#nav` / `#list` / `document`, not on rendered nodes.
- Before switching view/tab or starting another edit, call `commitEdit(false)` so a draft is not lost.
- A native `dblclick` never reaches a rebuilt node; detect double-click with `e.detail === 2` in the `click` handler.
- Things that must not re-render (an open editor) are updated in place, like the 60 s `ago()` label refresh.

## Adding UI actions

- Card and empty-state buttons carry `data-act="name"`; handle them in the `#list` click handler.
- Context menu entries go into `promptMenu` / `projectMenu` with ids like `'flag:red'`, `'move:<projectId>'`
  and are executed by `promptAction(p, id)`. Menu item shape (see `menuTemplate` in `main.js`):
  `'-'` separator, a plain string (resolves to its index), or
  `{ id, label, checked, enabled, icon: '#hex', submenu: [...] }`.
- Destructive actions go through `window.api.confirm(...)`.
- Keyboard: app-level shortcuts are menu accelerators in `main.js` that send a command handled in
  `window.api.onCommand`; `⌘0`–`⌘9` live in the `document` keydown handler; editor keys in `editorKeys`.
  Document new shortcuts in the README table.

## Markdown

`renderMarkdown` supports only fenced ```` ``` ```` blocks (with a language label and a copy button) and
`` `inline code` ``. Keep it that small; prompts are pasted into agents as plain text.

## Styling

- `styles.css` defines colour tokens on `:root` (dark values) and overrides them in
  `@media (prefers-color-scheme: light)`. Use tokens (`--text`, `--card`, `--fill-1`, `--accent`, `--warn`…),
  never hard-coded colours in rules.
- Flag colours exist twice: `FLAG_HEX` in `renderer.js` (used for native menu dots) and `--red`…`--gray`
  in `styles.css`. Change both.
- Follow macOS look: system font, `vibrancy: 'sidebar'`, hidden-inset title bar, `.drag` / `.no-drag` regions.

## Before you finish

- `npm run smoke` passes and covers the new behaviour (see the `smoke-test` skill).
- Check the change by hand with `npm start` in light and dark appearance.
- New top-level files that are not part of the app must be added to the `--ignore` list of the `dist`
  script in `package.json`, otherwise they ship inside the `.app`.
- Update `README.md` for user-visible changes.
