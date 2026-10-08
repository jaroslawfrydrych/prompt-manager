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
- `updater.js` — main process. App menu ▸ Check for Updates… and a silent check 10 s after launch
  (packaged builds only, at most once per 24 h, stamp in `userData/update-check.json`, not `data.json`; only an
  up-to-date answer writes the stamp, so a pending update or a failed check is re-checked on the next launch). `net.fetch`es
  GitHub's `releases/latest`, compares `tag_name` with `compare()` (numeric x.y.z, prerelease never newer), picks the
  `-<arch>.dmg` asset (`pickAsset`). Install: download to temp (size checked), `hdiutil attach`, `codesign --verify`,
  bundle id + version from `Info.plist`, `ditto` next to the current bundle as `.<name>.app.update`, then a detached
  `/bin/sh` (`SWAP`, paths as positional args) waits for the pid to exit and swaps the bundles; `app.quit()` lets the
  renderer's `beforeunload` save first. Refuses (offers the release page) when unpackaged, translocated, on `/Volumes`
  or the folder or the bundle itself is not writable. The download URL must parse (`assetUrl`) to `https://github.com`
  + this repo's `/releases/download/` path; the DMG is saved under a fixed name (`dmgPath`). If the swap rolls back,
  `SWAP` writes `userData/update-failed`; the next launch deletes it and offers the release page, and also removes
  a stale `.<name>.app.update`. Progress shows as the dock progress bar and a percentage dock badge.
  A check that finds a newer version keeps it in `pending` and sends the `'update-available'` command to the renderer,
  which unhides the sidebar's `#update` button; nothing is downloaded until the click calls `installPending` through
  `window.api.update()`. The manual check still shows its dialog as well.
- `preload.js` — the only bridge. Exposes `window.api`:
  - `load()` → saved state or `null`
  - `save(state)` → **synchronous** (`sendSync`) so a save from `beforeunload` completes
  - `copy(text)` → clipboard
  - `confirm(message, detail, okLabel)` → native warning dialog, resolves `true` on OK
  - `menu(items)` → native popup menu, resolves the clicked item's `id` (or index), `-1` when dismissed
  - `update()` → installs the update a check already found (the sidebar button)
  - `onCommand(fn)` → commands sent from the app menu (`'new-prompt'`, `'new-project'`, `'search'`, `'undo'`, `'redo'`, `'bold'`, `'italic'`, `'underline'`) and `'update-available'` from `updater.js`
- `renderer.js` — the entire UI in one file, sectioned with `// ---------- name ----------` comments.

New IPC: add `ipcMain.handle` in `main.js`, expose it in `preload.js`, call `window.api.x()` in the renderer.
Never enable `nodeIntegration` or pass Node objects to the renderer.

## Security (do not weaken)

- Every `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `lockDown(win)`
  (blocks navigation, opens only `https://github.com/` links externally).
- Every HTML file has a CSP meta tag with `default-src 'self'`; no inline scripts or styles, no remote assets.
- The app makes no network requests except `updater.js`: `api.github.com` for the latest release and GitHub release
  downloads (`github.com`, which redirects to `objects.githubusercontent.com` / `release-assets.githubusercontent.com`),
  for updates only. Prompts never leave the Mac; do not add other network use.

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

- UI-only state lives in module variables, not in `state`: `editing` (`{ id, draft, orig, isNew, caret, hist }`; every edit is saved to the prompt as you type via `saveDraft`, `orig` is what Esc restores),
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
- Editable fields (any input/textarea/contenteditable) get the native edit + spelling menu from the
  `context-menu` handler in `main.js`; renderer menus must `preventDefault()` the `contextmenu` event to replace it.
- Context menu entries go into `promptMenu` / `projectMenu` with ids like `'flag:red'`, `'move:<projectId>'`
  and are executed by `promptAction(p, id)`. Menu item shape (see `menuTemplate` in `main.js`):
  `'-'` separator, a plain string (resolves to its index), or
  `{ id, label, checked, enabled, icon: '#hex', submenu: [...] }`.
- Destructive actions go through `window.api.confirm(...)`.
- Keyboard: app-level shortcuts are menu accelerators in `main.js` that send a command handled in
  `window.api.onCommand`; `⌘0`–`⌘9` live in the `document` keydown handler; editor keys in `editorKeys`.
  Document new shortcuts in the README table.

## Markdown and the editor

`renderMarkdown` supports fenced ```` ``` ```` blocks (rendered as the code content only, no header, label or copy button; a fence is a line
starting with ```` ``` ```` after optional spaces with no backtick after it, the `FENCE` rule that `decorate`, `inFence`, `renumber` and
`fmtRuns` use too, so a ```` ``` ```` mid-line is never a block, and an unclosed fence runs to the end),
`` `inline code` `` (`CODE`: any backtick run closed by an equal one, so ```` ```x``` ```` alone on a line is inline code), `-` / `*` / `1.` / `1)` lists nested by indentation (2 spaces per level), and `**bold**`,
`*italic*` / `_italic_` and `<u>underline</u>` (`inline(text, keep)` → `emphasis`). Keep it small; prompts are pasted
into agents as plain text, and every copy (Copy, ⌘C / ⌘X in the editor) is the raw markdown, fences and backticks
included. Emphasis runs on **escaped** text (so `<u>` is only the literal tag pair, never other HTML),
never crosses a line, skips inline code and fences and lines over 2000 chars, and `*` / `_` only count at word
edges (an opener never follows a digit, `/` or `.`, nor a letter for `_`, and a `*` opener follows a letter only
when a letter or digit comes next, so `README*, LICENSE*` stays plain; a closer is never followed by a letter or
digit, and a closing `*` never follows `/` nor precedes `.ext`, so snake_case, `src/*.js`, `*.md, docs/*.md` and
`2*3*4` stay plain while `plain**bold**` renders). Each pass swaps its markers for private-use placeholders and
keeps a match only if it nests cleanly with earlier ones; with `keep` (the editor) the markers stay in the text as
dimmed `.fm` spans next to the `<strong>` / `<em>` / `<u>`.

The editor is a `contenteditable="plaintext-only"` div that shows the markdown **source**, one `<div class="ln">` per
line, decorated by `decorate(src)` (escaped text in spans). Its text (`readText(ed)`) always equals `editing.draft`;
the stored format stays a plain markdown string. On `input` the changed lines are re-decorated (`paint`) and the
selection is restored by plain-text offset (`selOf` / `setSel`); nothing is touched during IME composition.
Rewriting the DOM breaks native undo, so the editor keeps its own stack in `editing.hist` (capped at 200 steps).
Edit ▸ Undo / Redo (⌘Z / ⇧⌘Z) are therefore not native roles: they send the `'undo'` / `'redo'` command, which
runs `undoRedo` in the editor and `document.execCommand` in any other field. Edits made by key handling (Enter, Tab,
paste, cut) go through `applyEdit` as pure `(text, selection) → [text, selection]` functions such as `enterEdit` and
`tabEdit` (and `backEdit`: Backspace after a marker outdents / removes it); list edits end with `renumber`, which
keeps numbered siblings consecutive and never touches lines inside a ```` ``` ```` fence. Format ▸ Bold / Italic /
Underline (⌘B / ⌘I / ⌘U) send `'bold'` / `'italic'` / `'underline'`, which run `fmtEdit` through `applyEdit`: each
selected line is a part (past the list marker, edge whitespace trimmed, never in code); `emRuns(line)` maps the
renderer's runs to raw offsets, and when every part sits in a run of that kind (looking past other kinds' markers
that enclose it, so ⌘A ⌘B on `<u>**x**</u>` unbolds) the runs are split around it, else
the other parts are wrapped (a caret inside a word toggles the word; a caret against a run's marker steps across it
instead of nesting an empty pair; an italic wrap whose `*` would merge into a neighbouring `*` uses `_`, so the `_`
pass runs before the `*` passes). Native edits (`sync`) and paste / cut (`replaceSel`) go through `relist`, which
renumbers only when the edit changed the line count, so a retyped number sticks. Code is decorated too: inline
code via `inline(text, true)` is a `<code spellcheck="false">` whose `.fm` backticks sit inside the pill and are
transparent, and every line of a fenced block (fences included) is a `.ln.cb` div with `spellcheck="false"`, never
list or emphasis decorated; fence lines also get `.fence` (their ``` ``` ``` is transparent, the closer is drawn as the
block's bottom bar); `.cb-first` is the opener (drawn as the block's top bar; the preview's `.codeblock` has no header, only the code), `.cb-last` the closer or, while unclosed, the
last line, so the lines together look like the preview's `.codeblock`. In a block `enterEdit` keeps the line's
indentation (not on ⇧↩), and ↩ at the end of an opener nothing closes yet inserts the closing fence (one undo
step); ↩ after a typed closer directly above another bare closer steps over it (the duplicate goes, caret on the
line after) unless that bare line opens a following block. List lines hang after their marker: the marker is plain
inline monospace text (never `inline-block`, which breaks ↑/↓ columns) and the line gets
a `.w<n>` class (marker length) that sets `padding-left` and a negative `text-indent`. The line also carries
`ul`/`ol` and `l<n>` (nesting level) so CSS draws the preview's bullet (disc, circle, square) over the
transparent `-` / `*` with a zero-width `::before`, leaving the text raw markdown.

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
