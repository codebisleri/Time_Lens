# Time Lens — Release Notes

## Version 1.0.0 — Production Desktop Release (2026-06-20)

First production desktop release of Time Lens, the enterprise demand-forecasting
platform, packaged as a native cross-platform desktop application.

### Highlights
- ✅ **Native desktop application** — self-contained; bundles the forecasting
  engine + UI, no external setup required.
- ✅ **Frameless enterprise window** — no OS title bar / menu; custom minimize /
  maximize / close controls; draggable header.
- ✅ **Windows support** — NSIS installer (`TimeLens-Setup.exe`) + portable
  executable (`TimeLens.exe`), x64.
- ✅ **macOS support** — DMG + ZIP for **Intel (x64)** and **Apple Silicon
  (arm64)**.
- ✅ **Persistent login** — real backend authentication; the app remembers your
  session across restarts.
- ✅ **Workspace reset** — "Start New Forecast Session" clears the workspace
  without logging you out.
- ✅ **Forecasting workflow** — Data → EDA → Profile & Route → Forecast →
  Submission → Performance → Report, with multi-model competition + champion
  selection.
- ✅ **EDA workflow** — runs only on demand ("Run EDA"); results persist across
  navigation.
- ✅ **Enterprise UI** — strict navy + orange brand system, glass surfaces,
  premium login.
- ✅ **Loading experience** — global route progress bar, per-action spinners,
  double-click protection, live forecast progress.
- ✅ **Cross-platform packaging** — single electron-builder pipeline for Windows
  and macOS.

### Install
- **Windows:** run `windows/TimeLens-Setup.exe` (or run `windows/TimeLens.exe`
  portable — no install). SmartScreen → *More info → Run anyway* (unsigned).
- **macOS:** open `macos/TimeLens-<arch>.dmg`, drag to Applications; first launch
  right-click → **Open** (unsigned/un-notarized).

See `docs/MANAGER-INSTALL-GUIDE.md` for step-by-step instructions.

### Notes & limitations
- Builds are **unsigned** (no Authenticode / notarization yet).
- First launch warms up the local engine (~10–30 s, splash shown).
- Single-user, local (loopback) application.
- Full details in `docs/KNOWN-LIMITATIONS.md`.

### Build provenance
- App/installer version: **1.0.0** (`package.json`).
- Platform/UI generation: **v2.0** (shown in the app chrome).
- Windows artifacts built and verified on Windows x64; macOS artifacts built on
  macOS (see `docs/DEPLOYMENT-GUIDE.md`).
