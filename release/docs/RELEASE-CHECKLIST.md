# Time Lens Desktop — Release Checklist (Phase D.4)

> Run from `Frontend/` unless noted. Windows installers build on Windows; macOS
> installers build on macOS (they cannot be cross-built).

## 0. Prerequisites (per build machine)
- [ ] Node 18+ and the project dependencies installed (`npm ci` in `Frontend/`).
- [ ] Python venv for the backend (`Backend/venv`) with `pyinstaller` + all engine deps.
- [ ] `Frontend/build/icon.png` present (1024×1024 square). Generate with
      `powershell -File scripts/make-icon.ps1` (electron-builder converts it to
      `.ico` on Windows and `.icns` on macOS).

## 1. Pre-build validation
- [ ] `npm run type-check` — passes.
- [ ] `npm run lint` — passes.
- [ ] `npm run build` — compiles (24 routes), `output: standalone`.
- [ ] Backend starts: `Backend/venv/Scripts/python backend_main.py` → `http://127.0.0.1:8000/openapi.json` responds.
- [ ] Dev shell launches: `npm run desktop` (frameless, no OS menu, custom min/max/close).

## 2. Frontend build (STEP 1 + 3)
- [ ] `npm run build:web`  (next build + `desktop:prepare`).
- [ ] Verify `.next/standalone/server.js`, `.next/standalone/.next/static`, `.next/standalone/public` all exist.

## 3. Backend build (STEP 2) — per target OS
- [ ] `cd Backend && venv/Scripts/python -m PyInstaller backend.spec --noconfirm`
- [ ] Verify `Backend/dist/backend/` contains the executable
      (`backend.exe` on Windows / `backend` on macOS) + `_internal/` (Python
      runtime, numpy/scipy/statsmodels/lightgbm/prophet, engine modules).

## 4. Windows release (STEP 4 — on Windows)
- [ ] `npm run desktop:win`  (→ `electron-builder --win nsis portable --x64`).
- [ ] Output in `Frontend/dist-desktop/`:
  - [ ] `TimeLens-Setup.exe`  (NSIS installer)
  - [ ] `TimeLens.exe`        (portable)

## 5. macOS release (STEP 5 — on macOS, Intel + Apple Silicon)
- [ ] `npm run desktop:mac`  (→ `electron-builder --mac dmg zip`).
- [ ] Output in `Frontend/dist-desktop/`:
  - [ ] `TimeLens-x64.dmg`, `TimeLens-arm64.dmg`  (+ `.zip` per arch)
  - [ ] `Time Lens.app` (inside the dmg/zip)

## 6. Runtime validation (install + launch the artifact)
- [ ] App launches frameless — no OS title bar, no File/Edit/View/Window/Help menu.
- [ ] Custom minimize / maximize-restore / close work; header is draggable.
- [ ] Login with existing credentials (real `/auth` backend) succeeds.
- [ ] Close + reopen → still logged in (persistent session).
- [ ] Upload dataset → EDA (runs only on "Run EDA") → Forecast → Submission → Performance → Report.
- [ ] Loading indicators: global top bar on navigation; Continue/Run buttons show spinners + disable.
- [ ] Reset Workspace → confirm → workspace clears, returns to empty `/data`, **stays logged in**.
- [ ] Logout → returns to login.

## 7. Sign-off
- [ ] Version bumped in `package.json` (`version`).
- [ ] Artifacts archived / uploaded to the distribution channel.
- [ ] Manager install guide attached to the release.
