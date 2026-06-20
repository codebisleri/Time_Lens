# Time Lens Desktop — Known Limitations

## Packaging & distribution
- **Unsigned builds.** Windows installers are not Authenticode-signed (SmartScreen
  "More info → Run anyway") and macOS apps are not notarized (`identity: null`,
  `hardenedRuntime: false` — right-click → Open on first launch). Signing/
  notarization is a future step once certificates are provisioned.
- **Cross-build not possible.** Windows artifacts must be built on Windows and
  macOS artifacts on macOS. The PyInstaller backend is platform-specific and must
  be rebuilt on each target OS.
- **Large artifacts.** The bundled forecasting engine (numpy/scipy/statsmodels/
  lightgbm/prophet) makes the backend ~1.2 GB, so installers are large and the
  portable `.exe` is sizeable. This is expected for an offline ML desktop app.
- **Icon source.** Branding uses `build/icon.png` (generated from the brand logo,
  padded to a square canvas) which electron-builder converts to `.ico`/`.icns`.
  Replace with a hand-tuned master for pixel-perfect small sizes if desired.

## Runtime
- **First-launch warm-up.** The local engine takes ~10–30 s to start on first
  launch (splash shown); heavy forecast runs take ~60–120 s per forecast level.
- **Single instance.** A second launch focuses the existing window (by design).
- **Loopback only.** Backend (8000) and web (3000) bind to `127.0.0.1`; the app
  is single-user/local — not a multi-user server deployment.

## Platform support
- Windows: **x64** only (no ARM Windows target configured).
- macOS: **Intel (x64)** and **Apple Silicon (arm64)**.
- Linux: not configured.

## Auth & session
- Session persists via the local token (localStorage) + a 30-day presence cookie,
  rolled forward on each launch. If the app is not opened for 30+ days the user
  must sign in again. There is no offline login — the local `/auth` backend must
  be running (it is started automatically by the shell).

## Verified-in-this-environment vs requires-a-build-machine
- **Verified here (Windows dev box):** frontend `build:web` (standalone), backend
  PyInstaller bundle present (`Backend/dist/backend`, exe + `_internal`),
  electron-builder config + scripts, icon generation, type-check/lint/build.
- **Requires the proper build/runtime machine:** macOS DMG build (needs a Mac);
  full GUI runtime validation (login/upload/EDA/forecast/reset clickthrough in the
  installed app); code-signing/notarization.
