# Time Lens — Windows Desktop Packaging

Time Lens ships as a standalone Windows app (`TimeLensSetup.exe`) built with
**Electron + electron-builder**. The architecture is unchanged: Electron simply
supervises the existing **Next.js** server and **FastAPI** backend and points a
window at them. **SQLite** is preserved; data lives under `%APPDATA%/Time Lens`.

```
Electron (main process)
 ├─ spawns  backend.exe        →  127.0.0.1:8000   (FastAPI, PyInstaller-frozen)
 ├─ spawns  Next server.js     →  127.0.0.1:3000   (Next.js standalone, run via Electron's Node)
 └─ BrowserWindow loads        →  http://127.0.0.1:3000
```

In **development** the same `main.js` runs the backend from the project venv and
loads the `next dev` server; in **production** it runs the frozen `backend.exe`
and the bundled standalone server. Selection is automatic via `app.isPackaged`.

---

## One-time prerequisites

- Node 18+ and the Frontend deps: `cd Frontend && npm install`
- Python venv with the backend deps at `Backend/venv` (already present)
- (Optional, for branding) `Frontend/build/icon.ico` — see `Frontend/build/README.md`

---

## Development — `npm run desktop`

```powershell
cd Frontend
npm run desktop
```

This launches all three pieces:
1. **FastAPI backend** — Electron's `backend-launcher` runs `Backend/venv/Scripts/python.exe backend_main.py` (env `TIMELENS_DATA_DIR` → `%APPDATA%/Time Lens`).
2. **Next.js frontend** — `next dev` (started by the `concurrently` script).
3. **Electron window** — opens once both `:8000/openapi.json` and `:3000` answer.

---

## Production build → `TimeLensSetup.exe`

Three steps, in order. (1) freeze the backend, (2) build the web bundle, (3) build the installer.

### 1. Freeze the FastAPI backend (PyInstaller)

```powershell
powershell -ExecutionPolicy Bypass -File Backend\build_backend.ps1
# → Backend/dist/backend/backend.exe  (onedir: backend.exe + _internal/)
```

Driven by `Backend/backend.spec` (entry `Backend/backend_main.py`). It `collect_all`s
the ML stack (pandas/numpy/scipy/statsmodels/sklearn/lightgbm/holidays/streamlit,
plus prophet/xgboost/etc. when installed). If a `ModuleNotFoundError` shows at
runtime, add the module to `HIDDEN_IMPORTS` in `backend.spec` and rebuild.

Sanity-check the frozen server on its own:
```powershell
Backend\dist\backend\backend.exe   # then browse http://127.0.0.1:8000/openapi.json
```

### 2. Build the Next.js standalone web bundle

```powershell
cd Frontend
npm run build:web        # = next build (output:'standalone') + scripts/prepare-standalone.mjs
# → Frontend/.next/standalone/{server.js, node_modules, .next/static, public}
```

### 3. Build the installer (electron-builder, NSIS)

```powershell
cd Frontend
npm run desktop:dist     # = build:web + electron-builder --win nsis
# → Frontend/dist-desktop/TimeLensSetup.exe
```

`electron-builder` config lives in `Frontend/package.json` → `build`:
- `extraResources` ships `Backend/dist/backend` → `resources/backend` and
  `.next/standalone` → `resources/web`.
- `win.target = nsis`, `artifactName = TimeLensSetup.${ext}`, app icon `build/icon.ico`.
- `nsis`: not one-click, per-user (no admin), **desktop + start-menu shortcuts**, name "Time Lens".

> Full one-shot (after the venv/icon are ready):
> ```powershell
> powershell -ExecutionPolicy Bypass -File Backend\build_backend.ps1 ; cd Frontend ; npm run desktop:dist
> ```

---

## Data storage (SQLite)

`Backend/api.py` reads `TIMELENS_DATA_DIR` (set by Electron to `app.getPath('userData')`
= `%APPDATA%/Time Lens`) and writes there — never inside Program Files:
- `api_bridge.db` — datasets, forecasts, scenarios, submissions, reports
- `api_data/` — uploaded source files
- `dhisha_segments.db` — engine segmentation DB (`TIMELENS_DB_PATH`)

Uninstalling the app leaves user data intact under `%APPDATA%/Time Lens`.

---

## Files created / modified

**Created**
- `Frontend/electron/main.js` — Electron main: boot sequence, window, single-instance, teardown
- `Frontend/electron/preload.js` — locked-down context bridge (`window.timelens`)
- `Frontend/electron/backend-launcher.js` — spawn/supervise backend + Next server, readiness polling, kill-on-exit
- `Frontend/scripts/prepare-standalone.mjs` — copy `.next/static` + `public` into the standalone bundle
- `Frontend/build/README.md` — installer icon instructions
- `Backend/backend_main.py` — PyInstaller entry (uvicorn on `TIMELENS_HOST/PORT`)
- `Backend/backend.spec` — PyInstaller onedir spec for the ML backend
- `Backend/build_backend.ps1` — backend freeze helper
- `DESKTOP.md` — this document

**Modified**
- `Frontend/next.config.ts` — `output: 'standalone'`
- `Frontend/package.json` — `main`, desktop scripts, `build` (electron-builder/NSIS), electron tooling → devDependencies
- `Backend/api.py` — `DATA_DIR`/`DB_PATH` rooted at `TIMELENS_DATA_DIR` (writable home)

---

## Validation checklist (Part 7)

| # | Check | How |
|---|-------|-----|
| 1 | `npm run desktop` launches backend+frontend+window | run it; window shows the app |
| 2 | backend starts automatically | no terminal/venv/uvicorn needed; `:8000/openapi.json` answers |
| 3 | frontend loads automatically | window navigates to `:3000` after splash |
| 4 | Electron window opens | single window, external links → OS browser |
| 5 | SQLite works | upload a dataset → file appears in `%APPDATA%/Time Lens/api_data`, rows in `api_bridge.db` |
| 6 | installer builds | `npm run desktop:dist` → `dist-desktop/TimeLensSetup.exe` |
| 7 | installed app runs without Python | install on a clean machine (no Python); app launches (backend.exe is self-contained) |
