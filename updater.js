// In-app update from GitHub Releases. The app is only ad-hoc signed, so Squirrel/autoUpdater cannot be used;
// instead the release DMG is downloaded, verified and its bundle swapped in by a small shell script after quit.
const { app, net, dialog, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const fs = require('fs');

const API = 'https://api.github.com/repos/jaroslawfrydrych/prompt-manager/releases/latest';
const DOWNLOADS = '/jaroslawfrydrych/prompt-manager/releases/download/';
const RELEASES = 'https://github.com/jaroslawfrydrych/prompt-manager/releases/latest';
const BUNDLE_ID = 'com.jaroslawfrydrych.promptmanager';
const DAY = 24 * 3600 * 1000;
const run = promisify(execFile);

// Numeric major.minor.patch only (optional 'v'); anything else (prerelease, garbage) is null and never "newer".
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m && m.slice(1).map(Number);
}
// >0 when a is newer than b, 0 when equal or unparsable.
function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
const pickAsset = (assets, arch) => (assets || []).find((a) => a.name.endsWith(`-${arch}.dmg`));
// The asset's download URL, or a throw unless it is this repo's release download. Parsing resolves `..` and `%2e%2e`.
function assetUrl(asset) {
  const u = new URL(asset.browser_download_url);
  if (u.origin !== 'https://github.com' || !u.pathname.startsWith(DOWNLOADS)) throw new Error('Unexpected download location.');
  return u.href;
}
// Fixed name: the API-provided asset name never becomes a path.
const dmgPath = (tmp) => path.join(tmp, 'update.dmg');

// Waits for the app ($1 = pid) to exit, then swaps $3 into $2, keeping the old bundle in $4 until the new one is
// in place. On failure the old app stays and the marker file $5 tells the next launch. Paths come in as positional
// args, so spaces never meet the shell's word splitting.
const SWAP = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if mv "$2" "$4/old.app"; then
  if mv "$3" "$2"; then xattr -dr com.apple.quarantine "$2"; else mv "$4/old.app" "$2"; : > "$5"; fi
else
  : > "$5"
fi
open "$2"
# Never delete the only copy: clean up only once a bundle is back in place.
if [ -d "$2" ]; then rm -rf "$4" "$3"; fi
`;

let busy = false;

const parent = (win) => (win && !win.isDestroyed() ? win : undefined);
const box = (win, opts) => (parent(win) ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const openPage = (url) => shell.openExternal(url && url.startsWith('https://github.com/') ? url : RELEASES);

async function offerPage(win, message, detail, url) {
  const { response } = await box(win, {
    type: 'warning', message, detail, buttons: ['Open Release Page', 'Cancel'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) openPage(url);
}

async function latest() {
  const res = await net.fetch(API, {
    headers: { 'User-Agent': `Prompt-Manager/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
}

// The bundle this process runs from: .../Prompt Manager.app/Contents/MacOS/Prompt Manager.
const currentBundle = () => path.resolve(app.getPath('exe'), '../../..');
// Not ending in .app, so Launch Services does not pick up the staged copy before the swap.
const stagedFor = (bundle) => path.join(path.dirname(bundle), `.${path.basename(bundle)}.update`);
const failedFile = () => path.join(app.getPath('userData'), 'update-failed');

// Why an install in place is impossible, or null when it can go ahead.
function cannotInstall(bundle) {
  if (!app.isPackaged) return 'This is a development run (npm start); updates install only into a packaged app.';
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
    return 'The app runs from the disk image or a quarantined location. Move it to the Applications folder first.';
  }
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch {
    return `There is no permission to replace the app in ${path.dirname(bundle)}.`;
  }
  // Moving a folder to another parent also needs write permission on the folder itself (e.g. a root-owned app).
  try { fs.accessSync(bundle, fs.constants.W_OK); } catch {
    return `There is no permission to replace ${bundle}.`;
  }
  return null;
}

// Dock progress bar plus a percentage badge, so it is obvious a download is running; null clears both.
function progress(win, fraction) {
  if (parent(win)) win.setProgressBar(fraction === null ? -1 : fraction);
  if (app.dock) app.dock.setBadge(fraction === null ? '' : `${Math.floor(fraction * 100)}%`);
}

async function download(win, asset, file) {
  const res = await net.fetch(assetUrl(asset), { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const length = Number(res.headers.get('content-length'));
  if (length && length !== asset.size) throw new Error('The download has an unexpected size.');
  let got = 0, pct = -1;
  progress(win, 0);
  // pipeline closes the file and rethrows on any error (disk full, abort, oversize).
  await pipeline(Readable.fromWeb(res.body), async function* (src) {
    for await (const chunk of src) {
      got += chunk.length;
      if (got > asset.size) throw new Error('The download is larger than expected.');
      const now = Math.floor((got / asset.size) * 100);
      if (now !== pct) { pct = now; progress(win, got / asset.size); }
      yield chunk;
    }
  }, fs.createWriteStream(file));
  if (got !== asset.size) throw new Error('The download is incomplete.');
}

const plist = async (bundle, key) => (await run('plutil', ['-extract', key, 'raw', '-o', '-',
  path.join(bundle, 'Contents/Info.plist')])).stdout.trim();

async function install(win, rel, version) {
  const bundle = currentBundle();
  const why = cannotInstall(bundle);
  if (why) return offerPage(win, 'The update cannot be installed automatically.', why, rel.html_url);
  const asset = pickAsset(rel.assets, process.arch);
  if (!asset) return offerPage(win, 'The release has no download for this Mac.', '', rel.html_url);

  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'pm-update-'));
  const dmg = dmgPath(tmp);
  const mnt = path.join(tmp, 'mnt');
  const staged = stagedFor(bundle);
  let mounted = false, ok = false;
  try {
    await download(win, asset, dmg);
    fs.mkdirSync(mnt);
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]);
    mounted = true;
    const src = path.join(mnt, 'Prompt Manager.app');
    // The ad-hoc signature cannot prove who built it, but it does catch a damaged or tampered bundle.
    await run('codesign', ['--verify', '--deep', '--strict', src]);
    if (await plist(src, 'CFBundleIdentifier') !== BUNDLE_ID) throw new Error('The downloaded app is not Prompt Manager.');
    if (await plist(src, 'CFBundleShortVersionString') !== version) throw new Error('The downloaded app has the wrong version.');
    rm(staged);
    await run('ditto', [src, staged]);
    ok = true;
  } finally {
    // Detach before any cleanup: the mount point lives inside tmp.
    if (mounted) await run('hdiutil', ['detach', mnt]).catch(() => run('hdiutil', ['detach', '-force', mnt])).catch(() => {});
    progress(win, null);
    if (!ok) { rm(staged); rm(tmp); }
  }
  rm(dmg);
  // Quitting closes the window, whose beforeunload commits the open edit and saves synchronously;
  // the script only touches the bundle once this process is gone.
  spawn('/bin/sh', ['-c', SWAP, 'sh', String(process.pid), bundle, staged, tmp, failedFile()], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// silent: only speak up when there is an update (the automatic check).
async function check(win, { silent = false } = {}) {
  if (busy) {
    if (!silent) await box(win, { type: 'info', message: 'An update check or installation is already in progress.' });
    return;
  }
  busy = true;
  let rel;
  try {
    rel = await latest();
    try { fs.writeFileSync(stampFile(), JSON.stringify({ lastCheck: Date.now() })); } catch {}
    const version = String(rel.tag_name).replace(/^v/, '');
    if (rel.draft || rel.prerelease || compare(version, app.getVersion()) <= 0) {
      if (!silent) await box(win, { type: 'info', message: 'You’re up to date.', detail: `Prompt Manager ${app.getVersion()} is the latest version.` });
      return;
    }
    const notes = String(rel.body || '').trim();
    const { response } = await box(win, {
      type: 'info',
      message: `Prompt Manager ${version} is available (you have ${app.getVersion()}).`,
      detail: notes.length > 600 ? `${notes.slice(0, 600)}…` : notes,
      buttons: ['Install and Relaunch', 'Release Notes', 'Later'], defaultId: 0, cancelId: 2,
    });
    if (response === 1) openPage(rel.html_url);
    if (response === 0) await install(win, rel, version);
  } catch (e) {
    if (!silent || rel) await offerPage(win, rel ? 'The update could not be installed.' : 'Could not check for updates.', e.message, rel && rel.html_url);
  } finally {
    busy = false;
  }
}

const stampFile = () => path.join(app.getPath('userData'), 'update-check.json');

// Launch housekeeping and a silent check a little after launch, at most once a day; never in development runs
// (and so never in the smoke test). Returns whether a check was scheduled.
function auto(win) {
  if (!app.isPackaged) return false;
  rm(stagedFor(currentBundle())); // left behind by a quit in the middle of an install
  if (fs.existsSync(failedFile())) {
    rm(failedFile());
    offerPage(win, 'The update could not be installed.',
      'The previous version was kept. Download the new version from the release page and install it by hand.');
  }
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(stampFile(), 'utf8')).lastCheck || 0; } catch {}
  const age = Date.now() - last;
  if (age >= 0 && age < DAY) return false; // a stamp in the future (clock change) counts as stale
  setTimeout(() => check(win, { silent: true }), 10000);
  return true;
}

module.exports = { compare, pickAsset, assetUrl, dmgPath, check, auto, SWAP };
