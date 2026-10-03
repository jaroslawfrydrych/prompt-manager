# Contributing to Prompt Manager

Thanks for helping out! Prompt Manager is a small app on purpose, so the bar for a change is
"does it make the queue of prompts easier to use" rather than "is it a nice feature".
For anything larger than a fix, open an issue first so we can agree on the idea.

## Setup

You need macOS (Apple Silicon to match the released build) and Node.js 22 (the version CI uses).

```bash
git clone https://github.com/jaroslawfrydrych/prompt-manager.git
cd prompt-manager
npm install
npm start
```

`npm start` runs the app against your real data file
(`~/Library/Application Support/Prompt Manager/data.json`). Back it up if you are about to change how data is saved.

## Project layout

| File | Role |
|---|---|
| `main.js` | Main process: window, app menu, native context menus, dialogs, loading and saving `data.json` |
| `preload.js` | The only bridge between the two: exposes `window.api` (`load`, `save`, `copy`, `confirm`, `menu`, `onCommand`) |
| `renderer.js` | The whole UI: state, rendering, actions, drag & drop, keyboard shortcuts |
| `index.html`, `styles.css` | Main window markup and styles (light and dark via CSS variables) |
| `about.html`, `about.js` | About window |
| `scripts/smoke.js` | End-to-end smoke test that drives the real UI |
| `scripts/dmg.sh` | Wraps the packaged app in a DMG |

## Code conventions

- **No frameworks, no runtime dependencies.** Plain Electron with vanilla HTML, CSS and JS.
  Use a platform feature (Electron API, DOM, CSS) before writing code, and write code before adding a package.
- **Keep the security model.** `contextIsolation`, `sandbox` and no `nodeIntegration` in every window, a strict CSP
  in every HTML file, no navigation away from the app, external links limited to GitHub. The renderer reaches the
  system only through `window.api` in `preload.js`.
- **Local only.** The app makes no network requests.
- **Native feel.** Follow macOS conventions (Mail, Reminders, Finder). Use native menus and dialogs
  through `window.api.menu` and `window.api.confirm` instead of HTML imitations.
- **Data safety.** Saves are atomic. A change to the shape of `data.json` bumps `state.version` and adds
  a migration for older files, so nobody loses their prompts on update.
- Match the existing style: 2-space indent, single quotes, semicolons, short comments that explain *why*.

## Testing

```bash
npm run smoke
```

The smoke test starts the real app against a temporary data file and prints `SMOKE OK` on success.
Add a check to `scripts/smoke.js` for every new behaviour, and also try the change by hand with `npm start`,
in both light and dark appearance.

## Pull requests

1. Branch off `master`.
2. Keep the change focused; one feature or fix per pull request.
3. Run `npm run smoke`.
4. Update `README.md` if you change something users see (features, shortcuts).
5. Open the pull request. CI runs the smoke test and builds the DMG, which you can download from the run's artifacts.

## Working with AI agents

The project is developed with AI coding agents, and its conventions are written down as agent skills in
[`.agents/skills/`](.agents/skills). `.claude/skills` is a symlink to the same directory, so Claude Code picks them up
automatically, and other agents can read the `SKILL.md` files directly:

| Skill | Use it when |
|---|---|
| [`app-architecture`](.agents/skills/app-architecture/SKILL.md) | Changing or adding app behaviour, UI, data or IPC |
| [`smoke-test`](.agents/skills/smoke-test/SKILL.md) | Adding or debugging checks in `scripts/smoke.js` |
| [`release`](.agents/skills/release/SKILL.md) | Bumping the version and publishing a release |

When a change introduces a new convention, update the matching skill in the same pull request.

## Releasing (maintainers)

Releases are built by CI from a `v<version>` tag. The tag must equal the `version` in `package.json`,
otherwise the release job fails.

1. Make sure `master` is green and up to date.
2. Bump the version (the working tree must be clean); this edits `package.json` and `package-lock.json`, commits and creates the matching tag:

   ```bash
   npm version <patch|minor|major>
   ```

3. Push the commit together with the tag:

   ```bash
   git push --follow-tags
   ```

CI then builds `Prompt-Manager-<version>-arm64.dmg` and publishes it as a GitHub Release with generated notes.
The app is ad-hoc signed but not notarized, so the first launch has to be allowed as described in the README.
