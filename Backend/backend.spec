# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Time Lens FastAPI backend → dist/backend/backend.exe
(onedir). Build with:  pyinstaller backend.spec --noconfirm

onedir (not onefile) is deliberate: the ML stack (numpy/scipy/statsmodels/
lightgbm) is large and onefile re-extracts to a temp dir on every launch, which
is slow and trips some native DLLs. onedir gives a folder `dist/backend/` with
backend.exe + an `_internal/` payload — Electron ships the whole folder.

If a `ModuleNotFoundError` appears at runtime on the target machine, add the
missing module to HIDDEN_IMPORTS below and rebuild (the usual suspects are
dynamic imports inside uvicorn / statsmodels / sklearn)."""

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []

# Heavy / data-carrying packages: pull in their data files, native libs, and
# submodules. Guarded so the spec still builds if an optional lib is absent.
_COLLECT = [
    "uvicorn", "fastapi", "starlette", "pydantic", "pydantic_core",
    "anyio", "h11", "click",
    "pandas", "numpy", "scipy", "dateutil", "pytz", "tzdata",
    "sklearn", "statsmodels", "patsy", "joblib", "threadpoolctl",
    "lightgbm", "holidays",
    # Engine touches Streamlit at import time (st.cache_data decorators).
    "streamlit", "altair",
    # Optional forecasting extras — only collected if installed.
    "prophet", "cmdstanpy", "stan", "xgboost", "catboost",
    "pmdarima", "numba", "llvmlite", "chronos",
]
for _pkg in _COLLECT:
    try:
        d, b, h = collect_all(_pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as _exc:  # not installed → skip
        print(f"[backend.spec] skip collect_all({_pkg!r}): {_exc}")

# Engine source modules live beside this spec; ensure they're bundled even if
# import discovery misses a lazily-imported one.
hiddenimports += [
    "api", "app_v2_6", "temporal_features", "phase2_enhancements",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    "uvicorn.lifespan.off", "email.mime.text", "email.mime.multipart",
]
try:
    hiddenimports += collect_submodules("uvicorn")
except Exception:
    pass

block_cipher = None

a = Analysis(
    ["backend_main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Trim weight: GUI/test/dev-only packages the server never needs.
    excludes=["tkinter", "PyQt5", "PySide2", "matplotlib.tests",
              "pytest", "IPython", "notebook"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,           # onedir
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,                    # keep a console for log visibility; set False to hide
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="backend",                  # → dist/backend/backend.exe
)
