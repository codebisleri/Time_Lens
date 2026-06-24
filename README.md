# Time Lens

Enterprise demand forecasting & planning platform. A **Next.js 15** frontend, a
**Python / FastAPI** forecasting engine, and an **Electron** desktop shell that
bundles both into a single installable app (Windows `.exe` / macOS `.dmg`).

```
Electron (desktop shell)
 ├─ spawns  FastAPI backend  →  127.0.0.1:8000   (forecasting / scenarios / explainability)
 ├─ spawns  Next.js server   →  127.0.0.1:3000   (web UI)
 └─ BrowserWindow loads      →  http://127.0.0.1:3000
```

The web frontend and the backend can also be run **independently** for development.

---

## Prerequisites

| Tool       | Version                          | Notes |
|------------|----------------------------------|-------|
| Node.js    | **20.x** (18.x also supported)   | Pinned in [`.nvmrc`](.nvmrc) — run `nvm use` |
| npm        | latest stable (ships with Node)  | |
| Python     | **3.11**                         | The ML stack is validated on 3.11 |
| Git        | any                              | |

> macOS packaging (`.dmg`) must be built on macOS; Windows packaging (`.exe`) on Windows.

---

## 1. Clone the repository

```bash
git clone <repo-url>
cd Time_Lens
```

## 2. Frontend setup

```bash
cd Frontend
nvm use            # selects Node 20 from .nvmrc (optional, if you use nvm)
npm install
```

## 3. Backend setup

From the repository root:

```bash
cd Backend
python -m venv venv

# Windows (PowerShell):
venv\Scripts\Activate.ps1
# macOS / Linux:
source venv/bin/activate

pip install -r requirements.txt
```

> `requirements.txt` and `requirements_fixed.txt` hold the same versions;
> `requirements_fixed.txt` is the exact CI-validated pinned set (used by the
> macOS build workflow). Either installs a working engine.
>
> The Electron desktop shell launches the backend from `Backend/venv` in
> development, so create the venv at exactly that path.

## 4. Environment variables

The web app and its AI-assistant proxy read their config from a **Frontend** env
file. Copy the template and edit as needed:

```bash
cd Frontend
cp .env.example .env.local      # Windows: copy .env.example .env.local
```

Key variables (see [`Frontend/.env.example`](Frontend/.env.example) for the full list):

| Variable                     | Purpose | Default |
|------------------------------|---------|---------|
| `NEXT_PUBLIC_API_BASE_URL`   | Backend API URL. Set to `http://localhost:8000` to use the real backend; leave blank to run on mock data. | `/api` |
| `NEXT_PUBLIC_USE_MOCKS`      | `true` = run the whole UI on fixtures with no backend. | `true` |
| `ANTHROPIC_API_KEY`          | **Server-side** key for the AI assistant (`/api/assistant`). Never prefix with `NEXT_PUBLIC_`. When unset, the assistant shows a "not configured" message; the rest of the app is unaffected. | _unset_ |
| `ASSISTANT_MODEL`            | AI assistant model. | `claude-sonnet-4-6` |
| `ENABLE_AI_ASSISTANT`        | Kill switch — set to `false` to hide the assistant. | `true` |

> **Never commit `.env` / `.env.local` or real API keys.** `.gitignore` already
> excludes them (`.env.example` and the no-secret `.env.production` are the only
> committed env files).

## 5. Run the frontend (web, dev)

```bash
cd Frontend
npm run dev          # → http://localhost:3000
```

With `NEXT_PUBLIC_USE_MOCKS=true` (the default) the UI runs entirely on mock data —
no backend required. Mock auth accepts any email/password.

## 6. Run the backend (standalone, dev)

To exercise the real forecasting/scenario/explainability endpoints, run the API
with the venv active and point the frontend at it (`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`,
`NEXT_PUBLIC_USE_MOCKS=false`):

```bash
cd Backend
# venv active (see step 3)
python backend_main.py          # → http://127.0.0.1:8000  (OpenAPI at /openapi.json)
# or: uvicorn api:app --host 127.0.0.1 --port 8000
```

## 7. Run the Electron desktop app (dev)

Launches the backend (from `Backend/venv`), the Next.js dev server, and the
Electron window together:

```bash
cd Frontend
npm run desktop
```

## 8. Build the Windows package

Windows only. Freeze the backend first, then build the installer + portable exe:

```powershell
# 1. Freeze the FastAPI backend with PyInstaller (venv must have the deps)
powershell -ExecutionPolicy Bypass -File Backend\build_backend.ps1
#    → Backend/dist/backend/backend.exe

# 2. Build the installer + portable build
cd Frontend
npm run desktop:win
#    → Frontend/dist-desktop/TimeLens-Setup.exe  and  TimeLens.exe (portable)
```

See [`DESKTOP.md`](DESKTOP.md) for the full Windows packaging walkthrough.

## 9. Build the macOS package

macOS only. Freeze the backend, then build the `.app` + `.dmg`:

```bash
cd Frontend
npm run desktop:mac
#    → Frontend/dist-desktop/TimeLens-<arch>.dmg  (+ .zip, .app)
```

This is automated in CI by [`.github/workflows/build-macos.yml`](.github/workflows/build-macos.yml).

---

## Available npm scripts (run from `Frontend/`)

| Script               | Action |
|----------------------|--------|
| `npm run dev`        | Next.js dev server (web) |
| `npm run build`      | Production web build |
| `npm run type-check` | TypeScript check (`tsc --noEmit`) |
| `npm run lint`       | ESLint |
| `npm run desktop`    | Backend + frontend + Electron (dev) |
| `npm run desktop:win`| Windows installer + portable build |
| `npm run desktop:mac`| macOS `.app` + `.dmg` build |

---

## Project layout

```
Time_Lens/
├── Frontend/          # Next.js 15 app + Electron shell
│   ├── src/           # app routes, features, components, lib
│   ├── electron/      # main.js, preload.js, backend-launcher.js, after-pack.js
│   ├── scripts/       # prepare-standalone.mjs (web bundle for packaging)
│   ├── .env.example   # env template (copy to .env.local)
│   └── package.json   # scripts + electron-builder config
├── Backend/           # Python forecasting / scenario / explainability engine
│   ├── api.py         # FastAPI app (REST bridge to the engine)
│   ├── backend_main.py# frozen-friendly uvicorn entry (PyInstaller)
│   ├── requirements.txt / requirements_fixed.txt
│   └── backend.spec / build_backend.ps1   # PyInstaller packaging
├── DESKTOP.md         # Windows desktop packaging guide
└── .nvmrc             # Node version pin (20)
```

## Data storage

The backend persists to a writable user-data directory (`TIMELENS_DATA_DIR`,
set to `%APPDATA%/Time Lens` by the desktop shell): `api_bridge.db` (datasets,
forecasts, scenarios, reports), `api_data/` (uploaded files), and
`dhisha_segments.db` (segmentation). Uninstalling the desktop app leaves user
data intact.

## Troubleshooting

- **Assistant shows "not configured"** — set `ANTHROPIC_API_KEY` in `Frontend/.env.local` (web) or as an OS env var / `.env` beside the packaged app's resources (desktop).
- **Login fails / "No mock handler"** — you ran a production/desktop build against mocks. Set `NEXT_PUBLIC_USE_MOCKS=false` and `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` with the backend running.
- **`npm run desktop` can't start the backend** — ensure `Backend/venv` exists with `pip install -r requirements.txt` completed.
- **PyInstaller `ModuleNotFoundError` at runtime** — add the module to `HIDDEN_IMPORTS` in `Backend/backend.spec` and rebuild.
