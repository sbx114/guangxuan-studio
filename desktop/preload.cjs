const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('gx:app-info'),
  loadConnectionSettings: () => ipcRenderer.invoke('gx:load-connection'),
  saveConnectionSettings: (settings, rememberKey = false) =>
    ipcRenderer.invoke('gx:save-connection', { settings, rememberKey }),
  clearConnectionSettings: () => ipcRenderer.invoke('gx:clear-connection'),
  saveFile: (file) => ipcRenderer.invoke('gx:save-file', file),
  chooseMedia: () => ipcRenderer.invoke('gx:choose-media'),
  saveExport: (file) => ipcRenderer.invoke('gx:save-export', file),
}));
