// Time Lens — Electron main process.
//
// Startup sequence (Part 1/2):
//   1. resolve a writable data dir under %APPDATA%/Time Lens   (Part 6)
//   2. start the FastAPI backend (backend.exe packaged / venv python in dev)
//   3. start the Next.js server (standalone packaged / `next dev` in dev)
//   4. open the BrowserWindow on http://127.0.0.1:3000
//   5. tear both servers down on quit
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const launcher = require("./backend-launcher");
const updater = require("./updater");

// D.1 — native desktop shell: no OS chrome, no application/Electron menu. The
// renderer draws its own title bar + window controls (drag region + min/max/close
// over the window:* IPC channels below).
Menu.setApplicationMenu(null);

// Single-instance: a second launch focuses the existing window instead of
// spinning up a duplicate backend on the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let shuttingDown = false;

function dataDir() {
  // app.getPath('userData') = %APPDATA%/Time Lens (productName). Never Program Files.
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  // Size to the actual display work area (excludes taskbar, accounts for DPI
  // scaling). Clamp both the initial size AND the minimums so the window can
  // never exceed the visible screen — otherwise large fixed mins (e.g. 1400×900)
  // overflow on smaller / scaled displays, cutting off the right and bottom.
  const { width: areaW, height: areaH } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(1480, areaW);
  const winHeight = Math.min(920, areaH);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: Math.min(1200, areaW),
    minHeight: Math.min(700, areaH),
    show: false,
    center: true,
    fullscreenable: true,
    // Dark title bar via the Windows Controls Overlay (WCO): keep the REAL native
    // minimize/maximize/close buttons, but paint the title-bar area to match the
    // app header (#081a36) so there is no white OS strip. The app header doubles
    // as the title bar — it carries the drag region and reserves the top-right
    // space for the overlaid controls (see `.titlebar-safe-right`). This is NOT
    // frameless mode: the window frame/borders remain and we never draw custom
    // window buttons; only native controls are used.
    frame: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#081a36",
      symbolColor: "#ffffff",
      height: 72,
    },
    autoHideMenuBar: true,
    backgroundColor: "#081a36",
    title: "Time Lens",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // D.6 — wire the auto-updater's lifecycle to this window's renderer.
  updater.init(mainWindow);

  // Keep the renderer's maximize/restore icon in sync with the real state.
  const emitMaxState = () =>
    mainWindow?.webContents.send("window:maximized", mainWindow.isMaximized());
  mainWindow.on("maximize", emitMaxState);
  mainWindow.on("unmaximize", emitMaxState);

  // External links open in the OS browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return mainWindow;
}

// ── Custom window controls (D.1) ──────────────────────────────────────────────
// The frameless renderer drives these over IPC (see preload.js → window.desktop).
function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}
ipcMain.on("window:minimize", (e) => windowFor(e)?.minimize());
ipcMain.on("window:maximize", (e) => {
  const w = windowFor(e);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on("window:close", (e) => windowFor(e)?.close());
ipcMain.handle("window:isMaximized", (e) => !!windowFor(e)?.isMaximized());

// ── Auto-update IPC (D.6) ─────────────────────────────────────────────────────
// No-ops in dev (updater only functions in packaged builds — see boot()).
ipcMain.handle("update:check", () => updater.checkForUpdates());
ipcMain.handle("update:download", () => updater.downloadUpdate());
ipcMain.on("update:install", () => updater.quitAndInstall());
ipcMain.handle("app:version", () => app.getVersion());

function showSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: "#0b1220",
    title: "Time Lens",
  });
  splash.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;display:flex;align-items:center;justify-content:center;
         height:100vh;background:#0b1220;color:#e2e8f0;font-family:Segoe UI,system-ui,sans-serif">
         <div style="text-align:center">
           <div style="font-size:20px;font-weight:700;letter-spacing:.3px">Time Lens</div>
           <div style="margin-top:8px;font-size:13px;opacity:.7">Starting forecasting engine…</div>
         </div></body>`,
      ),
  );
  return splash;
}

async function boot() {
  const splash = showSplash();
  const ctx = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(), // …/resources/app  (packaged) or the Frontend dir (dev)
    dataDir: dataDir(),
    electronExec: process.execPath,
  };

  try {
    await launcher.startBackend(ctx);
    await launcher.startWeb(ctx);
  } catch (err) {
    if (!splash.isDestroyed()) splash.destroy();
    dialog.showErrorBox(
      "Time Lens failed to start",
      `Could not start the local services.\n\n${err?.stack || err}`,
    );
    app.quit();
    return;
  }

  const win = createWindow();
  await win.loadURL(launcher.WEB_URL);
  if (!splash.isDestroyed()) splash.destroy();

  // D.6 — production auto-update check. Dev (`npm run desktop`) is never touched
  // (electron-updater can't run unpackaged anyway). Fires 10s after startup so it
  // never blocks/delays launch or login.
  if (app.isPackaged) {
    setTimeout(() => {
      void updater.checkForUpdates();
    }, 10000);
  }
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  // On Windows/Linux quitting the last window quits the app (and its servers).
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

function teardown() {
  if (shuttingDown) return;
  shuttingDown = true;
  launcher.stopAll();
}
app.on("before-quit", teardown);
process.on("exit", teardown);
process.on("SIGINT", () => {
  teardown();
  process.exit(0);
});
