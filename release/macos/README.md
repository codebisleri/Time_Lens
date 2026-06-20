# macOS artifacts — built on a Mac

macOS installers **cannot** be cross-built on Windows. Produce them on a Mac and
drop the outputs here:

- `TimeLens-arm64.dmg`  (Apple Silicon)
- `TimeLens-x64.dmg`    (Intel)
- (optional) the `.zip` per architecture

## Steps (on macOS)
```bash
# 1. Build the macOS backend bundle
cd Backend && venv/bin/python -m PyInstaller backend.spec --noconfirm
# 2. Build the desktop app (Intel + Apple Silicon)
cd ../Frontend && npm ci && npm run desktop:mac
# 3. Copy outputs
cp dist-desktop/TimeLens-*.dmg  <repo>/release/macos/
```

Config is ready in `Frontend/package.json` → `build.mac`
(`dmg` + `zip`, `arch: [x64, arm64]`, `category: public.app-category.business`,
`hardenedRuntime: false`, `identity: null`). First launch on macOS: right-click →
**Open** (unsigned / not notarized).
