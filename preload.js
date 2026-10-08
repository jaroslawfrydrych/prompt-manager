const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('load'),
  // Synchronous so a save issued from beforeunload completes before the window dies.
  save: (data) => ipcRenderer.sendSync('save', data),
  // Installs the update a check already found; nothing is downloaded before this call.
  update: () => ipcRenderer.invoke('update'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  confirm: (message, detail, okLabel) => ipcRenderer.invoke('confirm', message, detail, okLabel),
  menu: (labels) => ipcRenderer.invoke('menu', labels),
  onCommand: (fn) => ipcRenderer.on('command', (_e, cmd) => fn(cmd)),
});
