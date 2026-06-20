# Time Lens — Installation Guide (for Managers)

Time Lens is a self-contained desktop application. Everything it needs (the app
and its local analytics engine) is included in the installer — there is nothing
else to set up.

---

## Windows

### Option A — Installer (recommended)
1. Double-click **`TimeLens-Setup.exe`**.
2. If Windows SmartScreen appears (the build is not code-signed), click
   **More info → Run anyway**.
3. Choose the install location (or accept the default) and finish.
4. Launch **Time Lens** from the Desktop or Start Menu shortcut.

### Option B — Portable (no installation)
1. Copy **`TimeLens.exe`** anywhere (e.g. your Desktop or a USB drive).
2. Double-click it to run — no installation, no admin rights.

---

## macOS (Intel & Apple Silicon)
1. Open **`TimeLens-<arch>.dmg`** (`x64` for Intel, `arm64` for Apple Silicon —
   if unsure, Apple Silicon is M1/M2/M3+).
2. Drag **Time Lens** into **Applications**.
3. First launch: the build is not notarized, so macOS may block it. Either:
   - **Right-click** the app → **Open** → **Open**, or
   - **System Settings → Privacy & Security → Open Anyway**.

---

## First launch
- The app starts its local engine in the background — the first launch can take
  10–30 seconds (a splash screen is shown). Subsequent launches are faster.
- Sign in with the credentials provided by your administrator. There are no demo
  or test accounts in production.

## Staying signed in
- The app **remembers your login** after you close and reopen it. Use
  **Log out** (top-right avatar menu) to end your session.

## Starting over
- The avatar menu has **Reset Workspace** → *Start New Forecast Session*. This
  permanently clears the current datasets, EDA, forecasts, and submissions, and
  returns you to an empty workspace. It does **not** sign you out.

## Need help?
- If the app won't start, fully quit it (close the window) and relaunch.
- Report issues to your administrator with a screenshot and what you were doing.
