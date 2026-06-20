"""Frozen-friendly entry point for the Time Lens FastAPI backend.

PyInstaller bundles THIS module into `backend.exe`. It imports the FastAPI app
object directly (no import-string / reloader, which don't work when frozen) and
serves it with uvicorn on a loopback address. Host/port and the data directory
are taken from environment variables the Electron launcher sets:

    TIMELENS_HOST       (default 127.0.0.1)
    TIMELENS_PORT       (default 8000)
    TIMELENS_DATA_DIR   (where api.py persists SQLite + uploads)

Run standalone for a sanity check:  python backend_main.py
"""
import os
import sys


def main() -> None:
    # Keep the engine's Streamlit cache decorators quiet outside a ST runtime.
    os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")

    import uvicorn
    from api import app  # importing api also boots the heavy engine module

    host = os.environ.get("TIMELENS_HOST", "127.0.0.1")
    port = int(os.environ.get("TIMELENS_PORT", "8000"))

    # workers=1 + no reload: the desktop app is single-user; multiprocessing
    # workers don't survive PyInstaller freezing cleanly anyway.
    uvicorn.run(app, host=host, port=port, reload=False, workers=1, log_level="info")


if __name__ == "__main__":
    # Frozen multiprocessing guard (harmless when not frozen).
    try:
        import multiprocessing
        multiprocessing.freeze_support()
    except Exception:
        pass
    sys.exit(main())
