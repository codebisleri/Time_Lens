"""
DhishaAI Time Lens — FastAPI Bridge
═══════════════════════════════════════════════════════════════════════════════

A thin REST layer that exposes the EXISTING forecasting engine (app_v2_6.py) to
the Next.js frontend. It does NOT reimplement any forecasting logic — it imports
and calls the engine's pure functions:

    _read_bytes_to_df   → parse uploaded CSV/Excel/Parquet/JSON
    profile_all_skus    → per-SKU intermittency / segment / routing profile
    build_panel_features→ long feature panel used by the forecaster
    forecast_one_sku    → full 5-stage per-SKU forecast → ForecastResult

Storage is minimal SQLite (`api_bridge.db`) + the raw uploaded files on disk
(`api_data/`). The engine's own segmentation DB (`dhisha_segments.db`) and the
Streamlit UI are left untouched.

Run:
    cd Backend
    venv\\Scripts\\python -m uvicorn api:app --reload --port 8000
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import math
import os
import sqlite3
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import bcrypt
import numpy as np
import pandas as pd

# ── Quiet Streamlit when calling its @st.cache_data-wrapped engine functions
#    outside a Streamlit runtime (they still execute correctly; the warnings
#    about a missing ScriptRunContext are just noise here). ─────────────────────
os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")
import warnings  # noqa: E402
# Bare-mode noise: the engine's @st.cache_data fns run fine without a Streamlit
# runtime; silence the "missing ScriptRunContext" UserWarnings and the
# "MemoryCacheStorageManager" log lines (F.12 #14 — do NOT create a Streamlit
# context; just suppress the expected warnings).
logging.getLogger("streamlit").setLevel(logging.ERROR)
for _ln in ("streamlit", "streamlit.runtime", "streamlit.runtime.caching",
            "streamlit.runtime.caching.cache_data_api",
            "streamlit.runtime.scriptrunner_utils.script_run_context",
            "streamlit.runtime.scriptrunner.script_run_context"):
    _lg = logging.getLogger(_ln)
    _lg.setLevel(logging.ERROR)
    _lg.propagate = False
warnings.filterwarnings("ignore", message=".*ScriptRunContext.*")
warnings.filterwarnings("ignore", message=".*missing ScriptRunContext.*")

# Ensure the engine modules (app_v2_6.py, temporal_features.py) import regardless
# of the process working directory.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import app_v2_6 as engine  # noqa: E402  — heavy import: the forecasting engine
import scenario_engine  # noqa: E402  — Scenario causal (DoWhy) service, parity extract


# ── Headless Streamlit shim ───────────────────────────────────────────────────
# The engine's single-series competition (TimeSeriesForecaster.forecast) emits
# st.info/warning/success/spinner and probes st.session_state. Outside a Streamlit
# runtime those can warn or raise. We neutralize them by pointing engine.st at a
# no-op shim AFTER import — @st.cache_data decorators were already applied with
# the real streamlit at decoration time, so caching is unaffected; only runtime
# st.* lookups inside engine functions resolve to these no-ops. The engine source
# is NOT modified.
class _NoopStreamlit:
    class _NoopCtx:
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False

    def __init__(self):
        self.session_state = {}

    def spinner(self, *_a, **_k):
        return self._NoopCtx()

    def __getattr__(self, _name):
        # Any other st.* attribute → a callable that no-ops and returns a no-op
        # context manager (covers st.status/progress/etc. used as CMs too).
        def _noop(*_a, **_k):
            return _NoopStreamlit._NoopCtx()
        return _noop


try:
    engine.st = _NoopStreamlit()  # type: ignore[attr-defined]
except Exception:  # pragma: no cover — engine without an `st` attribute
    pass

from fastapi import FastAPI, File, Header, HTTPException, Query, Response, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

# ──────────────────────────────────────────────────────────────────────────────
# Paths & storage
# ──────────────────────────────────────────────────────────────────────────────
# Data + DB live under a USER-WRITABLE home so a packaged install (Program Files,
# which is read-only for standard users) can still persist datasets/forecasts/
# scenarios/submissions. The Electron launcher sets TIMELENS_DATA_DIR to
# %APPDATA%/Time Lens; in dev (unset) it falls back to the source tree so nothing
# changes for `python api.py`.
_DATA_HOME = os.environ.get("TIMELENS_DATA_DIR") or BASE_DIR
os.makedirs(_DATA_HOME, exist_ok=True)
DATA_DIR = os.path.join(_DATA_HOME, "api_data")
DB_PATH = os.path.join(_DATA_HOME, "api_bridge.db")
os.makedirs(DATA_DIR, exist_ok=True)

# How many SKUs a single /forecasts/run processes by default (kept small so the
# synchronous request returns quickly). Override per-request via `limit`.
DEFAULT_RUN_LIMIT = 12
MAX_RUN_LIMIT = 60

# In-process cache of profile tables, keyed by dataset id (datasets are
# immutable once uploaded, so this never goes stale).
_PROFILE_CACHE: Dict[str, pd.DataFrame] = {}

# In-memory registry of async forecast jobs (the engine is slow — minutes — so
# /forecasts/run kicks off a background thread and returns a job to poll, well
# under the frontend's HTTP timeout). Cleared on process restart.
_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _job_update(job_id: str, **updates: Any) -> None:
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(updates)


def _job_get(job_id: str) -> Optional[Dict[str, Any]]:
    with _JOBS_LOCK:
        return dict(_JOBS[job_id]) if job_id in _JOBS else None


class _Heartbeat:
    """Background liveness ticker for long, opaque computations (e.g. a single
    SKU's multi-model competition, or global-model training). It runs in its own
    daemon thread and ONLY emits cosmetic job status — it never touches the
    forecast computation, its inputs, or its outputs, so forecast parity is fully
    preserved. The actual work keeps running synchronously in the worker thread;
    this observer just keeps `progress`/`message` advancing so the UI never looks
    frozen during a long stage.

    Progress is eased *within* the current step's band [base, ceil] and capped
    below the ceiling, so the heartbeat can never claim a step is complete — the
    worker sets the exact boundary value when the step actually finishes.
    """

    def __init__(self, job_id: str, stages: List[str], interval: float = 1.2):
        self._job_id = job_id
        self._stages = stages or ["Working"]
        self._interval = interval
        self._lock = threading.Lock()
        self._active = True
        self._t0 = time.monotonic()
        self._base = 0.0
        self._ceil = 0.0
        self._label = ""
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "_Heartbeat":
        self._thread.start()
        return self

    def step(self, label: str, base: float, ceil: float) -> None:
        """Begin a new step: `label` is the prefix shown to the user; progress
        eases from `base`→`ceil` (each a 0..1 fraction of the whole run)."""
        with self._lock:
            self._label = label
            self._base = max(0.0, min(1.0, base))
            self._ceil = max(self._base, min(1.0, ceil))
            self._t0 = time.monotonic()

    def stop(self) -> None:
        with self._lock:
            self._active = False

    def _run(self) -> None:
        tick = 0
        while True:
            time.sleep(self._interval)
            with self._lock:
                if not self._active:
                    return
                base, ceil, label, t0 = self._base, self._ceil, self._label, self._t0
            tick += 1
            elapsed = time.monotonic() - t0
            # Smooth saturating ease toward the ceiling (never reaches it).
            frac = 1.0 - 0.5 ** (elapsed / 7.0)
            prog = base + (ceil - base) * min(frac, 0.92)
            stage = self._stages[tick % len(self._stages)]
            secs = int(elapsed)
            msg = f"{label} — {stage}…" if label else f"{stage}…"
            if secs >= 2:
                msg = f"{msg} ({secs}s)"
            _job_update(self._job_id, progress=int(prog * 100), message=msg)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS datasets (
                id             TEXT PRIMARY KEY,
                file_name      TEXT,
                stored_path    TEXT,
                row_count      INTEGER,
                sku_count      INTEGER,
                sku_col        TEXT,
                date_col       TEXT,
                sales_col      TEXT,
                category_col   TEXT,
                price_col      TEXT,
                freq           TEXT,
                freq_label     TEXT,
                date_start     TEXT,
                date_end       TEXT,
                missing_values INTEGER,
                duplicate_rows INTEGER,
                invalid_dates  INTEGER,
                outlier_count  INTEGER,
                columns_json   TEXT,
                status         TEXT,
                uploaded_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS forecast_runs (
                id          TEXT PRIMARY KEY,
                dataset_id  TEXT,
                horizon     TEXT,
                freq        TEXT,
                periods     INTEGER,
                sku_count   INTEGER,
                status      TEXT,
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS forecasts (
                id                    TEXT PRIMARY KEY,
                run_id                TEXT,
                dataset_id            TEXT,
                sku                   TEXT,
                sku_code              TEXT,
                sku_name              TEXT,
                category              TEXT,
                model                 TEXT,
                horizon               TEXT,
                accuracy              REAL,
                mape                  REAL,
                smape                 REAL,
                bias                  REAL,
                total_forecast_units  REAL,
                generated_at          TEXT,
                detail_json           TEXT
            );

            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY,
                name          TEXT NOT NULL,
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT DEFAULT 'planner',
                created_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS workflow_state (
                id                INTEGER PRIMARY KEY CHECK (id = 1),
                dataset_id        TEXT,
                dataset_uploaded  INTEGER DEFAULT 0,
                eda_completed     INTEGER DEFAULT 0,
                profile_completed INTEGER DEFAULT 0,
                forecast_completed INTEGER DEFAULT 0,
                review_completed  INTEGER DEFAULT 0,
                updated_at        TEXT
            );

            CREATE TABLE IF NOT EXISTS submission_rows (
                id                   TEXT PRIMARY KEY,
                dataset_id           TEXT,
                run_id               TEXT,
                sku                  TEXT,
                forecast_month       TEXT,
                product_name         TEXT,
                category             TEXT,
                brand                TEXT,
                segment              TEXT,
                strategy             TEXT,
                mape                 REAL,
                model_forecast       REAL,
                submitted_forecast   REAL,
                last_year_same_month REAL,
                last_3mo_avg         REAL,
                mom_pct              REAL,
                yoy_pct              REAL,
                delta_vs_model_pct   REAL,
                reason               TEXT,
                notes                TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_submission_rows_run ON submission_rows(run_id);
            CREATE INDEX IF NOT EXISTS idx_submission_rows_ds ON submission_rows(dataset_id);

            CREATE TABLE IF NOT EXISTS submission_batches (
                id             TEXT PRIMARY KEY,
                dataset_id     TEXT,
                run_id         TEXT,
                submitted_at   TEXT,
                submitter      TEXT,
                notes          TEXT,
                override_count INTEGER,
                total_rows     INTEGER,
                total_units    REAL,
                pct_change     REAL
            );

            CREATE TABLE IF NOT EXISTS reports (
                id           TEXT PRIMARY KEY,
                dataset_id   TEXT,
                type         TEXT,
                title        TEXT,
                status       TEXT,
                html         TEXT,
                meta_json    TEXT,
                generated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_reports_ds ON reports(dataset_id);

            CREATE TABLE IF NOT EXISTS user_workflow (
                user_id            TEXT PRIMARY KEY,
                dataset_id         TEXT,
                dataset_uploaded   INTEGER DEFAULT 0,
                eda_completed      INTEGER DEFAULT 0,
                profile_completed  INTEGER DEFAULT 0,
                forecast_completed INTEGER DEFAULT 0,
                review_completed   INTEGER DEFAULT 0,
                updated_at         TEXT
            );

            CREATE TABLE IF NOT EXISTS single_sku_runs (
                id           TEXT PRIMARY KEY,
                dataset_id   TEXT,
                owner        TEXT,
                sku          TEXT,
                payload_json TEXT,
                created_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_single_sku_ds ON single_sku_runs(dataset_id);

            CREATE TABLE IF NOT EXISTS scenarios (
                id               TEXT PRIMARY KEY,
                dataset_id       TEXT,
                owner            TEXT,
                name             TEXT,
                sku              TEXT,
                adjustments_json TEXT,
                result_json      TEXT,
                created_at       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_scenarios_ds ON scenarios(dataset_id);
            """
        )
        # Single-row workflow state (id = 1), created once.
        conn.execute(
            "INSERT OR IGNORE INTO workflow_state (id, updated_at) VALUES (1, ?)",
            (now_iso(),),
        )

        # Lightweight migration: CREATE TABLE IF NOT EXISTS won't add columns
        # introduced later, so an existing api_bridge.db keeps its old schema.
        # Add any missing dataset columns idempotently (additive, non-breaking).
        existing = {r[1] for r in conn.execute("PRAGMA table_info(datasets)").fetchall()}
        for col, decl in (
            ("category_col", "TEXT"),
            ("price_col", "TEXT"),
            ("freq_label", "TEXT"),
            ("missing_values", "INTEGER"),
            ("duplicate_rows", "INTEGER"),
            ("invalid_dates", "INTEGER"),
            ("outlier_count", "INTEGER"),
            ("columns_json", "TEXT"),
            ("config_json", "TEXT"),
            ("owner", "TEXT"),  # authenticated user that uploaded the dataset
        ):
            if col not in existing:
                conn.execute(f"ALTER TABLE datasets ADD COLUMN {col} {decl}")

        # Per-run config (reconcile/useGlobal flags + stored reconciliation payload).
        run_cols = {r[1] for r in conn.execute("PRAGMA table_info(forecast_runs)").fetchall()}
        if "config_json" not in run_cols:
            conn.execute("ALTER TABLE forecast_runs ADD COLUMN config_json TEXT")

    _seed_admin_user()
    _seed_test_users()


# ──────────────────────────────────────────────────────────────────────────────
# Auth: bcrypt password hashing + stateless HMAC bearer tokens
# ──────────────────────────────────────────────────────────────────────────────
# Token signing secret. Override via TIMELENS_AUTH_SECRET in production so tokens
# can't be forged; the default keeps local/demo runs working out of the box.
_AUTH_SECRET = os.environ.get(
    "TIMELENS_AUTH_SECRET", "timelens-dev-secret-change-me"
).encode()
# Optional admin bootstrap — credentials come from the environment, never the
# source tree. Set both TIMELENS_ADMIN_EMAIL and TIMELENS_ADMIN_PASSWORD to seed
# a single admin on startup (e.g. for first-run/provisioning). Unset → no seeded
# account (real users are created via /auth/register or the production IdP).
SEED_ADMIN_EMAIL = os.environ.get("TIMELENS_ADMIN_EMAIL")
SEED_ADMIN_PASSWORD = os.environ.get("TIMELENS_ADMIN_PASSWORD")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def make_token(user_id: int) -> str:
    """Stateless bearer token: '<id>.<hmac>'. No sessions table needed."""
    uid = str(user_id)
    sig = hmac.new(_AUTH_SECRET, uid.encode(), hashlib.sha256).hexdigest()
    return f"{uid}.{sig}"


def parse_token(token: Optional[str]) -> Optional[int]:
    if not token:
        return None
    raw = token[7:] if token.lower().startswith("bearer ") else token
    parts = raw.split(".")
    if len(parts) != 2:
        return None
    uid, sig = parts
    expected = hmac.new(_AUTH_SECRET, uid.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        return int(uid)
    except ValueError:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Per-request authenticated user (data isolation). Set by an ASGI middleware from
# the bearer token; read by dataset/workflow lookups so each user only ever sees
# their OWN active dataset + workflow. No change to auth logic — we only READ the
# already-issued token here.
# ──────────────────────────────────────────────────────────────────────────────
_CURRENT_UID: ContextVar[Optional[int]] = ContextVar("current_uid", default=None)


def _current_uid() -> Optional[str]:
    uid = _CURRENT_UID.get()
    return str(uid) if uid is not None else None


def _seed_admin_user() -> None:
    """Seed a single admin ONLY when both TIMELENS_ADMIN_EMAIL and
    TIMELENS_ADMIN_PASSWORD are provided via the environment (idempotent).
    No credentials are hardcoded; unset env → nothing is seeded."""
    if not (SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD):
        return
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT 1 FROM users WHERE email = ?", (SEED_ADMIN_EMAIL,)
        ).fetchone()
        if existing:
            return
        conn.execute(
            """INSERT INTO users (name, email, password_hash, role, created_at)
               VALUES (?,?,?,?,?)""",
            ("Admin", SEED_ADMIN_EMAIL, hash_password(SEED_ADMIN_PASSWORD),
             "admin", now_iso()),
        )


# Dummy users for authentication / role-based testing. Inserted idempotently via
# the same users-table + hash_password path used by /auth/register — no auth
# logic or schema changes. (name, email, password, role)
_TEST_USERS = [
    ("Forecast Manager", "forecast.manager@dhishaai.com", "Password@123", "Admin"),
    ("Demand Planner", "demand.planner@dhishaai.com", "Password@123", "Planner"),
    ("Business Analyst", "business.analyst@dhishaai.com", "Password@123", "Analyst"),
    ("Operations Lead", "operations.lead@dhishaai.com", "Password@123", "Manager"),
    ("Demo User", "demo.user@dhishaai.com", "Password@123", "Viewer"),
]


def _seed_test_users() -> None:
    """Insert the dummy test users once (idempotent). Emails are stored lowercase
    to match the login lookup. Adds records only — touches no auth logic."""
    with get_conn() as conn:
        # Retire the legacy @timelens.com demo accounts (F.9 1.1 — dhishaai.com only).
        conn.execute("DELETE FROM users WHERE email LIKE '%@timelens.com'")
        for name, email, password, role in _TEST_USERS:
            email = email.strip().lower()
            if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                continue
            conn.execute(
                """INSERT INTO users (name, email, password_hash, role, created_at)
                   VALUES (?,?,?,?,?)""",
                (name, email, hash_password(password), role, now_iso()),
            )


def user_row_to_json(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "role": row["role"],
        "createdAt": row["created_at"],
    }


# ──────────────────────────────────────────────────────────────────────────────
# Workflow state — persisted stage progression (mirrors Streamlit's stateful tabs)
# ──────────────────────────────────────────────────────────────────────────────
_WORKFLOW_FLAGS = (
    "dataset_uploaded",
    "eda_completed",
    "profile_completed",
    "forecast_completed",
    "review_completed",
)
_WORKFLOW_LOCK = threading.Lock()


_EMPTY_WORKFLOW = {
    "datasetId": None,
    "datasetUploaded": False,
    "edaCompleted": False,
    "profileCompleted": False,
    "forecastCompleted": False,
    "reviewCompleted": False,
}


def workflow_get(user_id: Optional[str] = None) -> Dict[str, Any]:
    """Per-user workflow state. A user with no row (e.g. a brand-new account that
    hasn't uploaded) gets the all-false empty workflow → everything stays locked."""
    user_id = user_id or _current_uid()
    if user_id is None:
        return dict(_EMPTY_WORKFLOW)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM user_workflow WHERE user_id = ?", (user_id,)
        ).fetchone()
    if row is None:
        return dict(_EMPTY_WORKFLOW)
    return {
        "datasetId": row["dataset_id"],
        "datasetUploaded": bool(row["dataset_uploaded"]),
        "edaCompleted": bool(row["eda_completed"]),
        "profileCompleted": bool(row["profile_completed"]),
        "forecastCompleted": bool(row["forecast_completed"]),
        "reviewCompleted": bool(row["review_completed"]),
    }


def workflow_set(user_id: Optional[str] = None, **flags: Any) -> None:
    """Set workflow flags (snake_case keys) + optional dataset_id for ONE user.
    user_id defaults to the request's authenticated user; the background forecast
    worker (no request context) passes the dataset owner explicitly. No-ops when
    no user can be resolved. Thread-safe."""
    user_id = user_id or _current_uid()
    if user_id is None:
        return
    cols, vals = [], []
    for key, value in flags.items():
        if key in _WORKFLOW_FLAGS:
            cols.append(f"{key} = ?")
            vals.append(1 if value else 0)
        elif key == "dataset_id":
            cols.append("dataset_id = ?")
            vals.append(value)
    if not cols:
        return
    cols.append("updated_at = ?")
    vals.append(now_iso())
    with _WORKFLOW_LOCK, get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO user_workflow (user_id, updated_at) VALUES (?, ?)",
            (user_id, now_iso()),
        )
        conn.execute(
            f"UPDATE user_workflow SET {', '.join(cols)} WHERE user_id = ?",
            vals + [user_id],
        )


def workflow_reset_for_new_dataset(dataset_id: str, user_id: Optional[str] = None) -> None:
    """A fresh upload restarts the pipeline for that user: dataset uploaded,
    everything else cleared (re-run EDA → Profile → Forecast → Review)."""
    workflow_set(
        user_id,
        dataset_id=dataset_id,
        dataset_uploaded=True,
        eda_completed=False,
        profile_completed=False,
        forecast_completed=False,
        review_completed=False,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Small helpers
# ──────────────────────────────────────────────────────────────────────────────
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_float(value: Any) -> Optional[float]:
    """JSON-safe float: NaN / inf → None."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def iso_date(value: Any) -> Optional[str]:
    try:
        ts = pd.Timestamp(value)
    except (ValueError, TypeError):
        return None
    if pd.isna(ts):
        return None
    return ts.isoformat()


# Column auto-detection — tolerant of the various retail CSV shapes shipped in
# Data_for_forecast/ (date / latest_sku / sales) and common alternatives.
_SKU_HINTS = ["latest_sku", "sku_id", "sku", "item_id", "item", "product_id",
              "product", "material", "style", "code"]
_DATE_HINTS = ["date", "period", "month", "week", "ds", "timestamp", "time"]
_SALES_HINTS = ["sales", "qty", "quantity", "units", "demand", "volume",
                "y", "value", "revenue", "amount"]
_CATEGORY_HINTS = ["category", "segment", "department", "class", "family",
                   "group", "cat"]
_PRICE_HINTS = ["unit_price", "list_price", "avg_selling_price", "price",
                "mrp", "cost", "amount"]


def _pick_column(columns: List[str], hints: List[str]) -> Optional[str]:
    lower = {c.lower(): c for c in columns}
    # Exact hint match first, then substring match.
    for h in hints:
        if h in lower:
            return lower[h]
    for h in hints:
        for lc, orig in lower.items():
            if h in lc:
                return orig
    return None


def detect_columns(df: pd.DataFrame) -> Dict[str, str]:
    cols = list(df.columns.astype(str))
    sku_col = _pick_column(cols, _SKU_HINTS)
    date_col = _pick_column(cols, _DATE_HINTS)
    sales_col = _pick_column(cols, _SALES_HINTS)

    # Fallbacks: first datetime-parseable column for date; first numeric for sales.
    if date_col is None:
        for c in cols:
            parsed = _parse_dates(df[c])
            if parsed.notna().mean() > 0.8:
                date_col = c
                break
    if sales_col is None:
        for c in cols:
            if c not in (sku_col, date_col) and pd.api.types.is_numeric_dtype(df[c]):
                sales_col = c
                break
    if sku_col is None:
        for c in cols:
            if c not in (date_col, sales_col):
                sku_col = c
                break

    missing = [n for n, v in {"sku": sku_col, "date": date_col, "sales": sales_col}.items() if v is None]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Could not detect required column(s): {', '.join(missing)}. "
                   f"Columns found: {cols}",
        )
    return {"sku_col": sku_col, "date_col": date_col, "sales_col": sales_col}


# Data-page "Date format" labels → strftime, mirroring the Streamlit cfg
# `date_format_options` (app_v2_6.py). 'Auto-detect'/'Custom...'/None map to
# None → the caller infers the format the same way Streamlit does.
_DATE_FORMAT_STRPTIME = {
    "DD-MM-YYYY": "%d-%m-%Y",
    "MM-DD-YYYY": "%m-%d-%Y",
    "YYYY-MM-DD": "%Y-%m-%d",
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
    "YYYY/MM/DD": "%Y/%m/%d",
    "DD-MMM-YY": "%d-%b-%y",
    "MMM-YY": "%b-%y",
    "YYYY-MM": "%Y-%m",
}


def _resolve_date_format(cfg_or_label: Any) -> Optional[str]:
    """Map the configured Date-format selection to a concrete strftime string.
    Accepts either the raw label or the full config dict. 'Custom...' uses the
    planner-supplied `dateFormatCustom` strftime (Streamlit's custom text input);
    'Auto-detect'/None/unrecognized → None (caller infers). Mirrors Streamlit's
    date_format_options resolution exactly."""
    if isinstance(cfg_or_label, dict):
        label = cfg_or_label.get("dateFormat")
        custom = cfg_or_label.get("dateFormatCustom")
    else:
        label, custom = cfg_or_label, None
    if not label or label == "Auto-detect":
        return None
    if label == "Custom...":
        custom = str(custom or "").strip()
        return custom or None
    return _DATE_FORMAT_STRPTIME.get(label)


def _parse_dates(series: pd.Series, date_format: Optional[str] = None) -> pd.Series:
    """Parse a date column exactly the way the Streamlit engine does:
    an explicit strftime when one is configured, else infer via the engine's
    `_smart_detect_date_format` (resolves ISO + the DD/MM-vs-MM/DD ambiguity),
    else fall back to `dayfirst=True` (DD-MM-YYYY). This keeps ISO dates
    unambiguous while preventing monthly DD-MM dates like '01-12-2024' from
    being mis-read as Jan-12 (the prior month-first default)."""
    if date_format:
        parsed = pd.to_datetime(series, format=date_format, errors="coerce")
        # A wrong explicit format would null nearly everything — fall through.
        if parsed.notna().mean() >= 0.5:
            return parsed
    inferred = None
    try:
        inferred = engine._smart_detect_date_format(series)
    except Exception:
        inferred = None
    if inferred:
        parsed = pd.to_datetime(series, format=inferred, errors="coerce")
        if parsed.notna().mean() >= 0.5:
            return parsed
    return pd.to_datetime(series, dayfirst=True, errors="coerce")


def coerce_types(df: pd.DataFrame, date_col: str, sales_col: str,
                 date_format: Optional[str] = None) -> pd.DataFrame:
    out = df.copy()
    out[date_col] = _parse_dates(out[date_col], date_format)
    out[sales_col] = pd.to_numeric(out[sales_col], errors="coerce")
    out = out.dropna(subset=[date_col])
    out[sales_col] = out[sales_col].fillna(0.0)
    return out


def detect_freq(df: pd.DataFrame, date_col: str) -> str:
    try:
        code = engine._detect_period_frequency(df[date_col])[0]
    except Exception:
        code = "MS"
    return code if code in {"D", "W", "MS", "QS", "YS"} else "MS"


def detect_freq_label(df: pd.DataFrame, date_col: str) -> str:
    try:
        return str(engine._detect_period_frequency(df[date_col])[1])
    except Exception:
        return "Unknown"


def compute_validation(df_raw: pd.DataFrame, date_col: str,
                       sales_col: str) -> Dict[str, int]:
    """Cheap data-quality metrics for the Data Preparation view, computed on the
    raw (pre-coercion) frame so it reflects what the user uploaded."""
    parsed = _parse_dates(df_raw[date_col])
    invalid_dates = int(parsed.isna().sum())
    missing_values = int(df_raw.isna().sum().sum())
    duplicate_rows = int(df_raw.duplicated().sum())
    sales = pd.to_numeric(df_raw[sales_col], errors="coerce").dropna()
    outlier_count = 0
    if len(sales) >= 8:
        q1, q3 = sales.quantile(0.25), sales.quantile(0.75)
        iqr = q3 - q1
        if iqr > 0:
            lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            outlier_count = int(((sales < lo) | (sales > hi)).sum())
    return {
        "missing_values": missing_values,
        "duplicate_rows": duplicate_rows,
        "invalid_dates": invalid_dates,
        "outlier_count": outlier_count,
    }


# Display label + algorithm "family" per engine strategy, for the workflow UI.
_STRATEGY_LABELS: Dict[str, Dict[str, str]] = {
    "naive_zero": {"label": "Naive (zero)", "family": "Naive"},
    "chronos_zero_shot": {"label": "Chronos (zero-shot)", "family": "Chronos"},
    "croston_sba": {"label": "Croston / SBA", "family": "Croston"},
    "local_sarimax_promo": {"label": "SARIMAX + promo", "family": "SARIMAX"},
    "ensemble_local": {"label": "Local ensemble", "family": "Ensemble"},
    "global_lgbm": {"label": "Global LightGBM", "family": "Global"},
    "global_lgbm_full": {"label": "Global LightGBM", "family": "Global"},
}


def strategy_label(strategy: str) -> str:
    return _STRATEGY_LABELS.get(strategy, {}).get(
        "label", strategy.replace("_", " ").title())


def strategy_family(strategy: str) -> str:
    return _STRATEGY_LABELS.get(strategy, {}).get("family", "Other")


def volatility_band(cv: Optional[float]) -> str:
    if cv is None or (isinstance(cv, float) and math.isnan(cv)):
        return "low"
    return "high" if cv >= 1.0 else "medium" if cv >= 0.5 else "low"


def freq_to_horizon(freq: str) -> str:
    return {"W": "weekly", "MS": "monthly", "QS": "quarterly"}.get(freq, "monthly")


def map_model(strategy: str) -> str:
    """Map an engine strategy label onto the frontend ForecastModel union."""
    s = (strategy or "").lower()
    if "prophet" in s:
        return "prophet"
    if "sarimax" in s or "arima" in s:
        return "arima"
    if "holt" in s or "ets" in s or "expon" in s:
        return "ets"
    if any(k in s for k in ("croston", "sba", "tsb", "naive", "moving", "seasonal")):
        return "moving_average"
    return "ensemble"


def sku_status(profile_row: Dict[str, Any]) -> str:
    """Map an engine profile onto the frontend SkuStatus union."""
    if profile_row.get("is_cold_start"):
        return "new"
    if str(profile_row.get("intermittency", "")).lower() == "dead":
        return "inactive"
    return "active"


# ──────────────────────────────────────────────────────────────────────────────
# Dataset load / profile (reusing the engine)
# ──────────────────────────────────────────────────────────────────────────────
def load_dataset_row(dataset_id: str) -> sqlite3.Row:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found")
    return row


def latest_dataset_id(owner: Optional[str] = None) -> Optional[str]:
    """The active dataset for the current (or given) user. Data isolation: with
    no resolvable user, returns None — so an unauthenticated/new caller has no
    active dataset rather than inheriting someone else's."""
    owner = owner if owner is not None else _current_uid()
    if owner is None:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM datasets WHERE owner = ? ORDER BY uploaded_at DESC LIMIT 1",
            (owner,),
        ).fetchone()
    return row["id"] if row else None


def load_dataset_df(row: sqlite3.Row) -> pd.DataFrame:
    """Re-parse the stored upload via the engine's own reader, then coerce types."""
    with open(row["stored_path"], "rb") as fh:
        raw = fh.read()
    df = engine._read_bytes_to_df(row["file_name"], raw)
    if df is None or df.empty:
        raise HTTPException(status_code=422, detail="Stored dataset could not be parsed")
    # Honor the configured Date format (Auto-detect → engine smart-detect/dayfirst),
    # so the parsed date axis matches Streamlit everywhere downstream.
    date_format = _resolve_date_format(_resolve_config(row))
    return coerce_types(df, row["date_col"], row["sales_col"], date_format)


def _apply_history_window(df: pd.DataFrame, date_col: str,
                          cfg: Optional[Dict[str, Any]]) -> pd.DataFrame:
    """Drop rows before the configured history start — mirrors the Streamlit
    profile/forecast prep (`df = df[df[date_col] >= history_start_date]`).
    No-op when useFullHistory is true or no start is set. NOT applied to EDA
    (the Streamlit EDA tab analyses the full uploaded series)."""
    if not cfg or cfg.get("useFullHistory", True):
        return df
    start = cfg.get("historyStart")
    if not start:
        return df
    try:
        ts = pd.Timestamp(start)
    except (ValueError, TypeError):
        return df
    col = pd.to_datetime(df[date_col], errors="coerce")
    return df[col >= ts].copy()


def get_profiles(row: sqlite3.Row) -> pd.DataFrame:
    """Per-SKU profile table (cached per dataset + thresholds). Reuses
    engine.profile_all_skus, threading the configured cold-start / short-history
    routing thresholds so the routing (recommended_strategy, is_cold_start,
    is_short_history) reflects the user's settings — Streamlit cfg cold_thr /
    short_thr parity."""
    ds_id = row["id"]
    cfg = _resolve_config(row)
    cold = int(min(max(int(cfg.get("coldStartMonths") or 6), 1), 24))
    short = int(min(max(int(cfg.get("shortHistoryMonths") or 12), 1), 36))
    hist = None if cfg.get("useFullHistory", True) else cfg.get("historyStart")
    key = (ds_id, cold, short, hist)
    if key in _PROFILE_CACHE:
        return _PROFILE_CACHE[key]
    df = load_dataset_df(row)
    df = _apply_history_window(df, row["date_col"], cfg)
    profiles = engine.profile_all_skus(
        df,
        sku_col=row["sku_col"],
        sales_col=row["sales_col"],
        date_col=row["date_col"],
        segment_col="",   # engine auto-detects 'segment'/'brand' if present
        brand_col="",
        cold_start_threshold=cold,
        short_history_threshold=short,
    )
    _PROFILE_CACHE[key] = profiles
    return profiles


# ============================================================================
# F.7 — Configuration & Preparation engine parity (ported VERBATIM from the
# updated Streamlit source app_v2_6 (1).py so forecast EXECUTION matches it):
#   • Unified outlier cleaning   (app_v2_6 (1).py:1817-1902)
#   • Forecast-level aggregation (app_v2_6 (1).py:621-724)
#   • Top-down routing           (app_v2_6 (1).py:4166-4378)
# These run in the bridge forecast workers, gated by the persisted config, so a
# config change provably changes forecast output. Pure-pandas helpers; the only
# external dep is statsmodels' ExponentialSmoothing (already an engine dep).
# ============================================================================

try:  # statsmodels is an engine dependency; guard so api still imports without it
    from statsmodels.tsa.holtwinters import ExponentialSmoothing as _ExpSmoothing  # noqa: E402
except Exception:  # pragma: no cover
    _ExpSmoothing = None

FORECAST_ENTITY_COL = "__forecast_entity__"

_PERIOD_LEVEL_COLS = {
    "days", "days_in_month", "month", "quarter", "year", "week", "weekofyear",
    "peak_month", "festive", "other_imp_festivals", "scheme_days",
    "holiday_days", "weekends", "promo_flag", "promo_days", "price_band",
    "is_festive", "is_peak",
}

_OUTLIER_EXPLAIN_COLS = {
    "festive", "is_festive", "other_imp_festivals", "peak_month", "is_peak",
    "scheme_days", "promo_flag", "promo_days", "promo_intensity",
    "holiday_days", "is_holiday", "price_changed", "discount",
}


def _resolve_outlier_explain_cols(columns, extra=None) -> List[str]:
    """Explanatory flag columns present in `columns` (app_v2_6 (1).py:1824)."""
    cols = list(columns)
    low = {str(c).lower(): c for c in cols}
    out = [low[k] for k in _OUTLIER_EXPLAIN_COLS if k in low]
    out += [c for c in cols if str(c).lower().startswith("evt_")]
    for c in (extra or []):
        if c in cols and c not in out:
            out.append(c)
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def apply_unified_outlier_treatment(panel: pd.DataFrame, sku_col: str,
                                    sales_col: str, k_iqr: float = 3.0,
                                    explain_cols: Optional[List[str]] = None
                                    ) -> Tuple[pd.DataFrame, int, int]:
    """Per-entity robust IQR fence; clip unexplained spikes (app_v2_6 (1).py:1841)."""
    if sku_col not in panel.columns or sales_col not in panel.columns:
        return panel, 0, 0
    explain_cols = explain_cols or []
    vals = panel[sales_col].astype(float)

    explained = pd.Series(False, index=panel.index)
    for c in explain_cols:
        if c not in panel.columns:
            continue
        col = panel[c]
        if pd.api.types.is_numeric_dtype(col):
            explained |= col.fillna(0).abs() > 0
        else:
            explained |= (col.notna() & col.astype(str).str.strip().str.lower()
                          .isin(["1", "true", "yes", "y", "t"]))

    grp = vals.groupby(panel[sku_col])
    med = grp.transform("median")
    q1 = grp.transform(lambda s: s.quantile(0.25))
    q3 = grp.transform(lambda s: s.quantile(0.75))
    iqr = (q3 - q1)
    n = grp.transform("size")
    upper = med + k_iqr * iqr
    lower = (med - k_iqr * iqr).clip(lower=0)

    eligible = (iqr > 0) & (n >= 8)
    candidate = eligible & ((vals > upper) | (vals < lower))
    treat = candidate & (~explained)

    if treat.any():
        cleaned = vals.where(~treat, vals.clip(lower=lower, upper=upper))
        panel["sales_raw"] = vals
        panel[sales_col] = cleaned
    else:
        panel["sales_raw"] = vals
    panel["is_outlier"] = treat.astype(int)
    panel["is_event_outlier"] = (candidate & explained).astype(int)
    return panel, int(treat.sum()), int((candidate & explained).sum())


def aggregate_to_forecast_level(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Collapse df to one row per (entity, period) (app_v2_6 (1).py:668)."""
    mode = cfg.get("forecast_level_mode", "sku")
    if mode == "sku":
        return df
    date_col = cfg["date_col"]
    level_cols = list(cfg.get("forecast_level_cols") or [])
    work = df.copy()
    if mode == "overall":
        work[FORECAST_ENTITY_COL] = "All items"
        level_cols = []
    else:
        present = [c for c in level_cols if c in work.columns]
        if not present:
            return df  # misconfigured → fall back to per-SKU
        level_cols = present
        work[FORECAST_ENTITY_COL] = (work[level_cols].astype(str)
                                     .agg(" | ".join, axis=1))
    keys = [FORECAST_ENTITY_COL, date_col]
    agg_map: Dict[str, str] = {}
    for c in work.columns:
        if c in keys:
            continue
        cl = str(c).lower()
        if c in level_cols:
            agg_map[c] = "first"
        elif pd.api.types.is_numeric_dtype(work[c]):
            if "price" in cl or cl in ("promo_intensity", "discount", "margin"):
                agg_map[c] = "mean"
            elif cl in _PERIOD_LEVEL_COLS:
                agg_map[c] = "max"
            else:
                agg_map[c] = "sum"
        else:
            agg_map[c] = "first"
    return work.groupby(keys, as_index=False, sort=False).agg(agg_map)


def resolve_pipeline_cfg(cfg: dict) -> dict:
    """Re-point sku_col → entity key for non-SKU grains (app_v2_6 (1).py:646)."""
    if cfg.get("forecast_level_mode", "sku") == "sku":
        return cfg
    grp = set(cfg.get("forecast_level_cols") or [])
    out = dict(cfg)
    out["sku_col"] = FORECAST_ENTITY_COL
    out["sku_col_source"] = cfg.get("sku_col")
    out["segment_col"] = cfg.get("segment_col") if cfg.get("segment_col") in grp else None
    out["brand_col"] = cfg.get("brand_col") if cfg.get("brand_col") in grp else None
    return out


def _freq_offset(freq: str, n: int):
    f = (freq or "MS").upper()
    if f.startswith("W"):
        return pd.DateOffset(weeks=n)
    if f.startswith("D"):
        return pd.DateOffset(days=n)
    if f.startswith("Q"):
        return pd.DateOffset(months=3 * n)
    if f.startswith("Y") or f.startswith("A"):
        return pd.DateOffset(years=n)
    return pd.DateOffset(months=n)


def robust_series_forecast(hist: pd.Series, horizon: int,
                           freq: str = "MS") -> Optional[pd.Series]:
    """Robust univariate forecast for an aggregated series (app_v2_6 (1).py:4187)."""
    hist = pd.Series(hist).astype(float).dropna()
    if len(hist) < 2:
        return None
    try:
        future_idx = pd.date_range(hist.index[-1], periods=horizon + 1, freq=freq)[1:]
    except Exception:
        future_idx = pd.RangeIndex(len(hist), len(hist) + horizon)
    vals = None
    if _ExpSmoothing is not None:
        try:
            if len(hist) >= 24:
                m = _ExpSmoothing(hist, trend="add", seasonal="add",
                                  seasonal_periods=12,
                                  initialization_method="estimated").fit()
                vals = np.asarray(m.forecast(horizon), dtype=float)
            elif len(hist) >= 12:
                m = _ExpSmoothing(hist, trend="add",
                                  initialization_method="estimated").fit()
                vals = np.asarray(m.forecast(horizon), dtype=float)
            elif len(hist) >= 4:
                m = _ExpSmoothing(hist, initialization_method="estimated").fit()
                vals = np.asarray(m.forecast(horizon), dtype=float)
        except Exception:
            vals = None
    if vals is None or not np.all(np.isfinite(vals)):
        if len(hist) >= 12:
            base = hist.values[-12:]
            vals = np.tile(base, int(np.ceil(horizon / 12)))[:horizon]
        else:
            vals = np.repeat(float(hist.tail(min(6, len(hist))).mean()), horizon)
    vals = np.clip(np.asarray(vals, dtype=float), 0, None)
    n = min(len(vals), len(future_idx))
    return pd.Series(vals[:n], index=future_idx[:n])


def apply_top_down_routing(results: List[Any], profiles: pd.DataFrame,
                           df: pd.DataFrame, cfg: Dict[str, Any], horizon: int):
    """Re-forecast hard-to-forecast SKUs top-down, in place (app_v2_6 (1).py:4235)."""
    summary = {"enabled": False, "n_rerouted": 0, "n_groups": 0,
               "levels": [], "reasons": {}, "note": ""}
    if not cfg.get("top_down_enabled"):
        return results, summary
    levels = [c for c in (cfg.get("top_down_levels") or []) if c in df.columns]
    if not levels:
        summary["note"] = "no valid aggregation-level columns in the data"
        return results, summary
    summary["enabled"] = True
    summary["levels"] = levels
    date_col, sales_col, sku_col = cfg["date_col"], cfg["sales_col"], cfg["sku_col"]
    freq = cfg.get("freq", "MS")
    apply_flags = cfg.get("top_down_apply") or {}
    disagg = cfg.get("top_down_disagg", "Historical average share")
    noisy_cv2 = float(cfg.get("top_down_noisy_cv2", 0.5))

    prof = profiles.set_index("sku")

    def _qualifies(sku):
        if sku not in prof.index:
            return None
        p = prof.loc[sku]
        if apply_flags.get("cold") and bool(p.get("is_cold_start", False)):
            return "cold-start"
        if apply_flags.get("lumpy") and str(p.get("intermittency", "")) in (
                "intermittent", "lumpy"):
            return "lumpy/intermittent"
        if apply_flags.get("short") and bool(p.get("is_short_history", False)):
            return "short-history"
        if apply_flags.get("noisy"):
            try:
                if float(p.get("cv2", 0) or 0) >= noisy_cv2:
                    return "noisy"
            except Exception:
                pass
        return None

    dmap = (df[[sku_col] + levels].dropna(subset=[sku_col])
            .drop_duplicates(subset=[sku_col]).set_index(sku_col))

    def _gkey(sku):
        if sku not in dmap.index:
            return None
        row = dmap.loc[sku]
        return " | ".join(str(row[c]) for c in levels)

    df_dt = df.copy()
    df_dt[date_col] = pd.to_datetime(df_dt[date_col], errors="coerce")
    df_dt = df_dt.dropna(subset=[date_col])
    df_dt["__grp__"] = df_dt[levels].astype(str).agg(" | ".join, axis=1)
    sku_tot = df_dt.groupby(sku_col)[sales_col].sum()
    grp_tot = df_dt.groupby("__grp__")[sales_col].sum()
    grp_members = df_dt.groupby("__grp__")[sku_col].nunique()
    try:
        cutoff = df_dt[date_col].max() - _freq_offset(freq, 6)
        recent = df_dt[df_dt[date_col] >= cutoff]
    except Exception:
        recent = df_dt
    recent_sku_tot = recent.groupby(sku_col)[sales_col].sum()
    recent_grp_tot = recent.groupby("__grp__")[sales_col].sum()

    def _share(sku, gkey):
        if disagg == "Equal share within group":
            return 1.0 / max(1, int(grp_members.get(gkey, 0)))
        if disagg.startswith("Recent"):
            st_, gt = float(recent_sku_tot.get(sku, 0.0)), float(recent_grp_tot.get(gkey, 0.0))
        else:
            st_, gt = float(sku_tot.get(sku, 0.0)), float(grp_tot.get(gkey, 0.0))
        if gt > 0 and st_ > 0:
            return st_ / gt
        return 1.0 / max(1, int(grp_members.get(gkey, 0)))

    group_fc_cache: Dict[str, Optional[pd.Series]] = {}

    def _group_forecast(gkey):
        if gkey in group_fc_cache:
            return group_fc_cache[gkey]
        sub = df_dt[df_dt["__grp__"] == gkey]
        fc = None
        if len(sub):
            try:
                hist = (sub.groupby(pd.Grouper(key=date_col, freq=freq))[sales_col]
                        .sum().sort_index())
                hist = hist[hist.index.notna()]
                fc = robust_series_forecast(hist, horizon, freq)
            except Exception:
                fc = None
        group_fc_cache[gkey] = fc
        return fc

    for r in results:
        if r is None:
            continue
        reason = _qualifies(r.sku)
        if reason is None:
            continue
        gkey = _gkey(r.sku)
        if gkey is None:
            continue
        gfc = _group_forecast(gkey)
        if gfc is None or len(gfc) == 0:
            continue
        sh = _share(r.sku, gkey)
        new_fc = gfc * sh
        if r.forecast is not None and len(r.forecast):
            idx = r.forecast.index
            nn = min(len(idx), len(new_fc))
            new_fc = pd.Series(new_fc.values[:nn], index=idx[:nn], name=r.sku)
        new_fc = new_fc.clip(lower=0)
        r.auto_routed_strategy = r.auto_routed_strategy or r.strategy_used
        r.forecast = new_fc
        r.strategy_used = "top_down"
        r.notes = ((r.notes + " · ") if r.notes else "") + (
            f"Top-down [{reason}]: forecast {' × '.join(levels)} aggregate, "
            f"split by {disagg.lower()} (share={sh:.1%})")
        summary["n_rerouted"] += 1
        summary["reasons"][reason] = summary["reasons"].get(reason, 0) + 1
    summary["n_groups"] = len([v for v in group_fc_cache.values() if v is not None])
    return results, summary


def _engine_cfg(ds: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt the persisted (camelCase) config to the snake_case keys the ported
    engine helpers expect (Streamlit cfg shape)."""
    return {
        "date_col": ds["date_col"],
        "sales_col": ds["sales_col"],
        "sku_col": ds["sku_col"],
        "segment_col": cfg.get("segmentCol"),
        "brand_col": cfg.get("brandCol"),
        "freq": ds.get("freq") or cfg.get("freq") or "MS",
        "forecast_level_mode": cfg.get("forecastLevelMode", "sku"),
        "forecast_level_cols": cfg.get("forecastLevelCols") or [],
        "top_down_enabled": bool(cfg.get("topDownEnabled", False)),
        "top_down_levels": cfg.get("topDownLevels") or [],
        "top_down_apply": cfg.get("topDownApply") or {},
        "top_down_disagg": cfg.get("topDownDisagg", "Historical average share"),
        "top_down_noisy_cv2": 0.5,
    }


def skus_with_forecast(dataset_id: str) -> set:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT sku FROM forecasts WHERE dataset_id = ?", (dataset_id,)
        ).fetchall()
    return {r["sku"] for r in rows}


def profile_to_sku(profile_row: Dict[str, Any], row: sqlite3.Row,
                   has_fc: set) -> Dict[str, Any]:
    sku = str(profile_row.get("sku"))
    brand = profile_row.get("brand")
    segment = profile_row.get("segment")
    # Prefer a real segment/category label; fall back to brand, then a default.
    category = str(segment) if segment and segment != "unknown" else (
        str(brand) if brand and brand != "unknown" else "Uncategorized")
    strategy = str(profile_row.get("recommended_strategy") or "ensemble_local")
    cv = clean_float(profile_row.get("cv"))
    return {
        "id": sku,
        "code": sku,
        "name": sku,
        "category": category,
        "brand": None if brand in (None, "unknown") else str(brand),
        "status": sku_status(profile_row),
        "forecastAccuracy": None,
        "hasForecast": sku in has_fc,
        "updatedAt": row["uploaded_at"],
        # ── Profile & Route enrichment (additive; ignored by the SKU catalog) ──
        "demandPattern": str(profile_row.get("intermittency") or "smooth"),
        "volatility": volatility_band(cv),
        "cv": cv,
        "adi": clean_float(profile_row.get("adi")),
        "meanSales": clean_float(profile_row.get("mean_sales")),
        "nMonths": int(profile_row.get("n_months") or 0),
        "recommendedStrategy": strategy,
        "recommendedStrategyLabel": strategy_label(strategy),
        "strategyFamily": strategy_family(strategy),
        "isColdStart": bool(profile_row.get("is_cold_start")),
        "isShortHistory": bool(profile_row.get("is_short_history")),
        # abcClass + revenueSharePct are filled in by list_skus across the set.
    }


# ──────────────────────────────────────────────────────────────────────────────
# Forecast serialization (engine ForecastResult → frontend Forecast / Summary)
# ──────────────────────────────────────────────────────────────────────────────
def _algo_label(key: str) -> str:
    """Human-friendly algorithm name from the engine's registries."""
    info = getattr(engine, "STRATEGY_INFO", {}).get(key)
    if info and info.get("name"):
        return info["name"]
    add = getattr(engine, "ADDITIONAL_ALGORITHMS", {}).get(key)
    if add and add.get("name"):
        return add["name"]
    return str(key).replace("_", " ").title()


def _forecast_band(test_mape: Optional[float]) -> str:
    """Streamlit forecast quality bands on the test WMAPE (%)."""
    if test_mape is None:
        return "No metric"
    if test_mape < 20.0:
        return "Good"
    if test_mape <= 50.0:
        return "Review"
    return "Poor"


def _all_models_rows(res: "engine.ForecastResult") -> List[Dict[str, Any]]:
    """Per-algorithm comparison rows from res.all_algorithm_metrics."""
    metrics = getattr(res, "all_algorithm_metrics", None) or {}
    rows: List[Dict[str, Any]] = []
    for algo, m in metrics.items():
        fc = m.get("future_forecast")
        total = clean_float(fc.sum()) if isinstance(fc, pd.Series) else None
        rows.append({
            "algorithm": str(algo),
            "label": _algo_label(str(algo)),
            "isChampion": bool(m.get("is_champion")),
            "testWmape": clean_float(m.get("test_mape")),
            "testSmape": clean_float(m.get("test_smape")),
            "cvWmape": clean_float(m.get("cv_mape")),
            "valWmape": clean_float(m.get("val_mape")),
            "forecastTotal": total,
            "reason": str(m.get("test_reason") or ""),
        })
    # Champion first, then ascending test WMAPE (None last).
    rows.sort(key=lambda r: (not r["isChampion"], r["testWmape"] if r["testWmape"] is not None else 1e9))
    return rows


def build_forecast_detail(res: "engine.ForecastResult", history: pd.Series,
                          horizon: str, brand: Optional[str] = None,
                          segment: Optional[str] = None) -> Dict[str, Any]:
    points: List[Dict[str, Any]] = []

    # Historical actuals
    for idx, val in history.items():
        points.append({"date": iso_date(idx), "actual": clean_float(val)})

    # Forecast + confidence interval
    fc = res.forecast if isinstance(res.forecast, pd.Series) else pd.Series(dtype=float)
    ci = res.ci if isinstance(res.ci, pd.DataFrame) else None
    lower_col = upper_col = None
    if ci is not None and not ci.empty:
        for c in ci.columns:
            lc = str(c).lower()
            if lower_col is None and ("lower" in lc or lc in ("lo", "min")):
                lower_col = c
            if upper_col is None and ("upper" in lc or lc in ("hi", "max")):
                upper_col = c

    for idx, val in fc.items():
        point: Dict[str, Any] = {"date": iso_date(idx), "forecast": clean_float(val)}
        if ci is not None and idx in ci.index:
            if lower_col is not None:
                point["lowerBound"] = clean_float(ci.loc[idx, lower_col])
            if upper_col is not None:
                point["upperBound"] = clean_float(ci.loc[idx, upper_col])
        points.append(point)

    mape_frac = None if res.backtest_mape is None else clean_float(res.backtest_mape / 100.0)
    smape_frac = None if res.backtest_smape is None else clean_float(res.backtest_smape / 100.0)
    bias_frac = None if res.backtest_bias_pct is None else clean_float(res.backtest_bias_pct / 100.0)
    accuracy = None if mape_frac is None else max(0.0, min(1.0, 1.0 - mape_frac))

    period_start = iso_date(history.index[0]) if len(history) else (
        iso_date(fc.index[0]) if len(fc) else None)
    period_end = iso_date(fc.index[-1]) if len(fc) else (
        iso_date(history.index[-1]) if len(history) else None)

    # In-sample fit (rolling-origin) + test prediction overlays for the champion chart.
    def _series_points(s: Any) -> List[Dict[str, Any]]:
        if not isinstance(s, pd.Series):
            return []
        return [{"date": iso_date(i), "value": clean_float(v)} for i, v in s.items()]

    test_mape = clean_float(res.backtest_mape)
    train_mape = clean_float(res.train_mape)
    auto_routed = getattr(res, "auto_routed_strategy", None) or res.strategy_used

    return {
        "skuId": str(res.sku),
        "skuCode": str(res.sku),
        "skuName": str(res.sku),
        "brand": brand,
        "segment": segment,
        "horizon": horizon,
        "model": map_model(res.strategy_used),
        "strategyUsed": res.strategy_used,
        "strategyLabel": _algo_label(res.strategy_used),
        "autoRouted": str(auto_routed),
        "overridden": bool(auto_routed != res.strategy_used),
        "generatedAt": now_iso(),
        "periodStart": period_start,
        "periodEnd": period_end,
        "series": points,
        "fit": _series_points(getattr(res, "train_pred", None)),
        "testPred": _series_points(getattr(res, "backtest_pred", None)),
        # Held-out actuals for the backtest window — needed to pool residuals at
        # group level exactly like the Streamlit engine's _build_residuals_long.
        "testActual": _series_points(getattr(res, "backtest_actual", None)),
        "forecastTotal": clean_float(fc.sum()) if len(fc) else None,
        "trainWmape": train_mape,
        "testWmape": test_mape,
        "band": _forecast_band(test_mape),
        "mapeReason": str(getattr(res, "mape_reason", "") or ""),
        "notes": str(getattr(res, "notes", "") or ""),
        "cvSelected": bool(getattr(res, "cv_selected", False)),
        "cvWinner": getattr(res, "cv_winner", None),
        "allModels": _all_models_rows(res),
        "metrics": {
            "mape": mape_frac,
            "smape": smape_frac,
            "bias": bias_frac,
            "accuracy": accuracy,
        },
    }


# ──────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Time Lens API Bridge", version="1.0.0")

# CORS for the Next.js dev server. The frontend's axios client sends
# `withCredentials: true`, so the browser forbids a wildcard origin — we must
# echo explicit origins AND allow credentials. Extra origins can be supplied via
# the TIMELENS_CORS_ORIGINS env var (comma-separated).
_default_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
_extra_origins = [
    o.strip()
    for o in os.environ.get("TIMELENS_CORS_ORIGINS", "").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins + _extra_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class _UserContextMiddleware:
    """Pure-ASGI middleware that resolves the bearer token into _CURRENT_UID for
    the duration of each request, so dataset/workflow lookups are scoped to the
    authenticated user. (Pure ASGI — not BaseHTTPMiddleware — so the ContextVar
    propagates into the sync route handler run on Starlette's threadpool.)"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        auth = None
        for k, v in scope.get("headers") or []:
            if k == b"authorization":
                auth = v.decode("latin-1")
                break
        token = _CURRENT_UID.set(parse_token(auth))
        try:
            await self.app(scope, receive, send)
        finally:
            _CURRENT_UID.reset(token)


app.add_middleware(_UserContextMiddleware)

init_db()


@app.get("/")
def root() -> Dict[str, Any]:
    # The bridge persists its own data in api_bridge.db; the engine's SKU
    # segmentation DB is configured via TIMELENS_DB_PATH (default
    # dhisha_segments.db) and is reported here so the active (e.g. demo) DB is
    # verifiable at a glance.
    return {
        "status": "ok",
        "service": "timelens-api-bridge",
        "engine": "app_v2_6",
        "bridgeDb": os.path.basename(DB_PATH),
        "segmentDb": str(engine._resolve_segment_db_path()),
    }


# ── Authentication ────────────────────────────────────────────────────────────
@app.post("/auth/register")
def auth_register(payload: Dict[str, Any]) -> Dict[str, Any]:
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    name = str(payload.get("name") or "").strip() or (
        email.split("@")[0] if email else "")
    role = str(payload.get("role") or "planner").strip() or "planner"
    if not email or not password:
        raise HTTPException(status_code=422, detail="email and password are required")
    if len(password) < 6:
        raise HTTPException(status_code=422, detail="password must be at least 6 characters")

    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(status_code=409, detail="Email already registered")
        cur = conn.execute(
            """INSERT INTO users (name, email, password_hash, role, created_at)
               VALUES (?,?,?,?,?)""",
            (name, email, hash_password(password), role, now_iso()),
        )
        uid = int(cur.lastrowid)
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()

    return {"token": make_token(uid), "user": user_row_to_json(row)}


@app.post("/auth/login")
def auth_login(payload: Dict[str, Any]) -> Dict[str, Any]:
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if row is None or not verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"token": make_token(int(row["id"])), "user": user_row_to_json(row)}


@app.get("/auth/me")
def auth_me(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    uid = parse_token(authorization)
    if uid is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_row_to_json(row)


# ── PHASE 2 — Datasets ────────────────────────────────────────────────────────
def _row_get(row: sqlite3.Row, key: str, default: Any = None) -> Any:
    """sqlite3.Row has no .get(); tolerate columns absent on older rows."""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def _resolve_config(row: sqlite3.Row) -> Dict[str, Any]:
    """Full Data-page configuration for a dataset — persisted overrides merged
    onto defaults derived from the detected schema. Mirrors the Streamlit
    sidebar `cfg` (column mapping, frequency, horizon, exogenous, events,
    routing thresholds, missing/outlier handling, holiday country)."""
    raw = _row_get(row, "config_json")
    saved = json.loads(raw) if raw else {}
    cols = json.loads(_row_get(row, "columns_json") or "[]")
    defaults = {
        "dateCol": _row_get(row, "date_col"),
        "dateFormat": "Auto-detect",
        "dateFormatCustom": None,  # strftime string used when dateFormat == 'Custom...'
        "skuCol": _row_get(row, "sku_col"),
        "salesCol": _row_get(row, "sales_col"),
        "categoryCol": _row_get(row, "category_col"),
        "priceCol": _row_get(row, "price_col"),
        "segmentCol": None,
        "brandCol": _pick_column(cols, ["brand", "manufacturer", "vendor", "label"]),
        "freq": _row_get(row, "freq") or "MS",
        "horizon": 12,
        "useFullHistory": True,
        "historyStart": None,
        "coldStartMonths": 6,
        "shortHistoryMonths": 12,
        "exogNumeric": [],
        "exogCategorical": [],
        "exogStrategy": {},
        "missingHandling": "none",
        "outlierHandling": "none",
        "holidayCountry": "IN",
        "futureEvents": [],
        # ── F.7 parity (updated Streamlit Configuration & Preparation) ──
        "forecastLevelMode": "sku",          # 'sku' | 'custom' | 'overall'
        "forecastLevelCols": [],
        "topDownEnabled": False,
        "topDownLevels": [],
        "topDownApply": {"cold": True, "short": False, "lumpy": True, "noisy": False},
        "topDownDisagg": "Historical average share",
    }
    defaults.update({k: v for k, v in saved.items() if k in defaults})
    return defaults


def dataset_to_json(row: sqlite3.Row) -> Dict[str, Any]:
    columns_raw = _row_get(row, "columns_json")
    out: Dict[str, Any] = {
        "id": row["id"],
        "fileName": row["file_name"],
        "status": row["status"],
        "rowCount": row["row_count"],
        "skuCount": row["sku_count"],
        "uploadedAt": row["uploaded_at"],
        # Data-preparation metadata (additive).
        "frequency": _row_get(row, "freq"),
        "frequencyLabel": _row_get(row, "freq_label"),
        "missingValues": _row_get(row, "missing_values"),
        "duplicateRows": _row_get(row, "duplicate_rows"),
        "invalidDates": _row_get(row, "invalid_dates"),
        "outlierCount": _row_get(row, "outlier_count"),
        "columns": json.loads(columns_raw) if columns_raw else [],
        "detectedMapping": {
            "date": _row_get(row, "date_col"),
            "sku": _row_get(row, "sku_col"),
            "sales": _row_get(row, "sales_col"),
            "category": _row_get(row, "category_col"),
            "price": _row_get(row, "price_col"),
        },
        "config": _resolve_config(row),
    }
    if row["date_start"] and row["date_end"]:
        out["dateRange"] = {"start": row["date_start"], "end": row["date_end"]}
    return out


@app.post("/datasets/upload")
async def upload_dataset(file: UploadFile = File(...)) -> Dict[str, Any]:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")

    # Reuse the engine's multi-format reader.
    try:
        df = engine._read_bytes_to_df(file.filename or "upload.csv", raw)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}")
    if df is None or df.empty:
        raise HTTPException(status_code=422, detail="File parsed to an empty table")

    cols = detect_columns(df)
    all_cols = list(df.columns.astype(str))
    category_col = _pick_column(all_cols, _CATEGORY_HINTS)
    price_col = _pick_column(all_cols, _PRICE_HINTS)
    typed = coerce_types(df, cols["date_col"], cols["sales_col"])
    freq = detect_freq(typed, cols["date_col"])
    freq_label = detect_freq_label(typed, cols["date_col"])
    validation = compute_validation(df, cols["date_col"], cols["sales_col"])

    dataset_id = f"ds_{uuid.uuid4().hex[:12]}"
    stored_path = os.path.join(DATA_DIR, f"{dataset_id}__{os.path.basename(file.filename or 'upload.csv')}")
    with open(stored_path, "wb") as fh:
        fh.write(raw)

    row_count = int(len(typed))
    sku_count = int(typed[cols["sku_col"]].nunique())
    date_start = iso_date(typed[cols["date_col"]].min())
    date_end = iso_date(typed[cols["date_col"]].max())
    uploaded_at = now_iso()
    owner = _current_uid()  # authenticated uploader — datasets are user-scoped

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO datasets
               (id, file_name, stored_path, row_count, sku_count, sku_col, date_col,
                sales_col, category_col, price_col, freq, freq_label,
                date_start, date_end, missing_values, duplicate_rows,
                invalid_dates, outlier_count, columns_json, status, uploaded_at, owner)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (dataset_id, file.filename, stored_path, row_count, sku_count,
             cols["sku_col"], cols["date_col"], cols["sales_col"],
             category_col, price_col, freq, freq_label,
             date_start, date_end,
             validation["missing_values"], validation["duplicate_rows"],
             validation["invalid_dates"], validation["outlier_count"],
             json.dumps(all_cols), "ready", uploaded_at, owner),
        )

    # New dataset restarts THIS user's workflow (Step 1 complete; downstream cleared).
    workflow_reset_for_new_dataset(dataset_id, owner)

    # Single-dataset mode is now per-user: the upload replaces only THIS user's
    # previous dataset (+ its dependent forecasts/runs/submission/reports). Other
    # users' data is never touched.
    with get_conn() as conn:
        olds = conn.execute(
            "SELECT id, stored_path FROM datasets WHERE owner IS ? AND id != ?",
            (owner, dataset_id),
        ).fetchall()
        old_ids = [o["id"] for o in olds]
        if old_ids:
            ph = ",".join("?" * len(old_ids))
            conn.execute(f"DELETE FROM forecasts WHERE dataset_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM forecast_runs WHERE dataset_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM submission_rows WHERE dataset_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM submission_batches WHERE dataset_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM reports WHERE dataset_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM datasets WHERE id IN ({ph})", old_ids)
    for o in olds:
        sp = o["stored_path"]
        if sp and os.path.exists(sp):
            try:
                os.remove(sp)
            except OSError:
                pass
    _PROFILE_CACHE.clear()

    return {
        "id": dataset_id,
        "fileName": file.filename,
        "rowCount": row_count,
        "skuCount": sku_count,
        "status": "ready",
        "uploadedAt": uploaded_at,
        "dateRange": {"start": date_start, "end": date_end} if date_start else None,
        "frequency": freq,
        "frequencyLabel": freq_label,
        "missingValues": validation["missing_values"],
        "duplicateRows": validation["duplicate_rows"],
        "invalidDates": validation["invalid_dates"],
        "outlierCount": validation["outlier_count"],
        "columns": all_cols,
        "detectedMapping": {
            "date": cols["date_col"],
            "sku": cols["sku_col"],
            "sales": cols["sales_col"],
            "category": category_col,
            "price": price_col,
        },
    }


@app.post("/workspace/reset")
def reset_workspace() -> Dict[str, Any]:
    """F.18 — full per-user WORKSPACE reset (NOT logout). Deletes THIS user's
    datasets + every dependent artifact (forecasts, runs, submissions, reports,
    single-SKU runs, scenarios) and clears their workflow, returning the account
    to a brand-new state. Auth and other users' data are untouched."""
    owner = _current_uid()
    if owner is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    removed = 0
    with get_conn() as conn:
        olds = conn.execute(
            "SELECT id, stored_path FROM datasets WHERE owner IS ?", (owner,)
        ).fetchall()
        ids = [o["id"] for o in olds]
        if ids:
            ph = ",".join("?" * len(ids))
            for tbl in (
                "forecasts", "forecast_runs", "submission_rows",
                "submission_batches", "reports", "single_sku_runs",
            ):
                try:
                    conn.execute(f"DELETE FROM {tbl} WHERE dataset_id IN ({ph})", ids)
                except Exception:  # table/column may not exist — best-effort purge
                    pass
            conn.execute(f"DELETE FROM datasets WHERE id IN ({ph})", ids)
            removed = len(ids)
        # Owner-scoped tables (in case any row outlived its dataset).
        for tbl in ("scenarios", "single_sku_runs"):
            try:
                conn.execute(f"DELETE FROM {tbl} WHERE owner IS ?", (owner,))
            except Exception:
                pass
        # Reset the per-user workflow back to the all-locked empty state.
        try:
            conn.execute("DELETE FROM user_workflow WHERE user_id = ?", (owner,))
        except Exception:
            pass

    for o in olds:
        sp = o["stored_path"]
        if sp and os.path.exists(sp):
            try:
                os.remove(sp)
            except OSError:
                pass
    _PROFILE_CACHE.clear()
    return {"ok": True, "datasetsRemoved": removed}


@app.get("/datasets")
def list_datasets() -> List[Dict[str, Any]]:
    # Scoped to the authenticated user — a new user sees no datasets (empty state).
    owner = _current_uid()
    if owner is None:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM datasets WHERE owner = ? ORDER BY uploaded_at DESC", (owner,)
        ).fetchall()
    return [dataset_to_json(r) for r in rows]


@app.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> Dict[str, Any]:
    return dataset_to_json(load_dataset_row(dataset_id))


@app.get("/datasets/{dataset_id}/level-attributes")
def get_level_attributes(dataset_id: str) -> Dict[str, Any]:
    """Per-forecast-level categorical attribute values for the dynamic filter UI
    (Phase X.Q · Task 2). READ-ONLY — does not touch any forecasting math. Returns
    the low-cardinality categorical columns actually present in the dataset
    (excluding the date / sales / level columns) and, for each forecast-level
    entity, the value of each such column. The frontend builds its dynamic
    column/value filters entirely from this — nothing is hardcoded."""
    ds = dict(load_dataset_row(dataset_id))
    df = load_dataset_df(ds)
    sku_col = str(ds["sku_col"])
    exclude = {sku_col, str(ds["date_col"]), str(ds["sales_col"])}
    MAX_DISTINCT = 50

    def _label(col: str) -> str:
        return " ".join(w.capitalize() for w in str(col).replace("_", " ").split())

    cat_cols: List[str] = []
    for c in [str(c) for c in df.columns]:
        if c in exclude:
            continue
        s = df[c]
        if pd.api.types.is_numeric_dtype(s):
            continue
        try:
            n_distinct = int(s.astype(str).nunique(dropna=True))
        except Exception:
            continue
        if 1 <= n_distinct <= MAX_DISTINCT:
            cat_cols.append(c)

    columns = [{"key": c, "label": _label(c)} for c in cat_cols]
    entities: List[Dict[str, Any]] = []
    if cat_cols:
        # First non-null value of each categorical column per forecast-level entity.
        first_vals = df.groupby(df[sku_col].astype(str))[cat_cols].first()
        for entity, row in first_vals.iterrows():
            attrs: Dict[str, str] = {}
            for c in cat_cols:
                v = row[c]
                if pd.notna(v):
                    attrs[c] = str(v)
            entities.append({"entity": str(entity), "attrs": attrs})
    return {"columns": columns, "entities": entities}


# ── Data page — configuration, preview, and exports ───────────────────────────
def _csv_response(text: str, filename: str) -> Response:
    return Response(
        content=text, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _events_template_csv() -> str:
    cols = ["event_start_date", "event_end_date", "event_name", "event_type",
            "impact_pct", "applies_to", "notes"]
    rows = [
        ["2025-10-20", "2025-10-25", "Diwali", "Holiday", "25.0", "ALL",
         "Festive demand uplift"],
        ["2025-11-28", "2025-11-30", "Black Friday", "Promo", "40.0",
         "Electronics", "Promo burst"],
    ]
    buf = io.StringIO()
    buf.write(",".join(cols) + "\n")
    for r in rows:
        buf.write(",".join(r) + "\n")
    return buf.getvalue()


def _validation_checks(ds: Dict[str, Any]) -> List[Dict[str, str]]:
    """Streamlit 'Data Quality Checks' — 5 pass/warn/fail checks on the raw file."""
    df = load_dataset_df(ds)
    date_col, sku_col, sales_col = ds["date_col"], ds["sku_col"], ds["sales_col"]
    sales = pd.to_numeric(df[sales_col], errors="coerce")
    parsed = pd.to_datetime(df[date_col], errors="coerce")
    n_dt_bad = int(parsed.isna().sum())
    dupes = int(df.duplicated(subset=[sku_col, date_col]).sum())
    sales_na = int(sales.isna().sum())
    sales_negative = int((sales < 0).sum())
    sales_zero = int((sales == 0).sum())
    numeric_ok = pd.api.types.is_numeric_dtype(df[sales_col]) or sales.notna().any()

    def mk(check, ok, warn, detail):
        return {"check": check, "status": "Pass" if ok else ("Warning" if warn else "Fail"),
                "detail": detail}

    return [
        mk("Sales column is numeric", numeric_ok, False, f"dtype = {df[sales_col].dtype}"),
        mk("Date column parseable", n_dt_bad == 0, n_dt_bad < len(df),
           f"{n_dt_bad} unparseable values"),
        mk("No (SKU, date) duplicates", dupes == 0, True, f"{dupes} duplicate (SKU, date) rows"),
        mk("No missing sales values", sales_na == 0, True, f"{sales_na} NaN sales values"),
        mk("Sales values non-negative", sales_negative == 0, True,
           f"{sales_negative} negative, {sales_zero} zero"),
    ]


def _clean_long_df(ds: Dict[str, Any], cfg: Dict[str, Any]):
    """Cleaned long frame: type coercion, dedup, missing + outlier handling."""
    df = load_dataset_df(ds)
    date_col = cfg.get("dateCol") or ds["date_col"]
    sku_col = cfg.get("skuCol") or ds["sku_col"]
    sales_col = cfg.get("salesCol") or ds["sales_col"]
    work = df.copy()
    work[date_col] = pd.to_datetime(work[date_col], errors="coerce")
    work[sales_col] = pd.to_numeric(work[sales_col], errors="coerce")
    work = work.drop_duplicates()

    mh = cfg.get("missingHandling", "none")
    if mh == "drop":
        work = work.dropna(subset=[sales_col])
    elif mh == "zero":
        work[sales_col] = work[sales_col].fillna(0.0)
    elif mh in ("ffill", "interpolate"):
        ordered = work.sort_values(date_col)
        fn = (lambda s: s.ffill()) if mh == "ffill" else (lambda s: s.interpolate())
        work[sales_col] = ordered.groupby(sku_col)[sales_col].transform(fn)

    oh = cfg.get("outlierHandling", "none")
    if oh in ("clip", "remove"):
        s = work[sales_col].dropna()
        if len(s) >= 8:
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            iqr = q3 - q1
            if iqr > 0:
                lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
                if oh == "clip":
                    work[sales_col] = work[sales_col].clip(lo, hi)
                else:
                    work = work[(work[sales_col] >= lo) & (work[sales_col] <= hi)]
    return work, date_col, sku_col, sales_col


def _prepared_df(ds: Dict[str, Any], cfg: Dict[str, Any]) -> pd.DataFrame:
    """Cleaned + resampled to the configured frequency, canonical date/sku/sales."""
    work, date_col, sku_col, sales_col = _clean_long_df(ds, cfg)
    work = work.dropna(subset=[date_col])
    freq = cfg.get("freq") or ds.get("freq") or "MS"
    work = work[[sku_col, date_col, sales_col]].set_index(date_col)
    out = work.groupby(sku_col)[sales_col].resample(freq).sum().reset_index()
    return out.rename(columns={sku_col: "sku", date_col: "date", sales_col: "sales"})


@app.patch("/datasets/{dataset_id}/config")
def update_dataset_config(dataset_id: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Persist the Data-page configuration and re-derive schema-dependent metadata
    (frequency, validation, range, counts) under the chosen column mapping."""
    row = load_dataset_row(dataset_id)
    ds = dict(row)
    cfg = _resolve_config(row)
    for k in list(cfg.keys()):
        if payload and k in payload:
            cfg[k] = payload[k]

    date_col = cfg["dateCol"] or ds["date_col"]
    sku_col = cfg["skuCol"] or ds["sku_col"]
    sales_col = cfg["salesCol"] or ds["sales_col"]
    freq = cfg["freq"] or ds.get("freq") or "MS"

    # Recompute schema-dependent meta under the chosen mapping (best-effort).
    freq_label = ds.get("freq_label")
    validation = {
        "missing_values": ds.get("missing_values") or 0,
        "duplicate_rows": ds.get("duplicate_rows") or 0,
        "invalid_dates": ds.get("invalid_dates") or 0,
        "outlier_count": ds.get("outlier_count") or 0,
    }
    row_count = ds.get("row_count") or 0
    sku_count = ds.get("sku_count") or 0
    date_start, date_end = ds.get("date_start"), ds.get("date_end")
    # Use the *newly chosen* date format (the row still holds the old config
    # here), so changing Date format takes effect on this same save.
    new_fmt = _resolve_date_format(cfg)
    try:
        with open(ds["stored_path"], "rb") as fh:
            raw = engine._read_bytes_to_df(ds["file_name"], fh.read())
        typed = coerce_types(raw, date_col, sales_col, new_fmt)
        freq_label = detect_freq_label(typed, date_col)
        validation = compute_validation(raw, date_col, sales_col)
        row_count = int(len(typed))
        sku_count = int(typed[sku_col].nunique())
        date_start = iso_date(typed[date_col].min())
        date_end = iso_date(typed[date_col].max())
    except Exception as exc:
        logging.warning("config recompute failed: %s", exc)

    with get_conn() as conn:
        conn.execute(
            """UPDATE datasets SET date_col=?, sku_col=?, sales_col=?, category_col=?,
                   price_col=?, freq=?, freq_label=?, date_start=?, date_end=?,
                   row_count=?, sku_count=?, missing_values=?, duplicate_rows=?,
                   invalid_dates=?, outlier_count=?, config_json=? WHERE id=?""",
            (date_col, sku_col, sales_col, cfg["categoryCol"], cfg["priceCol"],
             freq, freq_label, date_start, date_end, row_count, sku_count,
             validation["missing_values"], validation["duplicate_rows"],
             validation["invalid_dates"], validation["outlier_count"],
             json.dumps(cfg), dataset_id),
        )
    return dataset_to_json(load_dataset_row(dataset_id))


@app.get("/datasets/{dataset_id}/preview")
def dataset_preview(dataset_id: str, rows: int = Query(12, ge=1, le=100)) -> Dict[str, Any]:
    """Data preview (first N rows) + schema details for the Quality & Schema tab."""
    ds = dict(load_dataset_row(dataset_id))
    df = load_dataset_df(ds)
    columns = [str(c) for c in df.columns]
    head = df.head(rows)
    preview_rows = [
        {str(c): (None if pd.isna(v) else str(v)) for c, v in rec.items()}
        for rec in head.to_dict("records")
    ]
    schema: List[Dict[str, Any]] = []
    for c in df.columns:
        col = df[c]
        non_null = int(col.notna().sum())
        first = col.dropna()
        schema.append({
            "column": str(c),
            "dtype": str(col.dtype),
            "nonNull": non_null,
            "unique": int(col.nunique(dropna=True)),
            "sample": (str(first.iloc[0])[:60] if len(first) else None),
        })
    return {"columns": columns, "rows": preview_rows, "schema": schema}


@app.get("/datasets/events/template")
def events_template() -> Response:
    return _csv_response(_events_template_csv(), "events_calendar_template.csv")


@app.get("/datasets/{dataset_id}/export/{kind}")
def export_dataset(dataset_id: str, kind: str):
    """Real Data-module exports: validation, quality, cleaned, prepared, config."""
    row = load_dataset_row(dataset_id)
    ds = dict(row)
    cfg = _resolve_config(row)
    base = (ds.get("file_name") or "dataset").rsplit(".", 1)[0]

    if kind == "config":
        body = json.dumps(
            {"datasetId": dataset_id, "fileName": ds.get("file_name"), "config": cfg},
            indent=2,
        )
        return Response(
            content=body, media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{base}_config.json"'},
        )

    if kind == "validation":
        checks = _validation_checks(ds)
        buf = io.StringIO()
        buf.write("check,status,detail\n")
        for c in checks:
            buf.write(f'"{c["check"]}","{c["status"]}","{c["detail"]}"\n')
        return _csv_response(buf.getvalue(), f"{base}_validation.csv")

    if kind == "quality":
        rng = ""
        if ds.get("date_start") and ds.get("date_end"):
            rng = f'{ds["date_start"]} → {ds["date_end"]}'
        metrics = [
            ("Rows", ds.get("row_count") or 0),
            ("SKUs", ds.get("sku_count") or 0),
            ("Date range", rng),
            ("Frequency", ds.get("freq_label") or ds.get("freq") or ""),
            ("Missing values", ds.get("missing_values") or 0),
            ("Duplicate rows", ds.get("duplicate_rows") or 0),
            ("Invalid dates", ds.get("invalid_dates") or 0),
            ("Outliers (IQR)", ds.get("outlier_count") or 0),
        ]
        buf = io.StringIO()
        buf.write("metric,value\n")
        for k, v in metrics:
            buf.write(f'"{k}","{v}"\n')
        return _csv_response(buf.getvalue(), f"{base}_data_quality.csv")

    if kind == "cleaned":
        work, _, _, _ = _clean_long_df(ds, cfg)
        return _csv_response(work.to_csv(index=False), f"{base}_cleaned.csv")

    if kind == "prepared":
        out = _prepared_df(ds, cfg)
        return _csv_response(out.to_csv(index=False), f"{base}_prepared.csv")

    raise HTTPException(status_code=404, detail=f"Unknown export '{kind}'")


# ── PHASE 3 — SKUs ────────────────────────────────────────────────────────────
@app.get("/skus")
def list_skus(
    datasetId: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=500),
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        return {"items": [], "total": 0, "page": page, "pageSize": pageSize, "hasNextPage": False}

    row = load_dataset_row(ds_id)
    profiles = get_profiles(row)
    has_fc = skus_with_forecast(ds_id)
    items = [profile_to_sku(rec, row, has_fc) for rec in profiles.to_dict("records")]

    # ── ABC classification + revenue share across the FULL set (before paging).
    # Revenue is proxied by mean_sales × n_months (no price in most feeds).
    revenues = [
        (it["meanSales"] or 0.0) * (it["nMonths"] or 0) for it in items
    ]
    total_rev = sum(revenues) or 1.0
    order = sorted(range(len(items)), key=lambda i: revenues[i], reverse=True)
    cumulative = 0.0
    for rank in order:
        share = revenues[rank] / total_rev
        items[rank]["revenueSharePct"] = round(share * 100, 4)
        cumulative += share
        items[rank]["abcClass"] = (
            "A" if cumulative <= 0.80 else "B" if cumulative <= 0.95 else "C"
        )

    if search:
        q = search.lower()
        items = [s for s in items
                 if q in s["code"].lower() or q in s["name"].lower() or q in s["category"].lower()]
    if status:
        items = [s for s in items if s["status"] == status]
    if category:
        items = [s for s in items if s["category"] == category]

    total = len(items)
    start = (page - 1) * pageSize
    page_items = items[start:start + pageSize]
    return {
        "items": page_items,
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "hasNextPage": start + pageSize < total,
    }


@app.get("/skus/{sku_id}")
def get_sku(sku_id: str, datasetId: Optional[str] = Query(None)) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    row = load_dataset_row(ds_id)
    profiles = get_profiles(row)
    match = profiles[profiles["sku"].astype(str) == sku_id]
    if match.empty:
        raise HTTPException(status_code=404, detail=f"SKU '{sku_id}' not found")
    return profile_to_sku(match.iloc[0].to_dict(), row, skus_with_forecast(ds_id))


# ── PHASE 4 — Forecasts ───────────────────────────────────────────────────────
def forecast_row_to_summary(r: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": r["id"],
        "skuId": r["sku"],
        "skuCode": r["sku_code"],
        "skuName": r["sku_name"],
        "horizon": r["horizon"],
        "model": r["model"],
        "accuracy": r["accuracy"],
        "totalForecastUnits": r["total_forecast_units"],
        "generatedAt": r["generated_at"],
    }


def _series_to_pairs(s: Any) -> List[Dict[str, Any]]:
    if not isinstance(s, pd.Series):
        return []
    return [{"d": iso_date(i), "v": clean_float(v)} for i, v in s.items()]


def _forecast_worker(job_id: str, ds: Dict[str, Any], chosen_skus: List[str],
                     periods: int, freq: str, horizon: str,
                     compare_algos: Optional[List[str]] = None,
                     cv_mode: bool = False, reconcile: bool = False,
                     use_global: bool = False, evaluate_oos: bool = True,
                     segment_secondary: Optional[Dict[str, List[str]]] = None) -> None:
    """Background thread: runs the engine over `chosen_skus`, persisting each
    forecast and updating the job's progress. `ds` is a plain dict snapshot of
    the dataset row so nothing is shared across threads except the in-memory
    job registry (lock-guarded) and per-call SQLite connections."""
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    _job_update(job_id, status="running", runId=run_id, startedAt=now_iso(),
                progress=0, message="Preparing data & features…")
    # Liveness ticker — cosmetic status only (never touches forecast math).
    hb: Optional[_Heartbeat] = _Heartbeat(
        job_id,
        ["Training AutoARIMA", "Running Prophet", "Fitting Theta / Holt-Winters",
         "Evaluating models", "Cross-validating folds", "Selecting champion",
         "Applying reconciliation"],
    ).start()
    try:
        # Single-run mode: a new run supersedes any prior run for this dataset.
        # Drop the old run + its forecasts and the now-stale submission worksheet
        # (rebuilt lazily against the new run on first access).
        with get_conn() as conn:
            conn.execute("DELETE FROM forecasts WHERE dataset_id = ? AND run_id != ?", (ds["id"], run_id))
            conn.execute("DELETE FROM forecast_runs WHERE dataset_id = ? AND id != ?", (ds["id"], run_id))
            conn.execute("DELETE FROM submission_rows WHERE dataset_id = ?", (ds["id"],))
            conn.execute("DELETE FROM submission_batches WHERE dataset_id = ?", (ds["id"],))

        cfg = _resolve_config(ds)
        ecfg = _engine_cfg(ds, cfg)
        df = load_dataset_df(ds)
        df = _apply_history_window(df, ds["date_col"], cfg)

        # ── F.7 (1) Unified outlier cleaning — BEFORE features, so lags/rolling
        # and the global model all train on the cleaned series (Streamlit parity).
        # Gated on the persisted Outlier-handling config (none → unchanged).
        outlier_summary = None
        if cfg.get("outlierHandling") in ("clip", "remove"):
            explain = _resolve_outlier_explain_cols(
                list(df.columns), (cfg.get("exogNumeric") or []))
            df, _n_treated, _n_kept = apply_unified_outlier_treatment(
                df, ds["sku_col"], ds["sales_col"], k_iqr=3.0, explain_cols=explain)
            outlier_summary = {"treated": _n_treated, "explainedKept": _n_kept}

        # ── F.7 (2) Forecast level (aggregation grain) — collapse to entities and
        # forecast those instead of raw SKUs (Streamlit resolve_pipeline_cfg).
        level_mode = ecfg.get("forecast_level_mode", "sku")
        if level_mode != "sku":
            df = aggregate_to_forecast_level(df, ecfg)
            rcfg = resolve_pipeline_cfg(ecfg)
            skc = rcfg["sku_col"]  # FORECAST_ENTITY_COL
            if skc not in df.columns:  # misconfigured custom → fell back to per-SKU
                skc, level_mode = ds["sku_col"], "sku"
        else:
            skc = ds["sku_col"]

        # Profiles: per-entity at non-SKU grain, else the cached per-SKU table.
        if level_mode != "sku":
            cold = int(min(max(int(cfg.get("coldStartMonths") or 6), 1), 24))
            short = int(min(max(int(cfg.get("shortHistoryMonths") or 12), 1), 36))
            profiles = engine.profile_all_skus(
                df, sku_col=skc, sales_col=ds["sales_col"], date_col=ds["date_col"],
                segment_col="", brand_col="",
                cold_start_threshold=cold, short_history_threshold=short,
            )
            run_keys = sorted(df[skc].dropna().astype(str).unique().tolist())
        else:
            profiles = get_profiles(ds)
            run_keys = chosen_skus
        prof_by_sku = {str(rec["sku"]): rec for rec in profiles.to_dict("records")}

        # ── Phase X.G — segment propagation (DISPLAY only) ───────────────────
        # The per-SKU profile table is built with segment_col="" so its `segment`
        # is "unknown" (business segments are COMPUTED in Profile & Route, not a
        # raw column). Pull the saved Profile & Route business segment — the SAME
        # source the Profile page shows — and use it for forecast OUTPUTS so the
        # performance/champion tables, reports and exports never read "unknown".
        # `profile_row` is intentionally NOT mutated → routing/candidate-pool and
        # the chosen primary are unchanged. SKU grain only (the saved segmentation
        # is keyed by the dataset SKU column; custom/enterprise grain is left as-is).
        seg_by_sku: Dict[str, str] = {}
        if level_mode == "sku":
            try:
                _seg_res = _build_segmentation(dict(ds), _resolve_seg_params(_seg_param_overrides({})))
                for _s in _seg_res.get("skus", []):
                    _sv = _s.get("segment")
                    if _sv and str(_sv).strip().lower() != "unknown":
                        seg_by_sku[str(_s.get("sku"))] = str(_sv)
            except Exception as exc:  # best-effort; never block the forecast
                logging.warning("segment propagation lookup failed: %s", exc)

        def _seg_for(sku_key: Any, profile_row: Dict[str, Any]) -> Optional[str]:
            """Priority: saved Profile & Route segment → profile segment → None."""
            saved = seg_by_sku.get(str(sku_key))
            if saved:
                return saved
            ps = profile_row.get("segment")
            return str(ps) if ps and str(ps).strip().lower() != "unknown" else None

        panel = engine.build_panel_features(
            df, date_col=ds["date_col"], sales_col=ds["sales_col"],
            sku_col=skc, freq=freq,
        )

        # ── Global LightGBM packages (only when the toggle is on) ─────────────
        # Production fit (holdout 0) + leak-free backtest fit (holdout=horizon),
        # exactly as run_forecasts does. Passed into every SKU so global_lgbm can
        # compete for champion.
        global_pkg = global_pkg_backtest = None
        if use_global:
            _job_update(job_id, message="Training global model…")
            hb.step("Training global LightGBM", 0.0, 0.06)
            all_cols = list(df.columns.astype(str))
            brand_c = _pick_column(all_cols, ["brand", "manufacturer", "vendor", "label"])
            segment_c = _pick_column(all_cols, ["segment", "segments"])
            cats = [c for c in [brand_c, segment_c, "price_band"]
                    if c and c in panel.columns]
            # LightGBM requires categoricals as pandas 'category' dtype, not
            # 'object'. Streamlit's run_forecasts gets this for free by passing
            # exog_categorical into build_panel_features (app_v2_6.py:876-878);
            # the bridge builds the panel without that arg, so cast here. Scoped
            # to the use_global path → the useGlobal=false behaviour is unchanged.
            for c in cats:
                if str(panel[c].dtype) == "object":
                    panel[c] = panel[c].astype("category")
            try:
                global_pkg = engine.train_global_lightgbm(
                    panel, skc, ds["date_col"], ds["sales_col"],
                    freq, cats, holdout_periods=0,
                )
                if global_pkg is not None:
                    global_pkg_backtest = engine.train_global_lightgbm(
                        panel, skc, ds["date_col"], ds["sales_col"],
                        freq, cats, holdout_periods=periods,
                    )
            except Exception as exc:  # LightGBM missing / fit failure → local fallback
                logging.warning("global LightGBM unavailable: %s", exc)
                global_pkg = global_pkg_backtest = None

        sku_forecasts: Dict[str, pd.Series] = {}
        total = len(run_keys)
        produced = 0
        conn = get_conn()
        try:
            def _detail_and_units(res: Any, profile_row: Dict[str, Any]):
                sku_panel = panel[panel[skc] == res.sku].sort_values(ds["date_col"])
                history = sku_panel.set_index(ds["date_col"])[ds["sales_col"]]
                detail = build_forecast_detail(
                    res, history, horizon,
                    brand=(str(profile_row.get("brand")) if profile_row.get("brand") else None),
                    segment=_seg_for(res.sku, profile_row),  # Phase X.G — saved segment
                )
                units = clean_float(res.forecast.sum()) if isinstance(res.forecast, pd.Series) else None
                return detail, units

            # ── Phase X.Y — PARALLEL per-entity forecasting ──────────────────
            # Each forecast level is INDEPENDENT and order-free: forecast_one_sku
            # only READS shared inputs (panel / global_pkg / profile_row) and all
            # randomness is per-estimator (random_state=42), so concurrent
            # execution yields byte-identical results — the math, champion
            # selection, WMAPE, CIs and business rules are untouched. The heavy
            # numeric work (statsmodels / sklearn / lightgbm / numpy) releases the
            # GIL, so a thread pool delivers real speedup WITHOUT pickling the
            # large shared panel into subprocesses (which on Windows-spawn would be
            # slow and risk subtle divergence).
            #
            # Compute is parallel; PERSISTENCE is single-threaded and walks
            # run_keys IN ORDER, so DB rows, `result_objs` and the reconciliation
            # inputs stay deterministic regardless of completion order (Task 3).
            # The single SQLite connection is thus only ever touched by this thread.
            persisted: Dict[str, Any] = {}   # sku -> (fc_id, profile_row)
            result_objs: List[Any] = []
            results_by_sku: Dict[str, Any] = {}

            def _compute_one(sku: str) -> Any:
                pr = prof_by_sku.get(sku, {})
                # Merge this item's per-segment SECONDARY models into its candidate
                # pool (Task 2). Champion stays lowest-WMAPE; the primary/auto route
                # is unchanged — these are ADDITIONAL candidates only.
                extra = list(compare_algos or [])
                _seg = _seg_for(sku, pr)
                if _seg and (segment_secondary or {}).get(_seg):
                    for _m in segment_secondary[_seg]:
                        if _m and _m not in extra:
                            extra.append(_m)
                return engine.forecast_one_sku(
                    sku=sku, panel=panel, profile_row=pr,
                    h=periods, freq=freq,
                    sku_col=skc, date_col=ds["date_col"],
                    sales_col=ds["sales_col"],
                    global_pkg=global_pkg, global_pkg_backtest=global_pkg_backtest,
                    run_backtest=evaluate_oos, cv_mode=cv_mode, cfg=None,
                    compare_algos=extra or None,
                )

            workers = min(os.cpu_count() or 1, 8)
            _t_start = time.time()
            completed = 0

            def _note_progress() -> None:
                """Advance job progress + ETA after each level finishes (Task 4)."""
                nonlocal completed
                completed += 1
                hb.step(f"Forecasting ({completed} of {total})",
                        (completed - 1) / max(total, 1), completed / max(total, 1))
                elapsed = time.time() - _t_start
                eta = int(elapsed / completed * (total - completed)) if completed else 0
                _job_update(
                    job_id,
                    progress=int(completed / max(total, 1) * 100),
                    message=f"Completed {completed} / {total} · ~{eta}s remaining",
                )

            # Parallel for real runs; serial fallback for tiny runs avoids pool
            # overhead and keeps single-entity behaviour byte-for-byte identical.
            if workers > 1 and total > 1:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {pool.submit(_compute_one, sku): sku for sku in run_keys}
                    for fut in as_completed(futures):
                        sku = futures[fut]
                        try:
                            results_by_sku[sku] = fut.result()
                        except Exception as exc:  # skip a failing entity, keep going
                            logging.warning("forecast_one_sku failed for %s: %s", sku, exc)
                        _note_progress()
            else:
                for sku in run_keys:
                    try:
                        results_by_sku[sku] = _compute_one(sku)
                    except Exception as exc:
                        logging.warning("forecast_one_sku failed for %s: %s", sku, exc)
                    _note_progress()

            # Persist IN run_keys ORDER — deterministic DB rows + result_objs,
            # single-threaded SQLite writes (Task 3).
            for sku in run_keys:
                res = results_by_sku.get(sku)
                if res is None:
                    continue
                profile_row = prof_by_sku.get(sku, {})
                detail, units = _detail_and_units(res, profile_row)
                fc_id = f"fc_{uuid.uuid4().hex[:12]}"
                if isinstance(res.forecast, pd.Series):
                    sku_forecasts[sku] = res.forecast
                conn.execute(
                    """INSERT INTO forecasts
                       (id, run_id, dataset_id, sku, sku_code, sku_name, category, model,
                        horizon, accuracy, mape, smape, bias, total_forecast_units,
                        generated_at, detail_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (fc_id, run_id, ds["id"], sku, sku, sku,
                     (_seg_for(sku, profile_row) or "Uncategorized"),  # Phase X.G — saved segment
                     detail["model"], horizon,
                     detail["metrics"]["accuracy"], detail["metrics"]["mape"],
                     detail["metrics"]["smape"], detail["metrics"]["bias"],
                     units, detail["generatedAt"],
                     json.dumps({**detail, "id": fc_id})),
                )
                conn.commit()  # ordered per-entity commit → /forecasts populates in order
                produced += 1
                persisted[sku] = (fc_id, profile_row)
                result_objs.append(res)
                _job_update(job_id, skuCount=produced)

            # Per-SKU competition done — pin the heartbeat to the finalize band.
            hb.step("Finalizing", 0.96, 0.99)

            # ── F.7 (3) Top-down routing — re-route qualifying SKUs from a clean
            # aggregate, then UPDATE their already-persisted rows in place (same
            # forecast values as before; only persistence order changed). SKU grain
            # only (entity grains already forecast aggregates).
            td_summary = None
            if level_mode == "sku" and ecfg.get("top_down_enabled") and result_objs:
                _job_update(job_id, message="Applying top-down routing…")
                try:
                    _, td_summary = apply_top_down_routing(
                        result_objs, profiles, df, ecfg, periods)
                    for res in result_objs:
                        if getattr(res, "strategy_used", "") != "top_down":
                            continue
                        rec = persisted.get(res.sku)
                        if not rec:
                            continue
                        fc_id, profile_row = rec
                        detail, units = _detail_and_units(res, profile_row)
                        if isinstance(res.forecast, pd.Series):
                            sku_forecasts[res.sku] = res.forecast
                        conn.execute(
                            """UPDATE forecasts SET model=?, accuracy=?, mape=?, smape=?,
                               bias=?, total_forecast_units=?, generated_at=?, detail_json=?
                               WHERE id=?""",
                            (detail["model"], detail["metrics"]["accuracy"],
                             detail["metrics"]["mape"], detail["metrics"]["smape"],
                             detail["metrics"]["bias"], units, detail["generatedAt"],
                             json.dumps({**detail, "id": fc_id}), fc_id),
                        )
                    conn.commit()
                except Exception as exc:
                    logging.warning("top-down routing failed: %s", exc)

            _job_update(job_id, message="Finalizing results…")

            # ── Brand reconciliation (only when the toggle is on) ────────────
            # Skipped at non-SKU forecast grains — aggregation drops the per-item
            # brand hierarchy (Streamlit resolve_pipeline_cfg parity).
            reconciliation_payload = None
            if reconcile and sku_forecasts and level_mode == "sku":
                all_cols = list(df.columns.astype(str))
                brand_c = _pick_column(all_cols, ["brand", "manufacturer", "vendor", "label"])
                if brand_c:
                    recon_cfg = {"brand_col": brand_c, "date_col": ds["date_col"],
                                 "sales_col": ds["sales_col"], "freq": freq}
                    try:
                        recon = engine.compute_brand_reconciliation(
                            sku_forecasts, profiles, df, recon_cfg, periods,
                        )
                        reconciliation_payload = {
                            "reconciled": {str(b): _series_to_pairs(s)
                                           for b, s in (recon.get("reconciled") or {}).items()},
                            "bottomUp": {str(b): _series_to_pairs(s)
                                         for b, s in (recon.get("bottom_up") or {}).items()},
                            "topDown": {str(b): _series_to_pairs(s)
                                        for b, s in (recon.get("top_down") or {}).items()},
                            "adjusted": {str(k): _series_to_pairs(s)
                                         for k, s in (recon.get("adjusted_sku_forecasts") or {}).items()},
                        }
                    except Exception as exc:
                        logging.warning("reconciliation failed: %s", exc)

            run_config = {
                "reconcile": bool(reconcile),
                "useGlobal": bool(use_global),
                "globalTrained": bool(global_pkg is not None),
                "reconciliation": reconciliation_payload,
                # F.7 — record which Config & Prep settings shaped this run.
                "forecastLevelMode": level_mode,
                "forecastLevelCols": ecfg.get("forecast_level_cols") or [],
                "outlierTreatment": outlier_summary,
                "topDown": td_summary,
            }
            conn.execute(
                """INSERT INTO forecast_runs
                   (id, dataset_id, horizon, freq, periods, sku_count, status, created_at, config_json)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (run_id, ds["id"], horizon, freq, periods, produced, "completed",
                 now_iso(), json.dumps(run_config)),
            )
            conn.commit()
        finally:
            conn.close()

        hb.stop()
        _job_update(job_id, status="completed", progress=100,
                    skuCount=produced, completedAt=now_iso(),
                    message=f"Completed — {produced} of {total} SKUs forecast")
        # Step 5 prerequisite satisfied — forecast results now exist. The worker
        # runs in a background thread (no request context), so scope the flag to
        # the dataset's owner explicitly.
        workflow_set(ds.get("owner"), forecast_completed=True)
    except Exception as exc:  # whole-run failure (parse/panel/DB)
        logging.exception("forecast run failed")
        _job_update(job_id, status="failed", error=str(exc)[:300],
                    completedAt=now_iso())
    finally:
        if hb is not None:
            hb.stop()


@app.post("/forecasts/run")
def start_forecast_run(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Kick off an async forecast run and return a job handle immediately. Poll
    GET /forecasts/jobs/{id} for progress/status."""
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset to forecast — upload one first")
    ds = dict(load_dataset_row(ds_id))  # thread-safe snapshot

    # F.8 Issue 6 — Forecast horizon has a SINGLE source of truth: the saved
    # Configuration & Preparation horizon (dataset.config.horizon). The Forecast
    # Run no longer owns a horizon control; payload `periods` is only a fallback.
    _run_cfg = _resolve_config(ds)
    periods = int(_run_cfg.get("horizon") or payload.get("periods") or 6)
    limit = min(int(payload.get("limit") or DEFAULT_RUN_LIMIT), MAX_RUN_LIMIT)
    requested = [str(s) for s in (payload.get("skuIds") or [])]
    mode = str(payload.get("selectionMode") or ("pick" if requested else "sample"))
    brands = [str(b) for b in (payload.get("brands") or [])]
    segments = [str(s) for s in (payload.get("segments") or [])]
    sample_per = int(payload.get("samplePerStrategy") or 3)
    compare_algos = [str(a) for a in (payload.get("compareAlgos") or [])] or None
    # Phase X.X.2 · Task 2 — per-segment SECONDARY models. Extra candidates merged
    # into each item's pool by its segment; champion selection is unchanged
    # (lowest WMAPE still wins). {segment_name: [model_key, …]}.
    _seg_sec_raw = payload.get("segmentSecondary") or {}
    segment_secondary = (
        {str(k): [str(m) for m in (v or [])] for k, v in _seg_sec_raw.items()}
        if isinstance(_seg_sec_raw, dict) else {}
    )
    cv_mode = bool(payload.get("cvMode"))
    reconcile = bool(payload.get("reconcile"))
    use_global = bool(payload.get("useGlobal"))
    # OOS backtest drives competition-based model selection — default ON to
    # preserve forecast parity (the parity validation showed OOS=off changes the
    # selected champion and forecast values). Output parity > speed.
    evaluate_oos = bool(payload.get("evaluateOos", True))

    profiles = get_profiles(ds)  # fast + cached; warms the worker's cache too
    freq = ds.get("freq") or "MS"
    horizon = freq_to_horizon(freq)

    pool = profiles
    if brands and "brand" in pool.columns:
        pool = pool[pool["brand"].astype(str).isin(brands)]
    if segments and "segment" in pool.columns:
        pool = pool[pool["segment"].astype(str).isin(segments)]

    if mode == "pick" and requested:
        chosen = pool[pool["sku"].astype(str).isin(requested)]
    elif mode == "all":
        chosen = pool.sort_values("mean_sales", ascending=False).head(MAX_RUN_LIMIT)
    elif mode == "sample" and "recommended_strategy" in pool.columns:
        # N SKUs per recommended strategy (top by volume within each strategy).
        chosen = (
            pool.sort_values("mean_sales", ascending=False)
            .groupby("recommended_strategy", group_keys=False)
            .head(max(1, sample_per))
            .head(MAX_RUN_LIMIT)
        )
    else:
        chosen = pool.sort_values("mean_sales", ascending=False).head(limit)
    chosen_skus = [str(s) for s in chosen["sku"].tolist()]
    if not chosen_skus:
        raise HTTPException(status_code=422, detail="No matching SKUs to forecast")

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id,
        "status": "queued",
        "progress": 0,
        "skuIds": chosen_skus,
        "skuCount": 0,
        "total": len(chosen_skus),
        "datasetId": ds_id,
        "horizon": horizon,
        "periods": periods,
        "runId": None,
        "startedAt": now_iso(),
        "completedAt": None,
        "error": None,
        "message": "Queued…",
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job

    threading.Thread(
        target=_forecast_worker,
        args=(job_id, ds, chosen_skus, periods, freq, horizon, compare_algos,
              cv_mode, reconcile, use_global, evaluate_oos, segment_secondary),
        daemon=True,
    ).start()

    return dict(job)


@app.get("/forecasts/jobs/{job_id}")
def get_forecast_job(job_id: str) -> Dict[str, Any]:
    job = _job_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return job


@app.get("/forecasts")
def list_forecasts(
    datasetId: Optional[str] = Query(None),
    runId: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=500),
) -> Dict[str, Any]:
    clauses, params = [], []
    if runId:
        clauses.append("run_id = ?"); params.append(runId)
    elif datasetId:
        clauses.append("dataset_id = ?"); params.append(datasetId)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_conn() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM forecasts{where}", params).fetchone()["n"]
        rows = conn.execute(
            f"SELECT * FROM forecasts{where} ORDER BY generated_at DESC LIMIT ? OFFSET ?",
            params + [pageSize, (page - 1) * pageSize],
        ).fetchall()

    return {
        "items": [forecast_row_to_summary(r) for r in rows],
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "hasNextPage": (page - 1) * pageSize + pageSize < total,
    }


@app.get("/forecasts/algorithms")
def forecast_algorithms() -> Dict[str, Any]:
    """Real algorithm registries for the Forecast configuration multiselect."""
    si = getattr(engine, "STRATEGY_INFO", {})
    aa = getattr(engine, "ADDITIONAL_ALGORITHMS", {})

    def pack(d: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [
            {"key": k, "name": v.get("name", k), "family": v.get("family"),
             "icon": v.get("icon"),
             "description": v.get("use_case") or v.get("description")}
            for k, v in d.items()
        ]

    return {
        "strategyInfo": pack(si),
        "additionalAlgorithms": pack(aa),
        "recommended": ["moe", "global_lgbm", "prophet", "theta", "holt_winters", "autoarima"],
        "selectable": [
            "moe", "global_lgbm", "croston_sba", "local_sarimax_promo", "ensemble_local",
            "global_lgbm_full", "naive_zero", "prophet", "autoarima", "holt_winters",
            "tsb", "naive_seasonal", "theta",
        ],
        "minHistoryForCv": int(getattr(engine, "MIN_HISTORY_FOR_CV", 24)),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Single-SKU Multi-Model Competition — the REAL Streamlit single-series engine
# (TimeSeriesEDA + TimeSeriesForecaster), run headless. NOT the portfolio path.
# ──────────────────────────────────────────────────────────────────────────────
_SS_MODELS_ALLOWED = [
    "prophet", "auto_arima", "sarimax", "arima", "holt_winters",
    "exponential_smoothing", "lightgbm", "dl_moe",
]
_SS_MODELS_DEFAULT = ["auto_arima", "sarimax", "holt_winters", "lightgbm"]


def _map_resample_freq(freq: Optional[str]) -> str:
    """Dataset pandas freq (MS/W/D/QS/YS…) → TimeSeriesEDA resample_freq (M/W/D/Q/Y)."""
    f = str(freq or "MS").upper()
    if f.startswith("W"):
        return "W"
    if f.startswith("D"):
        return "D"
    if f.startswith("Q"):
        return "Q"
    if f.startswith(("Y", "A")):
        return "Y"
    return "M"


def _ss_float(v: Any) -> Optional[float]:
    """Parse the engine's formatted metric strings ('12.34' / 'N/A') → float|None."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper() == "N/A":
        return None
    try:
        return clean_float(float(s))
    except ValueError:
        return None


def _build_single_sku_payload(sku, periods, models, eda, final_forecast,
                              best_name, best_result, summary, fc) -> Dict[str, Any]:
    sales_col = getattr(eda, "sales_col", "sales")
    points: List[Dict[str, Any]] = []
    hist = getattr(eda, "df_eda", None)
    if hist is not None and sales_col in getattr(hist, "columns", []):
        series = hist[sales_col]
        for idx, val in list(series.items())[-24:]:
            points.append({"date": iso_date(idx), "actual": clean_float(val)})

    ci = best_result.get("forecast_ci") if isinstance(best_result, dict) else None
    lower_c = upper_c = None
    if ci is not None and hasattr(ci, "columns"):
        for c in ci.columns:
            lc = str(c).lower()
            if lower_c is None and "lower" in lc:
                lower_c = c
            if upper_c is None and "upper" in lc:
                upper_c = c
    fc_series = final_forecast if isinstance(final_forecast, pd.Series) else pd.Series(dtype=float)
    for idx, val in fc_series.items():
        pt: Dict[str, Any] = {"date": iso_date(idx), "forecast": clean_float(val)}
        if ci is not None and idx in getattr(ci, "index", []):
            if lower_c is not None:
                pt["lower"] = clean_float(ci.loc[idx, lower_c])
            if upper_c is not None:
                pt["upper"] = clean_float(ci.loc[idx, upper_c])
        points.append(pt)

    champ = str(summary.get("Model", "")).upper()
    ranking = [{
        "model": r.get("Model"),
        "trainWmape": _ss_float(r.get("Train WMAPE (%)")),
        "trainRmse": _ss_float(r.get("Train RMSE")),
        "testWmape": _ss_float(r.get("Test WMAPE (%)")),
        "testRmse": _ss_float(r.get("Test RMSE")),
        "isChampion": str(r.get("Model", "")).upper() == champ,
    } for r in (getattr(fc, "last_run_details", None) or [])]

    try:
        narrative = engine.generate_narrative_summary(
            {"final_forecast": final_forecast, "best_model_name": best_name,
             "best_model_result": best_result, "result": summary},
            {"resample_freq": getattr(eda, "resample_freq", "M")},
        )
    except Exception:
        narrative = ""

    return {
        "sku": sku, "periods": periods, "models": models,
        "championModel": best_name,
        "errorCorrectionApplied": bool(summary.get("Error Correction Applied")),
        "trainWmape": _ss_float(summary.get("Train WMAPE (%)")),
        "testWmape": _ss_float(summary.get("Test WMAPE (%)")),
        "ranking": ranking,
        "series": points,
        "narrative": narrative,
        "generatedAt": now_iso(),
    }


def _single_sku_worker(job_id: str, ds: Dict[str, Any], sku: str, periods: int,
                       models: List[str], owner: Optional[str]) -> None:
    """Background thread: run the engine's single-series multi-model competition
    for ONE SKU (TimeSeriesForecaster.forecast) and persist the result."""
    _job_update(job_id, status="running", progress=10, startedAt=now_iso(),
                message=f"Preparing {sku} series…")
    # Liveness ticker — cosmetic status only; the competition runs unchanged.
    hb: Optional[_Heartbeat] = _Heartbeat(
        job_id,
        [f"Training {m}" for m in (models or ["models"])] + ["Evaluating accuracy", "Selecting champion"],
    ).start()
    try:
        df = load_dataset_df(ds)
        df = _apply_history_window(df, ds["date_col"], _resolve_config(ds))
        date_col, sales_col, sku_col = ds["date_col"], ds["sales_col"], ds["sku_col"]
        sub = df[df[sku_col].astype(str) == str(sku)][[date_col, sales_col]].copy()
        if sub.empty:
            raise ValueError(f"SKU '{sku}' has no history in this dataset")

        eda = engine.TimeSeriesEDA(
            sub, date_col=date_col, sales_col=sales_col,
            resample_freq=_map_resample_freq(ds.get("freq")), country_code="IN",
        )
        _job_update(job_id, progress=45,
                    message=f"Competing {len(models)} models on {sku}…")
        hb.step(f"Competing {len(models)} models on {sku}", 0.45, 0.95)
        fc = engine.TimeSeriesForecaster(eda)
        final_forecast, best_name, best_result, summary = fc.forecast(
            n_periods=periods, models_to_try=models, error_threshold=20.0, use_tsfresh=False,
        )
        hb.stop()

        payload = _build_single_sku_payload(
            sku, periods, models, eda, final_forecast, best_name, best_result, summary, fc,
        )
        rid = f"ssr_{uuid.uuid4().hex[:12]}"
        with get_conn() as conn:
            conn.execute(
                "DELETE FROM single_sku_runs WHERE owner IS ? AND dataset_id = ?",
                (owner, ds["id"]),
            )
            conn.execute(
                """INSERT INTO single_sku_runs (id, dataset_id, owner, sku, payload_json, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (rid, ds["id"], owner, sku, json.dumps(payload), now_iso()),
            )
        # Advance the workflow exactly like the portfolio worker — a completed
        # forecast (either mode) unlocks the Forecast Submission stage. (Was
        # missing here, so single-SKU runs never set forecast_completed and
        # Submission stayed locked.)
        workflow_set(owner, forecast_completed=True)
        _job_update(job_id, status="completed", progress=100, skuCount=1,
                    completedAt=now_iso(), resultId=rid,
                    message=f"Champion: {best_name}")
    except Exception as exc:
        logging.exception("single-sku competition failed")
        _job_update(job_id, status="failed", error=str(exc)[:300], completedAt=now_iso())
    finally:
        if hb is not None:
            hb.stop()


@app.post("/forecasts/single-sku/run")
def start_single_sku_run(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset to forecast — upload one first")
    sku = str(payload.get("skuId") or "").strip()
    if not sku:
        raise HTTPException(status_code=422, detail="skuId is required")
    periods = int(payload.get("periods") or 12)
    models = [m for m in (payload.get("models") or []) if m in _SS_MODELS_ALLOWED] or list(_SS_MODELS_DEFAULT)
    ds = dict(load_dataset_row(ds_id))  # thread-safe snapshot
    owner = _current_uid()

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id, "status": "queued", "progress": 0, "skuIds": [sku],
        "skuCount": 0, "total": 1, "datasetId": ds_id, "periods": periods,
        "runId": None, "startedAt": now_iso(), "completedAt": None, "error": None,
        "message": "Queued…", "mode": "single_sku",
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    threading.Thread(
        target=_single_sku_worker,
        args=(job_id, ds, sku, periods, models, owner),
        daemon=True,
    ).start()
    return dict(job)


@app.get("/forecasts/single-sku/result")
def get_single_sku_result(datasetId: Optional[str] = Query(None)) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    owner = _current_uid()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload_json FROM single_sku_runs WHERE owner IS ? AND dataset_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (owner, ds_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No single-SKU result yet")
    return json.loads(row["payload_json"])


# ──────────────────────────────────────────────────────────────────────────────
# Scenario Planning (What-If feature simulation) — faithful port of Streamlit
# render_whatif_tab: re-fit the single-series engine for one SKU (reusing
# TimeSeriesForecaster), apply the planner's exog adjustments over a date range,
# re-forecast with the fitted base model, and compare to baseline. Same operations
# as the Streamlit tab (no new forecast math). DoWhy causal path is optional and
# not required for the core what-if.
# ──────────────────────────────────────────────────────────────────────────────
_WHATIF_CHANGE_TYPES = ["Percentage Change", "Constant Change", "Set to New Value"]


def _apply_whatif_rules(exog: "pd.DataFrame", rules: List[Dict[str, Any]],
                        start: Optional[str], end: Optional[str]) -> "pd.DataFrame":
    """Replicate render_whatif_tab's exog modification (lines 14082-14089)."""
    sx = exog.copy()
    mask = pd.Series(True, index=sx.index)
    if start:
        mask &= sx.index >= pd.to_datetime(start)
    if end:
        mask &= sx.index <= pd.to_datetime(end)
    for r in rules:
        f = r.get("feature")
        t = str(r.get("type") or "")
        try:
            v = float(r.get("value"))
        except (TypeError, ValueError):
            continue
        if f not in sx.columns:
            continue
        if t == "Percentage Change":
            sx.loc[mask, f] = sx.loc[mask, f] * (1 + v / 100)
        elif t == "Constant Change":
            sx.loc[mask, f] = sx.loc[mask, f] + v
        else:  # "Set to New Value"
            sx.loc[mask, f] = v
    return sx


def _apply_causal_adjustment(baseline: "pd.Series", exog: "pd.DataFrame",
                             rule: Dict[str, Any], ate: float,
                             start: Optional[str], end: Optional[str]) -> Optional["pd.Series"]:
    """Causal-adjustment what-if (source render_whatif_tab 16098-16113): apply the
    DoWhy causal estimate (ATE) of one lever directly to the baseline, instead of
    re-forecasting through the model. Works for ANY champion model."""
    feat = rule.get("feature")
    t = str(rule.get("type") or "")
    try:
        v = float(rule.get("value"))
    except (TypeError, ValueError):
        return None
    if exog is None or feat not in getattr(exog, "columns", []):
        return None
    mask = pd.Series(True, index=exog.index)
    if start:
        mask &= exog.index >= pd.to_datetime(start)
    if end:
        mask &= exog.index <= pd.to_datetime(end)
    if t == "Percentage Change":
        delta_f = exog.loc[mask, feat] * (v / 100)
    elif t == "Constant Change":
        delta_f = v
    else:  # "Set to New Value"
        delta_f = v - exog.loc[mask, feat]
    sales_impact = delta_f * float(ate)
    whatif = baseline.copy()
    whatif.loc[mask] = whatif.loc[mask] + sales_impact
    return whatif


def _whatif_worker(job_id: str, ds: Dict[str, Any], sku: str, periods: int,
                   models: List[str], adjustments: List[Dict[str, Any]],
                   start: Optional[str], end: Optional[str],
                   causal_ate: Optional[float] = None) -> None:
    _job_update(job_id, status="running", progress=10, startedAt=now_iso(),
                message=f"Fitting {sku}…")
    try:
        df = load_dataset_df(ds)
        df = _apply_history_window(df, ds["date_col"], _resolve_config(ds))
        date_col, sales_col, sku_col = ds["date_col"], ds["sales_col"], ds["sku_col"]
        sub = df[df[sku_col].astype(str) == str(sku)][[date_col, sales_col]].copy()
        if sub.empty:
            raise ValueError(f"SKU '{sku}' has no history in this dataset")
        eda = engine.TimeSeriesEDA(
            sub, date_col=date_col, sales_col=sales_col,
            resample_freq=_map_resample_freq(ds.get("freq")), country_code="IN",
        )
        _job_update(job_id, progress=45, message="Generating baseline forecast…")
        fc = engine.TimeSeriesForecaster(eda)
        final_forecast, best_name, best_result, _summary = fc.forecast(
            n_periods=periods, models_to_try=models, error_threshold=20.0, use_tsfresh=False,
        )
        baseline = final_forecast if isinstance(final_forecast, pd.Series) else pd.Series(dtype=float)
        exog = getattr(fc, "exog_forecast", None)
        best_result = best_result if isinstance(best_result, dict) else {}
        model_name = best_result.get("model_name")
        base_model = best_result.get("model_object")
        avail = [str(c) for c in exog.columns] if exog is not None and hasattr(exog, "columns") else []

        whatif: Optional[pd.Series] = None
        message = ""
        # Causal-adjustment path (source 16098-16113): when the caller supplies a
        # DoWhy ATE, apply it directly to the baseline — works for ANY model.
        used_causal = causal_ate is not None and bool(adjustments)
        if used_causal:
            _job_update(job_id, progress=70, message="Applying causal estimate…")
            whatif = _apply_causal_adjustment(
                baseline, exog, adjustments[0], causal_ate, start, end)
            if whatif is None:
                message = ("Causal adjustment unavailable — the lever isn't an "
                           "exogenous feature of this forecast.")
        supported = (
            model_name in ("prophet", "auto_arima", "sarimax")
            and bool(avail) and base_model is not None
        )
        if used_causal:
            pass
        elif not supported:
            if model_name not in ("prophet", "auto_arima", "sarimax"):
                message = (f"What-if re-forecast not supported for "
                           f"{str(model_name).upper()}. Re-run with Prophet / "
                           f"AutoARIMA / SARIMAX, or use causal adjustment.")
            elif not avail:
                message = "No adjustable exogenous features available for this SKU."
            else:
                message = "Base model unavailable for re-forecast."
        elif not adjustments:
            message = "Add at least one adjustment to simulate a scenario."
        else:
            _job_update(job_id, progress=70, message="Re-forecasting scenario…")
            sx = _apply_whatif_rules(exog, adjustments, start, end)
            n = len(exog)
            try:
                if model_name == "prophet":
                    fut = base_model.make_future_dataframe(periods=n, freq=eda.resample_freq)
                    fut = fut.merge(sx, left_on="ds", right_index=True, how="left").ffill().bfill()
                    p = base_model.predict(fut)
                    whatif = pd.Series(p["yhat"].values[-n:], index=exog.index)
                elif model_name == "auto_arima":
                    whatif = pd.Series(list(base_model.predict(n_periods=len(sx), X=sx)), index=sx.index)
                elif model_name == "sarimax":
                    whatif = pd.Series(base_model.forecast(steps=len(sx), exog=sx))
                    whatif.index = sx.index
            except Exception as ex:  # mirror Streamlit's "Re-forecast failed" guard
                message = f"Re-forecast failed: {ex}"
                whatif = None

        base_total = clean_float(baseline.sum()) if len(baseline) else 0.0
        scen_total = clean_float(whatif.sum()) if (whatif is not None and len(whatif)) else None
        delta = (scen_total - base_total) if scen_total is not None else None
        pct = (delta / base_total * 100) if (delta is not None and base_total) else (
            0.0 if delta is not None else None)
        series: List[Dict[str, Any]] = []
        for idx, bval in baseline.items():
            pt: Dict[str, Any] = {"date": iso_date(idx), "baseline": clean_float(bval)}
            if whatif is not None and idx in getattr(whatif, "index", []):
                pt["scenario"] = clean_float(whatif.loc[idx])
            series.append(pt)

        result = {
            "sku": sku, "championModel": best_name,
            "supported": bool(whatif is not None), "message": message,
            "changeTypes": _WHATIF_CHANGE_TYPES,
            "availableFeatures": avail, "appliedAdjustments": adjustments,
            "baselineTotal": base_total, "scenarioTotal": scen_total,
            "deltaUnits": clean_float(delta) if delta is not None else None,
            "changePct": clean_float(pct) if pct is not None else None,
            "series": series, "generatedAt": now_iso(),
        }
        _job_update(job_id, status="completed", progress=100, completedAt=now_iso(),
                    message="Scenario ready", result=result)
    except Exception as exc:
        logging.exception("what-if scenario failed")
        _job_update(job_id, status="failed", error=str(exc)[:300], completedAt=now_iso())


def _latest_single_sku_run(owner: Optional[str], ds_id: str,
                           sku: str) -> Optional[Dict[str, Any]]:
    """The most recent single-SKU forecast run payload for this SKU (owner +
    dataset scoped), or None. Used so a what-if scenario reuses the EXACT model
    set + horizon the user already forecast on the Forecast page."""
    with get_conn() as conn:
        r = conn.execute(
            "SELECT payload_json FROM single_sku_runs WHERE owner IS ? AND dataset_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (owner, ds_id),
        ).fetchone()
    if not r or not r["payload_json"]:
        return None
    try:
        p = json.loads(r["payload_json"])
    except (ValueError, TypeError):
        return None
    return p if str(p.get("sku")) == str(sku) else None


@app.post("/scenarios/run")
def run_scenario(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset — upload one first")
    sku = str(payload.get("skuId") or "").strip()
    if not sku:
        raise HTTPException(status_code=422, detail="skuId is required")
    # Reuse the SAME forecast baseline the user saw: default the model set and
    # horizon to the latest single-SKU forecast run for this SKU (the engine is
    # deterministic, so re-fitting the same models reproduces the same champion
    # and baseline). Streamlit's what-if sits on the session forecast; this is
    # the stateless equivalent. An explicit caller override still wins.
    prior = _latest_single_sku_run(_current_uid(), ds_id, sku)
    explicit_models = [m for m in (payload.get("models") or []) if m in _SS_MODELS_ALLOWED]
    prior_models = [m for m in ((prior or {}).get("models") or []) if m in _SS_MODELS_ALLOWED]
    models = explicit_models or prior_models or list(_SS_MODELS_DEFAULT)
    periods = int(payload.get("periods") or (prior or {}).get("periods") or 12)
    adjustments = payload.get("adjustments") or []
    start = payload.get("start")
    end = payload.get("end")
    # Optional DoWhy causal estimate (ATE) to apply directly to the baseline
    # instead of re-forecasting (source what-if "Apply causal estimate" path).
    causal_ate = payload.get("causalAte")
    try:
        causal_ate = float(causal_ate) if causal_ate is not None else None
    except (TypeError, ValueError):
        causal_ate = None
    ds = dict(load_dataset_row(ds_id))

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id, "status": "queued", "progress": 0, "skuIds": [sku],
        "skuCount": 0, "total": 1, "datasetId": ds_id, "periods": periods,
        "runId": None, "startedAt": now_iso(), "completedAt": None, "error": None,
        "message": "Queued…", "mode": "scenario", "result": None,
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    threading.Thread(
        target=_whatif_worker,
        args=(job_id, ds, sku, periods, models, adjustments, start, end, causal_ate),
        daemon=True,
    ).start()
    return dict(job)


@app.post("/scenarios/save")
def save_scenario(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset")
    name = str(payload.get("name") or "Scenario").strip() or "Scenario"
    result = payload.get("result") or {}
    sku = str(payload.get("sku") or result.get("sku") or "")
    adjustments = payload.get("adjustments") or result.get("appliedAdjustments") or []
    owner = _current_uid()
    sid = f"scn_{uuid.uuid4().hex[:12]}"
    created = now_iso()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO scenarios (id, dataset_id, owner, name, sku, adjustments_json, result_json, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (sid, ds_id, owner, name, sku, json.dumps(adjustments), json.dumps(result), created),
        )
    return {"id": sid, "datasetId": ds_id, "name": name, "sku": sku, "createdAt": created}


@app.get("/scenarios")
def list_scenarios(datasetId: Optional[str] = Query(None)) -> List[Dict[str, Any]]:
    ds_id = datasetId or latest_dataset_id()
    owner = _current_uid()
    if ds_id is None or owner is None:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, sku, created_at, result_json FROM scenarios "
            "WHERE owner IS ? AND dataset_id = ? ORDER BY created_at DESC",
            (owner, ds_id),
        ).fetchall()
    out: List[Dict[str, Any]] = []
    for r in rows:
        res = json.loads(r["result_json"] or "{}")
        out.append({
            "id": r["id"], "name": r["name"], "sku": r["sku"],
            "createdAt": r["created_at"], "changePct": res.get("changePct"),
            "championModel": res.get("championModel"),
        })
    return out


@app.get("/scenarios/{scenario_id}")
def get_scenario(scenario_id: str) -> Dict[str, Any]:
    owner = _current_uid()
    with get_conn() as conn:
        r = conn.execute(
            "SELECT * FROM scenarios WHERE id = ? AND owner IS ?", (scenario_id, owner),
        ).fetchone()
    if r is None:
        raise HTTPException(status_code=404, detail=f"Scenario '{scenario_id}' not found")
    return {
        "id": r["id"], "datasetId": r["dataset_id"], "name": r["name"], "sku": r["sku"],
        "adjustments": json.loads(r["adjustments_json"] or "[]"),
        "result": json.loads(r["result_json"] or "{}"), "createdAt": r["created_at"],
    }


@app.delete("/scenarios/{scenario_id}")
def delete_scenario(scenario_id: str) -> Dict[str, Any]:
    owner = _current_uid()
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM scenarios WHERE id = ? AND owner IS ?", (scenario_id, owner),
        )
    return {"deleted": scenario_id}


# ──────────────────────────────────────────────────────────────────────────────
# Scenario · Causal Effect Estimation (DoWhy) — parity with render_causal_tab.
# Builds the single-SKU engineered-feature frame the same way the Streamlit tab
# does (eda._engineer_features() + merged numeric exog), then delegates the math
# to scenario_engine (verbatim DoWhy logic). Read-only: never alters forecasts.
# ──────────────────────────────────────────────────────────────────────────────
def _scenario_causal_features(ds: Dict[str, Any], sku: str):
    """Return (features_df, outcome, potential_cols, exog_cols) for one SKU,
    mirroring render_causal_tab's features_df construction (source 15597-15632)."""
    df = load_dataset_df(ds)
    df = _apply_history_window(df, ds["date_col"], _resolve_config(ds))
    date_col, sales_col, sku_col = ds["date_col"], ds["sales_col"], ds["sku_col"]
    sub = df[df[sku_col].astype(str) == str(sku)].copy()
    if sub.empty:
        raise ValueError(f"SKU '{sku}' has no history in this dataset")
    freq = _map_resample_freq(ds.get("freq"))
    eda = engine.TimeSeriesEDA(
        sub[[date_col, sales_col]], date_col=date_col, sales_col=sales_col,
        resample_freq=freq, country_code="IN",
    )
    features_df = eda._engineer_features()
    features_df.rename(columns={"sales": sales_col}, inplace=True)
    features_df["date"] = pd.to_datetime(features_df["date"])
    outcome = sales_col

    # Merge the configured numeric exogenous drivers for this SKU (price/promo/…)
    # so they are available as treatments AND confounders (source 15608-15619).
    cfg = _resolve_config(ds)
    exog_cfg = [c for c in (cfg.get("exogNumeric") or []) if c in sub.columns]
    if not exog_cfg:
        exclude = {date_col, sales_col, sku_col}
        exog_cfg = [
            c for c in sub.columns
            if c not in exclude and pd.to_numeric(sub[c], errors="coerce").notna().any()
        ]
    exog_added: List[str] = []
    if exog_cfg:
        ex = pd.DataFrame({"date": pd.to_datetime(sub[date_col], errors="coerce")})
        for c in exog_cfg:
            ex[c] = pd.to_numeric(sub[c], errors="coerce").values
        ex = (ex.dropna(subset=["date"]).groupby("date").mean()
              .resample(freq).mean().reset_index())
        new = [c for c in exog_cfg if c not in features_df.columns]
        if new:
            features_df = features_df.merge(ex[["date"] + new], on="date", how="left")
            features_df[new] = features_df[new].ffill().fillna(0)
            exog_added = new
    potential = [c for c in features_df.columns if c not in ["date", outcome]]
    return features_df, outcome, potential, exog_added


def _causal_worker(job_id: str, ds: Dict[str, Any], sku: str,
                   treatments: List[str], confounders: List[str],
                   instruments: List[str], effect_modifiers: List[str],
                   methods: List[str], refuters: List[str], compute_ci: bool) -> None:
    _job_update(job_id, status="running", progress=15, startedAt=now_iso(),
                message=f"Building features for {sku}…")
    try:
        features_df, outcome, potential, exog_added = _scenario_causal_features(ds, sku)
        confounders = [c for c in confounders if c in potential and c not in treatments]
        _job_update(job_id, progress=45, message="Measuring causal impact…")
        out = scenario_engine.estimate_causal_effects(
            features_df, outcome, treatments, confounders, instruments,
            effect_modifiers, methods, refuters, compute_ci)
        out.update({"sku": sku, "outcome": outcome, "potential": potential,
                    "exogAccountedFor": exog_added, "generatedAt": now_iso()})
        _job_update(job_id, status="completed", progress=100, completedAt=now_iso(),
                    message="Causal estimate ready", result=out)
    except Exception as exc:
        logging.exception("causal estimation failed")
        _job_update(job_id, status="failed", error=str(exc)[:300], completedAt=now_iso())


def _drivers_worker(job_id: str, ds: Dict[str, Any], sku: str, use_all_conf: bool) -> None:
    _job_update(job_id, status="running", progress=15, startedAt=now_iso(),
                message=f"Ranking levers for {sku}…")
    try:
        features_df, outcome, potential, _exog = _scenario_causal_features(ds, sku)
        _job_update(job_id, progress=45, message="Testing each lever…")
        ranked = scenario_engine.rank_drivers(features_df, outcome, potential, use_all_conf)
        _job_update(job_id, status="completed", progress=100, completedAt=now_iso(),
                    message="Driver ranking ready",
                    result={"sku": sku, "outcome": outcome, "ranked": ranked,
                            "generatedAt": now_iso()})
    except Exception as exc:
        logging.exception("driver ranking failed")
        _job_update(job_id, status="failed", error=str(exc)[:300], completedAt=now_iso())


@app.get("/scenarios/causal/features")
def scenario_causal_features(datasetId: Optional[str] = Query(None),
                             skuId: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Candidate levers (potential treatments/confounders) for a SKU + DoWhy
    availability. Mirrors how render_causal_tab derives `potential`."""
    if not scenario_engine.DOWHY_AVAILABLE:
        return {"available": False, "columns": [], "outcome": None,
                "message": "Install `dowhy` and `graphviz` for causal analysis."}
    ds_id = datasetId or latest_dataset_id()
    sku = str(skuId or "").strip()
    if ds_id is None or not sku:
        return {"available": True, "columns": [], "outcome": None,
                "exogAccountedFor": [], "message": "Select a forecast level first."}
    try:
        ds = dict(load_dataset_row(ds_id))
        _features, outcome, potential, exog_added = _scenario_causal_features(ds, sku)
        return {"available": True, "columns": potential, "outcome": outcome,
                "exogAccountedFor": exog_added, "message": ""}
    except Exception as exc:
        logging.warning("scenario_causal_features failed: %s", exc)
        return {"available": True, "columns": [], "outcome": None,
                "exogAccountedFor": [], "message": str(exc)[:200]}


@app.post("/scenarios/causal/run")
def run_causal(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    if not scenario_engine.DOWHY_AVAILABLE:
        raise HTTPException(status_code=503,
                            detail="Causal analysis requires dowhy + graphviz")
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset — upload one first")
    sku = str(payload.get("skuId") or "").strip()
    if not sku:
        raise HTTPException(status_code=422, detail="skuId is required")
    treatments = [str(t) for t in (payload.get("treatments") or []) if str(t).strip()]
    if not treatments:
        raise HTTPException(status_code=422, detail="Select at least one lever (treatment)")
    confounders = [str(c) for c in (payload.get("confounders") or [])]
    instruments = [str(c) for c in (payload.get("instruments") or [])]
    effect_modifiers = [str(c) for c in (payload.get("effectModifiers") or [])]
    methods = [str(m) for m in (payload.get("methods") or [])] or ["backdoor.linear_regression"]
    refuters = payload.get("refuters")
    refuters = ([str(r) for r in refuters] if isinstance(refuters, list)
                else [mn for mn, _ in scenario_engine.REFUTER_CHOICES])
    compute_ci = bool(payload.get("computeCi", True))
    ds = dict(load_dataset_row(ds_id))

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = {"id": job_id, "status": "queued", "progress": 0, "skuIds": [sku],
           "skuCount": 0, "total": 1, "datasetId": ds_id, "runId": None,
           "startedAt": now_iso(), "completedAt": None, "error": None,
           "message": "Queued…", "mode": "causal", "result": None}
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    threading.Thread(
        target=_causal_worker,
        args=(job_id, ds, sku, treatments, confounders, instruments,
              effect_modifiers, methods, refuters, compute_ci),
        daemon=True,
    ).start()
    return dict(job)


@app.post("/scenarios/causal/drivers")
def run_causal_drivers(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    if not scenario_engine.DOWHY_AVAILABLE:
        raise HTTPException(status_code=503,
                            detail="Causal analysis requires dowhy + graphviz")
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset — upload one first")
    sku = str(payload.get("skuId") or "").strip()
    if not sku:
        raise HTTPException(status_code=422, detail="skuId is required")
    use_all_conf = bool(payload.get("useAllConfounders", True))
    ds = dict(load_dataset_row(ds_id))
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = {"id": job_id, "status": "queued", "progress": 0, "skuIds": [sku],
           "skuCount": 0, "total": 1, "datasetId": ds_id, "runId": None,
           "startedAt": now_iso(), "completedAt": None, "error": None,
           "message": "Queued…", "mode": "drivers", "result": None}
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    threading.Thread(target=_drivers_worker, args=(job_id, ds, sku, use_all_conf),
                     daemon=True).start()
    return dict(job)


def _resolve_run(run_id: Optional[str], dataset_id: Optional[str]):
    """Return (run_id, [detail dicts]) for an explicit run or the latest run."""
    with get_conn() as conn:
        rid = run_id
        if not rid:
            ds = dataset_id or latest_dataset_id()
            r = conn.execute(
                "SELECT run_id FROM forecasts WHERE dataset_id=? ORDER BY generated_at DESC LIMIT 1",
                (ds,),
            ).fetchone()
            rid = r["run_id"] if r else None
        rows = (
            conn.execute("SELECT detail_json FROM forecasts WHERE run_id=?", (rid,)).fetchall()
            if rid else []
        )
    return rid, [json.loads(r["detail_json"]) for r in rows]


def _pooled(records: List[Dict[str, float]]) -> Dict[str, Any]:
    """Pooled WMAPE / SMAPE / bias over a list of {actual, pred} holdout points —
    the exact methodology of the engine's _aggregate_metrics (Σ|resid|/Σactual,
    pooled SMAPE, Σ(pred-actual)/Σactual). NOT an average of per-SKU metrics."""
    sum_actual = sum(r["actual"] for r in records)
    sum_pred = sum(r["pred"] for r in records)
    sum_abs_resid = sum(abs(r["pred"] - r["actual"]) for r in records)
    smape_vals: List[float] = []
    for r in records:
        denom = (abs(r["actual"]) + abs(r["pred"])) / 2.0
        if denom > 0:
            smape_vals.append(abs(r["actual"] - r["pred"]) / denom)
    return {
        "weightedWmape": clean_float(sum_abs_resid / sum_actual * 100) if sum_actual > 0 else None,
        "smape": clean_float(sum(smape_vals) / len(smape_vals) * 100) if smape_vals else None,
        "weightedBias": clean_float((sum_pred - sum_actual) / sum_actual * 100) if sum_actual > 0 else None,
        "volume": clean_float(sum_actual),
    }


def _pooled_groups(details: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the residual long frame from each forecast's stored testActual/testPred
    and pool metrics at overall / segment / brand / brand×segment — mirroring the
    Streamlit engine's _build_residuals_long + _aggregate_metrics. Coverage =
    backtested SKUs / attempted SKUs (per group)."""
    long: List[Dict[str, Any]] = []
    total_by: Dict[str, set] = {"segment": {}, "brand": {}, "brandSegment": {}}
    # Track attempted (total) SKUs per group from ALL details, backtested below.
    seg_total: Dict[str, set] = {}
    brand_total: Dict[str, set] = {}
    bs_total: Dict[Tuple[str, str], set] = {}
    for d in details:
        sku = str(d.get("skuId"))
        brand = d.get("brand") or "unknown"
        segment = d.get("segment") or "unknown"
        seg_total.setdefault(segment, set()).add(sku)
        brand_total.setdefault(brand, set()).add(sku)
        bs_total.setdefault((brand, segment), set()).add(sku)
        actuals = {p["date"]: p.get("value") for p in d.get("testActual", [])}
        preds = {p["date"]: p.get("value") for p in d.get("testPred", [])}
        for date, a in actuals.items():
            p = preds.get(date)
            if a is None or p is None:
                continue
            long.append({"sku": sku, "brand": brand, "segment": segment,
                         "actual": float(a), "pred": float(p)})

    def _group(key_cols, totals) -> List[Dict[str, Any]]:
        buckets: Dict[Any, List[Dict[str, float]]] = {}
        bt_skus: Dict[Any, set] = {}
        for row in long:
            k = key_cols(row)
            buckets.setdefault(k, []).append(row)
            bt_skus.setdefault(k, set()).add(row["sku"])
        out = []
        for k, recs in buckets.items():
            m = _pooled(recs)
            n_bt = len(bt_skus[k])
            n_total = len(totals.get(k, set())) or n_bt
            wmape = m["weightedWmape"]
            row = {
                **m,
                "skuCount": n_bt,
                "coveragePct": clean_float(round(n_bt / n_total * 100, 0)) if n_total else None,
                "errorContribution": clean_float((m["volume"] or 0) * wmape / 100) if wmape is not None else 0.0,
            }
            out.append((k, row))
        return out

    segment = [{"key": k, **row} for k, row in _group(lambda r: r["segment"], seg_total)]
    brand = [{"key": k, **row} for k, row in _group(lambda r: r["brand"], brand_total)]
    brand_segment = [
        {"brand": k[0], "segment": k[1], "key": f"{k[0]} · {k[1]}", **row}
        for k, row in _group(lambda r: (r["brand"], r["segment"]), bs_total)
    ]

    n_total = len({str(d.get("skuId")) for d in details})
    n_bt = len({r["sku"] for r in long})
    overall = {
        **_pooled(long),
        "skuCount": n_bt,
        "coveragePct": clean_float(round(n_bt / n_total * 100, 0)) if n_total else None,
    }
    return {"overall": overall, "segment": segment, "brand": brand, "brandSegment": brand_segment}


@app.get("/forecasts/metrics")
def forecast_metrics(
    datasetId: Optional[str] = Query(None),
    runId: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Run summary + per-SKU rows + quality-band counts for the Forecast results."""
    import statistics
    rid, details = _resolve_run(runId, datasetId)
    train_mapes: List[float] = []
    test_mapes: List[float] = []
    total_units = 0.0
    bands = {"Good": 0, "Review": 0, "Poor": 0, "No metric": 0}
    skus: List[Dict[str, Any]] = []
    for d in details:
        tw, te = d.get("trainWmape"), d.get("testWmape")
        band = d.get("band") or "No metric"
        bands[band] = bands.get(band, 0) + 1
        if tw is not None:
            train_mapes.append(tw)
        if te is not None:
            test_mapes.append(te)
        total_units += d.get("forecastTotal") or 0.0
        # bias is stored as a fraction in detail.metrics; expose as a percent so it
        # lines up with WMAPE/SMAPE in the Performance tab (Streamlit shows %).
        m = d.get("metrics") or {}
        bias_frac = m.get("bias")
        smape_frac = m.get("smape")
        skus.append({
            "id": d.get("id"),
            "sku": d.get("skuId"),
            "strategy": d.get("strategyUsed"),
            "strategyLabel": d.get("strategyLabel"),
            "brand": d.get("brand"),
            "segment": d.get("segment"),
            "trainWmape": tw,
            "testWmape": te,
            "bias": clean_float(bias_frac * 100) if bias_frac is not None else None,
            "smape": clean_float(smape_frac * 100) if smape_frac is not None else None,
            "band": band,
            "forecastTotal": d.get("forecastTotal"),
            "overridden": d.get("overridden"),
            "cvSelected": d.get("cvSelected"),
            "allModels": d.get("allModels", []),
        })

    def med(xs: List[float]) -> Optional[float]:
        return clean_float(statistics.median(xs)) if xs else None

    cfg = _run_config(rid)
    return {
        "runId": rid,
        "reconciled": bool(cfg.get("reconcile")),
        "globalTrained": bool(cfg.get("globalTrained")),
        "kpis": {
            "skusForecasted": len(details),
            "medianTrainWmape": med(train_mapes),
            "medianTestWmape": med(test_mapes),
            "totalForecastUnits": clean_float(total_units),
        },
        "bands": bands,
        "skus": skus,
        # Pooled group aggregates (Streamlit _aggregate_metrics parity) — the
        # Performance tab consumes these instead of averaging per-SKU metrics.
        "groups": _pooled_groups(details),
    }


def _run_config(run_id: Optional[str]) -> Dict[str, Any]:
    """Stored per-run config (reconcile/useGlobal flags + reconciliation payload)."""
    if not run_id:
        return {}
    with get_conn() as conn:
        r = conn.execute("SELECT config_json FROM forecast_runs WHERE id=?", (run_id,)).fetchone()
    if not r or not r["config_json"]:
        return {}
    try:
        return json.loads(r["config_json"])
    except (ValueError, TypeError):
        return {}


@app.get("/forecasts/reconciliation")
def forecast_reconciliation(
    datasetId: Optional[str] = Query(None),
    runId: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Brand-level reconciliation payload (JSON) for the run — powers the
    Forecast tab's "Brand-Level Reconciliation" table + reconciled charts.
    Returns 422 when the run was not launched with reconcile=true (mirrors the
    Streamlit section, which only appears when reconciliation ran)."""
    rid, _ = _resolve_run(runId, datasetId)
    cfg = _run_config(rid)
    recon = cfg.get("reconciliation") if cfg.get("reconcile") else None
    if not recon:
        raise HTTPException(
            status_code=422,
            detail="Reconciliation not enabled for this run (re-run with 'Reconcile to brand totals').",
        )
    reconciled = recon.get("reconciled", {})
    bottom_up = recon.get("bottomUp", {})
    top_down = recon.get("topDown", {})
    brands = sorted(reconciled.keys())

    # ── Brand-level historical actuals + previous-year overlay ────────────────
    # Read-only: derived from the SAME dataset the run used (groupby brand×period),
    # purely to surface the history Streamlit's reconciliation chart shows. Does
    # NOT touch compute_brand_reconciliation or any stored payload. Degrades
    # gracefully (no overlays) if the dataset/brand column is unavailable.
    hist_by_brand: Dict[str, List[tuple]] = {}
    prevyear_by_brand: Dict[str, Dict[str, float]] = {}
    try:
        with get_conn() as conn:
            rr = conn.execute(
                "SELECT dataset_id, freq FROM forecast_runs WHERE id=?", (rid,)
            ).fetchone()
        ds_id = (rr["dataset_id"] if rr else None) or datasetId or latest_dataset_id()
        run_freq = (rr["freq"] if rr and rr["freq"] else None) or "MS"
        ds = get_dataset(ds_id) if ds_id else None
        if ds:
            dfh = load_dataset_df(ds)
            dfh = _apply_history_window(dfh, ds["date_col"], _resolve_config(ds))
            bcol = _pick_column(
                list(dfh.columns.astype(str)),
                ["brand", "manufacturer", "vendor", "label"],
            )
            if bcol:
                grouped = (
                    dfh.groupby(
                        [bcol, pd.Grouper(key=ds["date_col"], freq=run_freq)]
                    )[ds["sales_col"]]
                    .sum()
                )
                for (b, ts), val in grouped.items():
                    b = str(b)
                    iso = iso_date(ts)
                    if iso is None:
                        continue
                    hist_by_brand.setdefault(b, []).append((iso, clean_float(val)))
                    # Keyed by YYYY-MM for previous-year alignment.
                    prevyear_by_brand.setdefault(b, {})[iso[:7]] = clean_float(val)
    except Exception as exc:  # pragma: no cover — overlay is best-effort
        logging.warning("reconciliation history overlay unavailable: %s", exc)

    out = []
    for brand in brands:
        bu = {p["d"]: p["v"] for p in bottom_up.get(brand, [])}
        td = {p["d"]: p["v"] for p in top_down.get(brand, [])}
        rc = {p["d"]: p["v"] for p in reconciled.get(brand, [])}
        dates = sorted(set(bu) | set(td) | set(rc))
        pv = prevyear_by_brand.get(brand, {})
        previous_year = [
            {"date": d, "value": pv.get(f"{int(d[:4]) - 1}-{d[5:7]}")}
            for d in dates
        ]
        history = [
            {"date": iso, "value": v} for iso, v in hist_by_brand.get(brand, [])
        ]
        out.append({
            "brand": brand,
            "series": [
                {"date": d, "bottomUp": bu.get(d), "topDown": td.get(d),
                 "reconciled": rc.get(d)}
                for d in dates
            ],
            "history": history,
            "previousYear": previous_year,
        })
    return {"runId": rid, "brands": brands, "reconciliation": out}


@app.get("/forecasts/export/{kind}")
def export_forecasts(
    kind: str,
    datasetId: Optional[str] = Query(None),
    runId: Optional[str] = Query(None),
):
    """Real Forecast exports: forecasts, all-models, reconciliation, sku-adjusted.

    Reconciliation is computed ONLY when the run was launched with reconcile=true
    (stored at run time). Exports reflect reconciled SKU forecasts when on, raw
    forecasts when off — matching the Streamlit toggle behaviour exactly."""
    rid, details = _resolve_run(runId, datasetId)
    if not details:
        raise HTTPException(status_code=404, detail="No forecasts to export")
    cfg = _run_config(rid)
    recon = cfg.get("reconciliation") if cfg.get("reconcile") else None

    if kind == "forecasts":
        # When reconciled, ship the adjusted SKU forecasts; else the raw ones.
        adjusted = (recon or {}).get("adjusted", {}) if recon else {}
        buf = io.StringIO()
        buf.write("sku,date,forecast,lower,upper,reconciled\n")
        for d in details:
            sku = str(d.get("skuId"))
            adj = {p["d"]: p["v"] for p in adjusted.get(sku, [])} if adjusted else {}
            for p in d.get("series", []):
                if p.get("forecast") is None:
                    continue
                date = p.get("date")
                val = adj.get(date, p.get("forecast")) if adj else p.get("forecast")
                buf.write(f'{sku},{date},{val},{p.get("lowerBound", "")},'
                          f'{p.get("upperBound", "")},{"yes" if adj else "no"}\n')
        return _csv_response(buf.getvalue(), "forecasts.csv")

    if kind == "all-models":
        buf = io.StringIO()
        buf.write("sku,algorithm,role,test_wmape,cv_wmape,forecast_total,note\n")
        for d in details:
            for m in d.get("allModels", []):
                role = "Champion" if m.get("isChampion") else "Candidate"
                buf.write(f'{d.get("skuId")},"{m.get("label")}",{role},'
                          f'{m.get("testWmape", "")},{m.get("cvWmape", "")},'
                          f'{m.get("forecastTotal", "")},"{m.get("reason", "")}"\n')
        return _csv_response(buf.getvalue(), "all_models_per_sku.csv")

    if kind in ("reconciliation", "sku-adjusted"):
        if not recon:
            raise HTTPException(
                status_code=422,
                detail="Reconciliation not enabled for this run (re-run with 'Reconcile to brand totals').",
            )
        buf = io.StringIO()
        if kind == "reconciliation":
            buf.write("brand,date,bottom_up,top_down,reconciled\n")
            reconciled = recon.get("reconciled", {})
            bottom_up = recon.get("bottomUp", {})
            top_down = recon.get("topDown", {})
            for brand, pairs in reconciled.items():
                bu = {p["d"]: p["v"] for p in bottom_up.get(brand, [])}
                td = {p["d"]: p["v"] for p in top_down.get(brand, [])}
                for p in pairs:
                    buf.write(f'"{brand}",{p["d"]},{bu.get(p["d"], "")},'
                              f'{td.get(p["d"], "")},{p["v"]}\n')
            return _csv_response(buf.getvalue(), "brand_reconciliation.csv")
        buf.write("sku,date,adjusted_forecast\n")
        for sku, pairs in recon.get("adjusted", {}).items():
            for p in pairs:
                buf.write(f'{sku},{p["d"]},{p["v"]}\n')
        return _csv_response(buf.getvalue(), "sku_forecasts_reconciled.csv")

    raise HTTPException(status_code=404, detail=f"Unknown export '{kind}'")


# NOTE: GET /forecasts/{forecast_id} is registered at the END of the file so the
# literal /forecasts/submission* routes match before this catch-all param route.


# ── Workflow state ────────────────────────────────────────────────────────────
@app.get("/workflow/status")
def get_workflow_status() -> Dict[str, Any]:
    return workflow_get()


@app.post("/workflow/complete")
def complete_workflow_step(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Mark a stage complete. `dataset` is set automatically on upload; the
    others (`eda`, `profile`, `forecast`, `review`) can be confirmed by the
    client in the authed request context. `forecast` is ALSO set by the run
    worker — accepting it here is a robust fallback so the transition never
    depends solely on the background thread resolving the dataset owner."""
    step = str((payload or {}).get("step") or "").strip().lower()
    mapping = {
        "eda": "eda_completed",
        "profile": "profile_completed",
        "forecast": "forecast_completed",
        "review": "review_completed",
    }
    if step not in mapping:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown step '{step}'. Expected one of {list(mapping)}.",
        )
    workflow_set(**{mapping[step]: True})
    return workflow_get()


# ── EDA (Exploratory Data Analysis) ───────────────────────────────────────────
_FREQ_PERIOD = {"D": 7, "W": 52, "MS": 12, "QS": 4, "YS": 1}
# Seasonal period used for seasonal_decompose — kept identical to the Streamlit
# engine's plot_decomposition map (app_v2_6.py: {'D':7,'W':4,'M':12,'Q':4,'Y':2})
# so the React decomposition matches Streamlit exactly. (Distinct from
# _FREQ_PERIOD, which also drives ACF/PACF nlags and is left unchanged.)
_DECOMP_PERIOD = {"D": 7, "W": 4, "MS": 12, "QS": 4, "YS": 2}


# ── Forecast Explainability (Phase X.U) ──────────────────────────────────────
# READ-ONLY interpretation layer. It derives a normalized driver breakdown from
# EXISTING data via statistical decomposition + correlation. It NEVER reruns,
# retrains, or alters any forecast — it only explains the demand pattern.
_EXOG_KEYWORDS = [
    ("promo", "Promotion"), ("scheme", "Promotion"), ("discount", "Discount"),
    ("price", "Price"), ("holiday", "Holiday"), ("festiv", "Holiday"),
    ("weather", "Weather"), ("temp", "Weather"), ("rain", "Weather"),
    ("market", "Marketing"), ("advert", "Marketing"), ("spend", "Marketing"),
    ("event", "Events"), ("region", "Region"), ("zone", "Region"),
    ("channel", "Channel"), ("store", "Channel"),
]


def _exog_label(col: str) -> str:
    lc = str(col).lower()
    for kw, label in _EXOG_KEYWORDS:
        if kw in lc:
            return label
    return " ".join(w.capitalize() for w in str(col).replace("_", " ").split())


def explain_forecast(s: "pd.Series", work: "pd.DataFrame", ds: Dict[str, Any],
                     freq: str) -> Optional[Dict[str, Any]]:
    """Derive a normalized contribution breakdown for a demand series.

    Returns {trend, seasonality, holiday, residual, exogenous:{label:pct}} where
    every value is a percentage and the magnitudes sum to ~100. READ-ONLY: pure
    decomposition + correlation of already-computed data. Returns None when the
    series is too short to interpret."""
    try:
        s = s.astype(float).dropna()
    except Exception:
        return None
    n = int(len(s))
    if n < 4:
        return None
    demand_std = float(s.std()) or 1.0

    # Trend / seasonality / residual signal magnitudes.
    try:
        slope = float(np.polyfit(np.arange(n), s.values, 1)[0])
    except Exception:
        slope = 0.0
    trend_sig = abs(slope) * n
    try:
        by_month = s.groupby(s.index.month).mean()
        season_sig = float(by_month.std()) if len(by_month) > 1 else 0.0
    except Exception:
        season_sig = 0.0
    resid_sig = demand_std * 0.20
    decomp_period = _DECOMP_PERIOD.get(freq, 4)
    if decomp_period >= 2 and n >= decomp_period * 2:
        try:
            from statsmodels.tsa.seasonal import seasonal_decompose
            dec = seasonal_decompose(s, model="additive", period=decomp_period)
            trend_sig = float(np.nanstd(dec.trend.values)) or trend_sig
            season_sig = float(np.nanstd(dec.seasonal.values)) or season_sig
            resid_sig = float(np.nanstd(dec.resid.values)) or resid_sig
        except Exception:
            pass

    # Exogenous / holiday signals via period-aligned Pearson correlation.
    holiday_sig = 0.0
    exog: Dict[str, Dict[str, float]] = {}
    try:
        date_col = str(ds["date_col"]); sales_col = str(ds["sales_col"]); sku_col = str(ds["sku_col"])
        exclude = {date_col, sales_col, sku_col}
        dts = pd.to_datetime(work[date_col], errors="coerce")
        for col in [str(c) for c in work.columns]:
            if col in exclude:
                continue
            ser = pd.to_numeric(work[col], errors="coerce")
            if ser.notna().sum() < max(4, n // 2):
                continue
            try:
                per = (pd.DataFrame({"d": dts, "v": ser}).dropna()
                       .set_index("d")["v"].resample(freq).mean())
                pair = pd.concat([s, per.reindex(s.index)], axis=1).dropna()
                if len(pair) < 4 or float(pair.iloc[:, 1].std()) == 0:
                    continue
                r = float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))
                if not np.isfinite(r):
                    continue
                mag = abs(r) * demand_std
                label = _exog_label(col)
                if label == "Holiday":
                    holiday_sig = max(holiday_sig, mag)
                else:
                    prev = exog.get(label)
                    if prev is None or mag > prev["_mag"]:
                        exog[label] = {"_mag": mag, "r": round(r, 3)}
            except Exception:
                continue
    except Exception:
        pass

    total = trend_sig + season_sig + holiday_sig + resid_sig + sum(v["_mag"] for v in exog.values())
    total = total or 1.0
    pct = lambda v: round(100.0 * float(v) / total, 1)
    exog_out = {
        label: {"pct": pct(v["_mag"]) * (1 if v["r"] >= 0 else -1), "correlation": v["r"]}
        for label, v in exog.items()
    }
    return {
        "trend": pct(trend_sig),
        "seasonality": pct(season_sig),
        "holiday": pct(holiday_sig),
        "residual": pct(resid_sig),
        "exogenous": exog_out,
        "slopeDirection": "up" if slope > 0 else "down" if slope < 0 else "flat",
    }


def _explain_series_for(ds: Dict[str, Any], freq: str, work: "pd.DataFrame",
                        sales_col: str, date_col: str) -> Optional[Dict[str, Any]]:
    """Resample `work` to a clean demand series, then explain it."""
    try:
        tmp = (pd.DataFrame({"d": pd.to_datetime(work[date_col], errors="coerce"),
                             "v": pd.to_numeric(work[sales_col], errors="coerce")})
               .dropna().set_index("d")["v"].resample(freq).sum())
        return explain_forecast(tmp, work, ds, freq)
    except Exception:
        return None


# Phase X.W — Explainability is now exclusively FORECAST-LEVEL. The former
# `/explainability/global` (portfolio + per-segment aggregate drivers) was removed:
# users want per-entity answers ("why did Material 1001 increase?"), not portfolio
# explanations. Only the local + horizon endpoints below remain.


@app.get("/explainability/local/{forecast_level}")
def explainability_local(forecast_level: str,
                         datasetId: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Single forecast-level entity: contribution breakdown + a derived waterfall
    (base demand → signed driver deltas → final forecast)."""
    ds_id = datasetId or latest_dataset_id()
    _empty = {"available": False, "entity": forecast_level, "model": "",
              "contributions": None, "waterfall": []}
    if ds_id is None:
        return dict(_empty)
    try:
        ds = dict(load_dataset_row(ds_id))
        df = load_dataset_df(ds)
        freq = ds["freq"] or "MS"
        date_col, sales_col, sku_col = str(ds["date_col"]), str(ds["sales_col"]), str(ds["sku_col"])
        work = df[df[sku_col].astype(str) == str(forecast_level)]
        if work.empty:
            return dict(_empty)
        ex = _explain_series_for(ds, freq, work, sales_col, date_col)
        if ex is None:
            return dict(_empty)

        # Base = historical mean/period; final = the stored forecast mean if present.
        hist = (pd.DataFrame({"d": pd.to_datetime(work[date_col], errors="coerce"),
                              "v": pd.to_numeric(work[sales_col], errors="coerce")})
                .dropna().set_index("d")["v"].resample(freq).sum())
        base = float(hist.mean()) if len(hist) else 0.0
        final = base
        model_label = ""
        try:
            with get_conn() as conn:
                row = conn.execute(
                    "SELECT total_forecast_units, horizon, model, detail_json FROM forecasts "
                    "WHERE dataset_id = ? AND sku = ? ORDER BY generated_at DESC LIMIT 1",
                    (ds_id, str(forecast_level)),
                ).fetchone()
            if row and row["total_forecast_units"]:
                hz = 1
                try:
                    hz = max(1, int(float(row["horizon"])))
                except Exception:
                    hz = 1
                final = float(row["total_forecast_units"]) / hz
            if row:
                try:
                    det = json.loads(row["detail_json"]) if row["detail_json"] else {}
                    model_label = str(det.get("strategyLabel") or row["model"] or "")
                except Exception:
                    model_label = str(row["model"] or "")
        except Exception:
            pass

        # Distribute (final - base) across the signed driver percentages. Drivers are
        # emitted in a fixed, business-readable order: Trend → Seasonality → exogenous
        # (Promotion / Price / …) → Holiday → Residual. Positive deltas lift demand,
        # negatives drag it; the Residual closes the bridge to the stored forecast.
        ordered: List[tuple] = [
            ("Trend", ex["trend"] * (1 if ex["slopeDirection"] != "down" else -1)),
            ("Seasonality", ex["seasonality"]),
        ]
        for label, info in sorted(ex["exogenous"].items(), key=lambda kv: -abs(kv[1]["pct"])):
            ordered.append((label, info["pct"]))
        ordered.append(("Holiday", ex["holiday"]))
        ordered.append(("Residual", ex["residual"]))
        sign_sum = sum(abs(p) for _, p in ordered) or 1.0
        delta = final - base
        waterfall = [{"label": "Base demand", "value": round(base, 1), "type": "base"}]
        for label, p in ordered:
            if p == 0:
                continue
            contrib = round(delta * (p / sign_sum), 1)
            waterfall.append({"label": label, "value": contrib, "type": "delta"})
        waterfall.append({"label": "Final forecast", "value": round(final, 1), "type": "total"})
        return {"available": True, "entity": forecast_level, "model": model_label,
                "contributions": ex, "waterfall": waterfall}
    except Exception as exc:
        logging.warning("explainability_local failed: %s", exc)
        return {"available": False, "entity": forecast_level, "model": "",
                "contributions": None, "waterfall": []}


@app.get("/explainability/horizon/{forecast_level}")
def explainability_horizon(forecast_level: str,
                           datasetId: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Per-horizon driver breakdown for one entity, derived from the seasonal
    index + trend over the stored forecast periods (read-only)."""
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        return {"available": False, "entity": forecast_level, "periods": []}
    try:
        ds = dict(load_dataset_row(ds_id))
        df = load_dataset_df(ds)
        freq = ds["freq"] or "MS"
        date_col, sales_col, sku_col = str(ds["date_col"]), str(ds["sales_col"]), str(ds["sku_col"])
        work = df[df[sku_col].astype(str) == str(forecast_level)]
        if work.empty:
            return {"available": False, "entity": forecast_level, "periods": []}
        hist = (pd.DataFrame({"d": pd.to_datetime(work[date_col], errors="coerce"),
                              "v": pd.to_numeric(work[sales_col], errors="coerce")})
                .dropna().set_index("d")["v"].resample(freq).sum())
        if len(hist) < 4:
            return {"available": False, "entity": forecast_level, "periods": []}

        overall = float(hist.mean())
        by_month = hist.groupby(hist.index.month).mean()
        try:
            slope = float(np.polyfit(np.arange(len(hist)), hist.values, 1)[0])
        except Exception:
            slope = 0.0

        # Derive the entity's exogenous + residual shares once (read-only) so each
        # horizon period carries Exogenous and Residual alongside Trend / Seasonality.
        ex = _explain_series_for(ds, freq, work, sales_col, date_col)
        exog_total_pct = 0.0
        residual_pct = 0.0
        holiday_pct = 0.0
        exog_items: List[tuple] = []
        if ex:
            exog_total_pct = sum(abs(v.get("pct", 0.0)) for v in ex.get("exogenous", {}).values())
            residual_pct = float(ex.get("residual", 0.0))
            holiday_pct = float(ex.get("holiday", 0.0))
            exog_items = list(ex.get("exogenous", {}).items())  # [(label, {pct,...})]
        exog_abs = round(overall * exog_total_pct / 100.0, 1)
        residual_abs = round(overall * residual_pct / 100.0, 1)
        holiday_abs = round(overall * holiday_pct / 100.0, 1)

        # Stored forecast dates for this entity (else synthesize the next periods).
        fc_dates: List[pd.Timestamp] = []
        try:
            with get_conn() as conn:
                row = conn.execute(
                    "SELECT detail_json FROM forecasts WHERE dataset_id = ? AND sku = ? "
                    "ORDER BY generated_at DESC LIMIT 1", (ds_id, str(forecast_level))).fetchone()
            if row and row["detail_json"]:
                det = json.loads(row["detail_json"])
                for p in det.get("series", []):
                    if p.get("forecast") is not None and p.get("date"):
                        fc_dates.append(pd.to_datetime(p["date"]))
        except Exception:
            pass
        if not fc_dates:
            last = hist.index[-1]
            fc_dates = list(pd.date_range(last, periods=7, freq=freq))[1:]

        month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        periods: List[Dict[str, Any]] = []
        for i, dt in enumerate(fc_dates[:24]):
            m = int(dt.month)
            seasonal = float(by_month.get(m, overall)) - overall
            trend = slope * (len(hist) + i)
            # Per-period driver share: each component's magnitude as a % of the
            # total moving parts for that period. Exogenous + Residual are the
            # entity-level shares applied as a flat lift, consistent across horizons.
            denom = abs(trend) + abs(seasonal) + abs(exog_abs) + abs(residual_abs)
            denom = denom or 1.0
            # Phase X.X · Task 6 — per-driver ABSOLUTE contributions for this month
            # (signed, demand units) so the monthly Forecast Bridge can decompose
            # into Trend / Seasonality / Holiday / Promotion / Price / Weather /
            # Residual. Same derived shares as the aggregate — just split per label.
            drivers: Dict[str, float] = {
                "Trend": round(trend, 1),
                "Seasonality": round(seasonal, 1),
            }
            if holiday_abs:
                drivers["Holiday"] = holiday_abs
            for _label, _info in exog_items:
                drivers[_label] = round(overall * float(_info.get("pct", 0.0)) / 100.0, 1)
            drivers["Residual"] = residual_abs
            periods.append({
                "label": f"{month_names[m - 1]} {int(dt.year)}",
                "index": f"M+{i + 1}",
                "base": round(overall, 1),
                "trend": round(trend, 1),
                "seasonality": round(seasonal, 1),
                "exogenous": exog_abs,
                "residual": residual_abs,
                "trendPct": round(100.0 * abs(trend) / denom, 1),
                "seasonalityPct": round(100.0 * abs(seasonal) / denom, 1),
                "exogenousPct": round(100.0 * abs(exog_abs) / denom, 1),
                "residualPct": round(100.0 * abs(residual_abs) / denom, 1),
                "drivers": drivers,
            })
        return {"available": True, "entity": forecast_level, "periods": periods}
    except Exception as exc:
        logging.warning("explainability_horizon failed: %s", exc)
        return {"available": False, "entity": forecast_level, "periods": []}


@app.get("/eda")
def get_eda(
    datasetId: Optional[str] = Query(None),
    sku: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Single-series / portfolio EDA: trend, seasonality, decomposition, ACF,
    outliers, and data-quality — reusing the engine's TimeSeriesEDA for prep +
    anomaly detection, then statsmodels for decomposition / autocorrelation."""
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    ds = dict(load_dataset_row(ds_id))
    df = load_dataset_df(ds)
    # Honor the saved Data-page configuration. Column mapping + frequency are
    # mirrored onto the dataset row by PATCH /datasets/{id}/config (so they
    # already flow through `ds`); the holiday country lives only in config_json,
    # so resolve it here — mirrors the Streamlit EDA tab's country selector
    # (render_eda_tab's `country` input → TimeSeriesEDA(country_code=...)).
    cfg = _resolve_config(ds)
    sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
    freq = ds["freq"] or "MS"
    holiday_country = cfg.get("holidayCountry") or "IN"

    mode = "sku" if sku else "portfolio"
    work = df if sku is None else df[df[sku_col].astype(str) == str(sku)]
    if work.empty:
        raise HTTPException(status_code=404, detail=f"No rows for SKU '{sku}'")

    # Reuse the engine's EDA prep + IsolationForest anomaly detection.
    sub = work[[date_col, sales_col]].rename(columns={date_col: "date", sales_col: "sales"})
    try:
        eda = engine.TimeSeriesEDA(
            sub, date_col="date", sales_col="sales",
            country_code=holiday_country, resample_freq=freq,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"EDA prep failed: {exc}")

    s = eda.df_eda["sales"].astype(float)
    n = int(len(s))
    values = s.values.astype(float)
    dates = [iso_date(d) for d in s.index]

    # Data-quality summary (on the raw subset, pre-resample).
    raw_missing = int(sub["sales"].isna().sum())
    # Total Revenue — Streamlit Data-tab KPI: df['revenue'].sum() over the FULL
    # dataset (app_v2_6 (1).py:15456). None when there is no revenue column.
    rev_col = _pick_column(list(df.columns.astype(str)),
                           ["revenue", "sales_value", "gmv", "turnover"])
    total_revenue = None
    if rev_col and pd.api.types.is_numeric_dtype(df[rev_col]):
        total_revenue = clean_float(pd.to_numeric(df[rev_col], errors="coerce").sum())
    data_quality = {
        # Streamlit "Observations" = raw dataset rows len(df) (app_v2_6 (1).py:15466),
        # NOT the filtered SKU subset or resampled period count.
        "totalRecords": int(len(df)),
        "nPeriods": n,
        "minDate": iso_date(pd.to_datetime(sub["date"], errors="coerce").min()),
        "maxDate": iso_date(pd.to_datetime(sub["date"], errors="coerce").max()),
        "missingValues": raw_missing,
        "frequency": freq,
        "frequencyLabel": ds.get("freq_label") or "",
        "skuCount": int(df[sku_col].nunique()),
        "totalRevenue": total_revenue,
        "totalSalesUnits": clean_float(pd.to_numeric(df[sales_col], errors="coerce").sum()),
    }

    # Trend statistics.
    first_v = float(values[0]) if n else 0.0
    last_v = float(values[-1]) if n else 0.0
    slope = 0.0
    if n >= 2:
        slope = float(np.polyfit(np.arange(n), values, 1)[0])
    trend = {
        "mean": clean_float(s.mean()),
        "min": clean_float(s.min()),
        "max": clean_float(s.max()),
        "std": clean_float(s.std()),
        "total": clean_float(s.sum()),
        "growthPct": clean_float((last_v - first_v) / first_v) if first_v else None,
        "slope": clean_float(slope),
        "direction": "up" if slope > 0 else "down" if slope < 0 else "flat",
    }

    # Seasonality — average by calendar month (seasonal index).
    by_month = s.groupby(s.index.month).mean()
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    seasonality = [
        {"label": month_names[int(m) - 1], "value": clean_float(v)}
        for m, v in by_month.items()
    ]
    peak_month = month_names[int(by_month.idxmax()) - 1] if len(by_month) else None

    # Decomposition (additive) when enough cycles exist. The seasonal period
    # matches the Streamlit engine's plot_decomposition map exactly.
    decomposition = None
    decomposition_reason = ""
    period = _FREQ_PERIOD.get(freq, 12)
    decomp_period = _DECOMP_PERIOD.get(freq, 4)
    if decomp_period >= 2 and n >= decomp_period * 2:
        try:
            from statsmodels.tsa.seasonal import seasonal_decompose
            dec = seasonal_decompose(s, model="additive", period=decomp_period)
            decomposition = [
                {
                    "date": dates[i],
                    "trend": clean_float(dec.trend.iloc[i]),
                    "seasonal": clean_float(dec.seasonal.iloc[i]),
                    "resid": clean_float(dec.resid.iloc[i]),
                }
                for i in range(n)
            ]
        except Exception as exc:
            decomposition_reason = f"decomposition unavailable ({type(exc).__name__})"
    else:
        decomposition_reason = (
            f"need ≥ {decomp_period * 2} periods for a {decomp_period}-period "
            f"decomposition; have {n}"
        )

    # Autocorrelation (ACF) & Partial autocorrelation (PACF) — EXACT parity with
    # the Streamlit engine's plot_acf_pacf: FIXED 20 lags (→ 21 points, lags 0–20),
    # both computed together with the same alpha=0.05 call, and a single warning
    # "Not enough data for 20-lag ACF/PACF." when len(series) <= 20 (no chart). No
    # adaptive lag count.
    ACF_LAGS = 20
    autocorrelation: List[Dict[str, Any]] = []
    partial_autocorrelation: List[Dict[str, Any]] = []
    acf_pacf_reason = ""
    if n <= ACF_LAGS:
        acf_pacf_reason = f"Not enough data for {ACF_LAGS}-lag ACF/PACF."
    else:
        try:
            from statsmodels.tsa.stattools import acf as _acf, pacf as _pacf
            avals = _acf(values, nlags=ACF_LAGS, alpha=0.05)[0]
            pvals = _pacf(values, nlags=ACF_LAGS, alpha=0.05)[0]
            autocorrelation = [
                {"lag": i, "value": clean_float(avals[i])} for i in range(len(avals))
            ]
            partial_autocorrelation = [
                {"lag": i, "value": clean_float(pvals[i])} for i in range(len(pvals))
            ]
        except Exception as exc:  # mirrors Streamlit's generic guard
            acf_pacf_reason = f"Could not generate ACF/PACF: {exc}"

    # Target Variable Distribution — histogram + monthly box-plot (the Streamlit
    # "Target Variable Distribution" panel: go.Histogram + go.Box by month).
    histogram = []
    monthly_box = []
    if n:
        n_bins = int(min(20, max(5, int(round(np.sqrt(n))) or 5)))
        counts, edges = np.histogram(values, bins=n_bins)
        for i in range(len(counts)):
            lo, hi = float(edges[i]), float(edges[i + 1])
            histogram.append({
                "binStart": clean_float(lo),
                "binEnd": clean_float(hi),
                "label": f"{lo:,.0f}–{hi:,.0f}",
                "count": int(counts[i]),
            })
        for m, gv in s.groupby(s.index.month):
            arr = gv.dropna().to_numpy(dtype=float)
            if not len(arr):
                continue
            monthly_box.append({
                "month": month_names[int(m) - 1],
                "min": clean_float(np.min(arr)),
                "q1": clean_float(np.percentile(arr, 25)),
                "median": clean_float(np.percentile(arr, 50)),
                "q3": clean_float(np.percentile(arr, 75)),
                "max": clean_float(np.max(arr)),
            })
    distribution = {"histogram": histogram, "monthlyBox": monthly_box}

    # Holiday Analysis — India calendar; flag each period that contains a holiday,
    # then compare average demand on holiday vs non-holiday periods (Streamlit's
    # analyze_holidays). A period "contains" a holiday if one falls in [t, t+step).
    holiday = {
        "available": False, "markers": [], "holidayCount": 0,
        "avgHoliday": None, "avgNonHoliday": None, "country": holiday_country,
    }
    try:
        import holidays as _holidays_lib
        years = sorted({int(d.year) for d in s.index})
        hol_map = _holidays_lib.country_holidays(holiday_country, years=years) if years else {}
        if hol_map and n:
            hol_dates = pd.DatetimeIndex(pd.to_datetime(list(hol_map.keys())))
            idx = s.index
            step = (idx[1:] - idx[:-1]).min() if n >= 2 else pd.Timedelta(days=31)
            is_hol = np.array([
                bool(((hol_dates >= idx[i]) & (hol_dates < idx[i] + step)).any())
                for i in range(n)
            ])
            hol_series = s[is_hol]
            markers = [
                {"date": iso_date(idx[i]), "value": clean_float(values[i])}
                for i in range(n) if is_hol[i]
            ]
            holiday = {
                "available": True,
                "country": holiday_country,
                "markers": markers,
                "holidayCount": int(is_hol.sum()),
                "avgHoliday": clean_float(hol_series.mean()) if len(hol_series) else None,
                "avgNonHoliday": clean_float(s[~is_hol].mean()),
            }
    except Exception:
        pass

    # Outliers from the engine's IsolationForest pass — carry the editable
    # "Correct Anomaly" workflow fields (Suggested Action + default decision).
    anomalies = eda.potential_anomalies_df
    outlier_points = []
    if anomalies is not None and not anomalies.empty:
        for _, r in anomalies.iterrows():
            is_hol_row = bool(r.get("Is Holiday", False))
            outlier_points.append({
                "date": iso_date(r["Date"]),
                "value": clean_float(r["Value"]),
                "isHoliday": is_hol_row,
                "suggestedAction": str(
                    r.get("Suggested Action", "Keep" if is_hol_row else "Correct")
                ),
                "correctAnomaly": bool(r.get("Correct Anomaly", not is_hol_row)),
            })
    corrected_default = sum(1 for p in outlier_points if p["correctAnomaly"])
    outliers = {
        "count": len(outlier_points),
        "points": outlier_points,
        "summary": {
            "totalPotential": len(outlier_points),
            "correctedCount": corrected_default,
        },
    }

    return {
        "mode": mode,
        "sku": sku,
        "datasetId": ds_id,
        "series": [
            {"date": dates[i], "value": clean_float(values[i])} for i in range(n)
        ],
        "dataQuality": data_quality,
        "trend": trend,
        "seasonality": seasonality,
        "peakMonth": peak_month,
        "distribution": distribution,
        "decomposition": decomposition,
        "decompositionReason": decomposition_reason,
        "autocorrelation": autocorrelation,
        "partialAutocorrelation": partial_autocorrelation,
        "acfPacfReason": acf_pacf_reason,
        "holiday": holiday,
        "outliers": outliers,
    }


@app.post("/eda/anomalies")
def apply_eda_anomalies(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Apply an edited anomaly-correction table — replicates Streamlit's
    `apply_anomaly_corrections`: for every anomaly flagged 'Correct Anomaly',
    swap the value for the 14-period rolling mean, then return the cleaned series
    and the corrected markers for the anomaly chart."""
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    ds = dict(load_dataset_row(ds_id))
    df = load_dataset_df(ds)
    cfg = _resolve_config(ds)
    sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
    freq = ds["freq"] or "MS"
    holiday_country = cfg.get("holidayCountry") or "IN"
    sku = payload.get("sku")
    work = df if not sku else df[df[sku_col].astype(str) == str(sku)]
    if work.empty:
        raise HTTPException(status_code=404, detail=f"No rows for SKU '{sku}'")

    sub = work[[date_col, sales_col]].rename(columns={date_col: "date", sales_col: "sales"})
    try:
        eda = engine.TimeSeriesEDA(
            sub, date_col="date", sales_col="sales",
            country_code=holiday_country, resample_freq=freq,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"EDA prep failed: {exc}")

    anomalies = eda.potential_anomalies_df
    overrides: Dict[str, bool] = {}
    for c in (payload.get("corrections") or []):
        try:
            key = str(pd.Timestamp(c["date"]).date())
        except (KeyError, ValueError, TypeError):
            continue
        overrides[key] = bool(c.get("correct"))
    if anomalies is not None and not anomalies.empty:
        anomalies = anomalies.copy()
        anomalies["Correct Anomaly"] = anomalies.apply(
            lambda row: overrides.get(
                str(pd.Timestamp(row["Date"]).date()),
                bool(row.get("Correct Anomaly", False)),
            ),
            axis=1,
        )
        eda.apply_anomaly_corrections(anomalies)

    cleaned = eda.df_eda["sales"].astype(float)
    corrected = getattr(eda, "corrected_anomalies", None) or {}
    corrected_points = [
        {
            "date": iso_date(d),
            "original": clean_float(v.get("original")),
            "replacedWith": clean_float(v.get("replaced_with")),
        }
        for d, v in corrected.items()
    ]
    total_potential = int(len(anomalies)) if anomalies is not None else 0
    return {
        "series": [
            {"date": iso_date(idx), "value": clean_float(val)}
            for idx, val in cleaned.items()
        ],
        "correctedAnomalies": corrected_points,
        "summary": {
            "totalPotential": total_potential,
            "correctedCount": len(corrected_points),
        },
    }


# ── Profile & Route — retail segmentation ─────────────────────────────────────
_SEG_PARAMS = {
    "cv_threshold": 1.15,
    "high_cum_share": 0.40,
    "mid_cum_share": 0.85,
    "min_periods": 3,
    "new_product_months": 3,
    "churn_months": 3,
    "short_history_months": 6,
}

# SBC demand-pattern palette + order for the Intermittency Distribution donut.
_INTERMITTENCY_COLORS = {
    "smooth": "#3b82f6", "erratic": "#f59e0b", "intermittent": "#10b981",
    "lumpy": "#ef4444", "dead": "#64748b",
}
_INTERMITTENCY_ORDER = ["smooth", "erratic", "intermittent", "lumpy", "dead"]
_STRATEGY_PALETTE = [
    "#073e5c", "#ef7602", "#10b981", "#f59e0b", "#dc2626",
    "#94a3b8", "#3b82f6", "#8b5cf6",
]


def _resolve_seg_params(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge caller threshold overrides onto the defaults, clamped to the same
    ranges the Streamlit number-inputs enforce."""
    p = dict(_SEG_PARAMS)
    if overrides:
        for k in p:
            if overrides.get(k) is not None:
                p[k] = overrides[k]
    p["cv_threshold"] = float(p["cv_threshold"])
    p["high_cum_share"] = float(min(max(float(p["high_cum_share"]), 0.10), 0.70))
    p["mid_cum_share"] = float(min(max(float(p["mid_cum_share"]), 0.50), 0.99))
    if p["mid_cum_share"] <= p["high_cum_share"]:
        p["mid_cum_share"] = min(0.99, p["high_cum_share"] + 0.05)
    p["min_periods"] = int(min(max(int(p["min_periods"]), 2), 24))
    p["new_product_months"] = int(min(max(int(p["new_product_months"]), 1), 24))
    p["churn_months"] = int(min(max(int(p["churn_months"]), 1), 24))
    p["short_history_months"] = int(min(max(int(p["short_history_months"]), 2), 24))
    return p


def _segment_recommended_model(segment: str) -> str:
    arch = engine.SEGMENT_ARCHITECTURE.get(segment)
    if arch is None:
        # Lifecycle / triage segments fall back through the engine's resolver.
        arch = engine.get_segment_architecture({"segment": segment})
    return strategy_label(str(arch.get("primary", "ensemble_local")))


def _segment_architecture_detail(segment: str) -> Dict[str, Any]:
    """Full model-architecture recipe for a segment — primary, blend members,
    features, residual booster, CI source, reconciliation, and the rationale
    tagline (drives the 'Segment Model Architecture' cards)."""
    arch = engine.SEGMENT_ARCHITECTURE.get(segment)
    if arch is None:
        arch = engine.get_segment_architecture({"segment": segment})
    return {
        "primary": strategy_label(str(arch.get("primary", "ensemble_local"))),
        "primaryKey": str(arch.get("primary", "ensemble_local")),
        "blend": [strategy_label(str(m)) for m in (arch.get("blend") or [])],
        "blendMethod": arch.get("blend_method"),
        "features": list(arch.get("features") or []),
        "residualBooster": arch.get("residual_booster"),
        "ciSource": arch.get("ci_source"),
        "reconcile": arch.get("reconcile"),
        "tagline": arch.get("tagline"),
    }


def _build_segmentation(ds: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, Any]:
    df = load_dataset_df(ds)
    sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
    df = _apply_history_window(df, date_col, _resolve_config(ds))
    all_cols = list(df.columns.astype(str))
    revenue_col = _pick_column(all_cols, ["revenue", "total_revenue", "sales_value"])
    brand_col = _pick_column(all_cols, ["brand", "manufacturer", "vendor", "label"])

    seg = engine.compute_retail_segmentation(
        df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
        revenue_col=revenue_col,
        cv_threshold=params["cv_threshold"],
        high_cum_share=params["high_cum_share"],
        mid_cum_share=params["mid_cum_share"],
        min_periods=params["min_periods"],
        new_product_months=params["new_product_months"],
        churn_months=params["churn_months"],
        short_history_months=params["short_history_months"],
    )

    brand_by_sku: Dict[str, str] = {}
    if brand_col:
        brand_by_sku = (
            df.groupby(sku_col)[brand_col].first().astype(str).to_dict()
        )

    playbook = engine.SEGMENT_PLAYBOOK
    skus: List[Dict[str, Any]] = []
    for rec in seg.to_dict("records"):
        sku_id = str(rec[sku_col])
        skus.append({
            "sku": sku_id,
            "segment": rec.get("segment"),
            "volatility": rec.get("volatility"),
            "contribution": rec.get("contribution"),
            "intermittency": rec.get("intermittency"),
            "cv": clean_float(rec.get("cv")),
            "meanSales": clean_float(rec.get("mean_sales")),
            "totalRevenue": clean_float(rec.get("total_revenue")),
            "nPeriods": int(rec.get("n_periods") or 0),
            "revenueSharePct": clean_float(rec.get("rev_share_pct")),
            "brand": brand_by_sku.get(sku_id),
        })

    # Segment grid — emit EVERY canonical segment in the Streamlit matrix order,
    # including zero-count ones (so the playbook is always visible). CV NULL/0 is
    # only included when present.
    counts = seg["segment"].value_counts().to_dict()
    rev_by_seg = seg.groupby("segment")["total_revenue"].sum().to_dict()
    total_rev = float(seg["total_revenue"].sum()) or 1.0
    matrix_order = [
        "Stable High contributors", "Stable Mid contributors", "Stable Low contributors",
        "Volatile High contributors", "Volatile Mid contributors", "Volatile Low contributors",
    ]
    lifecycle_order = ["New product", "Churned product", "Short history"]

    def _grid_card(segment: str, group: str) -> Dict[str, Any]:
        pb = playbook.get(segment, {})
        cnt = int(counts.get(segment, 0))
        rev = float(rev_by_seg.get(segment, 0.0))
        return {
            "segment": segment,
            "group": group,
            "skuCount": cnt,
            "revenueSharePct": clean_float(100.0 * rev / total_rev),
            "priority": pb.get("priority"),
            "strategy": pb.get("strategy"),
            "forecast": pb.get("forecast"),
            "safetyStock": pb.get("safety_stock"),
            "color": pb.get("color"),
            "recommendedModel": _segment_recommended_model(segment),
            "architecture": _segment_architecture_detail(segment),
        }

    grid: List[Dict[str, Any]] = [_grid_card(s, "matrix") for s in matrix_order]
    grid += [_grid_card(s, "lifecycle") for s in lifecycle_order]
    if int(counts.get("CV NULL/0", 0)) > 0:
        grid.append(_grid_card("CV NULL/0", "triage"))

    # Brand breakdown.
    brands: List[Dict[str, Any]] = []
    if brand_col:
        bdf = pd.DataFrame(skus)
        for brand, g in bdf.groupby(bdf["brand"].fillna("Unknown")):
            brands.append({
                "brand": str(brand),
                "skuCount": int(len(g)),
                "revenueSharePct": clean_float(float(g["revenueSharePct"].fillna(0).sum())),
            })
        brands.sort(key=lambda x: x["revenueSharePct"] or 0, reverse=True)

    # Intermittency distribution (Demand Pattern) — from the segmentation frame.
    intermit_counts: Dict[str, int] = {}
    for rec in seg.to_dict("records"):
        patt = str(rec.get("intermittency") or "unknown")
        intermit_counts[patt] = intermit_counts.get(patt, 0) + 1

    # Strategy distribution (Model Routing) — use the ENGINE's actual routing
    # output (profile_all_skus.recommended_strategy, computed from the configured
    # cold-start / short-history MONTH thresholds), not segment labels. This is
    # the single source of truth and keeps the routing chart consistent with the
    # cold/short KPIs. (Previously re-derived is_cold_start/is_short_history from
    # segment labels here, which diverged from the engine's threshold routing.)
    strat_counts: Dict[str, int] = {}
    # Routing KPI summary — computed SERVER-SIDE over ALL profiled SKUs, exactly
    # like the Streamlit render_profiling_tab KPI strip (is_cold_start.sum(),
    # is_short_history.sum(), intermittency.isin(['intermittent','lumpy']).sum(),
    # brand.nunique()). The frontend renders these verbatim — no client-side
    # re-aggregation over a paginated/capped SKU list.
    routing_summary = {
        "skusProfiled": 0, "coldStart": 0, "shortHistory": 0,
        "intermittentLumpy": 0, "brands": len(brands),
    }
    try:
        profiles = get_profiles(ds)
        for rec in profiles.to_dict("records"):
            strat = str(rec.get("recommended_strategy") or "ensemble_local")
            strat_counts[strat] = strat_counts.get(strat, 0) + 1
        routing_summary = {
            "skusProfiled": int(len(profiles)),
            "coldStart": int(profiles["is_cold_start"].sum())
            if "is_cold_start" in profiles else 0,
            "shortHistory": int(profiles["is_short_history"].sum())
            if "is_short_history" in profiles else 0,
            "intermittentLumpy": int(
                profiles["intermittency"].isin(["intermittent", "lumpy"]).sum()
            ) if "intermittency" in profiles else 0,
            "brands": int(profiles["brand"].nunique())
            if "brand" in profiles else len(brands),
        }
    except Exception as exc:
        logging.warning("strategy distribution from profiles failed: %s", exc)

    intermittency_dist = [
        {"pattern": p, "count": intermit_counts.get(p, 0),
         "color": _INTERMITTENCY_COLORS.get(p, "#94a3b8")}
        for p in _INTERMITTENCY_ORDER if intermit_counts.get(p, 0) > 0
    ]
    for p, c in intermit_counts.items():
        if p not in _INTERMITTENCY_ORDER:
            intermittency_dist.append({"pattern": p, "count": c, "color": "#94a3b8"})

    strategy_dist = []
    for i, (k, c) in enumerate(
        sorted(strat_counts.items(), key=lambda kv: kv[1], reverse=True)
    ):
        info = engine.STRATEGY_INFO.get(k, {})
        strategy_dist.append({
            "strategy": k,
            "label": info.get("name", strategy_label(k)),
            "family": info.get("family"),
            "count": c,
            "color": _STRATEGY_PALETTE[i % len(_STRATEGY_PALETTE)],
        })

    # Brand × Segment crosstab (counts of SKUs per brand per segment).
    brand_segment_matrix = None
    if brand_col:
        sdf = pd.DataFrame(skus)
        sdf["brand"] = sdf["brand"].fillna("Unknown")
        ct = pd.crosstab(sdf["brand"], sdf["segment"])
        seg_cols = [s for s in (matrix_order + lifecycle_order + ["CV NULL/0"])
                    if s in ct.columns]
        seg_cols += [c for c in ct.columns if c not in seg_cols]
        ct = ct.reindex(columns=seg_cols, fill_value=0)
        ct = ct.loc[ct.sum(axis=1).sort_values(ascending=False).index]
        ct = ct.head(25)  # cap rows so the payload/table stays manageable
        brand_segment_matrix = {
            "segments": [str(c) for c in ct.columns],
            "brands": [str(b) for b in ct.index],
            "counts": [[int(v) for v in row] for row in ct.to_numpy()],
            "rowTotals": [int(v) for v in ct.sum(axis=1).to_numpy()],
            "colTotals": [int(v) for v in ct.sum(axis=0).to_numpy()],
        }

    return {
        "datasetId": ds["id"],
        "params": params,
        "totalSkus": len(skus),
        "revenueBasis": "revenue" if revenue_col else "volume",
        "segments": grid,
        "skus": skus,
        "brands": brands,
        "brandSegmentMatrix": brand_segment_matrix,
        "strategyDistribution": strategy_dist,
        "intermittencyDistribution": intermittency_dist,
        "routing": routing_summary,
        "generatedAt": now_iso(),
    }


def _seg_param_overrides(src: Dict[str, Any]) -> Dict[str, Any]:
    """Map the camelCase threshold knobs from a query/body onto the engine's
    snake_case parameter names."""
    return {
        "high_cum_share": src.get("highCumShare"),
        "mid_cum_share": src.get("midCumShare"),
        "min_periods": src.get("minPeriods"),
        "new_product_months": src.get("newProductMonths"),
        "churn_months": src.get("churnMonths"),
        "short_history_months": src.get("shortHistoryMonths"),
    }


@app.get("/segmentation")
def get_segmentation(
    datasetId: Optional[str] = Query(None),
    highCumShare: Optional[float] = Query(None, ge=0.10, le=0.70),
    midCumShare: Optional[float] = Query(None, ge=0.50, le=0.99),
    minPeriods: Optional[int] = Query(None, ge=2, le=24),
    newProductMonths: Optional[int] = Query(None, ge=1, le=24),
    churnMonths: Optional[int] = Query(None, ge=1, le=24),
    shortHistoryMonths: Optional[int] = Query(None, ge=2, le=24),
) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    params = _resolve_seg_params(_seg_param_overrides({
        "highCumShare": highCumShare, "midCumShare": midCumShare,
        "minPeriods": minPeriods, "newProductMonths": newProductMonths,
        "churnMonths": churnMonths, "shortHistoryMonths": shortHistoryMonths,
    }))
    return _build_segmentation(dict(load_dataset_row(ds_id)), params)


@app.post("/segmentation/run")
def run_segmentation(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Validate & Save action: recompute with the supplied thresholds, persist an
    audit run (validator + notes), and mark the Profile & Route stage complete."""
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=400, detail="No dataset to segment — upload one first")
    ds = dict(load_dataset_row(ds_id))
    params = _resolve_seg_params(_seg_param_overrides(payload))
    result = _build_segmentation(ds, params)

    validated_by = str(payload.get("validatedBy") or "").strip() or "api_bridge"
    notes = str(payload.get("notes") or "").strip() or "Re-segmentation via API"

    # Persist a validated run for the audit trail (engine's segments DB).
    run_id = None
    try:
        df = load_dataset_df(ds)
        seg_df = pd.DataFrame(result["skus"]).rename(columns={
            "meanSales": "mean_sales", "totalRevenue": "total_revenue",
            "nPeriods": "n_periods", "revenueSharePct": "rev_share_pct",
        })
        fp = engine.dataset_fingerprint(df, ds["sku_col"], ds["date_col"], ds["sales_col"])
        run_id = engine.save_validated_segments(
            seg_df, sku_col="sku", params=params, dataset_fp=fp,
            validated_by=validated_by, notes=notes,
        )
    except Exception as exc:  # persistence is best-effort; don't fail the request
        logging.warning("segment persistence failed: %s", exc)

    workflow_set(profile_completed=True)
    result["runId"] = run_id
    return result


@app.get("/segmentation/runs")
def list_segmentation_runs(limit: int = Query(10, ge=1, le=100)) -> List[Dict[str, Any]]:
    try:
        runs = engine.list_segmentation_runs(limit=limit)
    except Exception:
        return []
    out = []
    for rec in runs.to_dict("records"):
        out.append({
            "runId": rec.get("run_id"),
            "runAt": rec.get("run_at"),
            "nSkus": int(rec.get("n_skus") or 0),
            "validatedBy": rec.get("validated_by"),
            "notes": rec.get("notes"),
            "datasetFingerprint": rec.get("dataset_fingerprint"),
        })
    return out


@app.get("/segmentation/trace")
def trace_segmentation(
    sku: str = Query(...),
    datasetId: Optional[str] = Query(None),
    highCumShare: Optional[float] = Query(None, ge=0.10, le=0.70),
    midCumShare: Optional[float] = Query(None, ge=0.50, le=0.99),
    minPeriods: Optional[int] = Query(None, ge=2, le=24),
    newProductMonths: Optional[int] = Query(None, ge=1, le=24),
    churnMonths: Optional[int] = Query(None, ge=1, le=24),
    shortHistoryMonths: Optional[int] = Query(None, ge=2, le=24),
) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    ds = dict(load_dataset_row(ds_id))
    df = load_dataset_df(ds)
    params = _resolve_seg_params(_seg_param_overrides({
        "highCumShare": highCumShare, "midCumShare": midCumShare,
        "minPeriods": minPeriods, "newProductMonths": newProductMonths,
        "churnMonths": churnMonths, "shortHistoryMonths": shortHistoryMonths,
    }))
    seg = engine.compute_retail_segmentation(
        df, sku_col=ds["sku_col"], sales_col=ds["sales_col"], date_col=ds["date_col"],
        cv_threshold=params["cv_threshold"],
        high_cum_share=params["high_cum_share"],
        mid_cum_share=params["mid_cum_share"],
        min_periods=params["min_periods"],
        new_product_months=params["new_product_months"],
        churn_months=params["churn_months"],
        short_history_months=params["short_history_months"],
    )
    match = seg[seg[ds["sku_col"]].astype(str) == str(sku)]
    if match.empty:
        raise HTTPException(status_code=404, detail=f"SKU '{sku}' not found")
    trace = engine.explain_sku_segment(match.iloc[0], params)
    return {"sku": sku, "final": trace.get("final"), "steps": trace.get("steps", [])}


# ── Forecast Submission ───────────────────────────────────────────────────────
# Mirrors the Streamlit "Step 5 · Forecast Submission" tab: a long-format
# SKU × forecast-month worksheet the planner edits (submitted_forecast / reason /
# notes), with history anchors (LY same-month, last-3mo avg) and derived deltas
# (MoM / YoY / Δ-vs-model), plus filters, KPIs, bulk ops, submit batches, audit,
# and CSV export. Reuses engine.REASON_OPTIONS and compute_retail_segmentation;
# does NOT touch the forecast engine.
_PRODUCT_HINTS = ["product_name", "product", "description", "item_name", "name", "title"]
_BRAND_HINTS = ["brand", "manufacturer", "vendor", "label"]


def _latest_run_id(dataset_id: str) -> Optional[str]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM forecast_runs WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
            (dataset_id,),
        ).fetchone()
    return row["id"] if row else None


def _recompute_run(run_id: str) -> None:
    """Refresh mom_pct + delta_vs_model_pct after edits (ports
    _recompute_derived_columns: first-month MoM anchored to last_3mo_avg)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, sku, model_forecast, submitted_forecast, last_3mo_avg "
            "FROM submission_rows WHERE run_id = ? ORDER BY sku, forecast_month",
            (run_id,),
        ).fetchall()
        by_sku: Dict[str, List[sqlite3.Row]] = {}
        for r in rows:
            by_sku.setdefault(r["sku"], []).append(r)
        for _sku, rs in by_sku.items():
            anchor = rs[0]["last_3mo_avg"]
            prev = None
            for i, r in enumerate(rs):
                sub, model = r["submitted_forecast"], r["model_forecast"]
                delta = ((sub - model) / model * 100) if (model not in (None, 0) and sub is not None) else None
                base = anchor if i == 0 else prev
                mom = ((sub - base) / base * 100) if (base not in (None, 0) and sub is not None) else None
                conn.execute(
                    "UPDATE submission_rows SET delta_vs_model_pct = ?, mom_pct = ? WHERE id = ?",
                    (clean_float(delta), clean_float(mom), r["id"]),
                )


def _build_submission_rows(ds: Dict[str, Any], run_id: str) -> None:
    """Port of build_submission_frame — long SKU × forecast-month worksheet from
    the persisted forecasts (detail series) + dataset history + segmentation."""
    df = load_dataset_df(ds)
    sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
    cols = list(df.columns.astype(str))
    pn_col = _pick_column(cols, _PRODUCT_HINTS)
    cat_col = _pick_column(cols, _CATEGORY_HINTS)
    brand_col = _pick_column(cols, _BRAND_HINTS)

    def first_map(col: Optional[str]) -> Dict[str, Any]:
        if not col:
            return {}
        return (df.groupby(sku_col)[col]
                .agg(lambda s: s.dropna().iloc[0] if s.dropna().size else None)
                .astype(object).to_dict())

    pn_map, cat_map, brand_map = first_map(pn_col), first_map(cat_col), first_map(brand_col)
    seg_map: Dict[str, str] = {}
    try:
        seg = engine.compute_retail_segmentation(
            df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
            cv_threshold=_SEG_PARAMS["cv_threshold"], high_cum_share=_SEG_PARAMS["high_cum_share"],
            mid_cum_share=_SEG_PARAMS["mid_cum_share"], min_periods=_SEG_PARAMS["min_periods"],
        )
        seg_map = dict(zip(seg[sku_col].astype(str), seg["segment"].astype(str)))
    except Exception as exc:
        logging.warning("submission segmentation failed: %s", exc)

    with get_conn() as conn:
        frows = conn.execute("SELECT * FROM forecasts WHERE run_id = ?", (run_id,)).fetchall()

    out: List[Dict[str, Any]] = []
    for fr in frows:
        try:
            detail = json.loads(fr["detail_json"])
        except Exception:
            continue
        series = detail.get("series") or []
        hist_pairs, fc_pairs = [], []
        for p in series:
            d = p.get("date")
            if not d:
                continue
            if p.get("actual") is not None:
                hist_pairs.append((pd.Timestamp(d), float(p["actual"])))
            if p.get("forecast") is not None:
                fc_pairs.append((pd.Timestamp(d), float(p["forecast"])))
        if not fc_pairs:
            continue
        hist = pd.Series(dict(hist_pairs)).sort_index() if hist_pairs else pd.Series(dtype=float)
        if len(hist) >= 3:
            last3 = float(hist.iloc[-3:].mean())
        elif len(hist):
            last3 = float(hist.mean())
        else:
            last3 = None

        sku = str(fr["sku"])
        mape_pct = None if fr["mape"] is None else clean_float(float(fr["mape"]) * 100)
        strategy = str(detail.get("strategyUsed") or fr["model"])
        pn = pn_map.get(sku) or sku
        cat = cat_map.get(sku) or "(uncategorised)"
        brand = brand_map.get(sku) or "—"
        segment = seg_map.get(sku) or "—"

        for ts, model_val in sorted(fc_pairs, key=lambda x: x[0]):
            ly = None
            if len(hist):
                ly_target = ts - pd.DateOffset(years=1)
                diffs = np.abs((hist.index - ly_target).days.values.astype(float))
                pos = int(np.argmin(diffs))
                if diffs[pos] <= 15:
                    ly = float(hist.iloc[pos])
            yoy = ((model_val - ly) / ly * 100) if (ly not in (None, 0, 0.0)) else None
            out.append({
                "id": f"sr_{uuid.uuid4().hex[:14]}",
                "dataset_id": ds["id"], "run_id": run_id, "sku": sku,
                "forecast_month": iso_date(ts),
                "product_name": str(pn), "category": str(cat),
                "brand": str(brand), "segment": str(segment), "strategy": strategy,
                "mape": mape_pct,
                "model_forecast": round(model_val, 1),
                "submitted_forecast": round(model_val, 1),
                "last_year_same_month": clean_float(ly), "last_3mo_avg": clean_float(last3),
                "mom_pct": None, "yoy_pct": clean_float(yoy), "delta_vs_model_pct": 0.0,
                "reason": engine.REASON_OPTIONS[0], "notes": "",
            })

    if out:
        with get_conn() as conn:
            conn.executemany(
                """INSERT INTO submission_rows
                   (id, dataset_id, run_id, sku, forecast_month, product_name, category,
                    brand, segment, strategy, mape, model_forecast, submitted_forecast,
                    last_year_same_month, last_3mo_avg, mom_pct, yoy_pct, delta_vs_model_pct,
                    reason, notes)
                   VALUES (:id,:dataset_id,:run_id,:sku,:forecast_month,:product_name,:category,
                    :brand,:segment,:strategy,:mape,:model_forecast,:submitted_forecast,
                    :last_year_same_month,:last_3mo_avg,:mom_pct,:yoy_pct,:delta_vs_model_pct,
                    :reason,:notes)""",
                out,
            )
        _recompute_run(run_id)


def _ensure_submission_rows(ds: Dict[str, Any]) -> Optional[str]:
    """Return the latest run's id, building its worksheet on first access
    (rebuild trigger ≈ Streamlit's _signature_of_results — keyed by run_id)."""
    run_id = _latest_run_id(ds["id"])
    if run_id is None:
        return None
    with get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) FROM submission_rows WHERE run_id = ?", (run_id,)).fetchone()[0]
    if n == 0:
        _build_submission_rows(ds, run_id)
    return run_id


def _submission_row_json(r: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": r["id"], "sku": r["sku"], "forecastMonth": r["forecast_month"],
        "productName": r["product_name"], "category": r["category"], "brand": r["brand"],
        "segment": r["segment"], "strategy": r["strategy"], "mape": r["mape"],
        "modelForecast": r["model_forecast"], "submittedForecast": r["submitted_forecast"],
        "lastYearSameMonth": r["last_year_same_month"], "last3moAvg": r["last_3mo_avg"],
        "momPct": r["mom_pct"], "yoyPct": r["yoy_pct"], "deltaVsModelPct": r["delta_vs_model_pct"],
        "reason": r["reason"], "notes": r["notes"],
    }


def _as_options(value: Any) -> set:
    """Filter value → set of allowed values (accepts list or comma-separated str)."""
    if value is None:
        return set()
    if isinstance(value, (list, tuple)):
        return {str(v).strip() for v in value if str(v).strip()}
    return {x.strip() for x in str(value).split(",") if x.strip()}


def _filter_rows(rows: List[sqlite3.Row], *, category=None, brand=None, product=None,
                 segment=None, sku=None, overridden_only=False, wmape=0.0) -> List[sqlite3.Row]:
    cat_s, br_s, pr_s = _as_options(category), _as_options(brand), _as_options(product)
    sg_s, sk_s = _as_options(segment), _as_options(sku)
    out = []
    for r in rows:
        if cat_s and str(r["category"]) not in cat_s:
            continue
        if br_s and str(r["brand"]) not in br_s:
            continue
        if pr_s and str(r["product_name"]) not in pr_s:
            continue
        if sg_s and str(r["segment"]) not in sg_s:
            continue
        if sk_s and str(r["sku"]) not in sk_s:
            continue
        if overridden_only and (r["submitted_forecast"] == r["model_forecast"]):
            continue
        if wmape and wmape > 0 and not ((r["mape"] or 0) > wmape):
            continue
        out.append(r)
    return out


def _mean_clean(values: List[Any]) -> Optional[float]:
    nums = [float(v) for v in values
            if v is not None and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))]
    return clean_float(sum(nums) / len(nums)) if nums else None


def _submission_kpis(rows: List[sqlite3.Row]) -> Dict[str, Any]:
    model_units = sum((r["model_forecast"] or 0) for r in rows)
    submitted_units = sum((r["submitted_forecast"] or 0) for r in rows)
    delta_units = submitted_units - model_units
    over_cells = sum(1 for r in rows if r["submitted_forecast"] != r["model_forecast"])
    over_skus = len({r["sku"] for r in rows if r["submitted_forecast"] != r["model_forecast"]})
    return {
        "modelUnits": clean_float(model_units),
        "submittedUnits": clean_float(submitted_units),
        "deltaUnits": clean_float(delta_units),
        "deltaPct": clean_float(delta_units / model_units * 100) if model_units else 0.0,
        "avgMomPct": _mean_clean([r["mom_pct"] for r in rows]),
        "avgYoyPct": _mean_clean([r["yoy_pct"] for r in rows]),
        "overrideCells": over_cells,
        "overrideSkus": over_skus,
        "skuCount": len({r["sku"] for r in rows}),
        "rowCount": len(rows),
    }


@app.get("/forecasts/submission")
def get_submission(
    datasetId: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    brand: Optional[str] = Query(None),
    product: Optional[str] = Query(None),
    segment: Optional[str] = Query(None),
    sku: Optional[str] = Query(None),
    overriddenOnly: bool = Query(False),
    wmapeThreshold: float = Query(0.0),
) -> Dict[str, Any]:
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    ds = dict(load_dataset_row(ds_id))
    run_id = _ensure_submission_rows(ds)
    reason_options = list(engine.REASON_OPTIONS)
    if run_id is None:
        return {
            "datasetId": ds_id, "runId": None, "rows": [],
            "kpis": _submission_kpis([]), "reasonOptions": reason_options,
            "totalRows": 0, "totalSkus": 0, "filteredRows": 0,
            "facets": {"categories": [], "brands": [], "products": [], "segments": [], "skus": []},
        }
    with get_conn() as conn:
        all_rows = conn.execute(
            "SELECT * FROM submission_rows WHERE run_id = ? ORDER BY sku, forecast_month",
            (run_id,),
        ).fetchall()
    filtered = _filter_rows(
        all_rows, category=category, brand=brand, product=product, segment=segment,
        sku=sku, overridden_only=overriddenOnly, wmape=wmapeThreshold,
    )

    def _distinct(col: str) -> List[str]:
        return sorted({str(r[col]) for r in all_rows if r[col] not in (None, "")})

    return {
        "datasetId": ds_id, "runId": run_id,
        "rows": [_submission_row_json(r) for r in filtered],
        "kpis": _submission_kpis(filtered),
        "reasonOptions": reason_options,
        "totalRows": len(all_rows),
        "totalSkus": len({r["sku"] for r in all_rows}),
        "filteredRows": len(filtered),
        "facets": {
            "categories": _distinct("category"), "brands": _distinct("brand"),
            "products": _distinct("product_name"), "segments": _distinct("segment"),
            "skus": _distinct("sku"),
        },
    }


@app.patch("/forecasts/submission")
def patch_submission(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Apply per-cell edits and/or a bulk operation, then recompute deltas.
    Body: { datasetId?, edits?: [{id, submittedForecast?, reason?, notes?}],
            bulk?: {op, value?, reason?}, filter?: {...} }."""
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    run_id = _latest_run_id(ds_id) if ds_id else None
    if run_id is None:
        raise HTTPException(status_code=400, detail="No forecast run to submit against")

    updated = 0
    edits = payload.get("edits") or []
    with get_conn() as conn:
        for e in edits:
            rid = e.get("id")
            if not rid:
                continue
            sets, vals = [], []
            if "submittedForecast" in e:
                sets.append("submitted_forecast = ?"); vals.append(clean_float(e["submittedForecast"]))
            if "reason" in e:
                sets.append("reason = ?"); vals.append(str(e["reason"]))
            if "notes" in e:
                sets.append("notes = ?"); vals.append(str(e["notes"]))
            if sets:
                vals.append(rid)
                conn.execute(
                    f"UPDATE submission_rows SET {', '.join(sets)} WHERE id = ? AND run_id = '{run_id}'",
                    vals,
                )
                updated += 1

    bulk = payload.get("bulk")
    if bulk:
        op = str(bulk.get("op") or "")
        fl = payload.get("filter") or {}
        with get_conn() as conn:
            all_rows = conn.execute("SELECT * FROM submission_rows WHERE run_id = ?", (run_id,)).fetchall()
            target = _filter_rows(
                all_rows,
                category=fl.get("category"), brand=fl.get("brand"), product=fl.get("product"),
                segment=fl.get("segment"), sku=fl.get("sku"),
                overridden_only=bool(fl.get("overriddenOnly")), wmape=float(fl.get("wmapeThreshold") or 0),
            )
            for r in target:
                if op == "uplift":
                    v = float(bulk.get("value") or 0)
                    new = round(max(0.0, (r["submitted_forecast"] or 0) * (1 + v / 100)), 1)
                    conn.execute("UPDATE submission_rows SET submitted_forecast = ? WHERE id = ?", (new, r["id"]))
                elif op == "copy_ly":
                    ly = r["last_year_same_month"]
                    if ly is not None:
                        conn.execute("UPDATE submission_rows SET submitted_forecast = ? WHERE id = ?", (round(ly, 1), r["id"]))
                elif op == "reset":
                    conn.execute(
                        "UPDATE submission_rows SET submitted_forecast = ?, reason = ?, notes = '' WHERE id = ?",
                        (r["model_forecast"], engine.REASON_OPTIONS[0], r["id"]),
                    )
                elif op == "reason":
                    conn.execute("UPDATE submission_rows SET reason = ? WHERE id = ?",
                                 (str(bulk.get("reason") or engine.REASON_OPTIONS[0]), r["id"]))
            updated += len(target)

    _recompute_run(run_id)
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM submission_rows WHERE run_id = ?", (run_id,)).fetchall()
    return {"runId": run_id, "updated": updated, "kpis": _submission_kpis(rows)}


@app.post("/forecasts/submission/submit")
def submit_submission(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    ds_id = payload.get("datasetId") or latest_dataset_id()
    run_id = _latest_run_id(ds_id) if ds_id else None
    if run_id is None:
        raise HTTPException(status_code=400, detail="No forecast run to submit")
    submitter = str(payload.get("submitter") or "demo_planner")
    notes = str(payload.get("notes") or "")

    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM submission_rows WHERE run_id = ?", (run_id,)).fetchall()
    if not rows:
        raise HTTPException(status_code=422, detail="No submission rows to submit")
    model_units = sum((r["model_forecast"] or 0) for r in rows)
    total_units = sum((r["submitted_forecast"] or 0) for r in rows)
    override_count = sum(1 for r in rows if r["submitted_forecast"] != r["model_forecast"])
    pct_change = round((total_units - model_units) / max(model_units, 1) * 100, 2)

    batch_id = f"sb_{uuid.uuid4().hex[:12]}"
    submitted_at = now_iso()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO submission_batches
               (id, dataset_id, run_id, submitted_at, submitter, notes, override_count,
                total_rows, total_units, pct_change)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (batch_id, ds_id, run_id, submitted_at, submitter, notes, override_count,
             len(rows), round(float(total_units), 1), pct_change),
        )
    workflow_set(review_completed=True)
    return {
        "id": batch_id, "datasetId": ds_id, "runId": run_id, "submittedAt": submitted_at,
        "submitter": submitter, "notes": notes, "overrideCount": override_count,
        "totalRows": len(rows), "totalUnits": clean_float(total_units), "pctChange": pct_change,
    }


@app.get("/forecasts/submission/audit")
def get_submission_audit(datasetId: Optional[str] = Query(None)) -> List[Dict[str, Any]]:
    clause, params = "", []
    ds_id = datasetId or latest_dataset_id()
    if ds_id:
        clause, params = " WHERE dataset_id = ?", [ds_id]
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM submission_batches{clause} ORDER BY submitted_at DESC", params
        ).fetchall()
    return [{
        "id": r["id"], "datasetId": r["dataset_id"], "runId": r["run_id"],
        "submittedAt": r["submitted_at"], "submitter": r["submitter"], "notes": r["notes"],
        "overrideCount": r["override_count"], "totalRows": r["total_rows"],
        "totalUnits": r["total_units"], "pctChange": r["pct_change"],
    } for r in rows]


@app.get("/forecasts/submission/export")
def export_submission(datasetId: Optional[str] = Query(None)) -> Response:
    ds_id = datasetId or latest_dataset_id()
    run_id = _latest_run_id(ds_id) if ds_id else None
    if run_id is None:
        raise HTTPException(status_code=404, detail="No submission to export")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM submission_rows WHERE run_id = ? ORDER BY sku, forecast_month",
            (run_id,),
        ).fetchall()
    header = ["sku", "product_name", "category", "brand", "segment", "strategy", "mape",
              "forecast_month", "last_year_same_month", "last_3mo_avg", "model_forecast",
              "submitted_forecast", "mom_pct", "yoy_pct", "delta_vs_model_pct", "reason", "notes"]
    lines = [",".join(header)]
    for r in rows:
        cells = [r[c] for c in header]
        lines.append(",".join(
            f'"{str("" if c is None else c).replace(chr(34), chr(34) * 2)}"' for c in cells
        ))
    csv_text = "\n".join(lines)
    ts = now_iso().replace(":", "").replace("-", "")[:15]
    return Response(
        content=csv_text, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="forecast_submission_{ts}.csv"'},
    )


# ──────────────────────────────────────────────────────────────────────────────
# Reports — executive HTML reports built by the engine's headless build_*_html_report
# functions (no Streamlit runtime needed). We reconstruct each builder's inputs
# from persisted data; the forecast/submission/segmentation engines are untouched.
# ──────────────────────────────────────────────────────────────────────────────
_REPORT_TYPES = {
    "segmentation": "Retail Segmentation Report",
    "routed_forecast": "Routed Portfolio Forecast Report",
}


def _median(values: List[float]) -> Optional[float]:
    nums = sorted(
        float(v) for v in values
        if v is not None and not (isinstance(v, float) and math.isnan(v))
    )
    if not nums:
        return None
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2.0


def _report_row_json(r: sqlite3.Row) -> Dict[str, Any]:
    meta = json.loads(r["meta_json"] or "{}") if "meta_json" in r.keys() else {}
    return {
        "id": r["id"], "datasetId": r["dataset_id"], "type": r["type"],
        "title": r["title"], "status": r["status"],
        "sizeBytes": meta.get("sizeBytes"), "generatedAt": r["generated_at"],
    }


def _segmentation_report_html(row: sqlite3.Row) -> str:
    """Reconstruct seg_df + raw df + cfg, then call the engine HTML builder."""
    ds = dict(row)
    df = load_dataset_df(row)
    sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
    cols = list(df.columns.astype(str))
    revenue_col = _pick_column(cols, ["revenue", "total_revenue", "sales_value"])
    p = _resolve_seg_params()
    seg = engine.compute_retail_segmentation(
        df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
        revenue_col=revenue_col,
        cv_threshold=p["cv_threshold"], high_cum_share=p["high_cum_share"],
        mid_cum_share=p["mid_cum_share"], min_periods=p["min_periods"],
        new_product_months=p["new_product_months"], churn_months=p["churn_months"],
        short_history_months=p["short_history_months"],
    )
    cfg = {"sku_col": sku_col, "sales_col": sales_col, "date_col": date_col}
    return engine.build_retail_segmentation_html_report(seg, df, cfg, profiles=None)


def _routed_forecast_report_html(row: sqlite3.Row) -> str:
    """Reconstruct ForecastResult-like + profile objects from stored detail_json."""
    from types import SimpleNamespace

    ds_id = row["id"]
    run_id = _latest_run_id(ds_id)
    if run_id is None:
        raise HTTPException(status_code=422, detail="No forecast run to report on")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM forecasts WHERE run_id = ?", (run_id,)
        ).fetchall()
        run = conn.execute(
            "SELECT * FROM forecast_runs WHERE id = ?", (run_id,)
        ).fetchone()
    if not rows:
        raise HTTPException(status_code=422, detail="No forecasts to report on")

    results, profiles = [], {}
    for r in rows:
        detail = json.loads(r["detail_json"] or "{}")
        pts = [
            (p.get("date"), p.get("forecast"))
            for p in detail.get("series", [])
            if p.get("forecast") is not None
        ]
        if pts:
            fc = pd.Series(
                [float(v) for _, v in pts],
                index=pd.to_datetime([d for d, _ in pts]),
            )
        else:
            fc = pd.Series(dtype=float)
        mape = detail.get("testWmape")
        results.append(SimpleNamespace(
            sku=r["sku"],
            strategy_used=detail.get("strategyUsed") or r["model"] or "ensemble_local",
            backtest_mape=float(mape) if mape is not None else math.nan,
            forecast=fc,
        ))
        profiles[r["sku"]] = SimpleNamespace(
            brand=detail.get("brand"), segment=detail.get("segment"),
        )

    periods = (run["periods"] if run and run["periods"] else
               (len(results[0].forecast) if results else 0))
    cfg = {"horizon": periods}
    return engine.build_routed_forecast_html_report(results, profiles, cfg)


def _build_report_html(row: sqlite3.Row, rtype: str) -> str:
    if rtype == "segmentation":
        return _segmentation_report_html(row)
    if rtype == "routed_forecast":
        return _routed_forecast_report_html(row)
    raise HTTPException(status_code=422, detail=f"Unknown report type '{rtype}'")


@app.get("/reports/summary")
def reports_summary(datasetId: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Executive dashboard — dataset basics, forecast headline, segment mix, top
    opportunities, and which reports can be generated given the current state."""
    ds_id = datasetId or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    row = load_dataset_row(ds_id)
    ds = dict(row)
    run_id = _latest_run_id(ds_id)

    bands = {"Good": 0, "Review": 0, "Poor": 0, "No metric": 0}
    wmapes: List[float] = []
    total_units = 0.0
    opportunities: List[Dict[str, Any]] = []
    skus_forecasted = 0
    if run_id is not None:
        with get_conn() as conn:
            frows = conn.execute(
                "SELECT sku, sku_name, detail_json, total_forecast_units "
                "FROM forecasts WHERE run_id = ?", (run_id,),
            ).fetchall()
        skus_forecasted = len(frows)
        for r in frows:
            d = json.loads(r["detail_json"] or "{}")
            band = d.get("band") or "No metric"
            bands[band] = bands.get(band, 0) + 1
            tw = d.get("testWmape")
            if tw is not None:
                wmapes.append(tw)
            ft = d.get("forecastTotal")
            if ft is None:
                ft = r["total_forecast_units"]
            total_units += float(ft or 0)
            opportunities.append({
                "sku": r["sku"],
                "name": d.get("skuName") or r["sku_name"] or r["sku"],
                "strategy": d.get("strategyLabel") or d.get("model"),
                "wmape": tw,
                "band": band,
                "forecastTotal": clean_float(ft),
            })
        opportunities.sort(key=lambda x: (x["forecastTotal"] or 0), reverse=True)

    seg_dist: List[Dict[str, Any]] = []
    seg_total = 0
    try:
        profiles = get_profiles(row)
        if "segment" in profiles.columns:
            vc = profiles["segment"].astype(str).value_counts()
            seg_total = int(vc.sum())
            seg_dist = [{"segment": str(k), "skuCount": int(v)} for k, v in vc.items()]
    except Exception:
        seg_dist, seg_total = [], 0

    available = [
        {"type": "segmentation", "title": _REPORT_TYPES["segmentation"],
         "available": True, "reason": ""},
        {"type": "routed_forecast", "title": _REPORT_TYPES["routed_forecast"],
         "available": run_id is not None,
         "reason": "" if run_id is not None else "Run a forecast first."},
    ]

    return {
        "dataset": {
            "id": ds_id, "name": ds.get("file_name"),
            "skuCount": ds.get("sku_count"), "rowCount": ds.get("row_count"),
            "dateStart": ds.get("date_start"), "dateEnd": ds.get("date_end"),
        },
        "forecast": {
            "runId": run_id, "skusForecasted": skus_forecasted,
            "medianTestWmape": _median(wmapes),
            "totalForecastUnits": clean_float(total_units), "bands": bands,
        },
        "segments": {"total": seg_total, "distribution": seg_dist},
        "topOpportunities": opportunities[:10],
        "availableReports": available,
    }


@app.get("/reports")
def list_reports(datasetId: Optional[str] = Query(None)) -> List[Dict[str, Any]]:
    ds_id = datasetId or latest_dataset_id()
    clause, params = "", []
    if ds_id:
        clause, params = " WHERE dataset_id = ?", [ds_id]
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM reports{clause} ORDER BY generated_at DESC", params
        ).fetchall()
    return [_report_row_json(r) for r in rows]


@app.post("/reports/generate")
def generate_report(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    rtype = str(payload.get("type") or "")
    if rtype not in _REPORT_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown report type '{rtype}'")
    ds_id = payload.get("datasetId") or latest_dataset_id()
    if ds_id is None:
        raise HTTPException(status_code=404, detail="No dataset uploaded yet")
    row = load_dataset_row(ds_id)
    try:
        html = _build_report_html(row, rtype)
    except HTTPException:
        raise
    except Exception as exc:  # builder/data failure → surface, don't 500 silently
        raise HTTPException(status_code=500, detail=f"Report generation failed: {exc}")

    rid = f"rep_{uuid.uuid4().hex[:12]}"
    gen_at = now_iso()
    title = _REPORT_TYPES[rtype]
    size = len(html.encode("utf-8"))
    with get_conn() as conn:
        # Single-report mode: regenerating a report replaces the previous one of
        # the same type — no historical accumulation.
        conn.execute(
            "DELETE FROM reports WHERE dataset_id = ? AND type = ?", (ds_id, rtype)
        )
        conn.execute(
            """INSERT INTO reports (id, dataset_id, type, title, status, html, meta_json, generated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (rid, ds_id, rtype, title, "ready", html, json.dumps({"sizeBytes": size}), gen_at),
        )
    return {
        "id": rid, "datasetId": ds_id, "type": rtype, "title": title,
        "status": "ready", "sizeBytes": size, "generatedAt": gen_at,
    }


@app.get("/reports/{report_id}/download")
def download_report(report_id: str) -> Response:
    with get_conn() as conn:
        r = conn.execute(
            "SELECT type, html, generated_at FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
    if r is None:
        raise HTTPException(status_code=404, detail=f"Report '{report_id}' not found")
    ts = (r["generated_at"] or now_iso()).replace(":", "").replace("-", "")[:15]
    fname = f"dhishaai_{r['type']}_{ts}.html"
    return Response(
        content=r["html"], media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.get("/reports/{report_id}")
def get_report(report_id: str) -> Dict[str, Any]:
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if r is None:
        raise HTTPException(status_code=404, detail=f"Report '{report_id}' not found")
    return _report_row_json(r)


# Catch-all forecast detail — declared LAST so /forecasts/submission, /forecasts/run,
# and /forecasts/jobs/* take precedence over the {forecast_id} param route.
@app.get("/forecasts/{forecast_id}")
def get_forecast(forecast_id: str) -> Dict[str, Any]:
    with get_conn() as conn:
        row = conn.execute("SELECT detail_json FROM forecasts WHERE id = ?", (forecast_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Forecast '{forecast_id}' not found")
    return json.loads(row["detail_json"])


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
