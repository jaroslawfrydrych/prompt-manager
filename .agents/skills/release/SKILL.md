---
name: release
description: How to cut a Prompt Manager release (version bump, matching git tag, CI build of the DMG, GitHub Release) and how the DMG is packaged. Use when the user asks to release, publish, bump the version, tag, or build the DMG.
---

# Releasing Prompt Manager

## Rules

- The version lives only in `package.json` (`version`). The About window and the DMG name read it from there.
- A release is triggered by pushing a tag `v<version>`. The CI job in `.github/workflows/build.yml`
  fails if the tag does not equal `v` + `package.json` version.
- Pushing a tag is outward-facing and creates a public GitHub Release: confirm with the user before pushing.
- The in-app updater (`updater.js`) depends on this contract: the release is GitHub's `releases/latest` (not a draft or
  prerelease), its tag is `v<x.y.z>` (numbers only), and it has an asset ending in `-arm64.dmg` whose root holds
  `Prompt Manager.app` with bundle id `com.jaroslawfrydrych.promptmanager` and that version. Renaming the DMG or app
  breaks updates for everyone already installed.
- Pick the bump with semver: `patch` for fixes, `minor` for new features, `major` for breaking changes
  (e.g. a data format older versions cannot read).

## Steps

1. Working tree clean, on `master`, up to date with `origin/master`, last CI run green.
2. `npm run smoke` passes locally.
3. Bump, commit and tag in one go (edits `package.json` and `package-lock.json`):

   ```bash
   npm version <patch|minor|major>
   ```

4. After the user confirms, push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

5. Watch the run: `gh run watch` (or `gh run list --workflow build.yml`). On success the release is at
   `https://github.com/jaroslawfrydrych/prompt-manager/releases/tag/v<version>` with
   `Prompt-Manager-<version>-arm64.dmg` and notes generated from merged pull requests and commits.

If the job failed on the version check, the tag and `package.json` disagree: delete the tag
(`git tag -d v<version>` and, after confirming with the user, `git push origin :refs/tags/v<version>`),
fix the version and tag again.

## How the DMG is built

`npm run dmg` = `npm run dist` + `scripts/dmg.sh`, macOS only.

- `dist` runs `@electron/packager` for `darwin` on the host architecture (CI uses an Apple Silicon runner, so arm64).
  Its `--ignore` list keeps dev files (`scripts`, `docs`, `.github`, `.agents`, `.claude`, README, CONTRIBUTING,
  `assets/icon.icns`…) out of the `.app`. Add new non-app top-level files there.
- `dmg.sh` ad-hoc signs the app (`codesign --sign -`; Apple Silicon refuses unsigned code), stages it next to an
  `Applications` symlink and creates a compressed DMG with `hdiutil`. No third-party tools.
- The app is not notarized, so Gatekeeper asks the user to confirm the first launch (README, Install section).

Every push to `master` and every pull request also builds the DMG and uploads it as the `Prompt-Manager-dmg`
workflow artifact, which is the way to test a build before releasing.
