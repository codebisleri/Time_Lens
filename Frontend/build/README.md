# Desktop build resources

electron-builder reads installer/app assets from this folder (`buildResources`).
The build config (`package.json` → `build`) references:

- **Windows:** `build/icon.ico`  (config: `win.icon`)
- **macOS:** `build/icon.icns`  (config: `mac.icon`)

These are **binary image assets** that must be generated from the brand mark
(`Frontend/public/time-lens-logo.png`) and committed here before producing real
installers. Until they exist, electron-builder falls back to the default Electron
icon (it warns, but a `--dir`/dev build still runs).

## Generate the icons

Start from a **square ≥1024×1024 PNG** master (`icon.png`), then:

### `icon.ico` (Windows — multi-resolution, include 256×256)
- ImageMagick:
  `magick icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico`
- or any PNG→ICO tool, saving as `build/icon.ico`.

### `icon.icns` (macOS — multi-resolution)
- On macOS, with `iconutil` (build an `.iconset` of 16→1024 px then):
  `iconutil -c icns icon.iconset -o build/icon.icns`
- or cross-platform: `npx electron-icon-builder --input=icon.png --output=build`
  (emits both `icon.ico` and `icon.icns`).

> macOS `.icns` conversion requires the source PNG to be **square** and ≥512×512
> (1024×1024 recommended). The existing `time-lens-logo.png` (865×772) is not
> square — pad it to a square canvas first.

## Per-OS build runners

- **Windows** targets (`nsis`, `portable`) build on Windows: `npm run desktop:win`.
- **macOS** targets (`dmg`, `zip`, Intel + Apple Silicon) build on macOS:
  `npm run desktop:mac`. (macOS apps cannot be produced on Windows.)
- Both require the platform's PyInstaller backend bundle at `../Backend/dist/backend`
  (Windows: `backend.exe`, macOS: `backend`) — see `electron/backend-launcher.js`.
