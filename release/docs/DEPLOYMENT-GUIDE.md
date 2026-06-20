# Time Lens Desktop — Deployment Guide (Engineering)

How Time Lens is assembled into desktop deliverables, and how to produce a release.

## Architecture (what ships)
A single Electron app that, on launch, starts two local processes on loopback and
loads the UI:

1. **FastAPI backend** — PyInstaller *onedir* bundle (`Backend/dist/backend/`,
   ~1.2 GB: Python runtime + numpy/scipy/statsmodels/lightgbm/prophet + the
   forecasting engine). Listens on `127.0.0.1:8000`. Shipped under
   `resources/backend/` (`backend.exe` Windows / `backend` macOS).
2. **Next.js standalone server** — `.next/standalone` (server.js + minimal
   node_modules + static + public). Run by Electron's bundled Node
   (`ELECTRON_RUN_AS_NODE`) on `127.0.0.1:3000`. Shipped under `resources/web/`.
3. **Electron shell** — frameless window, custom title bar/controls, supervises
   the two servers (`electron/main.js` + `electron/backend-launcher.js`), tears
   them down on quit.

Per-user writable data (SQLite DB, uploads) lives in the OS user-data dir
(`%APPDATA%/Time Lens` on Windows, `~/Library/Application Support/Time Lens` on
macOS) — never in Program Files. Set via `TIMELENS_DATA_DIR`.

## Build config (`package.json` → `build`)
- `appId: com.timelens.desktop`, `productName: "Time Lens"`, output `dist-desktop/`.
- `extraResources`: `../Backend/dist/backend → backend`, `.next/standalone → web`.
- **Windows:** targets `nsis` + `portable` (x64). Artifacts `TimeLens-Setup.exe`,
  `TimeLens.exe`.
- **macOS:** targets `dmg` + `zip` for **x64 (Intel)** + **arm64 (Apple Silicon)**;
  `category: public.app-category.business`, `hardenedRuntime: false`,
  `identity: null` (unsigned).
- Icon source: `build/icon.png` (electron-builder generates `.ico`/`.icns`).

## Release procedure
> Build each OS on that OS. The backend bundle is platform-specific — rebuild it
> on each target.

### Windows (on Windows)
```
cd Backend && venv\Scripts\python -m PyInstaller backend.spec --noconfirm
cd ..\Frontend && npm ci
powershell -File scripts\make-icon.ps1        # if build/icon.png absent
npm run desktop:win                            # build:web + electron-builder --win nsis portable --x64
```
→ `Frontend/dist-desktop/TimeLens-Setup.exe`, `TimeLens.exe`.

### macOS (on macOS — Intel & Apple Silicon)
```
cd Backend && venv/bin/python -m PyInstaller backend.spec --noconfirm
cd ../Frontend && npm ci
npm run desktop:mac                            # build:web + electron-builder --mac dmg zip
```
→ `Frontend/dist-desktop/TimeLens-<arch>.dmg` (+ zips), `Time Lens.app`.

## Scripts reference
| Script | Action |
| --- | --- |
| `npm run build:web` | `next build` + copy static/public into `.next/standalone` |
| `npm run desktop:prepare` | copy static/public into `.next/standalone` |
| `npm run desktop` | dev: `next dev` + Electron against it |
| `npm run desktop:win` | Windows nsis + portable (x64) |
| `npm run desktop:mac` | macOS dmg + zip (x64 + arm64) |
| `npm run desktop:dist` | build for the host OS |

## Ports
- Backend `127.0.0.1:8000`, Web `127.0.0.1:3000` (loopback only; not exposed).

## Signing (optional, future)
- Windows: provide a code-signing cert to silence SmartScreen.
- macOS: set `identity` + enable `hardenedRuntime` + notarize to silence Gatekeeper.
