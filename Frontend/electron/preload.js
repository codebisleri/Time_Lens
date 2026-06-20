// Minimal, locked-down preload. The app is a standard web client talking to the
// local FastAPI backend over HTTP, so it needs almost nothing from Electron — we
// expose only read-only app metadata behind a namespaced bridge. contextIsolation
// stays ON and nodeIntegration OFF (set in main.js) so the renderer can't reach
// Node/Electron internals.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timelens", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

// D.1 — custom title-bar window controls. The renderer calls these for the
// minimize / maximize / close buttons and subscribes to maximize-state changes
// to toggle the maximize/restore icon.
contextBridge.exposeInMainWorld("desktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  onMaximizeChange: (cb) => {
    const handler = (_e, isMax) => cb(!!isMax);
    ipcRenderer.on("window:maximized", handler);
    return () => ipcRenderer.removeListener("window:maximized", handler);
  },
});

// D.6 — auto-update bridge. check/download return promises; install quits + installs.
// onStatus/onProgress subscribe to main-process update events and return an
// unsubscribe fn.
contextBridge.exposeInMainWorld("updater", {
  appVersion: () => ipcRenderer.invoke("app:version"),
  check: () => ipcRenderer.invoke("update:check"),
  download: () => ipcRenderer.invoke("update:download"),
  install: () => ipcRenderer.send("update:install"),
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  onProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on("update:progress", handler);
    return () => ipcRenderer.removeListener("update:progress", handler);
  },
});
