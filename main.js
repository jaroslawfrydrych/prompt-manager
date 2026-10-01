const { app, BrowserWindow, ipcMain, clipboard, nativeTheme, nativeImage, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO_URL = 'https://github.com/jaroslawfrydrych/prompt-manager';

// Dev runs would otherwise be named "Electron" (menu, About, userData folder).
app.setName('Prompt Manager');

const DATA_FILE = path.join(app.getPath('userData'), 'data.json');

if (!app.requestSingleInstanceLock()) app.exit(0);

let win;
let aboutWin;

// Links open in the browser (GitHub only); the app itself never navigates away.
function lockDown(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/')) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showAbout() {
  if (aboutWin) return aboutWin.focus();
  aboutWin = new BrowserWindow({
    width: 320,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About Prompt Manager',
    titleBarStyle: 'hiddenInset',
    parent: win,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockDown(aboutWin);
  aboutWin.loadFile(path.join(__dirname, 'about.html'), { query: { v: require('./package.json').version } });
  aboutWin.on('closed', () => { aboutWin = null; });
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Keep the unreadable file instead of overwriting it with an empty state.
      fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
    }
    return null;
  }
}

function save(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

ipcMain.handle('load', () => load());
ipcMain.on('save', (e, data) => { save(data); e.returnValue = true; });
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text));
ipcMain.handle('confirm', async (_e, message, detail, okLabel) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message, detail, buttons: [okLabel, 'Cancel'], defaultId: 1, cancelId: 1,
  });
  return response === 0;
});
// Colour dot for menu items (Finder tag style): 12pt antialiased circle, BGRA premultiplied @2x.
function dot(hex) {
  const n = 24, buf = Buffer.alloc(n * n * 4);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = Math.max(0, Math.min(1, n / 2 - 1.5 - Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) + 0.5));
      buf.set([b * a, g * a, r * a, 255 * a], (y * n + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n, scaleFactor: 2 });
}

// Items: '-', a label (resolves to its index) or { id, label, checked, icon: '#hex', enabled, submenu }.
function menuTemplate(items, resolve) {
  return items.map((item, i) => {
    if (item === '-') return { type: 'separator' };
    if (typeof item === 'string') return { label: item, click: () => resolve(i) };
    const { id, checked, icon, submenu, ...rest } = item;
    const t = { ...rest };
    if (submenu) t.submenu = menuTemplate(submenu, resolve);
    else t.click = () => resolve(id ?? i);
    if (checked !== undefined) Object.assign(t, { type: 'checkbox', checked });
    if (icon) t.icon = dot(icon);
    return t;
  });
}

// Native context menu; resolves with the clicked item's id/index, or -1 when dismissed.
ipcMain.handle('menu', (_e, items) => new Promise((resolve) => {
  Menu.buildFromTemplate(menuTemplate(items, resolve))
    .popup({ window: win, callback: () => setTimeout(() => resolve(-1), 50) });
}));

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    title: 'Prompt Manager',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockDown(win);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
  const send = (cmd) => () => win && win.webContents.send('command', cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: showAbout },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Prompt', accelerator: 'CmdOrCtrl+N', click: send('new-prompt') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-project') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Prompt Manager on GitHub', click: () => shell.openExternal(REPO_URL) }],
    },
  ]));
  createWindow();
});

app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => app.quit());
