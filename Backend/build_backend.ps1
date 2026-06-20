# Build the Time Lens backend into dist/backend/backend.exe using the project venv.
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File Backend\build_backend.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venvPy = Join-Path $root "venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { $venvPy = "python" }

Write-Host "Installing PyInstaller into the venv..."
& $venvPy -m pip install --upgrade pyinstaller

Write-Host "Freezing backend (this can take several minutes for the ML stack)..."
& $venvPy -m PyInstaller (Join-Path $root "backend.spec") --noconfirm `
    --distpath (Join-Path $root "dist") `
    --workpath (Join-Path $root "build_pyi")

$exe = Join-Path $root "dist\backend\backend.exe"
if (Test-Path $exe) { Write-Host "OK -> $exe" }
else { throw "Build finished but $exe not found" }
