// D.6 — auto-update orchestration (electron-updater). Wraps the autoUpdater,
// forwards its lifecycle to the renderer over `update:status` / `update:progress`,
// and exposes check / download / install for the IPC handlers in main.js.
//
// Downloads are NOT automatic (`autoDownload = false`) — the user confirms in the
// in-app dialog. Updates only function in packaged builds (guarded in main.js).
//
// Defensive load: if `electron-updater` is ever absent from the packaged asar
// (e.g. a misconfigured `build.files`), DO NOT crash the whole app on startup.
// Fall back to safe no-ops so the window still opens — auto-update simply
// becomes inert until the dependency is packaged correctly again.
let autoUpdater;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (err) {
  console.warn(
    "[updater] electron-updater unavailable — auto-update disabled:",
    err?.message || err,
  );
  module.exports = {
    init() {},
    checkForUpdates() {},
    downloadUpdate() {},
    quitAndInstall() {},
  };
  return;
}

let targetWindow = null;
let lastChecked = null;

function send(channel, payload) {
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send(channel, payload);
  }
}

function stamp() {
  lastChecked = new Date().toISOString();
  return lastChecked;
}

/** Wire the autoUpdater events → renderer. Call once with the main window. */
function init(win) {
  targetWindow = win;
  autoUpdater.autoDownload = false; // user-initiated download
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () =>
    send("update:status", { state: "checking" }),
  );
  autoUpdater.on("update-available", (info) =>
    send("update:status", { state: "available", version: info?.version, lastChecked: stamp() }),
  );
  autoUpdater.on("update-not-available", (info) =>
    send("update:status", { state: "not-available", version: info?.version, lastChecked: stamp() }),
  );
  autoUpdater.on("download-progress", (p) =>
    send("update:progress", {
      percent: p?.percent ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    send("update:status", { state: "downloaded", version: info?.version }),
  );
  autoUpdater.on("error", (err) =>
    send("update:status", { state: "error", message: String(err?.message || err) }),
  );
}

async function checkForUpdates() {
  stamp();
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err) {
    send("update:status", { state: "error", message: String(err?.message || err) });
    return null;
  }
}

async function downloadUpdate() {
  try {
    send("update:status", { state: "downloading" });
    return await autoUpdater.downloadUpdate();
  } catch (err) {
    send("update:status", { state: "error", message: String(err?.message || err) });
    return null;
  }
}

function quitAndInstall() {
  // isSilent=false, isForceRunAfter=true → reopen the app after installing.
  autoUpdater.quitAndInstall(false, true);
}

module.exports = { init, checkForUpdates, downloadUpdate, quitAndInstall };
