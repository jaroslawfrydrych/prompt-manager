<p align="center">
  <img src="assets/icon.png" width="160" alt="Prompt Manager icon">
</p>

<h1 align="center">Prompt Manager</h1>

<p align="center">
  A native-feeling macOS app for the prompts you write while your AI agent is still working.
</p>

<p align="center">
  <a href="https://github.com/jaroslawfrydrych/prompt-manager/releases/latest"><img src="https://img.shields.io/github/v/release/jaroslawfrydrych/prompt-manager" alt="Latest release"></a>
  <a href="https://github.com/jaroslawfrydrych/prompt-manager/actions/workflows/build.yml"><img src="https://github.com/jaroslawfrydrych/prompt-manager/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/jaroslawfrydrych/prompt-manager/releases"><img src="https://img.shields.io/github/downloads/jaroslawfrydrych/prompt-manager/total" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple" alt="macOS, Apple Silicon">
  <img src="https://img.shields.io/github/package-json/dependency-version/jaroslawfrydrych/prompt-manager/dev/electron?logo=electron" alt="Electron">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jaroslawfrydrych/prompt-manager" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/screenshot-dark.png" width="820" alt="Prompt Manager in dark mode">
</p>

## What it is

When you work with AI coding agents (Claude Code, OpenCode, Codex…) or spec-driven workflows, you usually write the next prompt
while the agent is still busy with the current one: a piece of feedback, the next feature, a fix you just noticed.
Prompt Manager is where those prompts wait their turn.

- **One queue per project.** A Mail-style sidebar lists your projects, each with its pending count.
  **All** shows prompts from every project, **Flagged** only the flagged ones.
- **Prompts are plain text.** Click a prompt to edit it, `⌘↩` to save. Spelling is checked as you type; right-click a word for suggestions. Fenced ```` ``` ```` code blocks, `` `inline code` `` and `-` / `1.` lists are rendered,
  and every code block has its own copy button (a fence must start a line: ```` ``` ```` mid-line is not a code block). Code shows as code while you type too: in a block `↩` keeps the line's indentation,
  and ```` ``` ```` + `↩` adds the closing fence. `**bold**`, `*italic*` and `<u>underline</u>` show formatted as you type
  (the markers stay visible, dimmed); `⌘B` / `⌘I` / `⌘U` toggle them on the selection. Lists are formatted live while you type: `↩` continues a list
  (on an empty item it moves it up a level, or ends the list) and `⇥` / `⇧⇥` nest an item; numbers stay in sequence.
- **Copy, paste, done.** One click copies the whole prompt, ready to paste into your agent (code backticks and fences are left out). `⌥`-click also marks it as done.
  Done prompts move to a **Done** tab, where you can restore them.
- **See what's getting old.** Every prompt shows when it was written. Pending prompts older than 3 days get an orange badge,
  because they may be outdated.
- **Finder-style flags.** Right-click a prompt (or use its `…` button) to give it a red, orange, yellow, green, blue, purple or gray flag.
- **Drag & drop.** Reorder projects and prompts. To move a prompt to another project, drop it on that project
  or, in **All** and **Flagged**, click the project name on the card.
- **Light & dark.** Follows the system appearance.
- **Local only.** Everything is stored in one JSON file on your Mac. The only network requests are update checks
  to GitHub (once a day after launch, or **Prompt Manager ▸ Check for Updates…**).
- **Updates in place.** When a new release is out, an **Update available** button appears at the bottom of the sidebar;
  clicking it downloads the release, verifies it and replaces the app. Nothing is downloaded before that click.
  This needs the app in a folder you can write to (like **Applications**), not running from the disk image.

## Install

Download the latest `Prompt-Manager-<version>-arm64.dmg` from
[Releases](https://github.com/jaroslawfrydrych/prompt-manager/releases) and drag the app to **Applications**.
The build is for Apple Silicon.

The app is not notarized by Apple, so macOS will block the first launch. To open it anyway:

- go to **System Settings → Privacy & Security** and click **Open Anyway**, or
- run `xattr -dr com.apple.quarantine "/Applications/Prompt Manager.app"`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New prompt |
| `⇧⌘N` | New project |
| `⌘1`–`⌘9` / `⌘0` | Jump to project / All |
| `⌘F` | Search |
| `⌘↩` / `Esc` | Save / cancel editing |
| `⇥` / `⇧⇥` | Indent / outdent a list item while editing |
| `⌘B` / `⌘I` / `⌘U` | Bold / italic / underline the selection while editing |
| `⌥`-click **Copy** | Copy and mark as done |

Double-click a project to rename it, right-click it to rename or delete it. Right-click a prompt (or click `…`) to flag, move or delete it.

## Development

```bash
npm install
npm start          # run the app
npm run smoke      # UI smoke test against a temporary data file
npm run dmg        # build dist/Prompt-Manager-<version>-arm64.dmg (macOS only)
```

Plain Electron with vanilla HTML/CSS/JS, no frameworks and no runtime dependencies. Data is stored in
`~/Library/Application Support/Prompt Manager/data.json`, and every save is written atomically.

GitHub Actions runs the smoke test and builds the DMG on every push to `master` and on every pull request;
the DMG is available as a workflow artifact. Pushing a version tag publishes a GitHub Release.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, code conventions and the release process.

## License

[MIT](LICENSE) © 2026 Jarosław Frydrych

## Author

Made by [Jarosław Frydrych](https://github.com/jaroslawfrydrych), built with the help of
[Claude Code](https://claude.com/claude-code) (AI-assisted development).
