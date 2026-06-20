"""
DhishaAI Time Lens — v2
SKU-aware forecasting engine with segment routing, intermittent-demand models,
price-elasticity features, global cross-learning, and hierarchical reconciliation.

Designed for the MPTill data shape:
    - ~3,166 SKUs, monthly, 4–40 months history
    - 7 segments (Stable/Volatile × High/Mid/Low) → routed to different strategies
    - Strong price/promo signal (price changes in 84% of rows; scheme_days, festive, peak_month)
    - Brand hierarchy (8 brands) → reconciled with MinT
"""

import streamlit as st
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import warnings
import concurrent.futures
import io
import time
from typing import List, Tuple, Dict, Any, Optional
from dataclasses import dataclass, field

from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX
from sklearn.metrics import mean_squared_error
from sklearn.ensemble import IsolationForest

# Additional statsmodels / sklearn surface used by merged modules from app_96
import copy
import base64
import os
import sqlite3
import textwrap
import hashlib
from pathlib import Path
from datetime import datetime
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.stattools import acf, pacf
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.api import Holt
from sklearn.preprocessing import MinMaxScaler
try:
    from sklearn.metrics import mean_absolute_percentage_error
except ImportError:
    def mean_absolute_percentage_error(y_true, y_pred):
        y_true = np.asarray(y_true, dtype=float)
        y_pred = np.asarray(y_pred, dtype=float)
        mask = y_true != 0
        if not mask.any():
            return np.nan
        return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])))

# ── Temporal features (production exogenous variables) ──
try:
    from temporal_features import (
        build_temporal_features,
        validate_temporal_features,
        build_temporal_features_for_index,
        CALENDAR_DETERMINISTIC_COLUMNS,
    )
except ImportError:
    build_temporal_features = None
    validate_temporal_features = None
    build_temporal_features_for_index = None
    CALENDAR_DETERMINISTIC_COLUMNS = frozenset()

# Optional, gated imports
try:
    import lightgbm as lgb
except ImportError:
    lgb = None
try:
    from prophet import Prophet
except ImportError:
    Prophet = None
try:
    import pmdarima as pm
except ImportError:
    pm = None
try:
    from chronos import ChronosPipeline
    import torch
    # Streamlit's local-file watcher walks every module's __path__, and
    # `torch.classes` raises "Tried to instantiate class '__path__._path'"
    # when probed that way. Neutralising the attribute silences the
    # recurring "Examining the path of torch.classes raised…" log line
    # without affecting torch itself.
    try:
        torch.classes.__path__ = []
    except Exception:
        pass
except ImportError:
    ChronosPipeline = None
    torch = None
try:
    import holidays
except ImportError:
    holidays = None

# Additional optional dependencies for merged features (from app_96)
try:
    import xgboost as xgb
except ImportError:
    xgb = None
try:
    from dtaidistance import dtw
except ImportError:
    dtw = None
try:
    from sqlalchemy import create_engine
    from urllib.parse import quote_plus
except ImportError:
    create_engine = None
    quote_plus = None
try:
    from fpdf import FPDF
except ImportError:
    FPDF = None
try:
    from dowhy import CausalModel
except ImportError:
    CausalModel = None
try:
    import graphviz
except ImportError:
    graphviz = None
try:
    from tsfresh import extract_features
    from tsfresh.feature_extraction import MinimalFCParameters
except ImportError:
    extract_features = None
    MinimalFCParameters = None

# ââ Deep-learning Mixture-of-Experts (Keras) â optional, ENV-GATED ââââ
# Ported from app_96.py. TensorFlow is a HEAVY, frequently-broken dependency:
# on a mismatched numpy/ABI (e.g. TF 2.20 + numpy 1.24 here) `import tensorflow`
# can not only raise but DEADLOCK the C++ runtime ("mutex Lock blocking"),
# which would hang app startup. So we DO NOT import it by default. Set
# TIMELENS_ENABLE_DL_MOE=1 (with a working TF) to activate the Deep MoE; until
# then `tf is None` and every DL-MoE entry point degrades to Holt-Winters.
# (Same pattern as the TIMELENS_ENABLE_NEURAL gate used for the LSTM expert.)
tf = None
_DLMOE_FLAG = os.environ.get('TIMELENS_ENABLE_DL_MOE', '').strip().lower()
if _DLMOE_FLAG in ('1', 'true', 'yes', 'on'):
    try:
        import tensorflow as tf  # noqa: F401
        from tensorflow.keras.models import Model as _KerasModel
        from tensorflow.keras.layers import (
            Layer, Dense, LayerNormalization, MultiHeadAttention)
        from tensorflow.keras.optimizers import Adam
    except Exception:
        tf = None

if tf is not None:
    def create_sequences(data: np.ndarray, input_len: int,
                         output_len: int) -> Tuple[np.ndarray, np.ndarray]:
        """Sliding-window (X, y) builder. X carries all features; y is the
        target column (index 0) over the next `output_len` steps."""
        X, y = [], []
        for i in range(len(data) - input_len - output_len + 1):
            X.append(data[i:(i + input_len), :])
            y.append(data[(i + input_len):(i + input_len + output_len), 0])
        return np.array(X), np.array(y)

    class FourierLayer(Layer):
        """Seasonality expert front-end: maps time indices to sin/cos harmonics."""
        def __init__(self, period, k, **kwargs):
            super(FourierLayer, self).__init__(**kwargs)
            self.period = period
            self.k = k

        def call(self, inputs):
            time = tf.cast(inputs, tf.float32)
            harmonics = []
            for i in range(1, self.k + 1):
                harmonics.append(tf.sin(2 * np.pi * i * time / self.period))
                harmonics.append(tf.cos(2 * np.pi * i * time / self.period))
            return tf.stack(harmonics, axis=-1)

    class TransformerBlock(Layer):
        """Dynamic expert: multi-head self-attention + feed-forward residual block."""
        def __init__(self, embed_dim, num_heads, ff_dim, rate=0.1, **kwargs):
            super(TransformerBlock, self).__init__(**kwargs)
            self.att = MultiHeadAttention(num_heads=num_heads, key_dim=embed_dim)
            self.ffn = tf.keras.Sequential(
                [Dense(ff_dim, activation="relu"), Dense(embed_dim)])
            self.layernorm1 = LayerNormalization(epsilon=1e-6)
            self.layernorm2 = LayerNormalization(epsilon=1e-6)
            self.dropout1 = tf.keras.layers.Dropout(rate)
            self.dropout2 = tf.keras.layers.Dropout(rate)

        def call(self, inputs, training=False):
            attn_output = self.att(inputs, inputs)
            attn_output = self.dropout1(attn_output, training=training)
            out1 = self.layernorm1(inputs + attn_output)
            ffn_output = self.ffn(out1)
            ffn_output = self.dropout2(ffn_output, training=training)
            return self.layernorm2(out1 + ffn_output)

    class TimeSeriesMoE(_KerasModel):
        """Deep MoE: trend (Dense) + seasonality (Fourier) + dynamic (Transformer)
        experts combined by a softmax gating network that learns input-dependent
        weights per forecast step."""
        def __init__(self, input_len, output_len, num_features, num_experts=3,
                     period=7, k=3, embed_dim=32, num_heads=4, **kwargs):
            super(TimeSeriesMoE, self).__init__(**kwargs)
            self.input_len = input_len
            self.output_len = output_len
            self.num_features = num_features
            self.num_experts = num_experts
            self.input_projection = Dense(embed_dim)
            self.trend_expert = tf.keras.Sequential(
                [tf.keras.layers.Flatten(), Dense(output_len)], name="trend_expert")
            self.seasonality_expert = tf.keras.Sequential(
                [FourierLayer(period=period, k=k), tf.keras.layers.Flatten(),
                 Dense(output_len)], name="seasonality_expert")
            self.dynamic_expert = tf.keras.Sequential(
                [TransformerBlock(embed_dim=embed_dim, num_heads=num_heads,
                                  ff_dim=embed_dim * 2),
                 tf.keras.layers.Flatten(), Dense(output_len)], name="dynamic_expert")
            self.experts = [self.trend_expert, self.seasonality_expert,
                            self.dynamic_expert]
            self.gating_network = tf.keras.Sequential(
                [tf.keras.layers.Flatten(), Dense(64, activation='relu'),
                 Dense(num_experts, activation='softmax')], name="gating_network")

        def call(self, inputs):
            gating_weights = self.gating_network(inputs)
            trend_out = self.experts[0](inputs)
            time_indices = tf.range(0, self.input_len, 1, dtype=tf.float32)
            time_indices_seq = tf.reshape(time_indices, (1, self.input_len, 1))
            batch_time_indices = tf.tile(time_indices_seq,
                                         [tf.shape(inputs)[0], 1, 1])
            seasonality_out = self.experts[1](batch_time_indices)
            projected_inputs = self.input_projection(inputs)
            dynamic_out = self.experts[2](projected_inputs)
            stacked = tf.stack([trend_out, seasonality_out, dynamic_out], axis=1)
            weighted = tf.expand_dims(gating_weights, axis=-1) * stacked
            return tf.reduce_sum(weighted, axis=1)

warnings.filterwarnings('ignore')

DHISHAAI_BLUE = "#073e5c"
DHISHAAI_ORANGE = "#ef7602"


# =================================================================
# 1. SKU PROFILER — classifies each SKU into a forecasting strategy
# =================================================================

@dataclass
class SKUProfile:
    """One row per SKU, summarising what kind of series it is."""
    sku: str
    n_months: int
    mean_sales: float
    cv: float                      # coefficient of variation
    adi: float                     # avg demand interval
    cv2: float                     # cv-squared of non-zero demand
    intermittency: str             # smooth | erratic | intermittent | lumpy | dead
    is_cold_start: bool            # < 6 months
    is_short_history: bool         # 6–12 months
    segment: str
    brand: str
    recommended_strategy: str      # which forecasting branch to send this SKU down


def classify_intermittency(sales: np.ndarray) -> Tuple[str, float, float]:
    """Syntetos-Boylan-Croston classification.

    ADI = avg interval between non-zero demands; CV² = variance² of non-zero demands.
    Boundaries 1.32 and 0.49 are the standard SBC cutoffs.
    """
    nz = (sales != 0).sum()
    if nz == 0:
        return 'dead', np.inf, 0.0
    adi = len(sales) / nz
    nz_vals = sales[sales != 0]
    if len(nz_vals) > 1 and nz_vals.mean() > 0:
        cv2 = (nz_vals.std() / nz_vals.mean()) ** 2
    else:
        cv2 = 0.0
    if adi < 1.32 and cv2 < 0.49:
        cls = 'smooth'
    elif adi >= 1.32 and cv2 < 0.49:
        cls = 'intermittent'
    elif adi < 1.32 and cv2 >= 0.49:
        cls = 'erratic'
    else:
        cls = 'lumpy'
    return cls, adi, cv2


# =================================================================
# SEGMENT_ARCHITECTURE — the master per-segment model recipe.
# Inspired by the app_96 production architecture: every segment gets a
# *full forecasting stack* (primary + blend + features + residual booster +
# CI source + reconciliation level), not just one algorithm. The routing
# engine, candidate-pool builder, panel-feature builder, and profile UI
# all read from this single source of truth.
# =================================================================
SEGMENT_ARCHITECTURE = {
    # ── Hero SKUs — long history, rich signal, OOS = revenue loss ──
    # RETHINK: Prophet (trend+seasonality+holidays) + Global LGBM (cross-learning)
    # ensemble beats SARIMAX on short monthly series. Local SARIMAX struggles with
    # 1-3 seasonal cycles; Prophet's Bayesian approach handles sparsity better.
    # Global LGBM learns price elasticity across 3000 SKUs; SARIMAX can't.
    'Stable High contributors': {
        'primary': 'prophet',
        # NOTE: 'neural_elasticity' (LSTM) is an opt-in member — enable it by
        # adding it here AND setting TIMELENS_ENABLE_NEURAL=1 with a working
        # TensorFlow/NumPy environment. It is kept out of the default blend
        # because TensorFlow import can hang on mismatched ABIs (see
        # phase2_enhancements._try_import_keras).
        'blend': ['global_lgbm', 'moe', 'catboost', 'autoarima', 'theta'],
        'blend_method': 'weighted_median',     # robust to outliers
        'features': ['lag_rolling', 'price', 'fourier', 'holiday', 'promo', 'events'],
        'residual_booster': 'xgb',             # post-hoc residual XGBoost
        'residual_threshold_pct': 10.0,
        'ci_source': 'prophet',                # CIs from Prophet natively
        'reconcile': 'bottom_up',              # contribute up to brand/category
        'cold_start_proxy': False,
        'tagline': 'Prophet (Bayesian trend+events) · Global LGBM (cross-learning) · CatBoost · XGB residual @ 10%',
    },
    # ── Steady earners — automate, monitor for drift ──
    # RETHINK: Global LGBM primary. Local HW misses cross-SKU seasonality; with 72K
    # training rows (3000 SKUs × 24 mo), pooled model sees robust seasonal patterns
    # that beat local 1-3 cycle fitting. Plus native price/promo support.
    'Stable Mid contributors': {
        'primary': 'global_lgbm',
        'blend': ['prophet', 'catboost', 'theta', 'autoarima'],
        'blend_method': 'weighted_mean',
        'features': ['lag_rolling', 'price', 'fourier', 'holiday', 'promo'],
        'residual_booster': 'xgb',
        'ci_source': 'quantile_lgbm',
        'reconcile': 'bottom_up',
        'cold_start_proxy': False,
        'tagline': 'Global LGBM (pooled seasonality) · Prophet/Theta blend · CatBoost · XGB residual',
    },
    # ── Tail catalogue — many similar curves, global model wins ──
    'Stable Low contributors': {
        'primary': 'global_lgbm_full',
        'blend': ['holt_winters', 'theta', 'autoarima'],
        'blend_method': 'weighted_mean',
        'features': ['lag_rolling', 'price', 'fourier', 'promo', 'cross_sku'],
        'residual_booster': None,              # not worth the runtime cost on the long tail
        'ci_source': 'quantile_lgbm',          # quantile loss for cheap CIs
        'reconcile': 'top_down',               # take share from category total
        'cold_start_proxy': True,              # use brand-mean if history < 6mo
        'tagline': 'Global LightGBM · Theta/HW blend · quantile CIs',
    },
    # ── High-stakes spikes — event-aware trend ──
    # RETHINK: Prophet primary. Spikes are often EVENT-DRIVEN (Diwali, launches).
    # ARIMA treats events as shocks, reverts to mean; Prophet's additive model
    # captures holidays natively. For risk-aware forecasts, Prophet also gives
    # uncertainty intervals (use 90th percentile for safety stock).
    'Volatile High contributors': {
        'primary': 'prophet',
        'blend': ['global_lgbm', 'moe', 'xgb_quantile_90', 'theta', 'autoarima'],
        'blend_method': 'weighted_median',
        'features': ['lag_rolling', 'price', 'fourier', 'holiday', 'promo', 'events'],
        'residual_booster': 'xgb',
        'ci_source': 'prophet',
        'reconcile': 'middle_out',
        'cold_start_proxy': True,
        'tagline': 'Prophet (event-aware trend) · Global LGBM · P90 quantile (safety stock) · XGB residual',
    },
    # ── Promo / festive sensitive — exog signal is everything ──
    # RETHINK: Global LGBM primary. Promo sensitivity IS the signal; LGBM learns
    # price-demand nonlinearities across 3000 SKUs better than local ensemble
    # (HW+Theta+ARIMA can't learn exog at all). Prophet handles holiday spikes.
    # Expected: -35% WMAPE improvement (biggest opportunity).
    'Volatile Mid contributors': {
        'primary': 'global_lgbm',
        # 'neural_elasticity' fits this price-elastic segment well but is opt-in
        # (TIMELENS_ENABLE_NEURAL=1 + working TensorFlow) — see Stable High note.
        'blend': ['prophet', 'catboost', 'theta', 'autoarima'],
        'blend_method': 'weighted_median',
        'features': ['lag_rolling', 'price', 'fourier', 'holiday', 'promo', 'events'],
        'residual_booster': 'xgb',
        'ci_source': 'quantile_lgbm',
        'reconcile': 'bottom_up',
        'cold_start_proxy': False,
        'tagline': 'Global LGBM (price elasticity) · Prophet (events) · CatBoost · XGB residual',
    },
    # ── Intermittent tail — Croston family, consider rationalisation ──
    'Volatile Low contributors': {
        'primary': 'croston_sba',
        'blend': ['tsb', 'holt_winters', 'global_lgbm'],
        'blend_method': 'weighted_mean',
        'features': ['lag_rolling', 'promo'],
        'residual_booster': None,
        'ci_source': 'bootstrap',
        'reconcile': 'top_down',
        'cold_start_proxy': True,
        'tagline': 'Croston/SBA (demand occurrence + size) · TSB/HW · DTW proxy fallback',
    },
    # ── Cold-start / NPI — too little history to fit any model ──
    'CV NULL/0': {
        'primary': 'chronos_zero_shot',
        'blend': ['naive_seasonal', 'holt_winters'],
        'blend_method': 'weighted_mean',
        'features': ['lag_rolling'],
        'residual_booster': None,
        'ci_source': 'chronos_quantiles',
        'reconcile': 'top_down',
        'cold_start_proxy': True,              # ← key — DTW match to similar SKU
        'tagline': 'Chronos zero-shot · DTW-proxy from similar SKU · naive-seasonal anchor',
    },
}

# Per-intermittency-class fallback (when segment is unknown / not yet assigned).
INTERMITTENCY_ARCHITECTURE = {
    'smooth':       SEGMENT_ARCHITECTURE['Stable Mid contributors'],
    'erratic':      SEGMENT_ARCHITECTURE['Volatile Mid contributors'],
    'intermittent': SEGMENT_ARCHITECTURE['Volatile Low contributors'],
    'lumpy':        SEGMENT_ARCHITECTURE['Volatile High contributors'],
}


def get_segment_architecture(profile: dict) -> dict:
    """Resolve the right model-architecture recipe for this SKU.

    Lookup order:
      1. Exact segment match against SEGMENT_ARCHITECTURE.
      2. Fuzzy match (substring) for legacy label variants.
      3. Intermittency-class fallback if no segment is available.
      4. Last-resort Stable Mid recipe (the closest to "default smooth").
    """
    seg = str(profile.get('segment') or '').strip()
    if seg in SEGMENT_ARCHITECTURE:
        return SEGMENT_ARCHITECTURE[seg]
    seg_l = seg.lower()
    for k in SEGMENT_ARCHITECTURE:
        if k.lower() in seg_l or seg_l in k.lower():
            return SEGMENT_ARCHITECTURE[k]
    cls = str(profile.get('intermittency') or '').lower()
    if cls in INTERMITTENCY_ARCHITECTURE:
        return INTERMITTENCY_ARCHITECTURE[cls]
    return SEGMENT_ARCHITECTURE['Stable Mid contributors']


def recommend_strategy(profile: dict) -> str:
    """Decision tree mapping SKU profile → forecasting strategy.

    Now consults `SEGMENT_ARCHITECTURE` so the choice of *primary* model
    flows from the same recipe used by the candidate-pool builder, the
    feature engineer, and the Profile UI.

    Strategies (terminal labels):
        chronos_zero_shot   : <6 months — pretrained foundation model, no training needed
        global_lgbm         : 6–12 months OR Volatile Low — borrows strength across SKUs
        croston_sba         : intermittent or lumpy — handles many zeros
        local_sarimax_promo : Stable High contributors — enough data + strong exog signal
        ensemble_local      : Stable Mid + Volatile Mid/High — median of 3 models
        global_lgbm_full    : Stable Low — many SKUs, similar shape, global model wins
    """
    if profile.get('intermittency') == 'dead':
        return 'naive_zero'
    if profile.get('is_cold_start'):
        # Cold-start always uses zero-shot regardless of segment recipe — the
        # recipe's `cold_start_proxy` flag governs whether we also DTW-proxy.
        return 'chronos_zero_shot'
    if profile.get('intermittency') in ('intermittent', 'lumpy'):
        # Intermittent-class trumps segment — Croston/TSB are calibrated for
        # zero-heavy series and other models break down.
        return 'croston_sba'
    if profile.get('is_short_history'):
        return 'global_lgbm'

    # Normal path — read the per-segment architecture recipe.
    arch = get_segment_architecture(profile)
    return arch.get('primary', 'global_lgbm_full')


def _smart_detect_date_format(series: pd.Series) -> Optional[str]:
    """Inspect a date column and return a concrete strftime format string.

    Resolves two common headaches in one helper:
      1. ISO datetime with optional time + millisecond suffix
         (e.g. ``2024-10-01 00:00:00.000`` — exported by SQL Server,
         BigQuery, Excel "long date" columns). Previously the splitter
         choked on the trailing ``00:00:00.000`` and gave up.
      2. The DD/MM vs MM/DD ambiguity in pandas defaults — ``01/02/22``
         parses as Jan 2 (US) but is usually Feb 1 (DD/MM/YY).

    Detection order:
      • ISO date with optional time component → ``%Y-%m-%d`` family
      • 3-part numeric date — position-variance heuristic for DD/MM vs MM/DD
      • ``Jan-22`` / ``MMM-YY`` family
      • Else return None → caller falls through to pandas' inference
    """
    import re as _re
    sample = series.dropna().astype(str).str.strip().head(100).tolist()
    if not sample:
        return None

    # ── Path 1: ISO date with optional time (incl. ms) ──────────────
    # Matches: 2024-10-01 · 2024-10-01 00:00:00 · 2024-10-01 00:00:00.000 · 2024-10-01T00:00:00
    _iso_re = _re.compile(
        r'^\d{4}-\d{1,2}-\d{1,2}'
        r'(?:[ T]\d{1,2}:\d{1,2}:\d{1,2}(?:\.\d{1,6})?)?$'
    )
    if all(_iso_re.match(s) for s in sample[:15]):
        # Pick the most specific suffix any row carries
        has_ms = any('.' in (s.split(' ', 1)[1] if ' ' in s else
                              s.split('T', 1)[1] if 'T' in s else '')
                     for s in sample[:15])
        has_time = any((' ' in s or 'T' in s) for s in sample[:15])
        time_sep = 'T' if any('T' in s for s in sample[:15]) else ' '
        if has_ms:
            return f'%Y-%m-%d{time_sep}%H:%M:%S.%f'
        if has_time:
            return f'%Y-%m-%d{time_sep}%H:%M:%S'
        return '%Y-%m-%d'

    # ── Path 2: MMM-YY family (Jan-22, Mar-2024, etc.) ──────────────
    _mmm_re = _re.compile(r'^[A-Za-z]{3}[ -](?:\d{2}|\d{4})$')
    if all(_mmm_re.match(s) for s in sample[:15]):
        delim = '-' if '-' in sample[0] else ' '
        # 2-digit vs 4-digit year
        year_part = sample[0].split(delim, 1)[1]
        return f'%b{delim}%Y' if len(year_part) == 4 else f'%b{delim}%y'

    # ── Path 3: 3-part numeric date with DD/MM vs MM/DD ambiguity ───
    # Strip any trailing time component (after first space) so the split
    # logic below doesn't see leftover '00:00:00' junk.
    clean = [s.split(' ', 1)[0].split('T', 1)[0] for s in sample]

    delim = None
    for d in ('-', '/', '.'):
        if all(d in s for s in clean[:10]):
            delim = d
            break
    if delim is None:
        return None

    parsed = []
    for s in clean:
        parts = s.split(delim)
        if len(parts) != 3:
            continue
        try:
            parsed.append(tuple(int(p) for p in parts))
        except ValueError:
            continue
    if not parsed:
        return None

    p1 = [t[0] for t in parsed]
    p2 = [t[1] for t in parsed]
    p3 = [t[2] for t in parsed]

    yf3 = '%Y' if max(p3) > 99 else '%y'
    yf1 = '%Y' if max(p1) > 99 else '%y'

    if max(p1) > 31:
        return f'{yf1}{delim}%m{delim}%d'
    if max(p1) > 12:
        return f'%d{delim}%m{delim}{yf3}'
    if max(p2) > 12:
        return f'%m{delim}%d{delim}{yf3}'
    if len(set(p1)) == 1 and len(set(p2)) > 1:
        return f'%d{delim}%m{delim}{yf3}'
    return None


def _detect_period_frequency(dates) -> Tuple[str, str, float]:
    """Inspect a sorted set of unique parsed dates and infer the cadence.

    Returns ``(pandas_freq_code, human_label, median_gap_days)``:
        ('D',  'Daily',          1.0)
        ('W',  'Weekly',         7.0)
        ('MS', 'Monthly',        30.4)
        ('QS', 'Quarterly',      91.0)
        ('YS', 'Yearly',        365.2)
        ('?',  'Irregular',      …)

    Uses the *median* of consecutive gaps so outliers (missing months,
    holidays, mid-load fence-posts) don't skew the call.
    """
    if dates is None:
        return '?', 'Unknown', 0.0
    dt_index = pd.DatetimeIndex(pd.to_datetime(
        pd.Series(dates), errors='coerce').dropna().unique())
    if len(dt_index) < 2:
        return '?', 'Unknown', 0.0
    dt_index = dt_index.sort_values()
    gaps = np.diff(dt_index.values).astype('timedelta64[s]').astype(float) / 86400.0
    median_gap = float(np.median(gaps))

    # Tolerance bands — wide enough to absorb missing periods, narrow enough
    # to distinguish cleanly between cadences.
    if median_gap < 1.5:
        return 'D', 'Daily', median_gap
    if 6.0 <= median_gap <= 8.5:
        return 'W', 'Weekly', median_gap
    if 13.0 <= median_gap <= 16.0:
        return 'W', 'Bi-weekly', median_gap
    if 27.0 <= median_gap <= 32.0:
        return 'MS', 'Monthly', median_gap
    if 85.0 <= median_gap <= 95.0:
        return 'QS', 'Quarterly', median_gap
    if 350.0 <= median_gap <= 380.0:
        return 'YS', 'Yearly', median_gap
    return '?', f'Irregular (median gap ~{median_gap:.1f} days)', median_gap


@st.cache_data(show_spinner=False)
def profile_all_skus(df: pd.DataFrame, sku_col: str, sales_col: str,
                     date_col: str, segment_col: str, brand_col: str,
                     cold_start_threshold: int = 6,
                     short_history_threshold: int = 12,
                     _seg_stats: Optional[pd.DataFrame] = None) -> pd.DataFrame:
    """Build one-row-per-SKU profile table. Drives the routing.

    `_seg_stats` is leading-underscore on purpose: this function is wrapped in
    @st.cache_data, and the underscore tells Streamlit NOT to hash it into the
    cache key. That's both a perf win (no hashing a big DataFrame every call)
    and correct — reuse vs. fresh give identical output, so the result is fully
    determined by `df` + the threshold args that ARE in the key.

    `_seg_stats` (optional) is the per-SKU frame already produced by
    `compute_retail_segmentation` in the same unified step. When it covers the
    SKUs in `df` and carries an `intermittency` column (i.e. it was computed on
    the SAME data scope — no history-filter divergence), the ADI / CV² / SBC
    classification is REUSED from it instead of re-grouping the panel a second
    time. The caller is responsible for only passing it when the scope matches
    (see render_profiling_tab); when it's None or doesn't cover every SKU, the
    intermittency is recomputed here so the function stays correct standalone.
    """
    # Resolve the optional segment/brand cols once — checking BOTH that the
    # caller specified a name AND that the column is actually present in df.
    # Previously we only checked truthiness, which threw KeyError whenever
    # the configured column name didn't exist in the loaded dataset.
    #
    # Auto-detect 'segment' / 'brand' columns when the caller didn't supply
    # one but the dataframe already has them. This handles the common case
    # where the user ran the Data-tab Retail Segmentation flow — which
    # injects a 'segment' column into df_raw — but the sidebar selectbox
    # widget state is stuck on '(none)' from before the segmentation run.
    if (not segment_col) and 'segment' in df.columns:
        segment_col = 'segment'
    if (not brand_col) and 'brand' in df.columns:
        brand_col = 'brand'
    seg_col_eff = segment_col if (segment_col and segment_col in df.columns) else None
    brand_col_eff = brand_col if (brand_col and brand_col in df.columns) else None

    # Vectorised path — previously a Python for-loop over df.groupby(sku_col)
    # that re-sorted each group and rebuilt a NumPy array per SKU. The loop
    # dominated the profiling wall-clock on portfolios > 1K SKUs. The version
    # below replaces it with three groupby aggregations (full / non-zero /
    # first-row), all of which stay in C.
    df_sorted = df.sort_values([sku_col, date_col])
    sales_all = df_sorted[sales_col].astype(float)

    g_all = sales_all.groupby(df_sorted[sku_col], sort=False)
    n_series = g_all.size()
    mean_s = g_all.mean()
    std_s = g_all.std().fillna(0.0)

    mean_arr = mean_s.values.astype(float)
    with np.errstate(divide='ignore', invalid='ignore'):
        cv_arr = np.where(mean_arr > 0, std_s.values / mean_arr, 0.0)

    # ── ADI / CV² / SBC class — reuse from _seg_stats when the scope matches ──
    _reuse = None
    if _seg_stats is not None and 'intermittency' in getattr(_seg_stats, 'columns', []):
        _sku_key = sku_col if sku_col in _seg_stats.columns else (
            'sku' if 'sku' in _seg_stats.columns else None)
        if _sku_key is not None:
            _ss = _seg_stats.drop_duplicates(subset=[_sku_key]).set_index(_sku_key)
            # Only reuse when every SKU in this panel is present — a partial
            # cover (e.g. DB-loaded subset) would leave gaps, so recompute.
            if n_series.index.isin(_ss.index).all():
                _reuse = _ss.reindex(n_series.index)

    if _reuse is not None:
        adi_arr = _reuse['adi'].values.astype(float) if 'adi' in _reuse else np.full(len(n_series), np.nan)
        cv2_arr = _reuse['cv2'].values.astype(float) if 'cv2' in _reuse else np.full(len(n_series), 0.0)
        cls_arr = _reuse['intermittency'].astype(object).values.copy()
    else:
        # Non-zero stats (for ADI + CV²). fillna(0) so NaN months count as
        # no-demand (not as a demand occurrence) — matches the single-pass
        # computation in compute_retail_segmentation so the reuse path and this
        # fresh path classify identically.
        nz_mask = sales_all.fillna(0) != 0
        g_nz = sales_all[nz_mask].groupby(df_sorted.loc[nz_mask, sku_col], sort=False)
        nz_count = g_nz.size().reindex(n_series.index, fill_value=0)
        nz_mean = g_nz.mean().reindex(n_series.index)
        nz_std = g_nz.std().reindex(n_series.index).fillna(0.0)

        n_arr = n_series.values.astype(float)
        nz_count_arr = nz_count.values.astype(float)
        with np.errstate(divide='ignore', invalid='ignore'):
            adi_arr = np.where(nz_count_arr > 0, n_arr / np.where(nz_count_arr > 0, nz_count_arr, 1), np.inf)
            cv2_arr = np.where(
                nz_count_arr > 1,
                (nz_std.values / nz_mean.values.astype(float)) ** 2,
                0.0,
            )
            cv2_arr = np.nan_to_num(cv2_arr, nan=0.0, posinf=0.0, neginf=0.0)

        # Vectorised SBC classification
        cls_arr = np.full(len(n_series), 'lumpy', dtype=object)
        dead_mask = nz_count_arr == 0
        smooth_mask = (adi_arr < 1.32) & (cv2_arr < 0.49) & ~dead_mask
        interm_mask = (adi_arr >= 1.32) & (cv2_arr < 0.49) & ~dead_mask
        erratic_mask = (adi_arr < 1.32) & (cv2_arr >= 0.49) & ~dead_mask
        cls_arr[smooth_mask] = 'smooth'
        cls_arr[interm_mask] = 'intermittent'
        cls_arr[erratic_mask] = 'erratic'
        cls_arr[dead_mask] = 'dead'

    if seg_col_eff:
        seg_vals = (df_sorted.groupby(sku_col, sort=False)[seg_col_eff]
                    .first().reindex(n_series.index).fillna('unknown').values)
    else:
        seg_vals = np.full(len(n_series), 'unknown', dtype=object)
    if brand_col_eff:
        brand_vals = (df_sorted.groupby(sku_col, sort=False)[brand_col_eff]
                      .first().reindex(n_series.index).fillna('unknown').values)
    else:
        brand_vals = np.full(len(n_series), 'unknown', dtype=object)

    n_int = n_series.values.astype(int)
    profiles = pd.DataFrame({
        'sku': n_series.index.values,
        'n_months': n_int,
        'mean_sales': mean_arr,
        'cv': cv_arr,
        'adi': adi_arr,
        'cv2': cv2_arr,
        'intermittency': cls_arr,
        'is_cold_start': n_int < cold_start_threshold,
        'is_short_history': (n_int >= cold_start_threshold) & (n_int < short_history_threshold),
        'segment': seg_vals,
        'brand': brand_vals,
    })

    # Per-row strategy resolution — keeps the existing decision tree intact
    # (segment-aware via SEGMENT_ARCHITECTURE). Cheap dict lookups; not the
    # bottleneck.
    profiles['recommended_strategy'] = [
        recommend_strategy(rec) for rec in profiles.to_dict('records')
    ]
    return profiles


# =================================================================
# 2. PRICE & PROMO FEATURE ENGINEERING
#    These features are the highest-value signal in this dataset.
# =================================================================

def build_panel_features(df: pd.DataFrame, date_col: str, sales_col: str,
                         sku_col: str, freq: str = 'MS',
                         exog_numeric: List[str] = None,
                         exog_categorical: List[str] = None) -> pd.DataFrame:
    """Build a long panel (one row per SKU per period) with engineered features.

    Features:
        - Calendar: month, quarter, year
        - Lags & rolling (per SKU, leak-free): lag_1, lag_3, lag_12, roll_3, roll_6
        - Price: log price, price-change flag, price-delta-pct
        - Promo: festive, scheme_days, peak_month, weekends as-is
        - Encoded categoricals: brand, segments, price_band as category dtype
    """
    exog_numeric = exog_numeric or []
    exog_categorical = exog_categorical or []

    panel = df.copy()
    panel[date_col] = pd.to_datetime(panel[date_col], errors='coerce')
    panel = panel.dropna(subset=[date_col, sales_col, sku_col])
    panel = panel.sort_values([sku_col, date_col]).reset_index(drop=True)

    # Calendar
    panel['month'] = panel[date_col].dt.month
    panel['quarter'] = panel[date_col].dt.quarter
    panel['year'] = panel[date_col].dt.year

    # Per-SKU lag/rolling — shift+rolling MUST stay inside groupby.transform.
    # Bug fix: previously used `grp.shift(1).rolling(3)` which detaches from the
    # group-by and lets values bleed across SKU boundaries (the rolling window
    # would pull the last shifted value of SKU A into the first row of SKU B).
    panel['lag_1'] = panel.groupby(sku_col)[sales_col].shift(1)
    panel['lag_3'] = panel.groupby(sku_col)[sales_col].shift(3)
    panel['lag_12'] = panel.groupby(sku_col)[sales_col].shift(12)
    panel['roll_3_mean'] = panel.groupby(sku_col)[sales_col].transform(
        lambda s: s.shift(1).rolling(3, min_periods=1).mean()
    )
    panel['roll_6_mean'] = panel.groupby(sku_col)[sales_col].transform(
        lambda s: s.shift(1).rolling(6, min_periods=1).mean()
    )

    # ── Fourier seasonality (port from app_96) ──
    # Cheap, orthogonal to lag features — gives statistical and tree models
    # a smooth cyclic encoding of month/quarter that doesn't introduce the
    # December→January discontinuity of raw integer encoding.
    panel['sin_month'] = np.sin(2 * np.pi * panel['month'] / 12.0)
    panel['cos_month'] = np.cos(2 * np.pi * panel['month'] / 12.0)
    panel['sin_quarter'] = np.sin(2 * np.pi * panel['quarter'] / 4.0)
    panel['cos_quarter'] = np.cos(2 * np.pi * panel['quarter'] / 4.0)
    if freq.upper().startswith('W'):
        # `.fillna(0)` before astype — any row whose date_col failed to
        # parse leaves an NaT here; without the fill, .astype(int) raises
        # IntCastingNaNError. Rows with date_col=NaT were already dropped
        # earlier, so this is a belt-and-braces guard for partial parses.
        panel['week_of_year'] = panel[date_col].dt.isocalendar().week.fillna(0).astype(int)
        panel['sin_week'] = np.sin(2 * np.pi * panel['week_of_year'] / 52.0)
        panel['cos_week'] = np.cos(2 * np.pi * panel['week_of_year'] / 52.0)
    if freq.upper().startswith('D'):
        dow = panel[date_col].dt.dayofweek
        panel['sin_dow'] = np.sin(2 * np.pi * dow / 7.0)
        panel['cos_dow'] = np.cos(2 * np.pi * dow / 7.0)

    # ── Temporal/Exogenous features (frequency-aware) ──
    # Adds calendar-driven features: days_in_month, business_days, holiday counts,
    # seasonality multipliers, festival flags (India-specific), and phase features.
    # Auto-detects frequency and builds appropriate features for daily/weekly/monthly/quarterly/yearly.
    if build_temporal_features is not None:
        try:
            panel = build_temporal_features(
                panel,
                date_col=date_col,
                freq=freq,
                holiday_country='IN'
            )
            # Validate new features have expected ranges
            if validate_temporal_features is not None:
                validate_temporal_features(panel)
        except Exception as e:
            # Graceful degradation — continue without temporal features if module fails
            st.warning(f"Temporal features unavailable (fallback mode): {str(e)[:100]}")

    # ── Holiday-distance features (port from app_96) ──
    # Best-effort soft-import of the `holidays` library. When it's not
    # installed, the feature is just skipped — every downstream model is
    # already coded to handle missing columns.
    try:
        import holidays as _holidays_lib  # type: ignore
        years = list(range(int(panel[date_col].dt.year.min()),
                           int(panel[date_col].dt.year.max()) + 2))
        # Default India calendar — Titan's home market. Override via cfg later.
        _hol = _holidays_lib.country_holidays('IN', years=years)
        hol_dates = pd.to_datetime(sorted(_hol.keys()))
        if len(hol_dates):
            panel_dates = panel[date_col].values.astype('datetime64[ns]')
            hd = hol_dates.values.astype('datetime64[ns]')
            # `is_holiday` on the same day as any holiday
            panel['is_holiday'] = pd.Series(
                np.isin(panel_dates, hd), index=panel.index).astype(int)
            # days_to / days_from — vectorised via searchsorted
            idx = np.searchsorted(hd, panel_dates)
            next_h = np.where(idx < len(hd), hd[np.minimum(idx, len(hd) - 1)], hd[-1])
            prev_h = np.where(idx > 0, hd[np.maximum(idx - 1, 0)], hd[0])
            panel['days_to_next_holiday'] = (
                (next_h - panel_dates) / np.timedelta64(1, 'D')).astype(float)
            panel['days_from_prev_holiday'] = (
                (panel_dates - prev_h) / np.timedelta64(1, 'D')).astype(float)
    except Exception:
        # `holidays` lib missing — that's fine, models skip these columns.
        pass

    # Price features (high signal — 84% of rows have a price change)
    if 'current_price' in panel.columns:
        panel['log_price'] = np.log1p(panel['current_price'].fillna(0))
        if 'previous_price' in panel.columns:
            prev = panel['previous_price'].fillna(panel['current_price'])
            panel['price_change_pct'] = ((panel['current_price'] - prev) / prev.replace(0, np.nan)).fillna(0)
            panel['price_changed'] = (panel['price_change_pct'].abs() > 1e-6).astype(int)

    # Categorical encoding
    for col in exog_categorical:
        if col in panel.columns:
            panel[col] = panel[col].astype('category')

    # PERF: Optimize integer dtypes for memory efficiency on large panels
    # month, quarter, year can fit in int8/int16 instead of int64.
    #
    # SAFETY: skip the cast if the column contains NaN or ±inf —
    # `.astype('uint8' | 'int16')` raises IntCastingNaNError on
    # non-finite values. Real-world inputs (e.g., MP-Till SKUs with
    # partial fills for festive / scheme_days / weekends) routinely
    # have NaN in these columns, so the guard MUST be active. Columns
    # with NaN simply keep their float64 dtype — that's correct
    # behaviour, every downstream model already handles floats.
    for col in ['month', 'quarter', 'year', 'week_of_year', 'price_changed',
                'is_holiday', 'festive', 'peak_month', 'scheme_days', 'weekends']:
        if col not in panel.columns:
            continue
        if panel[col].dtype not in ('int64', 'float64'):
            continue
        col_series = panel[col]
        # Reject non-finite values before any int cast.
        if not np.isfinite(col_series.to_numpy(dtype='float64',
                                                na_value=np.nan)).all():
            continue
        col_max = col_series.max()
        col_min = col_series.min()
        if col_max < 256 and col_min >= 0:
            panel[col] = col_series.astype('uint8')
        elif col_max < 32768 and col_min >= -32768:
            panel[col] = col_series.astype('int16')

    return panel


def _event_slug(name: str) -> str:
    """Make a safe column-name suffix from a free-text event name.
    'Diwali Promo 2025' → 'diwali_promo_2025'.
    """
    import re as _re
    s = str(name or '').strip().lower()
    s = _re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    return s or 'event'


def _event_date_range(row) -> Tuple[Optional[pd.Timestamp], Optional[pd.Timestamp]]:
    """Resolve a row's event date range into (start, end) Timestamps.

    Supports three schemas — in priority order:
      1. NEW: explicit `event_start_date` + `event_end_date` columns.
      2. NEW (single-day): only one of start/end provided → use that for both.
      3. LEGACY: `event_date` column → treat as a one-month event.

    Returns (None, None) when the row carries nothing parseable. Callers can
    safely iterate `pd.date_range(start, end, freq='MS')` to flag every
    period the event covers.
    """
    start = pd.to_datetime(row.get('event_start_date') if hasattr(row, 'get')
                            else row['event_start_date'] if 'event_start_date' in row
                            else None,
                            errors='coerce')
    end = pd.to_datetime(row.get('event_end_date') if hasattr(row, 'get')
                          else row['event_end_date'] if 'event_end_date' in row
                          else None,
                          errors='coerce')
    legacy = pd.to_datetime(row.get('event_date') if hasattr(row, 'get')
                             else row['event_date'] if 'event_date' in row
                             else None,
                             errors='coerce')
    if pd.isna(start) and pd.isna(end) and pd.notna(legacy):
        # Legacy single-date schema — treat as a one-month event window
        return legacy, legacy
    if pd.notna(start) and pd.isna(end):
        return start, start
    if pd.isna(start) and pd.notna(end):
        return end, end
    if pd.isna(start) and pd.isna(end):
        return None, None
    if start > end:
        # User flipped the dates — swap silently so the iteration still works
        start, end = end, start
    return start, end


def _event_months_in_range(start: pd.Timestamp, end: pd.Timestamp) -> List[Tuple[int, int]]:
    """Enumerate every (year, month) tuple touched by the event window."""
    if pd.isna(start) or pd.isna(end):
        return []
    cur = pd.Timestamp(year=start.year, month=start.month, day=1)
    last = pd.Timestamp(year=end.year, month=end.month, day=1)
    months: List[Tuple[int, int]] = []
    while cur <= last:
        months.append((cur.year, cur.month))
        cur = cur + pd.DateOffset(months=1)
    return months


def _rows_match_scope(df: pd.DataFrame, applies_to: str, sku_col: str) -> pd.Series:
    """Resolve an 'Applies to' free-text field against the data.

    Accepts: 'ALL', or a comma-separated list of values that may match against
    any of: category, brand, segment, or sku. Match is case-insensitive and
    treats whitespace as ignored — so 'Footwear, Apparel' and 'footwear,apparel'
    behave the same.
    """
    if applies_to is None:
        return pd.Series(True, index=df.index)
    s = str(applies_to).strip()
    if not s or s.upper() == 'ALL':
        return pd.Series(True, index=df.index)
    tokens = [t.strip().lower() for t in s.split(',') if t.strip()]
    if not tokens:
        return pd.Series(True, index=df.index)
    mask = pd.Series(False, index=df.index)
    for col in ('category', 'brand', 'segment', sku_col):
        if col in df.columns:
            mask = mask | df[col].astype(str).str.lower().isin(tokens)
    return mask


def enrich_df_with_events(df: pd.DataFrame, events_df: Optional[pd.DataFrame],
                          cfg: Dict[str, Any]) -> Tuple[pd.DataFrame, List[str]]:
    """Inject one binary `evt_<slug>` column per unique event_name into df.

    History side: flag = 1 for the row whose (date, applicable-rows) match the
    event's `event_date` (same calendar month, same applicable SKUs). 0 otherwise.

    Future side: not added here — `enrich_future_exog_with_events` handles the
    forecast horizon, called from `build_future_exog`.

    Returns:
        (df_enriched, event_cols)
            df_enriched : a copy of df with the new evt_* columns
            event_cols  : the names of the columns that were added
    """
    df = df.copy()
    if events_df is None or events_df.empty:
        return df, []

    date_col = cfg['date_col']
    sku_col = cfg['sku_col']
    df[date_col] = pd.to_datetime(df[date_col], errors='coerce')

    event_cols: List[str] = []
    # Group by event_name so multiple historical/future occurrences of the
    # same logical event become a single column.
    for ev_name, grp in events_df.groupby('event_name', dropna=True):
        slug = _event_slug(ev_name)
        col = f"evt_{slug}"
        if col not in df.columns:
            df[col] = 0
        for _, row in grp.iterrows():
            # Multi-month range support — flags every calendar month the
            # event window touches, not just one month.
            ev_start, ev_end = _event_date_range(row)
            if ev_start is None:
                continue
            scope_mask = _rows_match_scope(df, row.get('applies_to'), sku_col)
            for yr, mo in _event_months_in_range(ev_start, ev_end):
                period_mask = ((df[date_col].dt.year == yr) &
                               (df[date_col].dt.month == mo))
                df.loc[period_mask & scope_mask, col] = 1
        event_cols.append(col)
    return df, event_cols


def apply_event_impact_to_forecast(forecast: pd.Series, sku: str,
                                   sku_attrs: Dict[str, Any],
                                   events_df: Optional[pd.DataFrame],
                                   sku_col: str) -> pd.Series:
    """Apply the planner's `impact_pct` multiplicatively to the forecast in
    the months where each future event fires.

    The model learns its own response from the historical evt_<slug> flag, so
    this is a *deliberate planner override* on top of that.

    `sku_attrs` is a dict of the SKU's category/brand/segment so we can
    evaluate the `applies_to` scope without re-loading df.
    """
    if events_df is None or events_df.empty or forecast is None or forecast.empty:
        return forecast
    out = forecast.copy().astype(float)
    sku_attrs_lower = {k: str(v).lower() for k, v in sku_attrs.items() if v is not None}
    sku_attrs_lower['sku'] = str(sku).lower()
    sku_attrs_lower.setdefault(sku_col, str(sku).lower())

    for _, row in events_df.iterrows():
        try:
            impact = float(row.get('impact_pct') or 0.0)
        except Exception:
            impact = 0.0
        if impact == 0:
            continue
        ev_start, ev_end = _event_date_range(row)
        if ev_start is None:
            continue
        # Scope check: 'ALL' or token-matches any of {category, brand, segment, sku}
        scope_str = str(row.get('applies_to') or 'ALL').strip()
        if scope_str.upper() != 'ALL':
            tokens = {t.strip().lower() for t in scope_str.split(',') if t.strip()}
            if tokens.isdisjoint(set(sku_attrs_lower.values())):
                continue
        # Apply multiplicatively across EVERY forecast period that falls
        # within the event's date range (inclusive on both ends).
        months_in_range = _event_months_in_range(ev_start, ev_end)
        if not months_in_range:
            continue
        range_mask = pd.Series(False, index=out.index)
        for yr, mo in months_in_range:
            range_mask = range_mask | ((out.index.year == yr) &
                                       (out.index.month == mo))
        if range_mask.any():
            out.loc[range_mask] = out.loc[range_mask] * (1 + impact / 100.0)
    return out.clip(lower=0)


# =================================================================
# 3. INTERMITTENT-DEMAND MODELS (Croston / SBA / TSB)
#    Critical for the 196 lumpy/intermittent SKUs your current code mishandles.
# =================================================================

def croston_classic(y: np.ndarray, alpha: float = 0.1, h: int = 12) -> np.ndarray:
    """Classic Croston: separately smooths demand size and inter-arrival interval."""
    y = np.asarray(y, dtype=float)
    nz_idx = np.where(y > 0)[0]
    if len(nz_idx) == 0:
        return np.zeros(h)
    # Initialise from first non-zero
    z = y[nz_idx[0]]                                       # demand size estimate
    p = nz_idx[0] + 1 if nz_idx[0] > 0 else 1              # interval estimate
    q = 1                                                   # periods since last demand
    for t in range(nz_idx[0] + 1, len(y)):
        if y[t] > 0:
            z = alpha * y[t] + (1 - alpha) * z
            p = alpha * q + (1 - alpha) * p
            q = 1
        else:
            q += 1
    forecast = z / p if p > 0 else 0.0
    return np.full(h, forecast)


def sba(y: np.ndarray, alpha: float = 0.1, h: int = 12) -> np.ndarray:
    """Syntetos-Boylan Approximation: bias-corrected Croston (multiplies by 1 - α/2)."""
    base = croston_classic(y, alpha, h)
    return base * (1 - alpha / 2)


def tsb(y: np.ndarray, alpha: float = 0.1, beta: float = 0.1, h: int = 12) -> np.ndarray:
    """Teunter-Syntetos-Babai: smooths demand probability (handles obsolescence)."""
    y = np.asarray(y, dtype=float)
    if len(y) == 0:
        return np.zeros(h)
    z = y[y > 0].mean() if (y > 0).any() else 0.0
    p = (y > 0).mean()
    for t in range(len(y)):
        if y[t] > 0:
            z = alpha * y[t] + (1 - alpha) * z
            p = beta * 1 + (1 - beta) * p
        else:
            p = beta * 0 + (1 - beta) * p
    return np.full(h, z * p)


# =================================================================
# 4. GLOBAL LIGHTGBM — proper recursive multi-step forecasting
# =================================================================

@dataclass
class GlobalModelPackage:
    model: Any
    feature_cols: List[str]
    categorical_cols: List[str]
    sku_col: str
    date_col: str
    sales_col: str
    freq: str
    panel_history: pd.DataFrame    # full historical panel — needed for recursive features


@st.cache_resource
def train_global_lightgbm(panel: pd.DataFrame, sku_col: str, date_col: str,
                          sales_col: str, freq: str,
                          categorical_cols: List[str],
                          holdout_periods: int = 0) -> Optional[GlobalModelPackage]:
    """One LightGBM trained on ALL SKUs at once. Learns shared seasonal & price patterns.

    holdout_periods > 0 removes the last N periods PER SKU before training.
    Use this when the model will be evaluated against those periods (backtesting),
    otherwise the test set has already been seen during training.
    """
    if lgb is None:
        return None

    train_panel = panel.copy()
    if holdout_periods > 0:
        # Drop last N rows per SKU (panel is already sorted by sku, date)
        rank_from_end = train_panel.groupby(sku_col).cumcount(ascending=False)
        train_panel = train_panel[rank_from_end >= holdout_periods].reset_index(drop=True)

    # `revenue` and `avg_price` are deterministic functions of the target
    # (revenue = sales × price; avg_price = revenue / sales). Including them
    # is target leakage: training loss collapses, but at inference time they
    # are unavailable and get filled with 0 in the recursive forecast loop,
    # destroying real-world accuracy. Drop them.
    drop_cols = {sku_col, date_col, sales_col, 'channel', 'revenue', 'avg_price'}
    feature_cols = [c for c in train_panel.columns
                    if c not in drop_cols and train_panel[c].dtype != 'object']
    # Ensure categoricals included
    for c in categorical_cols:
        if c in train_panel.columns and c not in feature_cols:
            feature_cols.append(c)

    train_df = train_panel.dropna(subset=['lag_1'])  # need at least one lag
    if train_df.empty:
        return None

    valid_cats = [c for c in categorical_cols if c in train_df.columns]
    X, y = train_df[feature_cols], train_df[sales_col]

    model = lgb.LGBMRegressor(
        n_estimators=300, learning_rate=0.05, num_leaves=63,
        min_child_samples=20, random_state=42, verbose=-1,
        objective='tweedie', tweedie_variance_power=1.3,  # robust to zeros + skew
    )
    model.fit(X, y, categorical_feature=valid_cats if valid_cats else 'auto')

    return GlobalModelPackage(
        model=model, feature_cols=feature_cols, categorical_cols=valid_cats,
        sku_col=sku_col, date_col=date_col, sales_col=sales_col,
        freq=freq, panel_history=train_panel.copy(),
        # When holdout > 0, panel_history reflects the truncated panel so that
        # recursive forecasting during a backtest doesn't accidentally read
        # actual future values when filling lags.
    )


def forecast_with_global_lgbm(pkg: GlobalModelPackage, sku: str, h: int,
                              future_exog: pd.DataFrame = None,
                              future_values: Optional[Dict[str, List[float]]] = None,
                              future_events: Optional[pd.DataFrame] = None,
                              sku_attrs: Optional[Dict[str, Any]] = None,
                              user_strategies: Optional[Dict[str, str]] = None,
                              ) -> pd.Series:
    """Recursive multi-step forecast for one SKU using the global model.

    At each step, fill in this period's lags from prior predictions, then predict.

    `future_values` ({col: [v0, v1, …]}) — planner-supplied explicit values per
    column, applied at highest precedence on the matching step. Missing tail
    falls back to the seasonal-repeat / classifier logic.

    `future_events` — planner event calendar. When supplied (and no explicit
    `future_exog` is passed) we build the future `evt_<slug>` flags via the same
    leak-free projector the SARIMAX path uses, so the model APPLIES the event
    lift it learned during training to upcoming events. Without this the loop
    zeroes every future evt_ flag and the global model ignores planner events.
    `sku_attrs` scopes events to this SKU; `user_strategies` carries per-column
    projection overrides from the UI.
    """
    sku_history = pkg.panel_history[pkg.panel_history[pkg.sku_col] == sku].copy()
    if sku_history.empty:
        return pd.Series(dtype=float)

    sku_history = sku_history.sort_values(pkg.date_col)
    last_date = sku_history[pkg.date_col].max()

    # Carry-forward defaults from last observed row
    last_row = sku_history.iloc[-1]
    static_cols = ['brand', 'segments', 'price_band', 'channel',
                   'current_price', 'previous_price', 'log_price']
    static_vals = {c: last_row[c] for c in static_cols if c in last_row}

    forecasts = []
    history_sales = sku_history[pkg.sales_col].tolist()
    future_dates = pd.date_range(start=last_date, periods=h + 1, freq=pkg.freq)[1:]

    # Calendar-driven defaults: same-month-last-year for promo / user-exog so the
    # recursive forecast captures repeated seasonality without leaking actuals.
    sku_history_indexed = sku_history.set_index(pkg.date_col)

    # Deterministic temporal features for the WHOLE horizon, recomputed exactly
    # from the calendar (days_in_month, holiday/festival counts, seasonality,
    # special/other-holiday flags, …). Without this the recursive loop's
    # reindex(fill_value=0) zeroed every temporal column the model trained on —
    # a train/serve skew that silently flattened seasonality. Computed once.
    future_calendar = None
    if build_temporal_features_for_index is not None:
        try:
            future_calendar = build_temporal_features_for_index(
                future_dates, freq=pkg.freq, holiday_country='IN')
        except Exception:
            future_calendar = None
    cal_cols = set(future_calendar.columns) if future_calendar is not None else set()
    det_future_cols = [c for c in pkg.feature_cols if c in cal_cols]

    # Feature columns that are categorical dtype in training — must be re-cast to
    # the same categories at predict time (LightGBM keys on the category codes).
    cat_feature_cols = [c for c in pkg.feature_cols
                        if str(getattr(pkg.panel_history.get(c), 'dtype', '')) == 'category']

    # Columns the loop sets explicitly (deterministic date terms, lags, price).
    _explicit_cols = ({pkg.date_col, 'month', 'quarter', 'year',
                       'sin_month', 'cos_month', 'sin_quarter', 'cos_quarter',
                       'week_of_year', 'sin_week', 'cos_week', 'sin_dow', 'cos_dow',
                       'lag_1', 'lag_3', 'lag_12', 'roll_3_mean', 'roll_6_mean',
                       'price_changed', 'price_change_pct'} | set(static_cols))

    # ── Future planned-event flags (evt_<slug>) ─────────────────────────
    # The model learned each event's lift from history; to apply it to an
    # upcoming event we flip its evt_ column to 1 on the event date(s). Build
    # the frame from this SKU's historical evt_ columns + the planner calendar
    # via the leak-free projector (only when the caller didn't pass an explicit
    # future_exog). Only evt_ columns are populated here — every other exog
    # keeps its existing in-loop projection (seasonal-repeat / calendar).
    if future_exog is None and future_events is not None and len(future_events):
        _evt_cols = [c for c in pkg.feature_cols
                     if c.startswith('evt_') and c in sku_history_indexed.columns]
        if _evt_cols:
            try:
                future_exog = build_future_exog(
                    sku_history_indexed[_evt_cols], h, pkg.freq,
                    future_events=future_events, sku_attrs=sku_attrs,
                    sku_col=pkg.sku_col, user_strategies=user_strategies,
                )
            except Exception:
                future_exog = None

    for step, future_date in enumerate(future_dates):
        row = dict(static_vals)
        row[pkg.date_col] = future_date

        # ── Deterministic calendar / Fourier terms (pure functions of the date —
        # always reconstructed so they're never zeroed regardless of frequency) ──
        row['month'] = future_date.month
        row['quarter'] = future_date.quarter
        row['year'] = future_date.year
        row['sin_month'] = np.sin(2 * np.pi * future_date.month / 12.0)
        row['cos_month'] = np.cos(2 * np.pi * future_date.month / 12.0)
        row['sin_quarter'] = np.sin(2 * np.pi * future_date.quarter / 4.0)
        row['cos_quarter'] = np.cos(2 * np.pi * future_date.quarter / 4.0)
        _woy = int(pd.Timestamp(future_date).isocalendar().week)
        row['week_of_year'] = _woy
        row['sin_week'] = np.sin(2 * np.pi * _woy / 52.0)
        row['cos_week'] = np.cos(2 * np.pi * _woy / 52.0)
        _dow = future_date.dayofweek
        row['sin_dow'] = np.sin(2 * np.pi * _dow / 7.0)
        row['cos_dow'] = np.cos(2 * np.pi * _dow / 7.0)

        # ── Lags / rolling from realised + previously-predicted demand ──
        row['lag_1'] = history_sales[-1] if len(history_sales) >= 1 else 0
        row['lag_3'] = history_sales[-3] if len(history_sales) >= 3 else 0
        row['lag_12'] = history_sales[-12] if len(history_sales) >= 12 else 0
        row['roll_3_mean'] = np.mean(history_sales[-3:]) if len(history_sales) >= 1 else 0
        row['roll_6_mean'] = np.mean(history_sales[-6:]) if len(history_sales) >= 1 else 0

        same_month_last_year = future_date - pd.DateOffset(years=1)
        ly_row = sku_history_indexed.loc[same_month_last_year] \
                 if same_month_last_year in sku_history_indexed.index else None

        # ── Richer temporal features: recompute exactly from the calendar ──
        if future_calendar is not None:
            for c in det_future_cols:
                row[c] = future_calendar.loc[future_date, c]

        # ── Price-change flags: assume no change unless user-supplied ──
        for c in ['price_changed', 'price_change_pct']:
            if future_exog is not None and c in future_exog.columns and future_date in future_exog.index:
                row[c] = future_exog.loc[future_date, c]
            else:
                row[c] = 0

        # ── Every remaining exog (festive, peak_month, scheme, user macro
        # features, evt_ flags): route through the same future-knowability
        # classifier the SARIMAX path uses, so user-supplied exog is projected
        # consistently instead of being silently zeroed by the reindex below. ──
        for c in pkg.feature_cols:
            if c in _explicit_cols or c in row:
                continue
            strat = classify_exog_strategy(c, cal_cols, None)
            # An explicitly-projected future value wins (e.g. an evt_ flag
            # flipped on a planner event date). Falls through to the
            # strategy-based default when no such value exists.
            if (future_exog is not None and c in future_exog.columns
                    and future_date in future_exog.index
                    and pd.notna(future_exog.loc[future_date, c])):
                row[c] = future_exog.loc[future_date, c]
            elif strat in ('zero', 'event'):
                row[c] = 0
            elif strat == 'flat':
                row[c] = last_row[c] if c in last_row else 0
            elif ly_row is not None and c in ly_row.index:
                row[c] = ly_row[c]
            elif c in last_row and c in ('weekends', 'days'):
                row[c] = last_row[c]
            else:
                row[c] = 0

        # ── Highest precedence: planner-supplied explicit future values ──
        # If the planner typed comma-separated values in section 2b, use those
        # for the matching forecast step regardless of strategy / lag logic.
        if future_values:
            for _col, _vals in future_values.items():
                if _col in pkg.feature_cols and step < len(_vals):
                    try:
                        row[_col] = float(_vals[step])
                    except (TypeError, ValueError):
                        pass

        x = pd.DataFrame([row])
        for c in cat_feature_cols:
            if c in x.columns:
                x[c] = pd.Categorical(x[c], categories=pkg.panel_history[c].cat.categories)

        # Reindex to match training feature order; any still-missing col → 0
        X = x.reindex(columns=pkg.feature_cols, fill_value=0)
        yhat = max(0.0, float(pkg.model.predict(X)[0]))   # clip negatives
        forecasts.append(yhat)
        history_sales.append(yhat)

    return pd.Series(forecasts, index=future_dates, name='forecast')


# =================================================================
# 5. CHRONOS ZERO-SHOT (cold-start SKUs)
# =================================================================

@st.cache_resource
def load_chronos_pipeline(model_size: str = 'mini'):
    if ChronosPipeline is None:
        return None
    return ChronosPipeline.from_pretrained(
        f"amazon/chronos-t5-{model_size}",
        device_map="cpu",
        torch_dtype=torch.bfloat16 if torch else None,
    )


def forecast_chronos(history: pd.Series, h: int, freq: str,
                     pipeline=None) -> Tuple[pd.Series, pd.DataFrame]:
    """Zero-shot forecast for cold-start SKUs."""
    if pipeline is None:
        pipeline = load_chronos_pipeline()
    if pipeline is None:
        # Fallback: naive seasonal mean
        idx = pd.date_range(start=history.index[-1], periods=h + 1, freq=freq)[1:]
        return pd.Series([history.mean()] * h, index=idx), None

    context = torch.tensor(history.values, dtype=torch.float32)
    samples = pipeline.predict(context, prediction_length=h, num_samples=20)
    arr = samples[0].numpy()
    median = np.quantile(arr, 0.5, axis=0).clip(min=0)
    lo, hi = np.quantile(arr, 0.1, axis=0).clip(min=0), np.quantile(arr, 0.9, axis=0).clip(min=0)
    idx = pd.date_range(start=history.index[-1], periods=h + 1, freq=freq)[1:]
    return pd.Series(median, index=idx), pd.DataFrame({'lower': lo, 'upper': hi}, index=idx)


# =================================================================
# 6. LOCAL CLASSICAL MODELS (for stable high SKUs with rich history)
# =================================================================

# Exog columns whose honest future value is "no change" → 0 (never carried
# forward, which would falsely signal a fresh price move every period).
_EXOG_ZERO_IN_FUTURE = ('price_changed', 'price_change_pct', 'is_outlier_t',
                        'high_residual_flag')

# Human-readable labels for each projection strategy (shown in the audit report).
_EXOG_STRATEGY_LABELS = {
    'calendar':        'calendar (recomputed from date)',
    'festival':        'festival/holiday calendar (recomputed)',
    'event':           'planned event flag (0; flipped on event dates)',
    'repeat_seasonal': 'repeat seasonal (same month last year)',
    'flat':            'held flat (last observed value)',
    'zero':            'assumed no change (0)',
    'explicit':        'explicit values (planner-supplied)',
}


def classify_exog_strategy(col: str,
                           future_calendar_cols: Optional[set] = None,
                           user_strategies: Optional[Dict[str, str]] = None) -> str:
    """Decide how an exogenous column should be projected into the future.

    The organising principle is *future-knowability* — a regressor is only
    usable if we can supply its value at prediction time without leaking the
    target:
      • Tier 0/1 (calendar/festival deterministic) → recompute from the date.
      • Tier 2 (planned events, `evt_*`)            → 0, flipped on event dates.
      • price/outlier flags                          → 0 (assume no change).
      • Tier 3/4 (everything else: festive, peak,    → repeat the seasonal
        scheme, user macro features)                   pattern (same month LY).
    A per-column user override (from the UI) always wins.
    """
    us = (user_strategies or {}).get(col)
    if us and str(us).lower() not in ('', 'auto', 'none'):
        return str(us).lower()
    if col.startswith('evt_'):
        return 'event'
    if col in _EXOG_ZERO_IN_FUTURE:
        return 'zero'
    if (col in CALENDAR_DETERMINISTIC_COLUMNS
            and (future_calendar_cols is None or col in future_calendar_cols)):
        return 'festival' if 'holiday' in col or 'festival' in col else 'calendar'
    return 'repeat_seasonal'


def summarize_exog_projection(exog_cols: List[str],
                              user_strategies: Optional[Dict[str, str]] = None
                              ) -> List[Tuple[str, str]]:
    """Preview (column, method-label) pairs for the UI, without computing values."""
    out = []
    for c in exog_cols:
        strat = classify_exog_strategy(c, future_calendar_cols=None,
                                       user_strategies=user_strategies)
        out.append((c, _EXOG_STRATEGY_LABELS.get(strat, strat)))
    return out


def build_future_exog(exog_train: pd.DataFrame, h: int, freq: str,
                      future_events: Optional[pd.DataFrame] = None,
                      sku_attrs: Optional[Dict[str, Any]] = None,
                      sku_col: str = 'sku',
                      user_strategies: Optional[Dict[str, str]] = None,
                      holiday_country: str = 'IN',
                      future_values: Optional[Dict[str, List[float]]] = None,
                      ) -> pd.DataFrame:
    """Construct exog values for a forecast horizon without leaking the test period.

    Each column is routed by `classify_exog_strategy` to the projection method
    that matches how knowable its future is:
      • Calendar/festival-deterministic columns (days_in_month, weekends,
        holiday/festival counts, seasonality, sin/cos, …) are **recomputed**
        exactly on the forecast dates — Feb-2025 gets 28 days, not Feb-2024's
        29. Copying last year (the old behaviour) silently degraded precisely
        the features meant to add calendar precision.
      • `evt_*` planned-event flags default to 0 and are flipped to 1 on the
        exact forecast period(s) the event fires (scoped via `sku_attrs`).
      • Price-change / outlier flags are set to 0 (future moves unknown).
      • Everything else (festive, peak_month, scheme, user macro features) is
        repeated seasonally (same month last year → same-month avg → median).

    A per-column override map (`user_strategies`, from the planner UI) takes
    precedence. The chosen method per column is recorded on the returned frame
    as `.attrs['projection_report']` for an auditable forecast.
    """
    last_date = exog_train.index[-1]
    future_idx = pd.date_range(start=last_date, periods=h + 1, freq=freq)[1:]
    exog_future = pd.DataFrame(index=future_idx, columns=exog_train.columns, dtype=float)

    # Deterministic future calendar frame (Tier 0/1) — recomputed, never copied.
    future_calendar: Optional[pd.DataFrame] = None
    if build_temporal_features_for_index is not None:
        try:
            future_calendar = build_temporal_features_for_index(
                future_idx, freq=freq, holiday_country=holiday_country)
        except Exception:
            future_calendar = None
    cal_cols = (set(future_calendar.columns) if future_calendar is not None else set())

    # Same-month-last-year fallback table for the seasonal-repeat strategy.
    train_with_month = exog_train.copy()
    train_with_month['__month__'] = train_with_month.index.month
    monthly_avg = train_with_month.groupby('__month__').mean(numeric_only=True)

    report: Dict[str, str] = {}

    def _seasonal_repeat(col: str) -> None:
        for fd in future_idx:
            smly = fd - pd.DateOffset(years=1)
            if smly in exog_train.index:
                exog_future.loc[fd, col] = exog_train.loc[smly, col]
            elif fd.month in monthly_avg.index and col in monthly_avg.columns:
                exog_future.loc[fd, col] = monthly_avg.loc[fd.month, col]
            else:
                exog_future.loc[fd, col] = exog_train[col].median()

    for col in exog_train.columns:
        strat = classify_exog_strategy(col, cal_cols, user_strategies)

        if strat == 'zero':
            exog_future[col] = 0.0
        elif strat == 'event':
            exog_future[col] = 0.0  # flipped on event dates below
        elif strat == 'flat':
            exog_future[col] = (float(exog_train[col].iloc[-1])
                                if len(exog_train) else 0.0)
        elif strat in ('calendar', 'festival') and col in cal_cols \
                and pd.api.types.is_numeric_dtype(future_calendar[col]):
            exog_future[col] = pd.to_numeric(
                future_calendar[col], errors='coerce').reindex(future_idx).to_numpy()
        else:
            # repeat_seasonal — also the safe fallback when a 'calendar' column
            # can't be recomputed (e.g. the temporal module is unavailable).
            _seasonal_repeat(col)
            if strat in ('calendar', 'festival'):
                strat = 'repeat_seasonal'

        report[col] = _EXOG_STRATEGY_LABELS.get(strat, strat)

    # ---- Highest precedence: planner-supplied explicit future values ----
    # Overlays the per-period values the planner typed in 2b (comma-separated).
    # Fewer values than the horizon → the supplied prefix is used, the rest
    # keeps whatever the strategy produced (typically seasonal repeat).
    if future_values:
        for col, vals in future_values.items():
            if col not in exog_future.columns or not vals:
                continue
            n = min(len(vals), len(future_idx))
            try:
                exog_future.iloc[:n, exog_future.columns.get_loc(col)] = [
                    float(v) for v in vals[:n]
                ]
                report[col] = (f"explicit values (planner-supplied, "
                               f"{n}/{len(future_idx)} period(s))")
            except (TypeError, ValueError):
                pass

    # ---- Now flip evt_<slug> columns on the actual event dates ----
    if future_events is not None and not future_events.empty:
        attrs = {k: str(v).lower() for k, v in (sku_attrs or {}).items()
                 if v is not None}
        for _, row in future_events.iterrows():
            ev_start, ev_end = _event_date_range(row)
            if ev_start is None:
                continue
            scope_str = str(row.get('applies_to') or 'ALL').strip()
            in_scope = True
            if scope_str.upper() != 'ALL':
                tokens = {t.strip().lower() for t in scope_str.split(',') if t.strip()}
                in_scope = bool(tokens) and not tokens.isdisjoint(set(attrs.values()))
            if not in_scope:
                continue
            slug = _event_slug(row.get('event_name', ''))
            col = f"evt_{slug}"
            if col not in exog_future.columns:
                continue
            # Multi-month range — flag every forecast period the event covers.
            months_in_range = _event_months_in_range(ev_start, ev_end)
            ev_mask = pd.Series(False, index=exog_future.index)
            for yr, mo in months_in_range:
                ev_mask = ev_mask | ((exog_future.index.year == yr) &
                                     (exog_future.index.month == mo))
            if ev_mask.any():
                exog_future.loc[ev_mask, col] = 1.0

    out = exog_future.astype(float)
    try:
        out.attrs['projection_report'] = report
    except Exception:
        pass
    return out


def _seasonal_naive_forecast(history: pd.Series, h: int, freq: str,
                              seasonal: int) -> pd.Series:
    """Fallback when a model errors: repeat the same-period-last-year value.

    Far better than `history.mean()` (the old default) — the mean is a
    flat line that ignores level shifts, trend, and seasonality. Seasonal
    naive preserves at least the calendar pattern, which is the dominant
    signal in monthly retail demand.
    """
    idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
    out = []
    for ts in idx:
        # Look h steps back if it lands inside history; else fall back to mean
        ref_ts = ts - pd.DateOffset(months=seasonal) if seasonal >= 12 \
                 else ts - pd.DateOffset(days=seasonal * 7) if seasonal == 52 \
                 else None
        if ref_ts is not None and ref_ts in history.index:
            out.append(float(history.loc[ref_ts]))
        elif len(history) >= seasonal:
            # Use the corresponding month in the most recent full cycle
            out.append(float(history.iloc[-seasonal:].mean()))
        else:
            out.append(float(history.mean()))
    return pd.Series(out, index=idx).clip(lower=0)


def _winsorize_series(series: pd.Series, low_q: float = 0.01,
                      high_q: float = 0.99) -> Tuple[pd.Series, int]:
    """Cap extreme values to [low_q, high_q] historical quantiles.

    Returns (winsorised_series, n_capped). One Mar-2023 promo spike of
    10× normal demand will be capped to the 99th percentile — SARIMAX
    then fits a sane level/trend instead of treating that month as the
    new normal.
    """
    if len(series) < 8:
        return series, 0
    lo = float(series.quantile(low_q))
    hi = float(series.quantile(high_q))
    n_capped = int(((series < lo) | (series > hi)).sum())
    return series.clip(lower=lo, upper=hi), n_capped


# =================================================================
# Deterministic calendar features
# These run BOTH on the historical panel (replace any noisy per-row
# input from the source CSV) AND on the forecast horizon (so future
# months get the same features the model was trained on). Computing
# them deterministically avoids the silent failure mode where a SKU's
# raw `weekends`/`festive` column was sparse, all-NaN, or simply
# missing — the engine still produces a clean feature matrix.
# =================================================================

def _count_weekends_in_month(month_start: pd.Timestamp) -> int:
    """Number of Saturdays + Sundays in the calendar month of `month_start`."""
    try:
        ms = pd.Timestamp(month_start).normalize().replace(day=1)
        dim = ms.days_in_month
        end = ms + pd.Timedelta(days=dim - 1)
        dates = pd.date_range(ms, end, freq='D')
        return int((dates.weekday >= 5).sum())
    except Exception:
        return 0


@st.cache_data(show_spinner=False)
def _holidays_for_year(country_code: str, year: int) -> List[pd.Timestamp]:
    """Cached list of public-holiday dates for a (country, year).
    Cached so re-rendering the panel doesn't re-call the `holidays`
    library hundreds of times."""
    try:
        import holidays as _hol_lib  # type: ignore
        h = _hol_lib.country_holidays(country_code, years=[int(year)])
        return [pd.Timestamp(d) for d in sorted(h.keys())]
    except Exception:
        return []


def _count_holidays_in_month(month_start: pd.Timestamp,
                              country_code: str = 'IN') -> int:
    """Number of public holidays in the calendar month."""
    try:
        ms = pd.Timestamp(month_start).normalize().replace(day=1)
        end = ms + pd.Timedelta(days=ms.days_in_month - 1)
        return sum(1 for d in _holidays_for_year(country_code, ms.year)
                   if ms <= d <= end)
    except Exception:
        return 0


def _count_events_in_month(month_start: pd.Timestamp,
                            events_df: Optional[pd.DataFrame]) -> int:
    """Number of planner-pinned events whose date range overlaps the
    calendar month. Uses the same _event_date_range helper as the rest
    of the pipeline so multi-month event windows are handled correctly.
    """
    if events_df is None or events_df.empty:
        return 0
    try:
        ms = pd.Timestamp(month_start).normalize().replace(day=1)
        ym = (ms.year, ms.month)
        n = 0
        for _, row in events_df.iterrows():
            s, e = _event_date_range(row)
            if s is None:
                continue
            if ym in set(_event_months_in_range(s, e)):
                n += 1
        return n
    except Exception:
        return 0


def _detect_peak_months_for_sku(history: pd.Series, top_k: int = 3) -> List[int]:
    """Return the top-K calendar months by mean demand for this SKU.

    Used when the planner picks "Auto-detect peak months per SKU" — each
    SKU gets its own peak-month list derived from its history, instead
    of relying on a fixed `peak_month` column that may not exist.
    """
    if history is None or len(history) < 12:
        return []
    try:
        monthly = history.groupby(history.index.month).mean()
        return [int(m) for m in monthly.nlargest(min(top_k, len(monthly))).index]
    except Exception:
        return []


def _detect_outlier_mask(series: pd.Series,
                          k_iqr: float = 3.0) -> pd.Series:
    """Identify months whose value is > k × IQR from the median.

    Returns a 0/1 Series aligned to the input — 1 where the value is an
    outlier. Used as an exog flag for SARIMAX so the model can *learn*
    the response to outliers (typically promo months) instead of
    pretending they didn't happen.
    """
    if len(series) < 8:
        return pd.Series(0, index=series.index, dtype=int)
    q1, q3 = series.quantile(0.25), series.quantile(0.75)
    iqr = float(q3 - q1)
    if iqr <= 0:
        return pd.Series(0, index=series.index, dtype=int)
    med = float(series.median())
    mask = ((series - med).abs() > k_iqr * iqr).astype(int)
    return mask


def forecast_sarimax_with_promo(history: pd.Series, h: int, freq: str,
                                exog_train: pd.DataFrame = None,
                                exog_future: pd.DataFrame = None,
                                auto_order: bool = False,
                                cached_order: Optional[Tuple[Tuple, Tuple]] = None
                                ) -> Tuple[pd.Series, Optional[pd.DataFrame]]:
    """Robust SARIMAX with outlier handling, exog hygiene, and a
    seasonal-naive fallback for the cases where the optimiser blows up.

    Hardening over the original (1,1,1)(1,1,0,12) implementation:
      • History is winsorised to [1%, 99%] historical quantiles before
        fitting — kills the "one promo month becomes the new level"
        pathology that produced 3,800-unit hallucinations on Stable High
        SKUs.
      • **Outlier exog flag** — an `is_outlier_t` binary column is added
        to the exog matrix so SARIMAX learns the *response* to outliers
        (promo months) rather than ignoring them via winsorisation.
        In the future horizon the flag is 0 by default (no promo
        assumed) unless caller-supplied exog overrides it.
      • Exog regressors are standardised (z-score) so SARIMAX coefficient
        estimation isn't dominated by scale differences (e.g. log_price
        ~10³ vs price_changed ∈ {0,1}).
      • Highly-correlated exog columns (corr > 0.85) are deduplicated —
        festive/peak_month/scheme_days collinearity made coefficients
        unstable.
      • Future exog rows with NaN trigger seasonal-naive fallback instead
        of producing NaN forecasts.
      • **auto_order=True** invokes pmdarima.auto_arima for per-SKU (p,d,q)
        × (P,D,Q,m) search instead of the fixed (1,1,1)(1,1,0,12) order.
        Used for hero SKUs (Stable High contributors) where 1-2s extra
        per SKU is worth the accuracy gain.
      • Try with enforce_stationarity=True first; only relax constraints
        if the constrained fit doesn't converge. Reduces explosive
        non-stationary models slipping through.
      • Fallback on any failure: seasonal naive (same-period-last-year)
        instead of a flat history.mean() line.
    """
    seasonal = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)

    # ── 1. Winsorise history so a single outlier month doesn't warp the fit
    hist_clean, n_capped = _winsorize_series(history)

    # ── 1b. Outlier flag — built from the ORIGINAL (un-winsorised)
    # series so the indicator survives the winsorisation. SARIMAX learns
    # the historical response to outlier months; at forecast time we set
    # the flag to 0 by default (no future outliers assumed unless the
    # caller-supplied future exog explicitly flags one).
    outlier_mask = _detect_outlier_mask(history)
    outlier_train_df = (pd.DataFrame({'is_outlier_t': outlier_mask.values},
                                      index=history.index)
                         if outlier_mask.sum() > 0 else None)

    # ── 2. Exog hygiene (only when exog is provided)
    exog_tr_clean: Optional[pd.DataFrame] = None
    exog_fu_clean: Optional[pd.DataFrame] = None
    exog_means: Dict[str, float] = {}
    exog_stds: Dict[str, float] = {}
    if exog_train is not None and not exog_train.empty:
        try:
            ex = exog_train.copy().select_dtypes(include=[np.number]).fillna(0)
            # Drop columns with zero variance — pure noise to SARIMAX
            ex = ex.loc[:, ex.std() > 1e-9]
            # Drop one of every pair with correlation > 0.85 (keep the first)
            if ex.shape[1] > 1:
                corr = ex.corr().abs()
                to_drop: List[str] = []
                cols = list(ex.columns)
                for i, c1 in enumerate(cols):
                    if c1 in to_drop:
                        continue
                    for c2 in cols[i + 1:]:
                        if c2 in to_drop:
                            continue
                        if corr.loc[c1, c2] > 0.85:
                            to_drop.append(c2)
                if to_drop:
                    ex = ex.drop(columns=to_drop)
            # Standardise — keep means/stds so we can transform exog_future
            exog_means = {c: float(ex[c].mean()) for c in ex.columns}
            exog_stds = {c: float(ex[c].std() or 1.0) for c in ex.columns}
            exog_tr_clean = pd.DataFrame(
                {c: (ex[c] - exog_means[c]) / exog_stds[c] for c in ex.columns},
                index=ex.index,
            )
            if exog_future is not None and not exog_future.empty:
                ef = exog_future.copy().reindex(columns=ex.columns, fill_value=0)
                if ef.isna().any().any():
                    # NaN in exog_future would produce NaN forecasts —
                    # fall through to seasonal naive.
                    return _seasonal_naive_forecast(history, h, freq, seasonal), None
                exog_fu_clean = pd.DataFrame(
                    {c: (ef[c].astype(float) - exog_means[c]) / exog_stds[c]
                     for c in ex.columns},
                    index=ef.index,
                )
        except Exception:
            # Exog hygiene failed → fit without exog rather than crash
            exog_tr_clean = None
            exog_fu_clean = None

    # ── 2b. Attach outlier flag to exog (works with or without other exog)
    if outlier_train_df is not None:
        if exog_tr_clean is not None:
            exog_tr_clean = pd.concat(
                [exog_tr_clean, outlier_train_df.reindex(exog_tr_clean.index)
                                                  .fillna(0)], axis=1)
        else:
            exog_tr_clean = outlier_train_df
        # Future horizon — assume no outliers unless caller said so
        future_idx = (exog_fu_clean.index if exog_fu_clean is not None
                      else pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:])
        outlier_future_df = pd.DataFrame(
            {'is_outlier_t': np.zeros(len(future_idx), dtype=float)},
            index=future_idx,
        )
        if exog_fu_clean is not None:
            exog_fu_clean = pd.concat([exog_fu_clean, outlier_future_df], axis=1)
        else:
            exog_fu_clean = outlier_future_df

    # ── 3. Order selection: cached → auto_arima → fixed.
    # PERF: `cached_order` lets the caller run auto_arima ONCE per SKU and
    # reuse the resulting (p,d,q)(P,D,Q,m) for every backtest fold / CV
    # fold / rolling-origin call. Without this cache, a single Stable
    # High SKU with CV mode + auto_order triggers ~13 auto_arima calls,
    # each fitting 10-20 SARIMAX models internally → 200+ fits per SKU.
    # With the cache, the order search runs once and every subsequent
    # fit is a direct SARIMAX call (no search) → typically 20-50× faster
    # per SKU at negligible accuracy cost (the order found on the full
    # history is a good proxy for shorter slices).
    auto_order_used: Optional[Tuple] = None
    if cached_order is not None:
        auto_order_used = cached_order
    elif auto_order:
        try:
            import pmdarima as _pm  # type: ignore
            use_seasonal = (seasonal > 1 and len(hist_clean) >= 2 * seasonal)
            _auto = _pm.auto_arima(
                hist_clean.values,
                X=(exog_tr_clean.values if exog_tr_clean is not None else None),
                seasonal=use_seasonal,
                m=seasonal if use_seasonal else 1,
                suppress_warnings=True, error_action='ignore',
                # Tighter bounds: 99% of useful retail-monthly fits land
                # in p,q ≤ 2 and P,Q ≤ 1. The wider grid (max_p=3, etc.)
                # added 3-5× wall time for marginal accuracy gain.
                stepwise=True, max_p=2, max_q=2, max_P=1, max_Q=1,
                max_d=2, max_D=1,
                # Short series get a cheaper non-seasonal test
                seasonal_test='ocsb',
            )
            auto_order_used = (_auto.order, _auto.seasonal_order)
        except Exception:
            auto_order_used = None

    # ── 4. Fit. Try stationary/invertible first; relax only if needed.
    def _fit(stationary: bool):
        if auto_order_used is not None:
            ord_, sord_ = auto_order_used
        else:
            ord_, sord_ = (1, 1, 1), (1, 1, 0, seasonal)
        kw = dict(order=ord_, seasonal_order=sord_,
                  enforce_stationarity=stationary,
                  enforce_invertibility=stationary)
        if exog_tr_clean is not None:
            m = SARIMAX(hist_clean, exog=exog_tr_clean, **kw).fit(disp=False)
        else:
            m = SARIMAX(hist_clean, **kw).fit(disp=False)
        return m

    model = None
    for try_stationary in (True, False):
        try:
            model = _fit(try_stationary)
            break
        except Exception:
            continue
    if model is None:
        return _seasonal_naive_forecast(history, h, freq, seasonal), None

    try:
        if exog_fu_clean is not None:
            fc = model.get_forecast(steps=h, exog=exog_fu_clean)
        else:
            fc = model.get_forecast(steps=h)
        pred = fc.predicted_mean.clip(lower=0)
        # ── 4. Sanity check: if SARIMAX still produced a wild forecast
        # (e.g. > 5× historical max), fall back to seasonal naive.
        # Production guardrails will clip later but this avoids polluting
        # the CI band with garbage.
        hist_max = float(history.max())
        if hist_max > 0 and float(pred.max()) > 5 * hist_max:
            return _seasonal_naive_forecast(history, h, freq, seasonal), None
        ci = fc.conf_int()
        ci.columns = ['lower', 'upper']
        ci = ci.clip(lower=0)
        return pred, ci
    except Exception:
        return _seasonal_naive_forecast(history, h, freq, seasonal), None


def forecast_holt_winters(history: pd.Series, h: int, freq: str) -> pd.Series:
    seasonal = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)
    try:
        if seasonal > 1 and len(history) >= 2 * seasonal:
            model = ExponentialSmoothing(history, seasonal_periods=seasonal,
                                         seasonal='add', trend='add',
                                         initialization_method='estimated').fit()
        else:
            model = ExponentialSmoothing(history, trend='add',
                                         initialization_method='estimated').fit()
        return model.forecast(h).clip(lower=0)
    except Exception:
        idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
        return pd.Series([history.mean()] * h, index=idx)


# =================================================================
# 6b. ADDITIONAL UNIVARIATE FORECASTERS  (opt-in via portfolio UI)
#     Soft-imports — every function falls back to Holt-Winters when the
#     underlying library is missing, so the app stays importable even
#     without prophet/pmdarima/etc. installed.
# =================================================================

def _future_index(history: pd.Series, h: int, freq: str) -> pd.DatetimeIndex:
    return pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]


def _prophet_holiday_frame(start, end, freq: str) -> Optional[pd.DataFrame]:
    """Build a Prophet `holidays` DataFrame from the calendar spanning
    [start, end]. Returns columns ['holiday', 'ds'] (Prophet's expected shape)
    or None when the `holidays` library is unavailable / empty.

    Why this matters: the Volatile/Stable *High* segments are event-driven
    (Diwali, Holi, launches, mega-sales). Without holiday regressors Prophet
    can only fit trend + yearly seasonality and is blind to the very spikes
    that define those segments — the single biggest source of error there.

    For monthly data each festival is snapped to its month-start so the effect
    aligns with the monthly observation that contains it. Major festivals get
    their own group so Prophet can size their effect separately from minor
    public holidays.
    """
    try:
        import holidays as _hol_lib  # type: ignore
    except Exception:
        return None
    try:
        years = list(range(pd.Timestamp(start).year, pd.Timestamp(end).year + 1))
        cal = _hol_lib.country_holidays('IN', years=years)
        monthly = freq in ('MS', 'M')
        majors = ('diwali', 'deepavali', 'holi', 'dussehra', 'dasara', 'dasR',
                  'navratri', 'navaratri', 'eid', 'christmas', 'pongal', 'onam',
                  'raksha', 'ganesh', 'janmashtami', 'makar', 'sankranti', 'ugadi')
        rows = []
        for d, name in cal.items():
            ts = pd.Timestamp(d)
            ds = ts.replace(day=1) if monthly else ts
            nm = str(name).lower()
            label = 'major_festival' if any(k in nm for k in majors) else 'public_holiday'
            rows.append((label, ds))
        if not rows:
            return None
        return pd.DataFrame(rows, columns=['holiday', 'ds']).drop_duplicates()
    except Exception:
        return None


def forecast_prophet(history: pd.Series, h: int, freq: str) -> pd.Series:
    """Meta's Prophet — additive trend + seasonality + holidays.
    Falls back to Holt-Winters if `prophet` isn't installed.

    Event-aware (Lever 1): we feed a holiday/festival regressor frame derived
    from the date span and scale `changepoint_prior_scale` with the series'
    own volatility, so spiky/event-driven SKUs (Volatile High) get a far more
    reactive trend while stable SKUs stay smooth.
    """
    try:
        from prophet import Prophet  # type: ignore
    except Exception:
        return forecast_holt_winters(history, h, freq)
    try:
        d = pd.DataFrame({'ds': history.index, 'y': history.values})
        # Adaptive trend flexibility: the higher the coefficient of variation,
        # the more changepoints Prophet is allowed to fit (default 0.05 is far
        # too rigid for event-driven demand). Capped to avoid overfitting.
        vals = np.asarray(history.values, dtype=float)
        _mean = float(np.mean(vals)) if len(vals) else 0.0
        _cv = float(np.std(vals) / _mean) if _mean > 0 else 0.0
        cps = 0.5 if _cv > 1.0 else (0.2 if _cv > 0.5 else 0.05)
        # Holiday/event regressors derived from the calendar over the full
        # history + forecast horizon.
        try:
            _span_end = _future_index(history, h, freq)[-1]
            hol_df = _prophet_holiday_frame(history.index.min(), _span_end, freq)
        except Exception:
            hol_df = None
        _kw = dict(yearly_seasonality=True, weekly_seasonality=False,
                   daily_seasonality=False, changepoint_prior_scale=cps,
                   seasonality_prior_scale=10.0)
        if hol_df is not None and len(hol_df):
            _kw['holidays'] = hol_df
            _kw['holidays_prior_scale'] = 15.0
        m = Prophet(**_kw)
        m.fit(d)
        fut = m.make_future_dataframe(periods=h, freq=freq, include_history=False)
        out = m.predict(fut)['yhat'].clip(lower=0).values
        return pd.Series(out, index=_future_index(history, h, freq))
    except Exception:
        return forecast_holt_winters(history, h, freq)


def forecast_autoarima(history: pd.Series, h: int, freq: str) -> pd.Series:
    """pmdarima auto_arima — searches (p,d,q)(P,D,Q) automatically.
    Falls back to Holt-Winters if pmdarima isn't installed.
    """
    try:
        import pmdarima as pm  # type: ignore
    except Exception:
        return forecast_holt_winters(history, h, freq)
    seasonal_m = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)
    try:
        seasonal = seasonal_m > 1 and len(history) >= 2 * seasonal_m
        model = pm.auto_arima(history.values, seasonal=seasonal,
                              m=seasonal_m if seasonal else 1,
                              suppress_warnings=True, error_action='ignore',
                              stepwise=True, max_p=3, max_q=3, max_P=2, max_Q=2)
        preds = np.clip(model.predict(n_periods=h), 0, None)
        return pd.Series(preds, index=_future_index(history, h, freq))
    except Exception:
        return forecast_holt_winters(history, h, freq)


def forecast_tsb(history: pd.Series, h: int, freq: str) -> pd.Series:
    """Teunter-Syntetos-Babai (existing `tsb` function wrapped to series API)."""
    try:
        arr = tsb(history.values, alpha=0.1, beta=0.1, h=h)
        return pd.Series(arr, index=_future_index(history, h, freq))
    except Exception:
        return forecast_holt_winters(history, h, freq)


def forecast_naive_seasonal(history: pd.Series, h: int, freq: str) -> pd.Series:
    """Last-year-same-period naive — the no-skill benchmark."""
    seasonal = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)
    idx = _future_index(history, h, freq)
    try:
        if len(history) >= seasonal:
            # Repeat the last `seasonal` observations, sliced to h
            tail = history.iloc[-seasonal:].values
            preds = np.tile(tail, int(np.ceil(h / seasonal)))[:h]
        else:
            preds = np.full(h, float(history.iloc[-1] if len(history) else 0.0))
        return pd.Series(np.clip(preds, 0, None), index=idx)
    except Exception:
        return pd.Series([float(history.mean()) if len(history) else 0.0] * h, index=idx)


def forecast_theta(history: pd.Series, h: int, freq: str) -> pd.Series:
    """Theta method — M3-competition winning decomposition.
    Uses statsmodels' ThetaModel when available, else falls back to HW.
    """
    try:
        from statsmodels.tsa.forecasting.theta import ThetaModel  # type: ignore
    except Exception:
        return forecast_holt_winters(history, h, freq)
    try:
        seasonal = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)
        period = seasonal if (seasonal > 1 and len(history) >= 2 * seasonal) else None
        tm = ThetaModel(history, period=period).fit()
        out = np.clip(tm.forecast(h).values, 0, None)
        return pd.Series(out, index=_future_index(history, h, freq))
    except Exception:
        return forecast_holt_winters(history, h, freq)


# Maps additional-algo keys → univariate forecast function. Each fn signature
# is (history: pd.Series, h: int, freq: str) → pd.Series. Used both as
# "extra benchmark" runners and as alternative primaries via segment overrides.
ADDITIONAL_FORECASTERS = {
    'prophet':        forecast_prophet,
    'autoarima':      forecast_autoarima,
    'holt_winters':   forecast_holt_winters,
    'tsb':            forecast_tsb,
    'naive_seasonal': forecast_naive_seasonal,
    'theta':          forecast_theta,
}


# =================================================================
# PHASE 2 ENHANCEMENTS — CatBoost · XGB-style Quantile · Neural Elasticity
# Optional advanced models (see phase2_enhancements.py). They are wired into
# the SAME (history, h, freq) -> pd.Series contract as the other additional
# forecasters via the adapters below, so the routing/candidate-pool machinery
# treats them like any other algorithm. The underlying implementations carry
# heavy optional deps (catboost / scikit-learn QuantileRegressor / TensorFlow);
# the import is guarded and every adapter falls back to Holt-Winters when its
# library is missing or returns nothing, so production never breaks.
# =================================================================
try:
    from phase2_enhancements import (
        forecast_catboost as _p2_catboost,
        forecast_xgb_quantile as _p2_xgb_quantile,
        forecast_neural_elasticity as _p2_neural_elasticity,
    )
    PHASE2_AVAILABLE = True
except Exception as _p2_err:  # pragma: no cover - defensive
    PHASE2_AVAILABLE = False
    _p2_catboost = _p2_xgb_quantile = _p2_neural_elasticity = None
    print(f"[phase2] enhancements unavailable, falling back to core models: {_p2_err}")


def _p2_lag_panel(history: pd.Series) -> pd.DataFrame:
    """Build a minimal lag-feature panel from a univariate history series.

    The Phase-2 models were authored for a multi-column panel (price, promo,
    event flags). When invoked through the univariate additional-forecaster
    contract we only have the sales history, so we synthesise the lag features
    they rely on. Cross-SKU / exogenous signal still flows through the global
    LGBM and Prophet members of each segment blend.
    """
    panel = pd.DataFrame({'date': history.index, 'sales': history.values})
    panel['lag_1'] = panel['sales'].shift(1)
    panel['lag_3'] = panel['sales'].shift(3)
    panel['lag_12'] = panel['sales'].shift(12)
    return panel


def forecast_catboost_uni(history: pd.Series, h: int, freq: str) -> pd.Series:
    """CatBoost adapter — univariate (history, h, freq) -> Series, never None."""
    if _p2_catboost is not None:
        try:
            fc, _ = _p2_catboost(
                _p2_lag_panel(history), 'date', 'sales', h, freq,
                numeric_features=['lag_1', 'lag_3', 'lag_12'],
                categorical_features=[],
            )
            if fc is not None and len(fc) == h:
                return pd.Series(np.clip(fc.values, 0, None),
                                 index=_future_index(history, h, freq))
        except Exception:
            pass
    return forecast_holt_winters(history, h, freq)


def forecast_xgb_quantile_90(history: pd.Series, h: int, freq: str) -> pd.Series:
    """90th-percentile quantile adapter — for risk-aware / safety-stock blends."""
    if _p2_xgb_quantile is not None:
        try:
            fc = _p2_xgb_quantile(history, h, freq, 0.9)
            if fc is not None and len(fc) == h:
                return pd.Series(np.clip(fc.values, 0, None),
                                 index=_future_index(history, h, freq))
        except Exception:
            pass
    return forecast_holt_winters(history, h, freq)


def forecast_neural_elasticity_uni(history: pd.Series, h: int, freq: str) -> pd.Series:
    """Neural-elasticity adapter. Needs a price column; when invoked univariately
    we pass a flat price so the model degrades gracefully (and falls back to
    Holt-Winters whenever TensorFlow is unavailable or history is too short)."""
    if _p2_neural_elasticity is not None:
        try:
            panel = pd.DataFrame({
                'date': history.index,
                'sales': history.values,
                'price': 1.0,
            })
            fc = _p2_neural_elasticity(panel, 'date', 'sales', 'price', h, freq)
            if fc is not None and len(fc) == h:
                return pd.Series(np.clip(fc.values, 0, None),
                                 index=_future_index(history, h, freq))
        except Exception:
            pass
    return forecast_holt_winters(history, h, freq)


if PHASE2_AVAILABLE:
    ADDITIONAL_FORECASTERS.update({
        'catboost':          forecast_catboost_uni,
        'xgb_quantile_90':   forecast_xgb_quantile_90,
        'neural_elasticity': forecast_neural_elasticity_uni,
    })


# =================================================================
# MIXTURE OF EXPERTS (MoE) â additive decomposition forecaster
# Four specialist experts each model ONE additive component of demand:
#   â¢ Trend       â Holt damped-trend (carries the level + direction)
#   â¢ Seasonality â period-of-cycle mean deviations from the de-trended series
#   â¢ Event       â Ridge on evt_* / holiday flags (planner + calendar events)
#   â¢ Exogenous   â Ridge on price / promo / user-exog numeric drivers
# A validation-optimised gate learns one non-negative weight per expert
# (NNLS on a held-out slice, minimising WMAPE), so the final forecast is
#   forecast(t) = Î£_e  w_e Â· component_e(t).
# This is the "compete everywhere" design: registered as the `moe` strategy,
# it only becomes a SKU's forecast when it wins champion selection.
# Robust by construction â every expert and the gate fall back gracefully,
# and on any failure the whole thing degrades to Holt-Winters.
# =================================================================

_MOE_SEASONAL_PERIOD = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4, 'YS': 1}


def _moe_season_key(idx: pd.DatetimeIndex, freq: str) -> np.ndarray:
    """Position-within-cycle key used to build seasonal indices.
    Monthly â month (1â12); weekly â ISO week; daily â day-of-week;
    quarterly â quarter; yearly â constant (no sub-year seasonality)."""
    di = pd.DatetimeIndex(idx)
    f = (freq or 'MS').upper()
    if f.startswith('W'):
        return di.isocalendar().week.astype(int).to_numpy()
    if f.startswith('D'):
        return di.dayofweek.to_numpy()
    if f.startswith('Q'):
        return di.quarter.to_numpy()
    if f.startswith('Y'):
        return np.zeros(len(di), dtype=int)
    return di.month.to_numpy()


def _moe_trend_expert(fit_hist: pd.Series, hh: int, freq: str
                      ) -> Tuple[pd.Series, pd.Series]:
    """Holt damped-trend expert. Returns (in-sample fit, horizon component).
    Always carries the level, so it doubles as the base term. Falls back to a
    flat recent-mean line so the MoE never loses its level if Holt fails."""
    fut_idx = _future_index(fit_hist, hh, freq)
    try:
        hm = Holt(fit_hist.astype(float), damped_trend=True,
                  initialization_method='estimated').fit()
        fit = pd.Series(np.asarray(hm.fittedvalues, dtype=float),
                        index=fit_hist.index)
        fut = pd.Series(np.asarray(hm.forecast(hh), dtype=float), index=fut_idx)
        return fit, fut
    except Exception:
        lvl = float(fit_hist.iloc[-min(3, len(fit_hist)):].mean())
        return (pd.Series(lvl, index=fit_hist.index),
                pd.Series(lvl, index=fut_idx))


def _moe_seasonal_expert(detrended: pd.Series, hh: int, freq: str
                         ) -> Tuple[pd.Series, pd.Series]:
    """Seasonal deviations from the de-trended series, projected by cycle
    position. Zero component when there isn't â¥2 full cycles of history."""
    fut_idx = _future_index(detrended, hh, freq)
    m = _MOE_SEASONAL_PERIOD.get(freq, 12)
    if m <= 1 or len(detrended) < 2 * m:
        return (pd.Series(0.0, index=detrended.index),
                pd.Series(0.0, index=fut_idx))
    try:
        keys = _moe_season_key(detrended.index, freq)
        dev = pd.Series(detrended.values, index=keys)
        season_map = dev.groupby(level=0).mean()
        # Centre so seasonality is a pure deviation (level lives in the trend).
        season_map = season_map - float(season_map.mean())
        fit = pd.Series([season_map.get(k, 0.0) for k in keys],
                        index=detrended.index)
        fut_keys = _moe_season_key(fut_idx, freq)
        fut = pd.Series([season_map.get(k, 0.0) for k in fut_keys], index=fut_idx)
        return fit.astype(float), fut.astype(float)
    except Exception:
        return (pd.Series(0.0, index=detrended.index),
                pd.Series(0.0, index=fut_idx))


def _moe_ridge_expert(residual: pd.Series, exog_fit: Optional[pd.DataFrame],
                      exog_future: Optional[pd.DataFrame], fut_idx: pd.DatetimeIndex,
                      standardize: bool) -> Tuple[pd.Series, pd.Series]:
    """Ridge regression of `residual` on the supplied exog columns. Returns
    (in-sample fit, horizon component), both 0 when no usable signal. Intercept
    is disabled so the component is purely driver-attributable (the level lives
    in the trend expert). When `standardize`, columns are z-scored and the same
    transform is applied to the future frame (mirrors the SARIMAX exog hygiene)."""
    zero_fit = pd.Series(0.0, index=residual.index)
    zero_fut = pd.Series(0.0, index=fut_idx)
    if (exog_fit is None or exog_fit.empty or exog_future is None
            or exog_future.empty):
        return zero_fit, zero_fut
    try:
        from sklearn.linear_model import Ridge  # type: ignore
    except Exception:
        return zero_fit, zero_fut
    try:
        X = exog_fit.reindex(residual.index).select_dtypes(include=[np.number]).fillna(0.0)
        # Drop zero-variance columns (pure noise to the regressor).
        X = X.loc[:, X.std() > 1e-9]
        if X.shape[1] == 0:
            return zero_fit, zero_fut
        # Deduplicate highly-correlated columns (keep the first of each pair).
        if X.shape[1] > 1:
            corr = X.corr().abs()
            drop, cols = [], list(X.columns)
            for i, c1 in enumerate(cols):
                if c1 in drop:
                    continue
                for c2 in cols[i + 1:]:
                    if c2 not in drop and corr.loc[c1, c2] > 0.85:
                        drop.append(c2)
            if drop:
                X = X.drop(columns=drop)
        means = X.mean() if standardize else None
        stds = X.std().replace(0, 1.0) if standardize else None
        Xz = (X - means) / stds if standardize else X
        Xf = exog_future.reindex(columns=X.columns, fill_value=0.0).astype(float)
        if Xf.isna().any().any():
            Xf = Xf.fillna(0.0)
        Xfz = (Xf - means) / stds if standardize else Xf
        model = Ridge(alpha=1.0, fit_intercept=False)
        model.fit(Xz.values, residual.reindex(X.index).fillna(0.0).values)
        fit = pd.Series(model.predict(Xz.values), index=X.index).reindex(
            residual.index).fillna(0.0)
        fut = pd.Series(model.predict(Xfz.values), index=Xf.index).reindex(
            fut_idx).fillna(0.0)
        return fit.astype(float), fut.astype(float)
    except Exception:
        return zero_fit, zero_fut


# Exog columns the MoE's exogenous expert draws on (same family the SARIMAX
# path uses). Event/holiday columns are routed to the event expert instead.
_MOE_BASE_EXOG = ['log_price', 'price_changed', 'price_change_pct', 'festive',
                  'other_imp_festivals', 'peak_month', 'scheme_days', 'weekends',
                  'days_in_month', 'weekends_in_month',
                  'num_special_festivals', 'num_other_holidays',
                  'seasonality_multiplier']


def _moe_is_event_col(col: str) -> bool:
    cl = col.lower()
    return col.startswith('evt_') or 'holiday' in cl or 'festiv' in cl


def forecast_moe(history: pd.Series, h: int, freq: str,
                 sku_panel: Optional[pd.DataFrame] = None,
                 date_col: str = 'date', sku_col: str = 'sku',
                 cfg: Optional[dict] = None,
                 profile_row: Optional[dict] = None,
                 ) -> Tuple[pd.Series, Optional[pd.DataFrame], str, Any]:
    """Mixture-of-Experts forecast. Returns (forecast, ci, notes, backtest_fn)
    to match the `_run_strategy_forecast` contract. Experts: trend, seasonality,
    event, exogenous; gate weights fit by NNLS on a held-out validation slice."""
    if history is None or len(history) < 8:
        fc = forecast_holt_winters(history, h, freq)
        return fc, None, 'MoE: history too short â Holt-Winters fallback', \
               (lambda tr, hh: forecast_holt_winters(tr, hh, freq))

    # ---- Resolve the exog matrix once from the SKU panel (event + driver cols) ----
    user_exog = list((cfg or {}).get('exog_user_numeric') or [])
    exog_full: Optional[pd.DataFrame] = None
    if sku_panel is not None and date_col in sku_panel.columns:
        event_cols = [c for c in sku_panel.columns if c.startswith('evt_')]
        want = list(dict.fromkeys(_MOE_BASE_EXOG + user_exog + event_cols))
        have = [c for c in want if c in sku_panel.columns]
        if have:
            exog_full = sku_panel.set_index(date_col)[have]
            if exog_full.index.duplicated().any():
                exog_full = exog_full.groupby(level=0).mean().sort_index()
    sku_attrs = {
        'category': (sku_panel['category'].iloc[0]
                     if sku_panel is not None and 'category' in sku_panel.columns
                     and len(sku_panel) else None),
        'brand': (profile_row or {}).get('brand'),
        'segment': (profile_row or {}).get('segment'),
    }
    events = (cfg or {}).get('future_events')
    strat_map = (cfg or {}).get('exog_future_strategy') or {}
    hc = (cfg or {}).get('holiday_country', 'IN')

    def _components(fit_hist: pd.Series, hh: int) -> Dict[str, pd.Series]:
        """Return {expert: horizon_component} of length hh for one fit window."""
        fut_idx = _future_index(fit_hist, hh, freq)
        trend_fit, trend_fut = _moe_trend_expert(fit_hist, hh, freq)
        detrended = (fit_hist - trend_fit.reindex(fit_hist.index)).fillna(0.0)
        seas_fit, seas_fut = _moe_seasonal_expert(detrended, hh, freq)
        resid1 = (detrended - seas_fit.reindex(fit_hist.index)).fillna(0.0)

        # Build the future exog frame (leak-free, consistent with SARIMAX path).
        exog_fit = exog_future = None
        if exog_full is not None:
            exog_fit = exog_full.loc[exog_full.index <= fit_hist.index[-1]]
            if not exog_fit.empty:
                try:
                    exog_future = build_future_exog(
                        exog_fit, hh, freq, future_events=events,
                        sku_attrs=sku_attrs, sku_col=sku_col,
                        user_strategies=strat_map, holiday_country=hc)
                except Exception:
                    exog_future = None
        ev_cols = ([c for c in exog_fit.columns if _moe_is_event_col(c)]
                   if exog_fit is not None else [])
        dr_cols = ([c for c in exog_fit.columns if not _moe_is_event_col(c)]
                   if exog_fit is not None else [])

        event_fit, event_fut = _moe_ridge_expert(
            resid1, exog_fit[ev_cols] if ev_cols else None,
            exog_future[ev_cols] if (exog_future is not None and ev_cols) else None,
            fut_idx, standardize=False)
        resid2 = (resid1 - event_fit.reindex(fit_hist.index)).fillna(0.0)
        exog_fit_c, exog_fut = _moe_ridge_expert(
            resid2, exog_fit[dr_cols] if dr_cols else None,
            exog_future[dr_cols] if (exog_future is not None and dr_cols) else None,
            fut_idx, standardize=True)
        return {'trend': trend_fut, 'seasonal': seas_fut,
                'event': event_fut, 'exog': exog_fut}

    _ORDER = ['trend', 'seasonal', 'event', 'exog']

    def _run(train_hist: pd.Series, hh: int) -> pd.Series:
        """Full expert-fit â gate-fit â combine, for one history window."""
        try:
            n = len(train_hist)
            val_h = max(1, min(hh, n // 4))
            weights = {'trend': 1.0, 'seasonal': 1.0, 'event': 1.0, 'exog': 1.0}
            # ---- Gate: NNLS on a held-out validation slice ----
            if n - val_h >= 4:
                comps_val = _components(train_hist.iloc[:-val_h], val_h)
                y_val = train_hist.iloc[-val_h:].astype(float).values
                idx_val = train_hist.index[-val_h:]
                M = np.column_stack([
                    comps_val[k].reindex(idx_val).fillna(0.0).values
                    for k in _ORDER])
                w = None
                try:
                    from scipy.optimize import nnls  # type: ignore
                    w = nnls(M, y_val)[0]
                except Exception:
                    # Inverse-error fallback: weight each expert by 1/(WMAPE+1).
                    denom = float(np.abs(y_val).sum()) or 1.0
                    invs = []
                    for j in range(M.shape[1]):
                        err = float(np.abs(y_val - M[:, j]).sum()) / denom
                        invs.append(1.0 / (err + 1.0))
                    s = sum(invs) or 1.0
                    w = np.array([v / s for v in invs])
                if w is not None and np.isfinite(w).all():
                    w = np.clip(w, 0.0, 2.0)
                    if w.sum() > 1e-9:
                        weights = {k: float(w[i]) for i, k in enumerate(_ORDER)}
            # ---- Refit on the full window and combine ----
            comps = _components(train_hist, hh)
            fut_idx = _future_index(train_hist, hh, freq)
            total = np.zeros(hh, dtype=float)
            for k in _ORDER:
                total = total + weights[k] * comps[k].reindex(fut_idx).fillna(0.0).values
            out = pd.Series(np.clip(total, 0, None), index=fut_idx)
            # Sanity guard (mirror SARIMAX): runaway forecast â seasonal naive.
            hist_max = float(train_hist.max())
            if hist_max > 0 and float(out.max()) > 5 * hist_max:
                m = _MOE_SEASONAL_PERIOD.get(freq, 12)
                return _seasonal_naive_forecast(train_hist, hh, freq, m)
            out.attrs['moe_weights'] = weights
            return out
        except Exception:
            return forecast_holt_winters(train_hist, hh, freq)

    forecast = _run(history, h)
    w = forecast.attrs.get('moe_weights', {}) if hasattr(forecast, 'attrs') else {}
    if w:
        notes = ("MoE: " + " Â· ".join(f"{k} {w.get(k, 0):.2f}" for k in _ORDER)
                 + " (validation-optimised gate)")
    else:
        notes = 'MoE: trend + seasonality + event + exog (additive)'
    backtest_fn = lambda tr, hh: _run(tr, hh)
    return forecast, None, notes, backtest_fn


# =================================================================
# DEEP-LEARNING MoE (Keras) â routing-engine adapter
# Wraps the `TimeSeriesMoE` network (trend + Fourier-seasonality + transformer
# experts, softmax gating) ported from app_96.py into the same strategy
# contract as forecast_moe. Multivariate: the network sees the sales target
# plus the SKU's price/promo/event exog. HEAVY â only ever runs when the user
# opts in (never in the default candidate pool). Degrades to Holt-Winters when
# TensorFlow is unavailable or history is too short for a 30-step window.
# =================================================================

_DLMOE_INPUT_LEN = 30
_DLMOE_OUTPUT_LEN = 1
_DLMOE_EPOCHS = 20


def forecast_dl_moe(history: pd.Series, h: int, freq: str,
                    sku_panel: Optional[pd.DataFrame] = None,
                    date_col: str = 'date', sku_col: str = 'sku',
                    cfg: Optional[dict] = None,
                    profile_row: Optional[dict] = None,
                    ) -> Tuple[pd.Series, Optional[pd.DataFrame], str, Any]:
    """Deep MoE forecast. Returns (forecast, ci, notes, backtest_fn) to match the
    `_run_strategy_forecast` contract. Falls back to Holt-Winters when TF is
    missing or history < INPUT_LEN+OUTPUT_LEN."""
    _hw = (lambda tr, hh: forecast_holt_winters(tr, hh, freq))
    if tf is None:
        return (forecast_holt_winters(history, h, freq), None,
                'Deep MoE: disabled (set TIMELENS_ENABLE_DL_MOE=1 with a working '
                'TensorFlow) â Holt-Winters fallback', _hw)
    if history is None or len(history) < _DLMOE_INPUT_LEN + _DLMOE_OUTPUT_LEN:
        return (forecast_holt_winters(history, h, freq), None,
                f'Deep MoE: history < {_DLMOE_INPUT_LEN + _DLMOE_OUTPUT_LEN} '
                'points â Holt-Winters fallback', _hw)

    # ---- Resolve the exog matrix once (price/promo/event drivers) ----
    user_exog = list((cfg or {}).get('exog_user_numeric') or [])
    exog_full: Optional[pd.DataFrame] = None
    if sku_panel is not None and date_col in sku_panel.columns:
        event_cols = [c for c in sku_panel.columns if c.startswith('evt_')]
        want = list(dict.fromkeys(_MOE_BASE_EXOG + user_exog + event_cols))
        have = [c for c in want if c in sku_panel.columns]
        if have:
            exog_full = sku_panel.set_index(date_col)[have]
            if exog_full.index.duplicated().any():
                exog_full = exog_full.groupby(level=0).mean().sort_index()
    sku_attrs = {
        'category': (sku_panel['category'].iloc[0]
                     if sku_panel is not None and 'category' in sku_panel.columns
                     and len(sku_panel) else None),
        'brand': (profile_row or {}).get('brand'),
        'segment': (profile_row or {}).get('segment'),
    }
    events = (cfg or {}).get('future_events')
    strat_map = (cfg or {}).get('exog_future_strategy') or {}
    hc = (cfg or {}).get('holiday_country', 'IN')
    seas_period = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4, 'YS': 1}.get(freq, 7)

    def _run(train_hist: pd.Series, hh: int) -> pd.Series:
        try:
            if len(train_hist) < _DLMOE_INPUT_LEN + _DLMOE_OUTPUT_LEN:
                return forecast_holt_winters(train_hist, hh, freq)
            # Assemble the multivariate frame: target column first, then exog.
            target = train_hist.astype(float).to_frame(name='__target__')
            exog_fit = exog_future = None
            if exog_full is not None:
                exog_fit = exog_full.loc[exog_full.index <= train_hist.index[-1]]
                exog_fit = exog_fit.reindex(train_hist.index).ffill().fillna(0.0)
                try:
                    exog_future = build_future_exog(
                        exog_full.loc[exog_full.index <= train_hist.index[-1]],
                        hh, freq, future_events=events, sku_attrs=sku_attrs,
                        sku_col=sku_col, user_strategies=strat_map,
                        holiday_country=hc)
                except Exception:
                    exog_future = None
            if exog_fit is not None and not exog_fit.empty:
                full_df = target.join(exog_fit, how='left').fillna(0.0)
            else:
                full_df = target
            num_features = full_df.shape[1]

            scaler = MinMaxScaler((0, 1))
            scaled = scaler.fit_transform(full_df)
            X_train, y_train = create_sequences(
                scaled, _DLMOE_INPUT_LEN, _DLMOE_OUTPUT_LEN)
            if len(X_train) == 0:
                return forecast_holt_winters(train_hist, hh, freq)

            model = TimeSeriesMoE(input_len=_DLMOE_INPUT_LEN,
                                  output_len=_DLMOE_OUTPUT_LEN,
                                  num_features=num_features,
                                  period=seas_period, k=5)
            model.compile(optimizer=Adam(learning_rate=0.001), loss='mae')
            model.fit(X_train, y_train, epochs=_DLMOE_EPOCHS, batch_size=32,
                      validation_split=0.2 if len(X_train) > 5 else 0.0, verbose=0,
                      callbacks=[tf.keras.callbacks.EarlyStopping(
                          monitor='loss', patience=5, restore_best_weights=True)])

            # Recursive multi-step forecast.
            preds_scaled = []
            seq = scaled[-_DLMOE_INPUT_LEN:].reshape(1, _DLMOE_INPUT_LEN, num_features)
            for i in range(hh):
                nxt = model.predict(seq, verbose=0)
                preds_scaled.append(float(nxt[0, 0]))
                step = np.zeros((1, 1, num_features))
                step[0, 0, 0] = nxt[0, 0]
                if num_features > 1 and exog_future is not None and i < len(exog_future):
                    fx = exog_future.iloc[[i]].reindex(columns=full_df.columns[1:],
                                                       fill_value=0.0)
                    dummy = pd.DataFrame(np.zeros((1, 1)), columns=['__target__'],
                                         index=fx.index)
                    scaled_fx = scaler.transform(pd.concat([dummy, fx], axis=1))[:, 1:]
                    step[0, 0, 1:] = scaled_fx
                seq = np.append(seq[:, 1:, :], step, axis=1)

            inv = np.zeros((len(preds_scaled), num_features))
            inv[:, 0] = preds_scaled
            vals = scaler.inverse_transform(inv)[:, 0]
            fut_idx = _future_index(train_hist, hh, freq)
            return pd.Series(np.clip(vals, 0, None), index=fut_idx)
        except Exception:
            return forecast_holt_winters(train_hist, hh, freq)

    forecast = _run(history, h)
    notes = ('Deep MoE (Keras): trend + Fourier-seasonality + transformer experts '
             'Â· softmax gating')
    backtest_fn = lambda tr, hh: _run(tr, hh)
    return forecast, None, notes, backtest_fn


# =================================================================
# RESIDUAL BOOSTER  (port from app_96.py)
# After a base forecaster has produced its in-sample fit, train an
# XGBoost on the residuals as a function of available exogenous features.
# At forecast time, add the predicted residual back to the base forecast.
# Empirically lifts accuracy 5-15% when there's untapped exog signal.
# =================================================================

def xgb_residual_correction(
    history: pd.Series,
    base_in_sample: pd.Series,
    base_forecast: pd.Series,
    exog_history: Optional[pd.DataFrame] = None,
    exog_future:  Optional[pd.DataFrame] = None,
    min_train: int = 12,
) -> Tuple[pd.Series, str]:
    """Correct `base_forecast` by adding an XGBoost-predicted residual.

    Parameters
    ----------
    history          : actual training values (datetime-indexed Series).
    base_in_sample   : the base model's *in-sample* prediction, aligned to history.
    base_forecast    : the base model's forecast for the horizon.
    exog_history     : optional engineered features for the training window.
    exog_future      : optional engineered features for the forecast window.
    min_train        : skip correction when there are fewer rows than this.

    Returns
    -------
    (corrected_forecast, note)  — note is a string explaining what happened
                                  (suitable for the SKU result `notes` field).
    """
    try:
        import xgboost as xgb  # type: ignore
    except Exception:
        return base_forecast, "xgb_residual: skipped (xgboost not installed)"

    if exog_history is None or exog_future is None or exog_history.empty or exog_future.empty:
        return base_forecast, "xgb_residual: skipped (no exog features supplied)"

    try:
        # Align everything on the date index of `history`
        residuals = (history - base_in_sample).dropna()
        if len(residuals) < min_train:
            return base_forecast, f"xgb_residual: skipped (only {len(residuals)} training rows)"

        Xtr = exog_history.loc[residuals.index].select_dtypes(include=[np.number]).fillna(0)
        if Xtr.shape[1] == 0:
            return base_forecast, "xgb_residual: skipped (no numeric exog features)"
        ytr = residuals.values

        model = xgb.XGBRegressor(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            objective='reg:squarederror', random_state=42, verbosity=0,
            n_jobs=1,
        )
        model.fit(Xtr, ytr)

        Xfut = exog_future.reindex(base_forecast.index).select_dtypes(
            include=[np.number]).fillna(0)
        # Keep only columns the model was trained on (defensive against schema drift)
        Xfut = Xfut.reindex(columns=Xtr.columns, fill_value=0)
        delta = pd.Series(model.predict(Xfut), index=base_forecast.index)
        corrected = (base_forecast + delta).clip(lower=0)
        rel_lift = float(np.mean(np.abs(delta) / np.maximum(base_forecast.abs(), 1e-6)))
        return corrected, f"xgb_residual: applied (~{rel_lift*100:.1f}% avg adjustment)"
    except Exception as _e:
        return base_forecast, f"xgb_residual: skipped ({type(_e).__name__})"


# =================================================================
# DTW PROXY LOOKUP  (port from app_96.py)
# For cold-start / NPI SKUs, find the closest analogue from the existing
# catalogue by Dynamic Time Warping distance on z-normalised series.
# The forecast then borrows the proxy's recent trajectory — much better
# than a naive zero or a chronos zero-shot run on 1-3 months of noise.
# =================================================================

def find_dtw_proxy(
    target_history: pd.Series,
    panel: pd.DataFrame,
    sku_col: str,
    date_col: str,
    sales_col: str,
    target_sku: str,
    min_proxy_len: int = 12,
    max_candidates: int = 60,
) -> Optional[Tuple[str, pd.Series, float]]:
    """Find the best-matching long-history SKU for a cold-start target.

    Returns (proxy_sku, proxy_series, dtw_distance) or None when no
    suitable proxy exists or the DTW library isn't installed.

    Notes
    -----
    * Soft-imports `dtaidistance`; falls back to a vectorised Euclidean
      distance on the overlapping tail so the function always returns
      something useful in production.
    * Both series are z-normalised before distance computation, so the
      match is on *shape* not magnitude. The caller is expected to scale
      the proxy back to the target's mean for the final forecast.
    """
    if target_history is None or len(target_history) == 0:
        return None

    # Build candidate pool: every other SKU with enough history.
    candidates: List[Tuple[str, pd.Series]] = []
    for sku, g in panel.groupby(sku_col):
        if str(sku) == str(target_sku):
            continue
        s = g.sort_values(date_col).set_index(date_col)[sales_col]
        s = pd.to_numeric(s, errors='coerce').dropna()
        if len(s) >= min_proxy_len:
            candidates.append((str(sku), s))
        if len(candidates) >= max_candidates:
            break

    if not candidates:
        return None

    # Try dtaidistance first (handles different-length series natively)
    try:
        from dtaidistance import dtw as _dtw  # type: ignore
        def _dist(a: np.ndarray, b: np.ndarray) -> float:
            a = (a - a.mean()) / (a.std() + 1e-8)
            b = (b - b.mean()) / (b.std() + 1e-8)
            return float(_dtw.distance_fast(a.astype(np.float64), b.astype(np.float64)))
    except Exception:
        def _dist(a: np.ndarray, b: np.ndarray) -> float:
            # Plain euclidean on z-normalised, trimmed-to-overlap arrays.
            n = min(len(a), len(b))
            if n == 0:
                return np.inf
            a, b = a[-n:], b[-n:]
            a = (a - a.mean()) / (a.std() + 1e-8)
            b = (b - b.mean()) / (b.std() + 1e-8)
            return float(np.linalg.norm(a - b))

    t = target_history.values.astype(float)
    best: Optional[Tuple[str, pd.Series, float]] = None
    for sku, s in candidates:
        try:
            d = _dist(t, s.values.astype(float))
            if best is None or d < best[2]:
                best = (sku, s, d)
        except Exception:
            continue
    return best


def find_dtw_lookalikes(
    target_history: pd.Series,
    panel: pd.DataFrame,
    sku_col: str,
    date_col: str,
    sales_col: str,
    target_sku: str,
    top_k: int = 5,
    min_proxy_len: int = 12,
    max_candidates: int = 200,
    same_brand_only: bool = False,
    brand_col: Optional[str] = None,
    target_brand: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return the top-K SKUs whose shape best matches the target.

    Used by the per-SKU interpretation panel for new-product and
    short-history SKUs — surfaces which catalogue SKUs the forecast is
    effectively borrowing from. Distance is z-normalised so the match
    captures pattern (seasonality, ramp, decline) rather than magnitude.

    Each result row: {sku, distance, n_periods, mean_sales, brand?}.
    Lower distance = closer match. The first entry is the primary proxy.
    """
    if target_history is None or len(target_history) == 0:
        return []

    # Build the candidate pool — every *other* SKU with enough history.
    # Optionally restrict to the target's brand for in-family lookalikes.
    candidates: List[Tuple[str, pd.Series, Optional[str]]] = []
    seen = 0
    for sku, g in panel.groupby(sku_col):
        if str(sku) == str(target_sku):
            continue
        if (same_brand_only and brand_col and target_brand
                and brand_col in g.columns):
            cand_brand = g[brand_col].iloc[0] if len(g) else None
            if str(cand_brand) != str(target_brand):
                continue
        s = g.sort_values(date_col).set_index(date_col)[sales_col]
        s = pd.to_numeric(s, errors='coerce').dropna()
        if len(s) >= min_proxy_len:
            cand_brand = (g[brand_col].iloc[0] if brand_col and brand_col in g.columns
                          and len(g) else None)
            candidates.append((str(sku), s, str(cand_brand) if cand_brand is not None else None))
            seen += 1
        if seen >= max_candidates:
            break

    if not candidates:
        return []

    try:
        from dtaidistance import dtw as _dtw  # type: ignore

        def _dist(a: np.ndarray, b: np.ndarray) -> float:
            a = (a - a.mean()) / (a.std() + 1e-8)
            b = (b - b.mean()) / (b.std() + 1e-8)
            return float(_dtw.distance_fast(a.astype(np.float64),
                                            b.astype(np.float64)))
    except Exception:
        def _dist(a: np.ndarray, b: np.ndarray) -> float:
            # Plain euclidean on z-normalised, trimmed-to-overlap arrays.
            n = min(len(a), len(b))
            if n == 0:
                return np.inf
            a, b = a[-n:], b[-n:]
            a = (a - a.mean()) / (a.std() + 1e-8)
            b = (b - b.mean()) / (b.std() + 1e-8)
            return float(np.linalg.norm(a - b))

    t = target_history.values.astype(float)
    scored: List[Dict[str, Any]] = []
    for sku, s, cand_brand in candidates:
        try:
            d = _dist(t, s.values.astype(float))
            scored.append({
                'sku': sku,
                'distance': d,
                'n_periods': int(len(s)),
                'mean_sales': float(s.mean()),
                'brand': cand_brand,
                # Last-12-period shape — used by the UI to render a sparkline.
                'tail_series': s.iloc[-min(12, len(s)):].copy(),
            })
        except Exception:
            continue

    scored.sort(key=lambda r: r['distance'])
    return scored[:top_k]


# =================================================================
# PIPELINE STAGE 1 — RUN-ALL-PICK-BEST CHAMPION SELECTION
# After the candidate pool is built (primary + segment blend members +
# defaults), every member is scored on the holdout; the lowest-WMAPE
# candidate becomes the actual forecast. The auto-routed primary is
# *no longer trusted blindly* — it has to win on out-of-sample data.
# This is the "ensemble competition" pattern from app_96 brought into
# the segment-aware routing engine.
# =================================================================

# ─────────────────────────────────────────────────────────────────────
# HYPERPARAMETER FINE-TUNING (runs on the champion after Stage 1)
# Tunable model families and their parameter grids:
#   • holt_winters         → {trend, seasonal, damped} grid
#   • local_sarimax_promo  → {(p,d,q), (P,D,Q,m)} small grid
# Other strategies (chronos, croston, naive, theta, global_lgbm,
# autoarima — which is already self-tuning) pass through unchanged.
#
# The tuner picks the param set with the LOWEST validation WMAPE on a
# holdout slice (the same slice used by the champion selector, to keep
# tuning honest), refits with the winning params on FULL history, and
# returns (refined_forecast, refined_backtest_fn, refined_val_mape).
# ─────────────────────────────────────────────────────────────────────

def _safe_mape(actual: pd.Series, pred: pd.Series) -> Optional[float]:
    """Tuning-internal WMAPE — returns None if all actuals are zero or
    arrays mis-align. Used so a single bad config doesn't crash the
    grid search.

    Returns WMAPE as a **percentage** (matching _compute_mape_smape and
    every other WMAPE-producer in this file). Caller can compare numbers
    from this function to numbers from backtest_holdout / champion
    selection without any unit conversion.
    """
    try:
        a = actual.astype(float).values
        p = np.asarray(pred, dtype=float)
        n = min(len(a), len(p))
        a, p = a[:n], p[:n]
        denom = float(np.abs(a).sum())
        if denom == 0:
            return None
        # Weighted WMAPE: sum|a-p| / sum|a|. ×100 so the return is in % units —
        # same units as _compute_mape_smape.
        return float(np.abs(a - p).sum() / denom * 100)
    except Exception:
        return None


def fine_tune_winner(
    strategy: str,
    history: pd.Series,
    h: int,
    freq: str,
    val_h: int,
    sku_panel: Optional[pd.DataFrame] = None,
    date_col: Optional[str] = None,
) -> Tuple[Optional[pd.Series], Optional[Any], Optional[float], str]:
    """Grid-search the winner's hyperparameters on the validation slice.

    Returns (tuned_forecast, tuned_backtest_fn, tuned_val_mape, note).
    Returns (None, None, None, "tuning: not supported ...") for strategies
    without a registered grid — caller should keep the un-tuned forecast.

    Validation slice: the LAST `val_h` periods of history. Same window
    used by the champion selector — this is intentional, because the
    headline reporting backtest uses a STRICTLY EARLIER slice (carved
    out by the leakage shield in pick_champion_by_holdout), so tuning
    on the champion-val slice doesn't contaminate the reported metric.
    """
    # Guard rails: need at least 2*val_h + 1 for a clean train/val split
    if val_h < 1 or len(history) < 2 * val_h + 1:
        return None, None, None, f"tuning: history too short ({len(history)} mo, need ≥{2 * val_h + 1})"

    train = history.iloc[:-val_h]
    val = history.iloc[-val_h:]
    seasonal_p = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)

    # ──────────────────────────────────────────────────────────────
    # HOLT-WINTERS grid
    # ──────────────────────────────────────────────────────────────
    if strategy == 'holt_winters':
        grid = [
            {'trend': None, 'seasonal': None, 'damped': False},
            {'trend': 'add', 'seasonal': None, 'damped': False},
            {'trend': 'add', 'seasonal': None, 'damped': True},
            {'trend': 'add', 'seasonal': 'add', 'damped': False},
            {'trend': 'add', 'seasonal': 'add', 'damped': True},
            {'trend': 'add', 'seasonal': 'mul', 'damped': False},
            {'trend': 'mul', 'seasonal': 'mul', 'damped': False},
        ]
        can_seasonal = seasonal_p > 1 and len(train) >= 2 * seasonal_p
        best: Tuple[Optional[dict], float] = (None, float('inf'))
        for params in grid:
            if params['seasonal'] is not None and not can_seasonal:
                continue
            try:
                kw: Dict[str, Any] = {'initialization_method': 'estimated'}
                if params['trend']:
                    kw['trend'] = params['trend']
                    if params['damped']:
                        kw['damped_trend'] = True
                if params['seasonal']:
                    kw['seasonal'] = params['seasonal']
                    kw['seasonal_periods'] = seasonal_p
                m = ExponentialSmoothing(train, **kw).fit()
                pred = m.forecast(val_h).clip(lower=0)
                mape = _safe_mape(val, pred)
                if mape is not None and mape < best[1]:
                    best = (params, mape)
            except Exception:
                continue
        if best[0] is None:
            return None, None, None, "tuning: HW grid search failed"
        best_params, best_mape = best

        # Refit on FULL history with best params, produce future forecast + bt_fn
        def _hw_apply(series: pd.Series, hh: int, _p=best_params, _sp=seasonal_p):
            try:
                kw: Dict[str, Any] = {'initialization_method': 'estimated'}
                if _p['trend']:
                    kw['trend'] = _p['trend']
                    if _p['damped']:
                        kw['damped_trend'] = True
                if _p['seasonal'] and _sp > 1 and len(series) >= 2 * _sp:
                    kw['seasonal'] = _p['seasonal']
                    kw['seasonal_periods'] = _sp
                m = ExponentialSmoothing(series, **kw).fit()
                idx = pd.date_range(series.index[-1], periods=hh + 1, freq=freq)[1:]
                return pd.Series(m.forecast(hh).clip(lower=0).values, index=idx)
            except Exception:
                return forecast_holt_winters(series, hh, freq)

        future_fc = _hw_apply(history, h)
        return (future_fc, _hw_apply, best_mape,
                f"tuning: HW grid → trend={best_params['trend']}, "
                f"seasonal={best_params['seasonal']}, "
                f"damped={best_params['damped']} (val_WMAPE {best_mape:.1f}%)")

    # ──────────────────────────────────────────────────────────────
    # SARIMAX grid (no-exog variant — keep this tuning fast)
    # If the caller wants exog-aware tuning, it has to re-run the
    # original forecast_sarimax_with_promo path; we tune only the
    # ARIMA orders here, which dominates the fit quality.
    # ──────────────────────────────────────────────────────────────
    if strategy == 'local_sarimax_promo':
        grid = [
            ((1, 1, 1), (1, 1, 0)),
            ((0, 1, 1), (0, 1, 1)),
            ((1, 1, 0), (0, 1, 1)),
            ((2, 1, 2), (1, 1, 1)),
            ((1, 0, 1), (1, 0, 1)),
            ((0, 1, 2), (1, 1, 0)),
        ]
        best_ord: Tuple[Optional[Tuple], float] = (None, float('inf'))
        for order, sorder in grid:
            try:
                full_sorder = (*sorder, seasonal_p)
                m = SARIMAX(train, order=order, seasonal_order=full_sorder,
                            enforce_stationarity=False,
                            enforce_invertibility=False).fit(disp=False)
                pred = m.get_forecast(steps=val_h).predicted_mean.clip(lower=0)
                mape = _safe_mape(val, pred)
                if mape is not None and mape < best_ord[1]:
                    best_ord = ((order, sorder), mape)
            except Exception:
                continue
        if best_ord[0] is None:
            return None, None, None, "tuning: SARIMAX grid search failed"
        (best_order, best_sorder), best_mape = best_ord

        def _sx_apply(series: pd.Series, hh: int,
                      _o=best_order, _so=best_sorder, _sp=seasonal_p):
            try:
                m = SARIMAX(series, order=_o, seasonal_order=(*_so, _sp),
                            enforce_stationarity=False,
                            enforce_invertibility=False).fit(disp=False)
                idx = pd.date_range(series.index[-1], periods=hh + 1, freq=freq)[1:]
                return pd.Series(m.get_forecast(steps=hh).predicted_mean.clip(lower=0).values,
                                 index=idx)
            except Exception:
                return forecast_holt_winters(series, hh, freq)

        future_fc = _sx_apply(history, h)
        return (future_fc, _sx_apply, best_mape,
                f"tuning: SARIMAX grid → order={best_order}, "
                f"seasonal_order=({best_sorder[0]},{best_sorder[1]},{best_sorder[2]},{seasonal_p}) "
                f"(val_WMAPE {best_mape:.1f}%)")

    # Untunable strategies — caller keeps original forecast
    return None, None, None, f"tuning: not supported for '{strategy}' (passes through)"


def pick_champion_by_holdout(
    history: pd.Series,
    candidate_fns: Dict[str, Tuple[Any, pd.Series]],
    eval_h: int,
    primary_strategy: str,
    tie_band: float = 0.02,
    validation_offset: int = 0,
) -> Tuple[str, Dict[str, Dict[str, Any]], str]:
    """Score every candidate on a held-out validation slice; return the
    winner, the per-strategy metric dict, and a human-readable note.

    Tie-handling: if the second-best candidate is within `tie_band` (relative
    WMAPE difference) of the winner, we keep the *primary* (auto-routed
    architecture pick) on the grounds that it's the segment's structurally
    correct choice and tiny holdout-WMAPE gaps are mostly noise.

    Leakage shield (`validation_offset`)
    ------------------------------------
    The headline test WMAPE downstream is reported on the LAST `eval_h`
    periods of history. If we pick the champion on the same slice, the
    reported WMAPE is biased downward (we cherry-picked the model that
    aced that exact month). Setting `validation_offset = eval_h` shifts
    the champion's evaluation slice ONE eval_h step back — the selection
    happens on `history[-2*eval_h : -eval_h]` and the reporting backtest
    later uses `history[-eval_h:]`. Strictly disjoint → no leakage.

    Falls back to `validation_offset = 0` (legacy behaviour) only when
    history is too short to reserve a separate slice.
    """
    # ── Leakage shield: carve out the reporting window before scoring ──
    if (validation_offset > 0
            and len(history) > eval_h + validation_offset + 1):
        history_eval = history.iloc[:-validation_offset]
        shield_active = True
    else:
        history_eval = history
        shield_active = False

    # PERF: Parallel evaluation of candidates for speedup on medium-to-large pools
    metrics = _evaluate_all_candidates_parallel(history_eval, candidate_fns, test_h=eval_h)
    ranked = [(s, m) for s, m in metrics.items() if m.get('test_mape') is not None]
    if not ranked:
        return primary_strategy, metrics, 'champion: kept primary (no candidate produced finite WMAPE)'

    ranked.sort(key=lambda kv: (
        kv[1]['test_mape'],
        kv[1]['test_smape'] if kv[1].get('test_smape') is not None else float('inf'),
        kv[0],
    ))
    winner, winner_metrics = ranked[0]
    winner_mape = winner_metrics['test_mape']

    # Tie-band check — if primary is in the ranked list and within tie_band
    # of the winner, prefer the primary (segment recipe wins ties).
    primary_metrics = metrics.get(primary_strategy, {})
    primary_mape = primary_metrics.get('test_mape')
    if (primary_mape is not None and winner != primary_strategy
            and winner_mape is not None
            and (primary_mape - winner_mape) / max(winner_mape, 1e-6) <= tie_band):
        return (primary_strategy, metrics,
                f"champion: kept primary ({primary_strategy}) — winner "
                f"{winner} within {tie_band*100:.0f}% tie band")

    if winner != primary_strategy:
        note = (f"champion: picked {winner} (val_WMAPE {winner_mape:.1f}%) "
                f"over primary {primary_strategy}")
        if primary_mape is not None:
            note += f" (primary_val_WMAPE {primary_mape:.1f}%)"
    else:
        note = f"champion: primary {primary_strategy} won by validation WMAPE"
    if shield_active:
        note += f" [leakage-shield: val slice offset {validation_offset}]"
    return winner, metrics, note


# =================================================================
# PIPELINE STAGE 1c — WEIGHTED ENSEMBLE  (Levers 3 & 5)
# Instead of winner-takes-all, combine the top-k candidates into one forecast.
# For high-variance segments (Volatile High/Mid) averaging is the single best
# variance reducer and stops the champion flip-flopping month to month.
#   • Lever 3: real weighted blend (weighted_mean / median per segment recipe).
#   • Lever 5: members are ranked AND weighted by a SPIKE-ROBUST score (SMAPE
#     first — bounded 0..200, well-behaved on spikes/near-zeros — then WMAPE),
#     so the exploding-WMAPE problem on event months no longer distorts which
#     models drive the final forecast.
# =================================================================
ENABLE_WEIGHTED_BLEND = True
BLEND_TOP_K = 3
# Cheap pre-filter: don't even attempt the (more expensive) blend comparison on
# SKUs a single model already forecasts very well — the ensemble's payoff is on
# error-prone SKUs. Low bar so we never miss a real win; the robust k-fold
# comparison below makes the actual adopt/reject decision.
BLEND_MIN_VAL_WMAPE = 10.0
# Folds used to compare champion-vs-blend. A single validation slice is too
# noisy on volatile series (it both adopts blends that only looked good once
# and rejects blends that are genuinely better); averaging over k folds makes
# the decision robust so we keep the big wins without the low-error regressions.
BLEND_DECISION_FOLDS = 3


def _robust_member_score(m: dict) -> Optional[float]:
    """Bounded, spike-robust error score for ranking/weighting blend members.
    Prefers SMAPE; falls back to WMAPE; None when neither is finite."""
    s = m.get('test_smape')
    if s is not None and np.isfinite(s):
        return float(s)
    mp = m.get('test_mape')
    if mp is not None and np.isfinite(mp):
        return float(mp)
    return None


def build_weighted_blend(
    candidate_fns: Dict[str, Tuple[Any, pd.Series]],
    val_metrics: Dict[str, Dict[str, Any]],
    blend_method: Optional[str],
    freq: str,
    top_k: int = BLEND_TOP_K,
):
    """Combine the top-k candidates into one (future_forecast, backtest_fn).

    Members are ranked by `_robust_member_score` (best first); weights ∝
    1/(score+1). `weighted_median` takes a plain median of the top-k (robust to
    one bad member); anything else uses the inverse-error weighted mean. The
    returned `backtest_fn` blends the SAME members so headline/Train WMAPE stay
    honest. Returns (future_forecast, backtest_fn, label, member_names) or None.
    """
    scored = []
    for strat, val in candidate_fns.items():
        bt_fn, fut_fc = val
        sc = _robust_member_score(val_metrics.get(strat, {}) or {})
        if sc is None or fut_fc is None or bt_fn is None:
            continue
        scored.append((sc, strat, bt_fn, fut_fc))
    if len(scored) < 2:
        return None
    scored.sort(key=lambda t: t[0])
    members = scored[:max(2, top_k)]
    weights = np.array([1.0 / (sc + 1.0) for sc, *_ in members], dtype=float)
    weights = weights / weights.sum()
    use_median = (blend_method == 'weighted_median')

    def _combine(series_list, idx):
        cols = []
        for s in series_list:
            ser = pd.Series(np.asarray(getattr(s, 'values', s), dtype=float),
                            index=getattr(s, 'index', idx[:len(s)]))
            ser = ser.reindex(idx)
            if ser.notna().any():
                cols.append(ser.ffill().bfill().values)
        if not cols:
            return None
        M = np.column_stack(cols)
        if use_median or M.shape[1] != len(weights):
            out = np.median(M, axis=1)
        else:
            out = (M * weights).sum(axis=1)
        return np.clip(out, 0, None)

    canon = members[0][3].index
    fut_combined = _combine([fc for *_, fc in members], canon)
    if fut_combined is None:
        return None
    future_forecast = pd.Series(fut_combined, index=canon[:len(fut_combined)])

    member_bts = [bt for _, _, bt, _ in members]

    def _blended_bt(tr, hh, _bts=member_bts):
        idx = _future_index(tr, hh, freq)
        preds = []
        for bt in _bts:
            try:
                p = bt(tr, hh)
            except Exception:
                continue
            if p is not None and len(p) > 0:
                preds.append(p)
        out = _combine(preds, idx) if preds else None
        if out is None:
            return forecast_holt_winters(tr, hh, freq)
        return pd.Series(out, index=idx[:len(out)])

    names = [strat for _, strat, _, _ in members]
    label = f"blend[{'median' if use_median else 'wmean'}]:" + "+".join(names)
    return future_forecast, _blended_bt, label, names


# =================================================================
# PIPELINE STAGE 2 — CONDITIONAL XGB RESIDUAL CORRECTION
# Refinement of the bare residual booster: only fire when the base
# model's average relative residual exceeds `residual_threshold` (e.g.
# 20%). Inside the training set we tag every period whose residual
# crossed the threshold with a `high_residual_flag` feature, so the
# booster can learn *when* corrections are likely (Diwali week, January
# slump, etc.) rather than smearing the correction uniformly.
# =================================================================

def conditional_xgb_residual_correction(
    history: pd.Series,
    base_in_sample: pd.Series,
    base_forecast: pd.Series,
    exog_history: Optional[pd.DataFrame] = None,
    exog_future:  Optional[pd.DataFrame] = None,
    residual_threshold: float = 20.0,   # 20% WMAPE — user-requested
    min_train: int = 8,
    validation_mape: Optional[float] = None,
) -> Tuple[pd.Series, str]:
    """Run XGB residual correction ONLY when the base model is performing
    poorly enough to warrant it.

    Unit convention — all WMAPE values in this function are **percentages**
    (e.g., `15.0` = 15%) to match _compute_mape_smape and _safe_mape. The
    threshold default of `20.0` therefore means "fire when val WMAPE ≥ 20%".

    Gate logic (in order of preference):
      1. If `validation_mape` is provided AND >= residual_threshold, fire
         the correction. This is the preferred gate because it's an
         honest *out-of-sample* signal of model quality.
      2. Otherwise, fall back to the in-sample residual proxy: average
         |actual-prediction|/|actual| × 100 on the training portion. Used
         when the caller hasn't computed a validation WMAPE yet.

    The correction adds a `high_residual_flag` exog feature so the booster
    learns the seasonal / calendar pattern of when residuals spike.

    Returns (corrected_forecast, note).
    """
    try:
        import xgboost as xgb  # type: ignore
    except Exception:
        return base_forecast, "xgb_residual: skipped (xgboost not installed)"

    # ── 1. Gate decision: prefer out-of-sample val WMAPE when available ──
    if validation_mape is not None and not np.isnan(validation_mape):
        if validation_mape < residual_threshold:
            return (base_forecast,
                    f"xgb_residual: not needed (val_WMAPE {validation_mape:.1f}% "
                    f"< {residual_threshold:.0f}% threshold)")
        gate_reason = f"val_WMAPE {validation_mape:.1f}%"
    else:
        # Fall back to in-sample residual proxy — converted to percent so
        # it's comparable to the threshold and renders consistently.
        residuals_proxy = (history - base_in_sample).dropna()
        if len(residuals_proxy) < min_train:
            return base_forecast, f"xgb_residual: skipped (only {len(residuals_proxy)} training rows)"
        abs_relative_proxy = (residuals_proxy.abs()
                              / np.maximum(history.reindex(residuals_proxy.index).abs(), 1e-6))
        avg_proxy_pct = float(abs_relative_proxy.mean() * 100)   # ← now %
        if avg_proxy_pct < residual_threshold:
            return (base_forecast,
                    f"xgb_residual: not needed (in-sample residual {avg_proxy_pct:.1f}% "
                    f"< {residual_threshold:.0f}% threshold; no val_WMAPE available)")
        gate_reason = f"in-sample residual {avg_proxy_pct:.1f}%"

    # ── 2. Build training residuals for the XGB regressor ───────────
    residuals = (history - base_in_sample).dropna()
    if len(residuals) < min_train:
        return base_forecast, f"xgb_residual: skipped (only {len(residuals)} training rows)"

    # abs_relative_pct is in PERCENT (% error per row) — matches the
    # residual_threshold's unit, so direct comparisons "row > threshold"
    # do the right thing for the high_residual_flag below.
    abs_relative_pct = (residuals.abs()
                        / np.maximum(history.reindex(residuals.index).abs(), 1e-6)) * 100
    avg_residual_pct = float(abs_relative_pct.mean())

    # ── 2. Build feature frame with high_residual_flag ──────────────
    if exog_history is None or exog_future is None or exog_history.empty or exog_future.empty:
        return (base_forecast,
                f"xgb_residual: residual {avg_residual_pct:.1f}% above threshold "
                f"but no exog features supplied — skipped")

    try:
        Xtr = exog_history.loc[residuals.index].select_dtypes(include=[np.number]).fillna(0).copy()
        if Xtr.shape[1] == 0:
            return base_forecast, "xgb_residual: skipped (no numeric exog features)"

        # high_residual_flag = 1 wherever the base residual *crossed* the
        # threshold in-sample. Both sides of the comparison are in % units
        # (abs_relative_pct vs residual_threshold) so the flag fires only
        # on rows that exceed the user-set threshold.
        Xtr['high_residual_flag'] = (abs_relative_pct > residual_threshold).astype(int).values
        # Encode signed residual direction too — under-forecast vs over-forecast
        Xtr['residual_sign'] = np.sign(residuals.values).astype(int)
        ytr = residuals.values

        model = xgb.XGBRegressor(
            n_estimators=300, max_depth=4, learning_rate=0.05,
            objective='reg:squarederror', random_state=42, verbosity=0,
            n_jobs=1,
        )
        model.fit(Xtr, ytr)

        # ── 3. Future features — extrapolate flag from feature similarity
        Xfut = exog_future.reindex(base_forecast.index).select_dtypes(
            include=[np.number]).fillna(0).copy()
        # For each future month, set high_residual_flag = 1 if its calendar
        # signature matches an in-sample high-residual period. We use the
        # month (or week) value as the match key — captures festive seasons
        # without needing additional config.
        if 'month' in Xtr.columns and 'month' in Xfut.columns:
            high_months = set(Xtr.loc[Xtr['high_residual_flag'] == 1, 'month'].unique().tolist())
            Xfut['high_residual_flag'] = Xfut['month'].isin(high_months).astype(int)
        else:
            Xfut['high_residual_flag'] = 0
        # Sign of expected correction — bias toward the in-sample average sign
        avg_sign = int(np.sign(residuals.mean())) or 1
        Xfut['residual_sign'] = avg_sign

        # Align columns to the model's training schema (defensive)
        Xfut = Xfut.reindex(columns=Xtr.columns, fill_value=0)
        delta = pd.Series(model.predict(Xfut), index=base_forecast.index)

        # Dampen the correction — XGB on residuals tends to over-correct on
        # short series. Apply 70% of the predicted delta.
        DAMPEN = 0.7
        corrected = (base_forecast + DAMPEN * delta).clip(lower=0)

        # avg_lift_pct is the average % adjustment the booster applied.
        avg_lift_pct = float(np.mean(np.abs(corrected - base_forecast) /
                                     np.maximum(base_forecast.abs(), 1e-6))) * 100
        n_flagged = int(Xfut['high_residual_flag'].sum())
        return (corrected,
                f"xgb_residual: applied ({gate_reason} > "
                f"{residual_threshold:.0f}% threshold; {n_flagged}/{len(Xfut)} future "
                f"months flagged; avg adjustment {avg_lift_pct:.1f}%)")
    except Exception as _e:
        return base_forecast, f"xgb_residual: errored ({type(_e).__name__})"


# =================================================================
# PIPELINE STAGE 3 — BUSINESS-RULE GUARDRAILS (MoM + YoY)
# After every statistical / ML / residual layer is done, run the
# forecast through business sanity checks. Two rules:
#   • Month-over-Month change cap: forecast[t] / forecast[t-1] is
#     capped at the historical MoM range, expanded by a tolerance.
#   • Year-over-Year band: forecast[t] is bounded by
#     history[same period last year] × (1 ± z * sigma_yoy).
# Both rules CLIP — they never invent demand, only constrain extreme
# moves that would never survive a planner review.
# =================================================================

def apply_business_rules(
    history: pd.Series,
    forecast: pd.Series,
    freq: str,
    mom_tolerance: float = 0.50,
    yoy_z: float = 3.0,
) -> Tuple[pd.Series, str]:
    """Cap forecast values using MoM and YoY bounds derived from history.

    Parameters
    ----------
    mom_tolerance : multiplicative slack added to the historical MoM range
                    bounds. 0.50 = allow +/- 50% beyond historical extremes
                    before clipping. Stops the rule from clipping genuine
                    growth/decline while still blocking nonsense spikes.
    yoy_z         : z-score band around the same-period-last-year baseline.
                    3.0 = ±3σ — clipping only the truly extreme tails.

    Returns (adjusted_forecast, trace_note).
    """
    if len(history) < 2 or forecast is None or len(forecast) == 0:
        return forecast, "business_rules: skipped (insufficient data)"

    out = forecast.copy()
    adjustments: List[str] = []

    # ── Rule 1: MoM change cap ──────────────────────────────────────
    # Build the historical MoM ratio range, then expand by tolerance.
    hist_clean = history.replace(0, np.nan).dropna()
    if len(hist_clean) >= 3:
        mom_ratios = (hist_clean / hist_clean.shift(1)).dropna()
        if len(mom_ratios) > 0:
            mom_low = float(mom_ratios.quantile(0.05))
            mom_high = float(mom_ratios.quantile(0.95))
            mom_low *= (1 - mom_tolerance)
            mom_high *= (1 + mom_tolerance)
            # First forecast step compares to last history; subsequent steps
            # compare to the previous (possibly already-adjusted) forecast.
            prev = float(hist_clean.iloc[-1])
            n_mom_clipped = 0
            for t in out.index:
                if prev <= 0:
                    prev = out.loc[t]
                    continue
                ratio = out.loc[t] / prev
                if ratio < mom_low:
                    out.loc[t] = prev * mom_low
                    n_mom_clipped += 1
                elif ratio > mom_high:
                    out.loc[t] = prev * mom_high
                    n_mom_clipped += 1
                prev = out.loc[t]
            if n_mom_clipped:
                adjustments.append(
                    f"MoM-clipped {n_mom_clipped}/{len(out)} months "
                    f"(allowed ratio band [{mom_low:.2f}, {mom_high:.2f}])"
                )

    # ── Rule 2: YoY band ────────────────────────────────────────────
    # Match each forecast period to its same period last year, build a
    # tolerance band, clip to it. Only meaningful when history covers
    # >= 1 full year for monthly / weekly.
    seasonal = {'D': 365, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4, 'YS': 1}.get(freq, 12)
    if len(history) >= seasonal + 2:
        # Compute YoY std on historical (period_t vs period_{t-seasonal})
        h_arr = history.values.astype(float)
        yoy_ratios = h_arr[seasonal:] / np.where(
            h_arr[:-seasonal] > 0, h_arr[:-seasonal], np.nan)
        yoy_ratios = yoy_ratios[~np.isnan(yoy_ratios) & np.isfinite(yoy_ratios)]
        if len(yoy_ratios) >= 3:
            yoy_mu = float(np.mean(yoy_ratios))
            yoy_sigma = float(np.std(yoy_ratios))
            low_mult = max(0.0, yoy_mu - yoy_z * yoy_sigma)
            high_mult = yoy_mu + yoy_z * yoy_sigma
            # Build the same-period-last-year reference for each forecast step
            n_yoy_clipped = 0
            for t in out.index:
                ref_idx = t - pd.tseries.frequencies.to_offset(freq) * seasonal
                if ref_idx in history.index:
                    ref = float(history.loc[ref_idx])
                    if ref > 0:
                        lower = ref * low_mult
                        upper = ref * high_mult
                        v = out.loc[t]
                        if v < lower:
                            out.loc[t] = lower
                            n_yoy_clipped += 1
                        elif v > upper:
                            out.loc[t] = upper
                            n_yoy_clipped += 1
            if n_yoy_clipped:
                adjustments.append(
                    f"YoY-clipped {n_yoy_clipped}/{len(out)} months "
                    f"(YoY band {low_mult:.2f}× — {high_mult:.2f}× LY)"
                )

    out = out.clip(lower=0)
    if adjustments:
        return out, "business_rules: " + " · ".join(adjustments)
    return out, "business_rules: no clipping needed"


# =================================================================
# 7. CONFORMAL PREDICTION INTERVALS
#    Distribution-free CIs that work for any model (Croston, LGBM, etc.)
# =================================================================

def conformal_intervals(point_forecast: pd.Series, residuals: np.ndarray,
                        alpha: float = 0.1) -> pd.DataFrame:
    """Split-conformal: width = quantile of |residuals| at level (1-α)."""
    if len(residuals) == 0:
        return pd.DataFrame({'lower': point_forecast, 'upper': point_forecast})
    q = np.quantile(np.abs(residuals), 1 - alpha)
    return pd.DataFrame({
        'lower': (point_forecast - q).clip(lower=0),
        'upper': point_forecast + q,
    })


# =================================================================
# 8. HIERARCHICAL RECONCILIATION (MinT-style, simplified)
#    Ensures Σ SKU forecasts within a Brand = Brand forecast
# =================================================================

def compute_brand_reconciliation(
    sku_forecasts: Dict[str, pd.Series],
    profiles: pd.DataFrame,
    df: pd.DataFrame,
    cfg: Dict[str, Any],
    horizon: int,
    blend_weight_bu: float = 0.5,
) -> Dict[str, Any]:
    """Proper hierarchical reconciliation for brand totals.

    Computes THREE estimates per brand and reconciles them:

      1. **Bottom-up (BU):** sum of forecasted SKU forecasts in the brand.
         High SKU-level resolution, but its shape can drift from the brand-level
         seasonality when a sample of SKUs is forecasted, or when the routing
         engine applies different model families to SKUs within one brand.

      2. **Top-down (TD):** Holt-Winters fitted on the brand-aggregated *history*
         (sum of all sales for that brand over time). Captures the brand's
         macro seasonality cleanly; ignores the SKU mix.

      3. **Reconciled:** weighted blend (default 50/50) of BU and TD. The
         reconciled brand total is then *pushed back* to the SKU forecasts
         via proportional scaling, so the parts sum to the whole.

    Returns
    -------
    dict with keys:
        bottom_up   : {brand: pd.Series}
        top_down    : {brand: pd.Series or None}
        reconciled  : {brand: pd.Series}
        history     : {brand: pd.Series}                actual brand-aggregated history
        coverage    : {brand: dict(n_total, n_forecasted, pct, has_top_down)}
        adjusted_sku_forecasts : {sku: pd.Series}       SKU forecasts after reconciliation
        method_notes : str
    """
    out: Dict[str, Any] = {
        'bottom_up': {}, 'top_down': {}, 'reconciled': {},
        'history': {}, 'coverage': {},
        'adjusted_sku_forecasts': dict(sku_forecasts),
        'method_notes': (
            f"Bottom-up = Σ(SKU forecasts). "
            f"Top-down = Holt-Winters on brand-aggregated history. "
            f"Reconciled = {blend_weight_bu:.0%} BU + {1-blend_weight_bu:.0%} TD; "
            f"the reconciled brand total is then scaled proportionally back to "
            f"each SKU forecast so parts equal the whole."
        ),
        'blend_weight_bu': blend_weight_bu,
    }

    brand_col = cfg.get('brand_col')
    if not brand_col or brand_col not in df.columns:
        return out
    if not sku_forecasts:
        return out

    date_col = cfg['date_col']
    sales_col = cfg['sales_col']
    freq = cfg.get('freq', 'MS')

    # SKU → brand from profiles (canonical)
    sku_to_brand = profiles.set_index('sku')['brand'].astype(str).to_dict()

    # Group forecasted SKUs by brand
    by_brand: Dict[str, List[str]] = {}
    for sku in sku_forecasts:
        brand = sku_to_brand.get(sku, 'unknown')
        by_brand.setdefault(brand, []).append(sku)

    # df with parsed dates for history aggregation
    df_dt = df.copy()
    df_dt[date_col] = pd.to_datetime(df_dt[date_col], errors='coerce')
    df_dt = df_dt.dropna(subset=[date_col])

    for brand, brand_skus in by_brand.items():
        if not brand_skus:
            continue

        # -- Bottom-up: align all SKU forecasts on a union index, zero-fill gaps --
        f_series = [sku_forecasts[s].astype(float) for s in brand_skus]
        common_idx = sorted(set().union(*[set(s.index) for s in f_series]))
        if not common_idx:
            continue
        aligned = pd.DataFrame({
            s: ser.reindex(common_idx).fillna(0.0)
            for s, ser in zip(brand_skus, f_series)
        })
        bu = aligned.sum(axis=1)
        bu.index = pd.Index(common_idx, name=date_col)
        bu.name = brand
        out['bottom_up'][brand] = bu

        # -- Brand history (aggregated) --
        brand_df = df_dt[df_dt[brand_col].astype(str) == str(brand)]
        hist = None
        if len(brand_df) > 0:
            try:
                hist = (brand_df.groupby(pd.Grouper(key=date_col, freq=freq))[sales_col]
                                .sum().sort_index())
                hist = hist[hist.index.notna()]
                if len(hist) > 0:
                    out['history'][brand] = hist
            except Exception:
                hist = None

        # -- Top-down forecast via Holt-Winters --
        td = None
        if hist is not None and len(hist) >= 6:
            try:
                if len(hist) >= 24:
                    model = ExponentialSmoothing(
                        hist, trend='add', seasonal='add',
                        seasonal_periods=12, initialization_method='estimated',
                    ).fit()
                elif len(hist) >= 12:
                    model = ExponentialSmoothing(
                        hist, trend='add', initialization_method='estimated',
                    ).fit()
                else:
                    model = ExponentialSmoothing(
                        hist, initialization_method='estimated',
                    ).fit()
                td_fc = model.forecast(steps=horizon)
                # Align TD index to BU's first `horizon` periods
                td = pd.Series(td_fc.values[:len(bu)], index=bu.index[:len(td_fc)],
                               name=brand)
            except Exception:
                td = None
        out['top_down'][brand] = td

        # -- Reconciled --
        if td is not None:
            td_aligned = td.reindex(bu.index).fillna(bu)
            rec = blend_weight_bu * bu + (1 - blend_weight_bu) * td_aligned
            rec.name = brand
        else:
            rec = bu.copy()
            rec.name = brand
        out['reconciled'][brand] = rec

        # -- Coverage (was the WHOLE brand forecasted, or just a sample?) --
        all_brand_skus = profiles[profiles['brand'].astype(str) == str(brand)]['sku'].tolist()
        n_total = len(all_brand_skus)
        n_fc = len(brand_skus)
        out['coverage'][brand] = {
            'n_total': n_total,
            'n_forecasted': n_fc,
            'pct': 100.0 * n_fc / n_total if n_total else 0.0,
            'has_top_down': td is not None,
        }

        # -- Push reconciled total back to each SKU via proportional scaling --
        # New SKU forecast = SKU forecast × (reconciled / bottom-up), per date.
        # SAFETY 1: Skip dates where BU == 0 (avoid division blowup).
        # SAFETY 2: Cap the scale factor to [0.5, 2.0].
        #   Why: with partial coverage (only a sample of SKUs forecasted),
        #   bottom-up is tiny vs the brand's full top-down → scale → 10-50×
        #   and individual SKU forecasts explode to absurd values.
        #   The cap means the reconciled push-back can nudge a SKU up to
        #   2× or down to 0.5× of its local fit, but never produce a
        #   hallucinated spike. Wider deviations indicate poor coverage
        #   or top-down model failure — the local fit is more trustworthy
        #   in those cases.
        SCALE_MIN, SCALE_MAX = 0.5, 2.0
        bu_safe = bu.replace(0, np.nan)
        scale = (rec / bu_safe).reindex(bu.index).fillna(1.0)
        scale = scale.clip(lower=SCALE_MIN, upper=SCALE_MAX)
        for s in brand_skus:
            sku_ser = sku_forecasts[s]
            sku_scale = scale.reindex(sku_ser.index, fill_value=1.0)
            out['adjusted_sku_forecasts'][s] = sku_ser * sku_scale

    return out


# Backwards-compat alias for older callers (kept thin — new code should use
# `compute_brand_reconciliation` for richer output).
def reconcile_hierarchy(sku_forecasts: Dict[str, pd.Series],
                        sku_to_brand: Dict[str, str]) -> Dict[str, pd.Series]:
    """Deprecated: kept only for backwards-compatibility. Use
    `compute_brand_reconciliation` for proper hierarchical reconciliation."""
    if not sku_forecasts:
        return sku_forecasts
    by_brand: Dict[str, List[str]] = {}
    for sku, brand in sku_to_brand.items():
        by_brand.setdefault(brand, []).append(sku)
    out = dict(sku_forecasts)
    for brand, skus in by_brand.items():
        brand_skus = [s for s in skus if s in sku_forecasts]
        if not brand_skus:                               # FIX: include single-SKU brands
            continue
        f_series = [sku_forecasts[s].astype(float) for s in brand_skus]
        common_idx = sorted(set().union(*[set(s.index) for s in f_series]))
        aligned = pd.DataFrame({
            s: ser.reindex(common_idx).fillna(0.0)
            for s, ser in zip(brand_skus, f_series)
        })
        out[f'__brand__{brand}'] = aligned.sum(axis=1)
    return out


# =================================================================
# 9. ROUTING ENGINE — runs the right model for each SKU
# =================================================================

@dataclass
class ForecastResult:
    sku: str
    strategy_used: str
    forecast: pd.Series
    ci: Optional[pd.DataFrame] = None
    backtest_mape: Optional[float] = None
    backtest_smape: Optional[float] = None   # symmetric MAPE — defined when actuals are zero
    backtest_bias_pct: Optional[float] = None  # signed: (sum_pred - sum_actual)/sum_actual; +ve = over-forecast
    backtest_actual: Optional[pd.Series] = None   # held-out actuals (for cross-level aggregation)
    backtest_pred: Optional[pd.Series] = None     # backtest predictions (aligned to actuals)
    test_horizon: Optional[int] = None       # # periods actually held out for the Test WMAPE
    mape_reason: str = ''                    # explains why WMAPE/SMAPE could not be computed
    notes: str = ''
    # ---- Training-set (in-sample / rolling-origin) accuracy ----
    # These come from rolling_origin_train_backtest and answer the question
    # "how well does the model fit history?" — complementing the test-holdout
    # number which answers "how well does it generalise to the next month?".
    train_mape: Optional[float] = None
    train_smape: Optional[float] = None
    train_bias_pct: Optional[float] = None
    train_actual: Optional[pd.Series] = None   # rolling-origin actuals (for the plot)
    train_pred: Optional[pd.Series] = None     # rolling-origin predictions (a.k.a. "Historical forecast")
    train_reason: str = ''                     # why training accuracy could not be computed
    # ---- Benchmark / portfolio extras ----
    auto_routed_strategy: Optional[str] = None  # what the router originally picked
    benchmark_forecasts: Dict[str, pd.Series] = field(default_factory=dict)
    benchmark_mapes: Dict[str, Optional[float]] = field(default_factory=dict)
    benchmark_smapes: Dict[str, Optional[float]] = field(default_factory=dict)
    # ---- K-fold CV algorithm selection ----
    # When this SKU had ≥ MIN_HISTORY_FOR_CV months and CV mode was enabled,
    # `cv_results` holds per-algorithm CV scores and `cv_winner` is the
    # strategy that won (= what `strategy_used` will be set to).
    cv_selected: bool = False                          # was the strategy chosen via CV?
    cv_winner: Optional[str] = None
    cv_k: Optional[int] = None                         # number of folds used
    cv_results: Dict[str, Any] = field(default_factory=dict)  # {strat: {mean_mape, fold_mapes, ...}}
    cv_reason: str = ''                                # why CV did not run (eg short history)
    # ---- Always-on algorithm evaluation ----
    # Populated for EVERY SKU regardless of CV mode. Lists each candidate
    # algorithm's test WMAPE + future forecast so the Forecast tab can show
    # a unified "all algorithms compared" table and indicate the champion.
    # Shape: { strategy_name: {
    #     'test_mape': float|None, 'test_smape': float|None,
    #     'cv_mape':   float|None,  # populated only when CV ran
    #     'cv_smape':  float|None,
    #     'future_forecast': pd.Series,
    #     'is_champion': bool,      # True iff this == strategy_used
    #     'test_reason': str,
    # }}
    all_algorithm_metrics: Dict[str, Any] = field(default_factory=dict)
    # Diagnostic — records why the candidate pool ended up empty (silent
    # exception during build, or pool intentionally skipped). Empty string
    # means the pool was built successfully.
    pool_build_note: str = ''
    # ---- DTW lookalikes (new-product / short-history SKUs only) -------
    # Top-K SKUs whose historical *shape* is closest to this one, used as
    # analogues when there isn't enough own-history to fit a local model.
    # Each entry: {sku, distance, n_periods, mean_sales, brand, tail_series}.
    # Populated only when profile.is_cold_start OR profile.is_short_history.
    lookalikes: List[Dict[str, Any]] = field(default_factory=list)
    lookalike_reason: str = ''  # e.g. "is_cold_start (3 months)" or empty


def _compute_mape_smape(actual: np.ndarray, pred: np.ndarray) -> Tuple[Optional[float], Optional[float]]:
    """Returns (mape_pct, smape_pct). WMAPE is None if all actuals are zero."""
    actual = np.asarray(actual, dtype=float)
    pred = np.asarray(pred, dtype=float)
    # SMAPE — symmetric, defined whenever |actual|+|pred| > 0
    denom = (np.abs(actual) + np.abs(pred)) / 2
    smape_mask = denom > 0
    smape = float(np.mean(np.abs(actual[smape_mask] - pred[smape_mask]) / denom[smape_mask]) * 100) \
            if smape_mask.any() else None
    # Weighted MAPE (WMAPE / WAPE): sum|actual-pred| / sum|actual|. Errors are
    # weighted by actual volume, so low-volume periods don't dominate. Undefined
    # only when every actual is zero. (Variable kept named `mape` so the rest of
    # the pipeline is unchanged — it now carries a WMAPE value.)
    denom = float(np.abs(actual).sum())
    if denom == 0:
        return None, smape
    mape = float(np.abs(actual - pred).sum() / denom * 100)
    return mape, smape


def backtest_holdout(history: pd.Series, h: int, forecast_fn) -> Tuple[
    Optional[float], Optional[float], Optional[float],
    Optional[pd.Series], Optional[pd.Series], str
]:
    """Last-h holdout backtest. Returns (mape, smape, bias_pct, actual, pred, reason).

    `forecast_fn` takes (train_series, h) → forecast Series.
    `bias_pct` is signed: positive = over-forecasting; negative = under-forecasting.
    `actual` and `pred` are the aligned holdout series (or None if backtest failed),
    so callers can re-aggregate residuals to any hierarchy level.
    `reason` is empty when WMAPE was successfully computed; otherwise it explains why.
    """
    if h < 1:
        return None, None, None, None, None, 'horizon < 1'
    if len(history) < 2 * h:
        return None, None, None, None, None, \
               f'history too short ({len(history)} months < {2*h} required for {h}-month backtest)'
    train, test = history.iloc[:-h], history.iloc[-h:]
    try:
        pred = forecast_fn(train, h)
    except Exception as e:
        return None, None, None, None, None, f'forecast errored: {type(e).__name__}'
    if pred is None or len(pred) == 0:
        return None, None, None, None, None, 'forecast returned empty'
    # Align by DATE, not position. Some strategies (notably the global LGBM,
    # whose panel_history was truncated by the engine-level horizon, not by
    # this SKU's bt_h) emit predictions for a different month range than
    # `test`. Comparing actual[Oct] vs pred[Jan] silently inflates WMAPE.
    pred_series = pd.Series(np.asarray(pred, dtype=float),
                            index=getattr(pred, 'index', test.index[:len(pred)]))
    # Dedupe both sides on index BEFORE the intersection. Without this,
    # .loc[overlap] expands rows for the side that has duplicates, causing
    # actual/pred shape mismatch downstream.
    if test.index.duplicated().any():
        test = test.groupby(level=0).sum().sort_index()
    if pred_series.index.duplicated().any():
        pred_series = pred_series.groupby(level=0).mean().sort_index()
    overlap = test.index.intersection(pred_series.index)
    if len(overlap) == 0:
        return None, None, None, None, None, (
            f'forecast/test date misalignment: pred covers '
            f'{pred_series.index.min()}..{pred_series.index.max()}, '
            f'test covers {test.index.min()}..{test.index.max()}'
        )
    actual_series = test.loc[overlap].astype(float)
    pred_series = pred_series.loc[overlap].astype(float)
    actual_arr = actual_series.values
    pred_arr = pred_series.values
    mape, smape = _compute_mape_smape(actual_arr, pred_arr)
    # Bias — signed total error as % of total actual
    sum_actual = actual_arr.sum()
    bias_pct = float((pred_arr.sum() - sum_actual) / sum_actual * 100) if sum_actual > 0 else None
    if mape is None and smape is None:
        return None, None, bias_pct, actual_series, pred_series, \
               'all test actuals and predictions are zero'
    if mape is None:
        return None, smape, bias_pct, actual_series, pred_series, \
               'all test actuals are zero (WMAPE undefined; SMAPE shown)'
    return mape, smape, bias_pct, actual_series, pred_series, ''


def rolling_origin_train_backtest(
    history: pd.Series, forecast_fn, k_windows: int = 6, test_h: int = 1,
) -> Tuple[Optional[float], Optional[float], Optional[float],
           Optional[pd.Series], Optional[pd.Series], str]:
    """Rolling-origin in-sample backtest — the "training accuracy" companion to
    the single-shot test holdout above.

    For each origin point t in the last `k_windows` *training* months (i.e.
    excluding the test_h months reserved for the test holdout), we:
        1. fit/forecast using `forecast_fn(history[:t], 1)`
        2. record (actual[t], predicted[t])

    This gives a series of one-step-ahead predictions that the chart can
    overlay as a "Historical forecast" line — letting the planner *see* how
    well the model would have called the last few months in retrospect.

    Returns (train_mape, train_smape, train_bias_pct, actual_series,
             pred_series, reason). `reason` is empty on success.

    Notes:
        • `k_windows` is capped at the available training length, so SKUs with
          short history get a smaller window automatically (or skipped if too
          short to be meaningful).
        • For strategies whose `backtest_fn` closes over a pre-trained model
          (e.g. global LGBM whose leak-free package was trained with the last
          month removed once), this isn't a strict rolling re-fit — it's a
          rolling-window *evaluation* of the same backtest model at different
          origins. That's still the right comparator for "how does the
          training fit look on the historical chart."
    """
    if forecast_fn is None:
        return None, None, None, None, None, 'no backtest fn (forecast errored upstream)'
    # Need at least: test_h (held-out for test) + k_windows (rolling origins)
    # + 1 (to have any training data left for the earliest origin).
    # Goal: produce SOME historical prediction for every SKU that has at
    # least 2 months of history beyond the test holdout (i.e. 2 train + 1 test).
    min_required = test_h + max(1, k_windows) + 1
    if len(history) < min_required:
        # Try to gracefully degrade — use whatever windows we have. Allow
        # even k_windows=1 (a single rolling origin) when the SKU is tiny —
        # one historical prediction is better than none for the chart.
        k_windows = max(0, len(history) - test_h - 1)
        if k_windows < 1:
            return None, None, None, None, None, (
                f'history too short for training backtest '
                f'(have {len(history)} months, need ≥3 for at least 1 '
                f'rolling window after reserving {test_h} for test)'
            )

    # Origins: the LAST k_windows months of the training portion
    # (everything except the last `test_h` which is the test holdout).
    train_end = len(history) - test_h
    origins = list(range(max(1, train_end - k_windows), train_end))
    if not origins or origins[0] < 1:
        return None, None, None, None, None, 'not enough leading history for rolling backtest'

    actuals: List[float] = []
    preds: List[float] = []
    idxs: List[Any] = []
    for t in origins:
        train_slice = history.iloc[:t]
        try:
            pred = forecast_fn(train_slice, 1)
        except Exception:
            continue
        if pred is None or len(pred) == 0:
            continue
        # Take the first predicted value — it lands on history.index[t]
        pred_val = float(np.asarray(pred, dtype=float)[0])
        actuals.append(float(history.iloc[t]))
        preds.append(pred_val)
        idxs.append(history.index[t])

    if len(actuals) < 1:
        return None, None, None, None, None, 'rolling backtest produced no points'

    actual_series = pd.Series(actuals, index=pd.Index(idxs))
    pred_series = pd.Series(preds, index=pd.Index(idxs))
    mape, smape = _compute_mape_smape(actual_series.values, pred_series.values)
    sum_actual = actual_series.sum()
    bias_pct = float((pred_series.sum() - sum_actual) / sum_actual * 100) \
               if sum_actual > 0 else None
    reason = ''
    if mape is None and smape is None:
        reason = 'rolling actuals/predictions all zero'
    elif mape is None:
        reason = 'rolling actuals all zero (WMAPE undefined; SMAPE shown)'
    elif len(actuals) == 1:
        reason = 'only 1 rolling origin available — WMAPE based on single point'
    return mape, smape, bias_pct, actual_series, pred_series, reason


# =================================================================
# 8b. TIME-SERIES K-FOLD CV + ALGORITHM SELECTOR
#     For SKUs with ≥ MIN_HISTORY_FOR_CV months, run K=3 expanding-window
#     CV across a candidate algorithm pool and pick the one with the
#     lowest mean WMAPE. Below that threshold, the engine falls back to
#     the auto-router + segment-portfolio resolution.
# =================================================================

# Minimum history to enable CV — 24 monthly observations gives 2 full
# seasonal cycles, enough for SARIMAX/AutoARIMA/Theta to fit a seasonal
# component and for 3 expanding-window folds to be meaningful.
MIN_HISTORY_FOR_CV: int = 24


def timeseries_kfold_cv(history: pd.Series, forecast_fn,
                        k: int = 3, h: int = 1) -> Dict[str, Any]:
    """Expanding-window time-series K-fold CV. K test points, walked from
    most-recent K-h backwards.

    For K=3, h=1, length N:
        Fold 1: train [0:N-3], test [N-3]    (one-step-ahead)
        Fold 2: train [0:N-2], test [N-2]
        Fold 3: train [0:N-1], test [N-1]

    This is the textbook scheme for time-series CV — never shuffles, never
    lets a future month leak into a past fit, and every fold uses *all*
    prior data (expanding window), which matches how the production model
    is trained on full history.

    Returns:
        {
            'mean_mape': float | None,
            'mean_smape': float | None,
            'fold_mapes': [float|None, ...],   # length k
            'fold_smapes': [float|None, ...],
            'n_folds_scored': int,             # how many folds returned a finite WMAPE
            'reason': str,                     # empty on success
        }
    """
    result_template: Dict[str, Any] = {
        'mean_mape': None, 'mean_smape': None,
        'fold_mapes': [], 'fold_smapes': [],
        'n_folds_scored': 0, 'reason': '',
    }
    if forecast_fn is None:
        result_template['reason'] = 'no backtest fn'
        return result_template
    # Need at least k+1 points so the earliest fold has ≥1 month of training
    if len(history) < k + 1:
        result_template['reason'] = (
            f'history too short for K={k} CV (have {len(history)}, '
            f'need ≥{k + 1})'
        )
        return result_template

    fold_mapes: List[Optional[float]] = []
    fold_smapes: List[Optional[float]] = []
    n_scored = 0
    # Fold i (i=0..k-1) uses train_end = N - (k - i), test = train_end
    # i=0 → earliest fold (smallest training set)
    # i=k-1 → latest fold (largest training set; predicts the most recent month)
    N = len(history)
    for i in range(k):
        train_end = N - (k - i)
        if train_end < 2:
            fold_mapes.append(None)
            fold_smapes.append(None)
            continue
        train = history.iloc[:train_end]
        actual_val = float(history.iloc[train_end])
        try:
            pred_series = forecast_fn(train, h)
        except Exception:
            fold_mapes.append(None)
            fold_smapes.append(None)
            continue
        if pred_series is None or len(pred_series) == 0:
            fold_mapes.append(None)
            fold_smapes.append(None)
            continue
        pred_val = float(np.asarray(pred_series, dtype=float)[0])
        mape, smape = _compute_mape_smape(
            np.array([actual_val]), np.array([pred_val]))
        fold_mapes.append(mape)
        fold_smapes.append(smape)
        if mape is not None:
            n_scored += 1

    finite_mapes = [m for m in fold_mapes if m is not None]
    finite_smapes = [s for s in fold_smapes if s is not None]
    mean_mape = float(np.mean(finite_mapes)) if finite_mapes else None
    mean_smape = float(np.mean(finite_smapes)) if finite_smapes else None
    reason = '' if mean_mape is not None else (
        'all folds had zero actuals (WMAPE undefined)' if not finite_mapes else ''
    )
    return {
        'mean_mape': mean_mape, 'mean_smape': mean_smape,
        'fold_mapes': fold_mapes, 'fold_smapes': fold_smapes,
        'n_folds_scored': n_scored, 'reason': reason,
    }


def _build_candidate_pool(profile_row: dict,
                          portfolio: Optional[dict],
                          global_pkg: Optional[GlobalModelPackage],
                          compare_algos: Optional[List[str]] = None) -> List[str]:
    """List of candidate algorithms to evaluate for this SKU, de-duplicated
    and in priority order.

    Pool composition:
        1. The strategy the router picked (profile-based)
        2. Any 'extras' the user selected in the segment portfolio
        3. A default shortlist of compatible algorithms (different for
           intermittent SKUs vs. regular SKUs).

    Used by both:
        - `build_candidate_backtest_fns` (for CV / always-on evaluation)
        - the always-on test-WMAPE evaluator
    so the algorithm pool stays consistent across modes.

    `compare_algos` (from the Forecast tab's "Algorithms to compare" checklist)
    OVERRIDES the auto-built pool: when supplied, exactly those algorithms are
    scored (deduped, plus the SKU's routed primary so a champion always exists),
    skipping the default shortlist and lifting the size cap. Intermittent-only
    models stay available; global_lgbm is dropped only when no global model was
    trained this run.
    """
    intermittency = str(profile_row.get('intermittency', '')).lower()
    auto_strat = profile_row.get('recommended_strategy')

    # ââ Explicit user checklist wins ââââââââââââââââââââââââââââââââââ
    if compare_algos:
        # Score EXACTLY the chosen algorithms (deduped). global_lgbm needs a
        # trained global model, so it's dropped when none exists this run. The
        # champion is the best of the chosen set; fall back to the routed
        # primary / Holt-Winters only if the set resolves to nothing.
        chosen: List[str] = []
        for a in compare_algos:
            if a in ('global_lgbm', 'global_lgbm_full') and global_pkg is None:
                continue
            if a not in chosen:
                chosen.append(a)
        if chosen:
            return chosen
        return [auto_strat] if auto_strat else ['holt_winters']

    candidates: List[str] = []
    if auto_strat:
        candidates.append(auto_strat)

    # Extras from segment override
    if portfolio:
        seg = profile_row.get('segment')
        seg_ov = (portfolio.get('segment_overrides') or {}).get(seg) or {}
        for e in (seg_ov.get('extras') or []):
            if e not in candidates:
                candidates.append(e)

    # ── Segment-architecture blend members ────────────────────────────
    # The new SEGMENT_ARCHITECTURE recipe specifies which models compose
    # the ensemble for each segment (e.g. Stable High blends Prophet +
    # AutoARIMA + HW around the SARIMAX primary). Adding them to the
    # candidate pool means each one gets backtested on the holdout, so
    # the actually-best blend constituent gets surfaced in the validation
    # table — and the user can drop any underperformer from the segment
    # overrides UI.
    arch = get_segment_architecture(profile_row)
    for b in (arch.get('blend') or []):
        # Skip global_lgbm if we don't have a global model fitted in this run.
        if b in ('global_lgbm', 'global_lgbm_full') and global_pkg is None:
            continue
        if b not in candidates:
            candidates.append(b)

    # Final safety net — always include a small default shortlist so even a
    # mis-configured segment gets *some* candidate to score against.
    if intermittency in ('intermittent', 'lumpy'):
        default_pool = ['croston_sba', 'tsb', 'holt_winters']
    else:
        # MoE leads the non-intermittent default shortlist so it always competes
        # for SKUs with real trend/seasonality/event/exog signal, even when the
        # segment recipe didn't list it. Intermittent/dead SKUs are left to the
        # Croston family (the decomposition experts add no value on zero-heavy
        # demand).
        default_pool = ['moe', 'holt_winters', 'theta', 'autoarima']
        if global_pkg is not None:
            default_pool.append('global_lgbm')
    for c in default_pool:
        if c not in candidates:
            candidates.append(c)

    # ââ Deep MoE (dl_moe) â OPT-IN ONLY ââââââââââââââââââââââââââââââ
    # Never enters the pool by default (a neural net per SKU across the whole
    # portfolio is prohibitively slow). It competes only when the planner ticks
    # it as a global "additional algorithm", and only for non-intermittent SKUs.
    # Inserted right after the primary so the MAX_POOL cap can't drop it.
    _dlmoe_on = bool((portfolio or {}).get('additional', {}).get('dl_moe'))
    if (_dlmoe_on and intermittency not in ('intermittent', 'lumpy')
            and 'dl_moe' not in candidates):
        candidates.insert(1 if candidates else 0, 'dl_moe')

    # Cap pool size so we don't blow up runtime on heavy segments (Stable
    # High has 5-6 blend members + 4 defaults = up to 10 candidates per SKU).
    # Profile-driven primary is always first; we keep the top-7 only.
    MAX_POOL = 7
    if len(candidates) > MAX_POOL:
        candidates = candidates[:MAX_POOL]

    return candidates


def build_candidate_backtest_fns(
    history: pd.Series, sku: str, h: int, freq: str,
    sku_panel: pd.DataFrame, date_col: str, sku_col: str,
    profile_row: dict, cfg: Optional[dict],
    global_pkg: Optional[GlobalModelPackage],
    chronos_pipeline,
    portfolio: Optional[dict],
    errors_out: Optional[Dict[str, str]] = None,
    compare_algos: Optional[List[str]] = None,
) -> Dict[str, Tuple[Any, pd.Series]]:
    """For each candidate algorithm, return {strategy: (backtest_fn, future_forecast)}.

    `future_forecast` is the candidate's h-step-ahead forecast trained on
    full history — used both for the always-on evaluator (so we can show
    each candidate's projected total in the comparison table) and as the
    raw material for the champion's chart trace.

    If `errors_out` is provided, per-candidate failure reasons are written
    into it as `{candidate_name: 'ExceptionType: message'}` (or
    'returned None forecast/backtest_fn' for soft failures). This is how
    the UI surfaces *why* the pool is empty.

    OPTIMIZED: Uses concurrent.futures to fit multiple candidates in parallel.
    """
    candidates = _build_candidate_pool(profile_row, portfolio, global_pkg,
                                       compare_algos=compare_algos)
    out: Dict[str, Tuple[Any, pd.Series]] = {}
    err_dict: Dict[str, str] = {} if errors_out is None else errors_out

    def _fit_one(cand):
        try:
            fc, _ci, _notes, bt_fn = _run_strategy_forecast(
                cand, history, sku, h, freq, sku_panel, date_col,
                global_pkg=global_pkg, chronos_pipeline=chronos_pipeline,
                cfg=cfg, sku_col=sku_col, profile_row=profile_row,
            )
            if bt_fn is None or fc is None:
                return cand, None, 'returned None forecast or backtest_fn'
            return cand, (bt_fn, fc), None
        except Exception as e:
            return cand, None, f"{type(e).__name__}: {e}"

    if len(candidates) >= 4:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(candidates))) as executor:
            for cand, result, err in executor.map(_fit_one, candidates):
                if result is not None:
                    out[cand] = result
                elif err:
                    err_dict[cand] = err
    else:
        for cand in candidates:
            cand_name, result, err = _fit_one(cand)
            if result is not None:
                out[cand_name] = result
            elif err:
                err_dict[cand_name] = err
    return out


# Backwards-compat shim: select_best_algorithm_via_cv still calls the old
# name. Keep it as a thin wrapper that drops the future_forecast.
def build_cv_candidate_backtest_fns(*args, **kwargs) -> Dict[str, Any]:
    return {k: v[0] for k, v in
            build_candidate_backtest_fns(*args, **kwargs).items()}


def _evaluate_all_candidates_parallel(
    history: pd.Series, candidate_fns: Dict[str, Tuple[Any, pd.Series]],
    test_h: int = 1,
) -> Dict[str, Dict[str, Any]]:
    """Parallel version of evaluate_all_candidates_test_mape for speedup."""
    def _eval_one_strat(strat_and_fn):
        strat, (bt_fn, future_fc) = strat_and_fn
        if len(history) < test_h + 1:
            return strat, {
                'test_mape': None, 'test_smape': None,
                'future_forecast': future_fc,
                'test_reason': f'history too short for {test_h}-mo test',
            }
        try:
            t_mape, t_smape, _bias, _act, _pred, t_reason = \
                backtest_holdout(history, test_h, bt_fn)
        except Exception as e:
            t_mape, t_smape, t_reason = None, None, f'errored: {type(e).__name__}'
        return strat, {
            'test_mape': t_mape, 'test_smape': t_smape,
            'future_forecast': future_fc,
            'test_reason': t_reason,
        }
    
    out: Dict[str, Dict[str, Any]] = {}
    # Parallel only for larger pools (4+); threading helps I/O bound backtest calls
    if len(candidate_fns) >= 4:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(candidate_fns))) as executor:
            for strat, result in executor.map(_eval_one_strat, candidate_fns.items()):
                out[strat] = result
    else:
        # Serial for small pools
        for strat, result in map(_eval_one_strat, candidate_fns.items()):
            out[strat] = result
    return out


def evaluate_all_candidates_test_mape(
    history: pd.Series, candidate_fns: Dict[str, Tuple[Any, pd.Series]],
    test_h: int = 1,
) -> Dict[str, Dict[str, Any]]:
    """For each candidate, compute single-shot test WMAPE on the last `test_h`
    months. Returns {strategy: {test_mape, test_smape, future_forecast,
    test_reason}}.

    This is the always-on evaluator — it runs regardless of CV mode and
    gives the planner a uniform WMAPE comparison across the candidate pool
    in the Forecast tab's drill-down.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for strat, (bt_fn, future_fc) in candidate_fns.items():
        if len(history) < test_h + 1:
            out[strat] = {
                'test_mape': None, 'test_smape': None,
                'future_forecast': future_fc,
                'test_reason': f'history too short for {test_h}-mo test',
                'test_pred': None, 'test_actual': None,
            }
            continue
        try:
            t_mape, t_smape, _bias, _act, _pred, t_reason = \
                backtest_holdout(history, test_h, bt_fn)
        except Exception as e:
            t_mape, t_smape, t_reason, _act, _pred = None, None, f'errored: {type(e).__name__}', None, None
        out[strat] = {
            'test_mape': t_mape, 'test_smape': t_smape,
            'future_forecast': future_fc,
            'test_reason': t_reason,
            'test_pred': _pred,
            'test_actual': _act,
        }
    return out


def select_best_algorithm_via_cv(
    history: pd.Series, sku: str, h: int, freq: str,
    sku_panel: pd.DataFrame, date_col: str, sku_col: str,
    profile_row: dict, cfg: Optional[dict],
    global_pkg: Optional[GlobalModelPackage],
    chronos_pipeline,
    portfolio: Optional[dict],
    k: int = 3,
) -> Tuple[Optional[str], Dict[str, Dict[str, Any]]]:
    """Run K-fold time-series CV across the candidate pool and return
    (winner_strategy, per_algo_cv_results).

    Tie-breaking when two algos have identical mean WMAPE:
        1. Lower mean SMAPE
        2. Alphabetical strategy name (stable, reproducible)
    Returns (None, {}) when no candidate could be scored.
    """
    candidate_fns = build_candidate_backtest_fns(
        history, sku, h, freq, sku_panel, date_col, sku_col,
        profile_row, cfg, global_pkg, chronos_pipeline, portfolio,
    )
    if not candidate_fns:
        return None, {}

    cv_results: Dict[str, Dict[str, Any]] = {}
    for strat, (bt_fn, _future_fc) in candidate_fns.items():
        cv_results[strat] = timeseries_kfold_cv(history, bt_fn, k=k, h=1)

    # Score = mean_mape; algos with no score (None) are excluded from winning.
    ranked = [(s, r) for s, r in cv_results.items() if r['mean_mape'] is not None]
    if not ranked:
        return None, cv_results
    # Sort: ascending WMAPE → ascending SMAPE → alphabetical
    ranked.sort(key=lambda kv: (
        kv[1]['mean_mape'],
        kv[1]['mean_smape'] if kv[1]['mean_smape'] is not None else float('inf'),
        kv[0],
    ))
    winner = ranked[0][0]
    return winner, cv_results


def resolve_effective_strategy(profile_row: dict,
                               portfolio: Optional[dict]) -> Tuple[str, List[str]]:
    """Combine portfolio toggles + per-segment overrides into the SKU's
    effective primary strategy and the list of extra (benchmark) algorithms.

    Returns:
        (primary, extras)
          primary  : strategy key to use as the headline forecast. May be either
                     a key from STRATEGY_INFO (auto-routed family) or from
                     ADDITIONAL_FORECASTERS (univariate family).
          extras   : list of additional-algo keys to run alongside for benchmark.
    """
    auto_strategy = profile_row.get('recommended_strategy', 'ensemble_local')
    if not portfolio:
        return auto_strategy, []

    # 1. Start with the auto-routed pick, allow segment override
    seg = profile_row.get('segment', None)
    seg_ov = (portfolio.get('segment_overrides') or {}).get(seg, {}) if seg else {}
    primary = seg_ov.get('primary') or auto_strategy

    # 2. If the primary is an auto-routed strategy that the user disabled,
    #    fall back to ensemble_local. If THAT is also disabled, fall back to
    #    holt_winters (which always exists as an adapter).
    auto_routed = portfolio.get('auto_routed') or {}
    if primary in auto_routed and not auto_routed[primary].get('enabled', True):
        if auto_routed.get('ensemble_local', {}).get('enabled', True):
            primary = 'ensemble_local'
        else:
            primary = 'holt_winters'

    # 3. Gather extras: segment-specific (always) + globally-toggled additional
    extras_set: List[str] = []
    for e in seg_ov.get('extras', []) or []:
        if e != primary and e not in extras_set:
            extras_set.append(e)
    for a, on in (portfolio.get('additional') or {}).items():
        if on and a != primary and a not in extras_set:
            extras_set.append(a)

    return primary, extras_set


def _run_strategy_forecast(
    strategy: str, history: pd.Series, sku: str, h: int, freq: str,
    sku_panel: pd.DataFrame, date_col: str,
    global_pkg: Optional[GlobalModelPackage],
    chronos_pipeline,
    cfg: Optional[dict] = None,
    sku_col: str = 'sku',
    profile_row: Optional[dict] = None,
) -> Tuple[pd.Series, Optional[pd.DataFrame], str, Any]:
    """Dispatch helper. Runs the given strategy and returns
    (forecast, ci, notes, backtest_fn) — backtest_fn is a (train,h)->Series.

    Used both for the primary forecast path and for benchmark extras when the
    user selected an auto-routed strategy as the primary for a segment.
    """
    notes = ''
    ci: Optional[pd.DataFrame] = None
    backtest_fn = None

    # Global-LGBM event/attr/strategy context (mirrors forecast_one_sku) — these
    # are referenced by the 'global_lgbm' branch below; without them the candidate
    # evaluation raises NameError and global_lgbm is silently dropped from the
    # all-models comparison.
    _gl_future_events = (cfg or {}).get('future_events')
    _gl_sku_attrs = {'brand': (profile_row or {}).get('brand'),
                     'segment': (profile_row or {}).get('segment')}
    _gl_exog_strategy = (cfg or {}).get('exog_future_strategy') or {}

    if strategy == 'naive_zero':
        idx = _future_index(history, h, freq)
        forecast = pd.Series([0.0] * h, index=idx)
        backtest_fn = lambda tr, hh: pd.Series([0.0] * hh)
        notes = 'Dead SKU — zero forecast'

    elif strategy == 'chronos_zero_shot':
        forecast, ci = forecast_chronos(history, h, freq, chronos_pipeline)
        backtest_fn = lambda tr, hh: forecast_chronos(tr, hh, freq, chronos_pipeline)[0]
        notes = 'Cold-start: Amazon Chronos zero-shot'

    elif strategy == 'croston_sba':
        arr = sba(history.values, alpha=0.1, h=h)
        forecast = pd.Series(arr, index=_future_index(history, h, freq))
        backtest_fn = lambda tr, hh: pd.Series(sba(tr.values, 0.1, hh))
        notes = 'Intermittent: SBA'

    elif strategy in ('global_lgbm', 'global_lgbm_full'):
        if global_pkg is None:
            forecast = forecast_holt_winters(history, h, freq)
            backtest_fn = lambda tr, hh: forecast_holt_winters(tr, hh, freq)
            notes = 'Global LGBM unavailable → Holt-Winters fallback'
        else:
            _fv = (cfg or {}).get('exog_future_values') or {}
            forecast = forecast_with_global_lgbm(global_pkg, sku, h, future_values=_fv,
                                                 future_events=_gl_future_events,
                                                 sku_attrs=_gl_sku_attrs,
                                                 user_strategies=_gl_exog_strategy)
            backtest_fn = lambda tr, hh: forecast_with_global_lgbm(global_pkg, sku, hh)
            notes = 'Global LightGBM (cross-SKU learning)'

    elif strategy == 'local_sarimax_promo':
        base_exog = ['log_price', 'price_changed', 'festive',
                     'other_imp_festivals', 'peak_month',
                     'scheme_days', 'weekends',
                     # Calendar-count temporal features SARIMAX can't derive
                     # from its seasonal order (vary year-to-year). Recomputed
                     # exactly on the horizon by build_future_exog; correlated
                     # duplicates are pruned by the exog-hygiene step. Seasonal
                     # *index* features (seasonality_multiplier/is_peak_season)
                     # are deliberately omitted — SARIMAX models seasonality
                     # natively, so they'd double-count.
                     'days_in_month', 'weekends_in_month',
                     'num_special_festivals', 'num_other_holidays']
        user_exog = list((cfg or {}).get('exog_user_numeric') or [])
        event_cols = [c for c in sku_panel.columns if c.startswith('evt_')]
        # dict.fromkeys → order-preserving dedupe (user may have re-selected a
        # column also present in base_exog; duplicate columns crash SARIMAX).
        exog_cols = list(dict.fromkeys(
            c for c in (base_exog + user_exog + event_cols)
            if c in sku_panel.columns))
        sku_attrs = {
            'category': sku_panel['category'].iloc[0] if 'category' in sku_panel.columns and len(sku_panel) else None,
            'brand':    sku_panel['brand'].iloc[0]    if 'brand'    in sku_panel.columns and len(sku_panel) else None,
            'segment':  (profile_row or {}).get('segment'),
        }
        future_events_df = (cfg or {}).get('future_events')
        # Per-column future-projection overrides + holiday calendar (from UI).
        exog_strategy_map = (cfg or {}).get('exog_future_strategy') or {}
        exog_future_values_map = (cfg or {}).get('exog_future_values') or {}
        holiday_country = (cfg or {}).get('holiday_country', 'IN')
        # Hero SKUs (Stable High contributors) get per-SKU auto-arima
        # order selection. PERF: search the order ONCE here on the full
        # history, then pass it as `cached_order` to every subsequent
        # call (backtests, CV folds, rolling origins). Without this
        # cache, auto_arima would re-run 13+ times per SKU — adding
        # several minutes per Stable High SKU on a sampled run.
        _seg_label = str((profile_row or {}).get('segment') or '')
        _use_auto_order = _seg_label == 'Stable High contributors'
        _sku_cached_order: Optional[Tuple[Tuple, Tuple]] = None
        if _use_auto_order:
            try:
                import pmdarima as _pm  # type: ignore
                _seas_m = {'D': 7, 'W': 52, 'MS': 12, 'M': 12, 'QS': 4}.get(freq, 12)
                _use_seasonal = (_seas_m > 1 and len(history) >= 2 * _seas_m)
                _hist_for_search = _winsorize_series(history)[0]
                _auto_pre = _pm.auto_arima(
                    _hist_for_search.values,
                    seasonal=_use_seasonal,
                    m=_seas_m if _use_seasonal else 1,
                    suppress_warnings=True, error_action='ignore',
                    stepwise=True, max_p=2, max_q=2, max_P=1, max_Q=1,
                    max_d=2, max_D=1, seasonal_test='ocsb',
                )
                _sku_cached_order = (_auto_pre.order, _auto_pre.seasonal_order)
            except Exception:
                _sku_cached_order = None
        if exog_cols:
            exog_train = sku_panel.set_index(date_col)[exog_cols]
            exog_future = build_future_exog(exog_train, h, freq,
                                            future_events=future_events_df,
                                            sku_attrs=sku_attrs,
                                            sku_col=sku_col,
                                            user_strategies=exog_strategy_map,
                                            holiday_country=holiday_country,
                                            future_values=exog_future_values_map)
            forecast, ci = forecast_sarimax_with_promo(
                history, h, freq, exog_train, exog_future,
                auto_order=_use_auto_order,
                cached_order=_sku_cached_order,
            )
            def _sarimax_bt(tr, hh, _exog=exog_train, _freq=freq,
                            _ev=future_events_df, _attrs=sku_attrs, _sc=sku_col,
                            _auto=_use_auto_order, _cache=_sku_cached_order,
                            _strat=exog_strategy_map, _hc=holiday_country):
                exog_tr = _exog.loc[_exog.index <= tr.index[-1]]
                exog_fu = build_future_exog(exog_tr, hh, _freq,
                                            future_events=_ev,
                                            sku_attrs=_attrs,
                                            sku_col=_sc,
                                            user_strategies=_strat,
                                            holiday_country=_hc)
                pred, _ = forecast_sarimax_with_promo(
                    tr, hh, _freq, exog_tr, exog_fu,
                    auto_order=_auto, cached_order=_cache)
                return pred
            backtest_fn = _sarimax_bt
        else:
            forecast, ci = forecast_sarimax_with_promo(
                history, h, freq,
                auto_order=_use_auto_order, cached_order=_sku_cached_order)
            backtest_fn = lambda tr, hh, _auto=_use_auto_order, \
                                 _cache=_sku_cached_order: \
                forecast_sarimax_with_promo(
                    tr, hh, freq, auto_order=_auto, cached_order=_cache)[0]
        if _use_auto_order and _sku_cached_order is not None:
            notes = (f'Auto-arima order {_sku_cached_order[0]} × '
                     f'{_sku_cached_order[1]} (cached) + outlier-flag + '
                     'price/promo regressors')
        elif _use_auto_order:
            notes = 'Auto-arima + outlier-flag + price/promo regressors'
        else:
            notes = 'SARIMAX + price/promo regressors'

    elif strategy == 'ensemble_local':
        preds = [forecast_holt_winters(history, h, freq)]
        sarimax_pred, _ = forecast_sarimax_with_promo(history, h, freq)
        preds.append(sarimax_pred)
        if global_pkg is not None:
            _fv = (cfg or {}).get('exog_future_values') or {}
            preds.append(forecast_with_global_lgbm(global_pkg, sku, h, future_values=_fv,
                                                 future_events=_gl_future_events,
                                                 sku_attrs=_gl_sku_attrs,
                                                 user_strategies=_gl_exog_strategy))
        stacked = pd.concat([p.reset_index(drop=True) for p in preds], axis=1)
        forecast = stacked.median(axis=1)
        forecast.index = preds[0].index
        def _ens_bt(tr, hh, _freq=freq):
            bp = [forecast_holt_winters(tr, hh, _freq)]
            sx, _ = forecast_sarimax_with_promo(tr, hh, _freq)
            bp.append(sx)
            if global_pkg is not None:
                bp.append(forecast_with_global_lgbm(global_pkg, sku, hh))
            return pd.concat([p.reset_index(drop=True) for p in bp], axis=1).median(axis=1)
        backtest_fn = _ens_bt
        notes = f'Ensemble median ({len(preds)} models)'

    elif strategy == 'moe':
        # Mixture of Experts â trend + seasonality + event + exog experts,
        # combined by a validation-optimised gate. forecast_moe owns its own
        # exog resolution + backtest closure.
        forecast, ci, notes, backtest_fn = forecast_moe(
            history, h, freq, sku_panel=sku_panel, date_col=date_col,
            sku_col=sku_col, cfg=cfg, profile_row=profile_row)

    elif strategy == 'dl_moe':
        # Deep-learning MoE (Keras: trend + Fourier-seasonality + transformer
        # experts, softmax gating). Opt-in only; degrades to Holt-Winters when
        # TensorFlow is unavailable. Owns its own exog resolution + backtest.
        forecast, ci, notes, backtest_fn = forecast_dl_moe(
            history, h, freq, sku_panel=sku_panel, date_col=date_col,
            sku_col=sku_col, cfg=cfg, profile_row=profile_row)

    elif strategy in ADDITIONAL_FORECASTERS:
        # Univariate additional algorithm used as primary (segment override path)
        fn = ADDITIONAL_FORECASTERS[strategy]
        forecast = fn(history, h, freq)
        backtest_fn = lambda tr, hh, _fn=fn: _fn(tr, hh, freq)
        notes = f"{strategy} (additional algorithm as primary)"

    else:
        forecast = forecast_holt_winters(history, h, freq)
        backtest_fn = lambda tr, hh: forecast_holt_winters(tr, hh, freq)
        notes = f"Unknown strategy '{strategy}' → Holt-Winters fallback"

    return forecast, ci, notes, backtest_fn


def _smart_test_horizon(forecast_h: int, n_history: int) -> int:
    """Length of the out-of-sample Test window, as a forecasting-sane function
    of the forecast horizon and the history we actually have.

    The Test window mirrors the PRODUCTION horizon, so "Test WMAPE" answers the
    question the planner cares about — *how wrong are we over the next
    `forecast_h` periods we're about to ship?* — rather than an easy 1-step peek.

    Short-history handling (history < horizon, or barely longer): a holdout
    backtest needs at least as much data to TRAIN as it reserves to TEST, so we
    never hand more than half the series to the test window. When the horizon is
    longer than half the history we shrink the test to the largest leak-free
    window we can still afford, instead of refusing to evaluate. Returns 0 only
    when there aren't even 2 periods to split into train + test.
    """
    if n_history < 2:
        return 0
    return max(1, min(forecast_h, n_history // 2))


def forecast_one_sku(sku: str, panel: pd.DataFrame, profile_row: dict,
                     h: int, freq: str, sku_col: str, date_col: str, sales_col: str,
                     global_pkg: Optional[GlobalModelPackage] = None,
                     global_pkg_backtest: Optional[GlobalModelPackage] = None,
                     chronos_pipeline=None,
                     run_backtest: bool = True,
                     portfolio: Optional[dict] = None,
                     cfg: Optional[dict] = None,
                     cv_mode: bool = False,
                     cv_k: int = 3,
                     cv_min_history: int = MIN_HISTORY_FOR_CV,
                     compare_algos: Optional[List[str]] = None) -> ForecastResult:
    """Single-SKU forecast — runs the full 5-stage demand-forecasting pipeline.

    ═══════════════════════════════════════════════════════════════════════
    PIPELINE STAGE ORDER  (every SKU's final forecast goes through all of
    these in sequence; each stage is gated and may pass through silently):

      0. CANDIDATE POOL BUILD
         → primary (segment recipe) + blend members + safety defaults
         → one fit per candidate on full history (cached for reuse)

      1. CHAMPION-BY-HOLDOUT  (LEAKAGE-SHIELDED)
         → every candidate scored on a validation slice
         → validation_offset=EVAL_HORIZON reserves the headline-reporting
           slice STRICTLY EARLIER, so champion selection ≠ WMAPE reporting
         → winner overrides `strategy`; tie-band keeps primary on noise

      1b. HYPERPARAMETER FINE-TUNING  (winner-only)
         → grid search the winner's parameters on the same val slice
         → tunable: holt_winters {trend, seasonal, damped}, sarimax
           {(p,d,q), (P,D,Q,m)}. Others pass through.
         → tuned variant adopted ONLY if it beats champion's val_WMAPE

      2. CONDITIONAL XGB RESIDUAL CORRECTION  (gated)
         → fires ONLY when validation_WMAPE ≥ 20% (out-of-sample signal,
           not in-sample residual proxy)
         → adds high_residual_flag + residual_sign features so the booster
           learns the CALENDAR PATTERN of where the base model fails
         → 70% dampening to avoid over-correction on short series

      3. BUSINESS-RULE GUARDRAILS  (always-on)
         → MoM clip: forecast[t]/forecast[t-1] in [5th, 95th] quantile of
           historical MoM ratios × (1 ± 50% tolerance)
         → YoY clip: forecast[t] in history[t-12] × (μ ± 3σ) of historical
           YoY ratios
         → CLIP-only — never invents demand, only constrains extremes

      4. HEADLINE METRICS REPORTING  (last)
         → test WMAPE / sWMAPE / bias on history[-EVAL_HORIZON:]
         → train WMAPE via rolling-origin on history[:-EVAL_HORIZON]
         → all_algorithm_metrics emitted for the UI's drill-down table

    EVAL_HORIZON scales with `h`: max(1, min(h, len(history)//4)). So a
    6-month forecast validates and reports on a 6-month slice (provided
    history is long enough); a 1-month forecast uses 1 month.

    Backtesting principles
    ----------------------
      • Every strategy is backtested when feasible (not just Croston).
      • For global LightGBM, `global_pkg_backtest` should be trained on a
        panel with the last `h` periods removed per SKU — prevents the
        test period from leaking into the global model's training set.
      • When WMAPE cannot be computed (short history, all-zero test, model
        failure), we record an explicit reason instead of silent None.
    ═══════════════════════════════════════════════════════════════════════
    """
    sku_panel = panel[panel[sku_col] == sku].sort_values(date_col)
    history = sku_panel.set_index(date_col)[sales_col]
    # Defensive: collapse any duplicate datetime entries to their sum.
    # build_panel_features does NOT resample, so if the source data has
    # multiple rows per (sku, period) — e.g., unaggregated channel splits —
    # this index will carry duplicates. Downstream backtest .loc[overlap]
    # would then expand actuals while predictions stay unique, producing
    # a shape-mismatch in _compute_mape_smape (e.g. (6,) vs (2,)).
    if history.index.duplicated().any():
        history = history.groupby(level=0).sum().sort_index()
    # Auto-routed strategy from profiling — preserved for the result so the UI
    # can show "originally routed to X, user overrode to Y".
    auto_strategy = profile_row.get('recommended_strategy', 'ensemble_local')

    # ── DTW lookalikes (new-product / short-history SKUs only) ──────
    # Surfaces the top-K SKUs the engine is effectively borrowing shape
    # from. Cheap to compute (one DTW pass over ≤200 candidates) and we
    # ONLY run it when the target's own history is thin enough that
    # analogue-borrowing is the actual forecasting strategy — for long-
    # history SKUs the local model is authoritative and this would be
    # noise.
    lookalikes: List[Dict[str, Any]] = []
    lookalike_reason: str = ''
    try:
        _is_cold = bool(profile_row.get('is_cold_start'))
        _is_short = bool(profile_row.get('is_short_history'))
        _seg_label = str(profile_row.get('segment') or '').strip()
        # Also fire for the lifecycle override segments injected by
        # compute_retail_segmentation (New product / Short history).
        _seg_triggers = {'New product', 'Short history'}
        if _is_cold or _is_short or (_seg_label in _seg_triggers):
            _target_brand = profile_row.get('brand')
            lookalikes = find_dtw_lookalikes(
                target_history=history,
                panel=panel,
                sku_col=sku_col, date_col=date_col, sales_col=sales_col,
                target_sku=sku,
                top_k=5,
                min_proxy_len=12,
                max_candidates=200,
                brand_col='brand' if 'brand' in panel.columns else None,
                target_brand=_target_brand if _target_brand else None,
                same_brand_only=False,
            )
            _why = ('cold-start' if _is_cold
                    else 'short-history' if _is_short
                    else _seg_label.lower())
            lookalike_reason = (
                f"{_why}: {len(history)} months of own history "
                f"→ borrowing shape from {len(lookalikes)} closest analogue(s)"
            )
    except Exception as _le:
        lookalike_reason = f"lookalike search skipped ({type(_le).__name__})"

    # Apply user portfolio (per-segment override + global enable/disable +
    # additional-algorithm picks) on top of the auto-routed default.
    strategy, extras = resolve_effective_strategy(profile_row, portfolio)

    # ─────────────────────────────────────────────────────────────────
    # Validation/reporting horizon — scales with the forecast horizon h.
    # Rationale: validating a 6-month forecast against a 1-month holdout
    # is a weak signal; we want the validation window to mirror the
    # production horizon. Capped at 1/4 of history so we don't burn
    # the training set on validation for long horizons (e.g. h=12 on a
    # 24-month SKU would otherwise reserve 50% of history for testing).
    # Lower bound = 1 month so single-month forecasts still work.
    #
    # This single constant is used BY:
    #   • Stage 1 — Champion-by-holdout (validation slice size)
    #   • Stage 2 — Conditional XGB residual gate (val_mape threshold)
    #   • Headline reporting backtest at the bottom of this function
    # ─────────────────────────────────────────────────────────────────
    EVAL_HORIZON = max(1, min(h, max(1, len(history) // 4)))

    # Headline Test-WMAPE window — mirrors the production horizon (capped at
    # half of history). Distinct from EVAL_HORIZON, which stays narrow (¼ of
    # history) for *champion selection* so it doesn't burn the training set.
    # The reported Test number is leak-free either way: backtest_holdout refits
    # the backtest_fn on history[:-TEST_HORIZON], and the global backtest LGBM
    # excludes the full forecast horizon (>= TEST_HORIZON) per SKU.
    TEST_HORIZON = _smart_test_horizon(h, len(history))

    # Planner events + projection overrides for the global-LGBM forecast, so
    # upcoming planned events influence its predictions the same way they do
    # SARIMAX (the model learned each event's lift during training). Used only
    # for the production/blend forecast — NOT the backtest closures, where the
    # holdout is a past window that future-dated planner events can't touch.
    _gl_future_events = (cfg or {}).get('future_events')
    _gl_sku_attrs = {'brand': (profile_row or {}).get('brand'),
                     'segment': (profile_row or {}).get('segment')}
    _gl_exog_strategy = (cfg or {}).get('exog_future_strategy') or {}

    # ---- Build candidate pool ONCE (shared by CV + always-on eval + extras) ----
    # Performance: previously the candidate pool was built up to 3 times per
    # SKU (once for CV, once for the always-on evaluator, once for benchmark
    # extras), each rebuild triggering N fresh fits. We now build it once and
    # all three downstream uses read from the same dict.
    #
    # Skip pool building for trivially-cheap or trivially-routed strategies:
    #   - dead SKUs (naive_zero) — pool would be wasted, zero forecast wins
    #   - cold-start (chronos_zero_shot) — model dispatcher already owns the
    #     fit; pool can't usefully compete with no history to fit on
    #
    # PERF: For short-history (<12 mo) SKUs, skip the heaviest stages
    # (hyperparameter tuning + XGB residual correction). Champion selection
    # and the full candidate-pool fit STILL run so every SKU gets all blended
    # models evaluated with per-algorithm WMAPE.
    skip_expensive_stages = (
        len(history) < 12
        or profile_row.get('intermittency') == 'dead'
        or profile_row.get('is_cold_start')
    )
    # Only skip the candidate pool for truly dead SKUs (the zero forecast is
    # the right answer by definition) or completely empty history. The pool
    # build runs regardless of `run_backtest` — without backtest scoring we
    # still get each candidate's future_forecast, so the All-models per SKU
    # table can show every Primary + Blend member's projection for each SKU.
    # Individual fits are guarded by try/except inside build_candidate_backtest_fns,
    # so candidates that can't fit on short history are silently dropped
    # rather than crashing the whole pool.
    skip_pool = (strategy == 'naive_zero' or len(history) < 2)
    candidate_fns: Dict[str, Tuple[Any, pd.Series]] = {}
    pool_build_error: str = ''
    pool_candidate_errors: Dict[str, str] = {}
    if not skip_pool:
        try:
            candidate_fns = build_candidate_backtest_fns(
                history=history, sku=sku, h=h, freq=freq,
                sku_panel=sku_panel, date_col=date_col, sku_col=sku_col,
                profile_row=profile_row, cfg=cfg,
                global_pkg=global_pkg, chronos_pipeline=chronos_pipeline,
                portfolio=portfolio,
                errors_out=pool_candidate_errors,
                compare_algos=compare_algos,
            )
        except Exception as _pbe:
            candidate_fns = {}
            pool_build_error = f"{type(_pbe).__name__}: {_pbe}"
        # If build returned an empty dict, surface the per-candidate
        # failure reasons so we can see exactly which models died.
        if not candidate_fns and pool_candidate_errors and not pool_build_error:
            pool_build_error = "all candidates failed: " + "; ".join(
                f"{c}={e}" for c, e in list(pool_candidate_errors.items())[:5]
            )
    elif skip_pool:
        pool_build_error = (
            f"pool skipped: strategy={strategy!r}, "
            f"len(history)={len(history)}"
        )

    # ─────────────────────────────────────────────────────────────────
    # 🏆 PIPELINE STAGE 1 — CHAMPION-BY-HOLDOUT (leakage-shielded)
    # PERF: Skip for short-history SKUs (< 12 months) to save time
    # ─────────────────────────────────────────────────────────────────
    champion_pipeline_note: str = ''
    champion_val_mape: Optional[float] = None
    # Per-candidate validation WMAPEs — these are the numbers the champion
    # selector ACTUALLY ranked. Stored separately from headline test WMAPE
    # so the UI can show both: val WMAPE explains *why this is champion*,
    # test WMAPE is the leak-free reported number on a strictly later slice.
    champion_val_metrics: Dict[str, Dict[str, Any]] = {}
    if run_backtest and not skip_pool and candidate_fns:
        try:
            _winner, _champ_metrics, _champ_note = pick_champion_by_holdout(
                history=history,
                candidate_fns=candidate_fns,
                eval_h=EVAL_HORIZON,
                primary_strategy=strategy,
                tie_band=0.02,
                validation_offset=EVAL_HORIZON,
            )
            champion_pipeline_note = _champ_note
            if _winner != strategy:
                strategy = _winner
            if _champ_metrics and strategy in _champ_metrics:
                champion_val_mape = _champ_metrics[strategy].get('test_mape')
            # Stash the full per-candidate val-WMAPE dict for the UI table.
            champion_val_metrics = _champ_metrics or {}
        except Exception as _ce:
            champion_pipeline_note = f"champion: skipped ({type(_ce).__name__})"

    # ─────────────────────────────────────────────────────────────────
    # 🔬 PIPELINE STAGE 1b — HYPERPARAMETER FINE-TUNING (on winner only)
    # PERF: Skip for short-history SKUs (< 12 months) to save time
    # ─────────────────────────────────────────────────────────────────
    tuning_pipeline_note: str = ''
    if run_backtest and not skip_pool and candidate_fns and not skip_expensive_stages:
        try:
            _tuned_fc, _tuned_bt_fn, _tuned_mape, _tune_note = fine_tune_winner(
                strategy=strategy,
                history=history,
                h=h,
                freq=freq,
                val_h=EVAL_HORIZON,
                sku_panel=sku_panel,
                date_col=date_col,
            )
            tuning_pipeline_note = _tune_note
            if (_tuned_fc is not None and _tuned_bt_fn is not None
                    and _tuned_mape is not None
                    and (champion_val_mape is None or _tuned_mape <= champion_val_mape)):
                candidate_fns[strategy] = (_tuned_bt_fn, _tuned_fc)
                champion_val_mape = _tuned_mape
            elif _tuned_mape is not None and champion_val_mape is not None:
                tuning_pipeline_note += (f" — kept pre-tune (tuned_WMAPE "
                                         f"{_tuned_mape:.1f}% ≥ champ "
                                         f"{champion_val_mape:.1f}%)")
        except Exception as _te:
            tuning_pipeline_note = f"tuning: skipped ({type(_te).__name__})"

    # ---- K-fold CV algorithm selection (data-rich SKUs only) ----
    # When the user enabled "Auto-select via K-fold CV" AND this SKU has
    # enough history (≥ cv_min_history months), we evaluate a candidate
    # pool of algorithms on K time-series folds and override `strategy`
    # with the lowest-WMAPE winner. SKUs with short history fall through
    # to the existing portfolio-resolved strategy unchanged.
    # PERF: Also skip CV for trivially-routed strategies (Croston, Chronos, etc.)
    cv_selected_flag: bool = False
    cv_winner_strat: Optional[str] = None
    cv_results_dict: Dict[str, Any] = {}
    cv_reason_msg: str = ''
    skip_cv_for_strategy = strategy in ('naive_zero', 'chronos_zero_shot', 'croston_sba')
    # Per-segment override — Stable High contributors always run K-fold CV
    # because they're hero SKUs with enough history to make CV worthwhile,
    # and the extra accuracy from picking on 3 folds (vs 1 holdout) is
    # justified by the revenue importance. Other segments only run CV when
    # the user explicitly ticks the global cv_mode checkbox.
    _seg_label_for_cv = str((profile_row or {}).get('segment') or '')
    _force_cv_for_segment = (_seg_label_for_cv == 'Stable High contributors')
    _effective_cv_mode = cv_mode or _force_cv_for_segment
    if _effective_cv_mode and not skip_cv_for_strategy and not skip_expensive_stages:
        if len(history) >= cv_min_history and candidate_fns:
            try:
                # Reuse the already-built backtest_fns rather than rebuilding
                # — this halves the fit count when CV is on.
                cv_results_dict = {}
                for strat_name, (bt_fn, _ff) in candidate_fns.items():
                    cv_results_dict[strat_name] = timeseries_kfold_cv(
                        history, bt_fn, k=cv_k, h=1)
                ranked = [(s, r) for s, r in cv_results_dict.items()
                          if r.get('mean_mape') is not None]
                if ranked:
                    ranked.sort(key=lambda kv: (
                        kv[1]['mean_mape'],
                        kv[1]['mean_smape'] if kv[1]['mean_smape'] is not None else float('inf'),
                        kv[0],
                    ))
                    cv_winner_strat = ranked[0][0]
                    cv_selected_flag = True
                    strategy = cv_winner_strat
                    if _force_cv_for_segment and not cv_mode:
                        cv_reason_msg = ('CV auto-forced for Stable High '
                                          'contributor — picked '
                                          f'{cv_winner_strat} by mean CV WMAPE')
                else:
                    cv_reason_msg = 'no candidate produced a finite CV WMAPE'
            except Exception as _e:
                cv_reason_msg = f'CV errored: {type(_e).__name__}'
        elif len(history) < cv_min_history:
            cv_reason_msg = (f'history {len(history)} mo < {cv_min_history} '
                             f'required for {cv_k}-fold CV — kept portfolio strategy')
        else:
            cv_reason_msg = 'no candidate pool available for CV'
    elif skip_cv_for_strategy:
        cv_reason_msg = f'CV skipped for {strategy} (trivially-routed strategy)'
    elif skip_expensive_stages:
        cv_reason_msg = 'CV skipped for short-history SKU (<12 months)'

    forecast: Optional[pd.Series] = None
    ci: Optional[pd.DataFrame] = None
    mape: Optional[float] = None
    smape: Optional[float] = None
    bias_pct: Optional[float] = None
    bt_actual: Optional[pd.Series] = None
    bt_pred: Optional[pd.Series] = None
    mape_reason: str = ''
    notes: str = ''

    # Build the forecast_fn we'll use for backtesting BEFORE producing the
    # final forecast. The fn takes (train_series, h) → predicted Series.
    backtest_fn = None

    # ---- Fast-path: reuse the pool's primary fit ----
    # The candidate pool fit every strategy once on full history. If the
    # current `strategy` is in the pool, that fit (forecast + backtest_fn)
    # is already available — copy it instead of re-fitting in the dispatcher
    # below. Skips the dispatcher entirely for ~90% of SKUs and saves one
    # complete model fit each.
    if strategy in candidate_fns:
        _bt_fn, _ff = candidate_fns[strategy]
        if _ff is not None:
            forecast = _ff
            backtest_fn = _bt_fn
            ci = None  # pool doesn't compute prediction intervals — see below
            notes = f"Strategy {strategy} (pool-cached fit)"

    # ─────────────────────────────────────────────────────────────────
    # 🧬 PIPELINE STAGE 1c — WEIGHTED ENSEMBLE (Levers 3 & 5)
    # Replace the single champion with a robust weighted blend of the top-k
    # candidates — but ONLY if the blend is no worse than the champion on the
    # same leakage-shielded validation slice (guarantees no regression vs
    # winner-takes-all). Disabled for trivially-routed / short-history SKUs.
    # ─────────────────────────────────────────────────────────────────
    blend_pipeline_note: str = ''
    if (ENABLE_WEIGHTED_BLEND and run_backtest and not skip_pool
            and len(candidate_fns) >= 2 and champion_val_metrics
            and strategy not in ('naive_zero', 'chronos_zero_shot', 'croston_sba')
            and not skip_expensive_stages
            and backtest_fn is not None
            and champion_val_mape is not None
            and champion_val_mape >= BLEND_MIN_VAL_WMAPE):
        try:
            _arch_blend = get_segment_architecture(profile_row or {})
            _blend = build_weighted_blend(
                candidate_fns, champion_val_metrics,
                _arch_blend.get('blend_method'), freq, top_k=BLEND_TOP_K,
            )
            if _blend is not None:
                _bfc, _bbt, _blabel, _bmembers = _blend
                # Robust adopt/reject: compare champion vs blend over K rolling
                # folds (not a single noisy slice). Adopt only if the blend's
                # mean fold WMAPE is ≤ the champion's — so we keep the big wins
                # on high-error SKUs without the low-error regressions a
                # single-slice decision produced.
                _kf = max(2, min(BLEND_DECISION_FOLDS,
                                 max(0, len(history) - EVAL_HORIZON - 2)))
                _champ_cv = timeseries_kfold_cv(history, backtest_fn,
                                                k=_kf, h=1).get('mean_mape')
                _blend_cv = timeseries_kfold_cv(history, _bbt,
                                                k=_kf, h=1).get('mean_mape')
                if (_blend_cv is not None and _champ_cv is not None
                        and _blend_cv <= _champ_cv + 1e-9):
                    forecast = _bfc
                    backtest_fn = _bbt
                    ci = None
                    strategy = _blabel
                    blend_pipeline_note = (
                        f"ensemble: adopted {_blabel} "
                        f"({_kf}-fold WMAPE {_blend_cv:.1f}% ≤ champion {_champ_cv:.1f}%)")
                else:
                    blend_pipeline_note = (
                        "ensemble: kept champion "
                        f"(blend {_kf}-fold WMAPE "
                        f"{_blend_cv if _blend_cv is not None else float('nan'):.1f}% "
                        f"> champion "
                        f"{_champ_cv if _champ_cv is not None else float('nan'):.1f}%)")
        except Exception as _ble:
            blend_pipeline_note = f"ensemble: skipped ({type(_ble).__name__})"

    try:
        if forecast is not None:
            # Already populated via pool fast-path — skip dispatcher entirely
            pass
        elif strategy == 'naive_zero':
            idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
            forecast = pd.Series([0.0] * h, index=idx)
            notes = 'Dead SKU — zero forecast'
            backtest_fn = lambda tr, hh: pd.Series([0.0] * hh)

        elif strategy == 'chronos_zero_shot':
            forecast, ci = forecast_chronos(history, h, freq, chronos_pipeline)
            notes = 'Cold-start: Amazon Chronos zero-shot'
            backtest_fn = lambda tr, hh: forecast_chronos(tr, hh, freq, chronos_pipeline)[0]

        elif strategy == 'croston_sba':
            arr = sba(history.values, alpha=0.1, h=h)
            idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
            forecast = pd.Series(arr, index=idx)
            notes = f"Intermittent ({profile_row['intermittency']}): SBA"
            backtest_fn = lambda tr, hh: pd.Series(sba(tr.values, 0.1, hh))

        elif strategy in ('global_lgbm', 'global_lgbm_full'):
            if global_pkg is None:
                forecast = forecast_holt_winters(history, h, freq)
                notes = 'Global LGBM unavailable → Holt-Winters fallback'
                backtest_fn = lambda tr, hh: forecast_holt_winters(tr, hh, freq)
            else:
                _fv = (cfg or {}).get('exog_future_values') or {}
                forecast = forecast_with_global_lgbm(global_pkg, sku, h, future_values=_fv,
                                                 future_events=_gl_future_events,
                                                 sku_attrs=_gl_sku_attrs,
                                                 user_strategies=_gl_exog_strategy)
                notes = 'Global LightGBM (cross-SKU learning)'
                # Use the leak-free backtest model when available
                if global_pkg_backtest is not None:
                    backtest_fn = lambda tr, hh, _pkg=global_pkg_backtest, _sku=sku: \
                        forecast_with_global_lgbm(_pkg, _sku, hh)
                else:
                    mape_reason = 'global LGBM backtest skipped: no leak-free model trained ' \
                                  '(set run_backtest=True at engine level)'

        elif strategy == 'local_sarimax_promo':
            # Base exog (built-in price/promo signals) + user-supplied numeric
            # exog from the sidebar + any evt_<slug> event flags injected into
            # the panel by enrich_df_with_events.
            base_exog = ['log_price', 'price_changed', 'festive',
                         'other_imp_festivals', 'peak_month',
                         'scheme_days', 'weekends',
                         # Calendar-count temporal features (recomputed exactly
                         # on the horizon; correlated dups pruned by hygiene).
                         'days_in_month', 'weekends_in_month',
                         'num_special_festivals', 'num_other_holidays']
            user_exog = list((cfg or {}).get('exog_user_numeric') or [])
            event_cols = [c for c in sku_panel.columns if c.startswith('evt_')]
            # dict.fromkeys → order-preserving dedupe (user may have re-selected
            # a column also present in base_exog; dup columns crash SARIMAX).
            exog_cols = list(dict.fromkeys(
                c for c in (base_exog + user_exog + event_cols)
                if c in sku_panel.columns))
            # Resolve this SKU's attributes once for future-event scope checks
            sku_attrs = {
                'category': sku_panel['category'].iloc[0] if 'category' in sku_panel.columns and len(sku_panel) else None,
                'brand':    sku_panel['brand'].iloc[0]    if 'brand'    in sku_panel.columns and len(sku_panel) else None,
                'segment':  profile_row.get('segment'),
            }
            future_events_df = (cfg or {}).get('future_events')
            exog_strategy_map = (cfg or {}).get('exog_future_strategy') or {}
            exog_future_values_map = (cfg or {}).get('exog_future_values') or {}
            holiday_country = (cfg or {}).get('holiday_country', 'IN')
            if exog_cols:
                exog_train = sku_panel.set_index(date_col)[exog_cols]
                exog_future = build_future_exog(exog_train, h, freq,
                                                future_events=future_events_df,
                                                sku_attrs=sku_attrs,
                                                sku_col=sku_col,
                                                user_strategies=exog_strategy_map,
                                                holiday_country=holiday_country,
                                                future_values=exog_future_values_map)
                forecast, ci = forecast_sarimax_with_promo(history, h, freq, exog_train, exog_future)

                # Backtest fn: rebuild exog for the train slice, generate exog
                # for the holdout window using build_future_exog (so it doesn't
                # peek at the test period). We still pass future_events so any
                # events in the holdout horizon are reflected.
                def sarimax_backtest_fn(tr, hh, _exog=exog_train, _freq=freq,
                                        _ev=future_events_df, _attrs=sku_attrs,
                                        _sku_col=sku_col, _strat=exog_strategy_map,
                                        _hc=holiday_country):
                    exog_tr = _exog.loc[_exog.index <= tr.index[-1]]
                    exog_fu = build_future_exog(exog_tr, hh, _freq,
                                                future_events=_ev,
                                                sku_attrs=_attrs,
                                                sku_col=_sku_col,
                                                user_strategies=_strat,
                                                holiday_country=_hc)
                    pred, _ = forecast_sarimax_with_promo(tr, hh, _freq, exog_tr, exog_fu)
                    return pred
                backtest_fn = sarimax_backtest_fn
            else:
                forecast, ci = forecast_sarimax_with_promo(history, h, freq)
                backtest_fn = lambda tr, hh: forecast_sarimax_with_promo(tr, hh, freq)[0]
            notes = 'Stable High: SARIMAX + price/promo regressors'

        elif strategy == 'ensemble_local':
            preds = [forecast_holt_winters(history, h, freq)]
            sarimax_pred, _ = forecast_sarimax_with_promo(history, h, freq)
            preds.append(sarimax_pred)
            if global_pkg is not None:
                _fv = (cfg or {}).get('exog_future_values') or {}
                preds.append(forecast_with_global_lgbm(global_pkg, sku, h, future_values=_fv,
                                                 future_events=_gl_future_events,
                                                 sku_attrs=_gl_sku_attrs,
                                                 user_strategies=_gl_exog_strategy))
            stacked = pd.concat([p.reset_index(drop=True) for p in preds], axis=1)
            forecast = stacked.median(axis=1)
            forecast.index = preds[0].index
            notes = f'Ensemble median ({len(preds)} models)'

            def ensemble_backtest_fn(tr, hh, _bt_pkg=global_pkg_backtest, _sku=sku, _freq=freq):
                bt_preds = [forecast_holt_winters(tr, hh, _freq)]
                bt_sarimax, _ = forecast_sarimax_with_promo(tr, hh, _freq)
                bt_preds.append(bt_sarimax)
                if _bt_pkg is not None:
                    bt_preds.append(forecast_with_global_lgbm(_bt_pkg, _sku, hh))
                bt_stacked = pd.concat([p.reset_index(drop=True) for p in bt_preds], axis=1)
                return bt_stacked.median(axis=1)
            backtest_fn = ensemble_backtest_fn

        elif strategy == 'moe':
            # Mixture of Experts â trend + seasonality + event + exog experts
            # combined by a validation-optimised gate (see forecast_moe).
            forecast, ci, notes, backtest_fn = forecast_moe(
                history, h, freq, sku_panel=sku_panel, date_col=date_col,
                sku_col=sku_col, cfg=cfg, profile_row=profile_row)

        elif strategy == 'dl_moe':
            # Deep-learning MoE (Keras). Opt-in; HW fallback when TF unavailable.
            forecast, ci, notes, backtest_fn = forecast_dl_moe(
                history, h, freq, sku_panel=sku_panel, date_col=date_col,
                sku_col=sku_col, cfg=cfg, profile_row=profile_row)

        elif strategy in ADDITIONAL_FORECASTERS:
            # Segment-override path: user picked an additional univariate
            # algorithm (Prophet / AutoARIMA / Holt-Winters / TSB / Naive
            # Seasonal / Theta) as the primary for this segment.
            _fn = ADDITIONAL_FORECASTERS[strategy]
            forecast = _fn(history, h, freq)
            backtest_fn = lambda tr, hh, _f=_fn: _f(tr, hh, freq)
            notes = (f"{ADDITIONAL_ALGORITHMS.get(strategy, {}).get('name', strategy)}"
                     f" (segment override)")

        else:
            forecast = forecast_holt_winters(history, h, freq)
            notes = f"Unknown strategy '{strategy}' → Holt-Winters fallback"
            backtest_fn = lambda tr, hh: forecast_holt_winters(tr, hh, freq)

    except Exception as e:
        idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
        forecast = pd.Series([history.mean()] * h, index=idx)
        notes = f'Strategy {strategy} errored ({type(e).__name__}); used historical mean'
        mape_reason = f'forecast itself errored: {type(e).__name__}'

    # Evaluate over the FORECAST HORIZON — the planner's headline metric.
    # Hold out the last TEST_HORIZON periods, forecast them, compare. The
    # leak-free global LGBM was trained with the full horizon removed per SKU,
    # so its predictions over this window are genuinely out-of-sample.
    # TEST_HORIZON already shrinks for short-history SKUs (<= half of history);
    # when it's smaller than the requested horizon `h`, we note that so the UI
    # can tell the planner the test couldn't span the whole horizon.
    if run_backtest and backtest_fn is not None and not mape_reason:
        if TEST_HORIZON >= 1 and len(history) >= 2 * TEST_HORIZON:
            mape, smape, bias_pct, bt_actual, bt_pred, mape_reason = \
                backtest_holdout(history, TEST_HORIZON, backtest_fn)
            # ── Apply Stage-3 guardrails to bt_pred ──────────────────
            # Production forecasts get MoM/YoY clipped, but historically
            # bt_pred was the RAW model output — so a single SARIMAX
            # numerical blow-up could push test WMAPE to >100% while the
            # production forecast (clipped) looked fine. Apply the same
            # guardrails here, using ONLY the training portion of history
            # as the band source (no leakage of test actuals into the
            # band). Then re-score WMAPE on the clipped predictions so the
            # headline number matches what production actually ships.
            if bt_pred is not None and len(bt_pred) > 0 and len(history) > 2 * TEST_HORIZON:
                try:
                    _bt_train_hist = history.iloc[:-TEST_HORIZON]
                    bt_pred_clipped, _bt_clip_note = apply_business_rules(
                        history=_bt_train_hist, forecast=bt_pred, freq=freq,
                        mom_tolerance=0.50, yoy_z=3.0,
                    )
                    bt_pred = bt_pred_clipped
                    if bt_actual is not None and len(bt_actual) == len(bt_pred):
                        _bt_overlap = bt_actual.index.intersection(bt_pred.index)
                        if len(_bt_overlap) > 0:
                            _ba = bt_actual.loc[_bt_overlap].astype(float).values
                            _bp = bt_pred.loc[_bt_overlap].astype(float).values
                            mape, smape = _compute_mape_smape(_ba, _bp)
                            _bsum = float(_ba.sum())
                            bias_pct = (float((_bp.sum() - _bsum) / _bsum * 100)
                                        if _bsum > 0 else None)
                except Exception:
                    # Clipping is a best-effort post-processor; never let a
                    # bad SKU kill the headline metrics it was supposed to fix.
                    pass
            # Flag when history was too short to test the full horizon, so the
            # planner reads the Test number with the right caveat.
            if not mape_reason and TEST_HORIZON < h:
                mape_reason = (f'history too short for the full {h}-period horizon — '
                               f'Test WMAPE measured over {TEST_HORIZON} period(s)')
        else:
            mape_reason = (f'history too short ({len(history)} months) — '
                           f'need at least 2 periods to hold out an out-of-sample test')

    # ---- Training-set accuracy via rolling-origin 1-step backtest ----
    # Companion to the single-shot test holdout above. Walks the last K
    # months of the training portion (i.e. excluding the test holdout) and
    # records one-step-ahead predictions, so the user can both see (in the
    # SKU drill-down chart) and quantify (in the summary table) how well
    # the model fits history vs how well it generalises.
    train_mape: Optional[float] = None
    train_smape: Optional[float] = None
    train_bias_pct: Optional[float] = None
    tr_actual: Optional[pd.Series] = None
    tr_pred: Optional[pd.Series] = None
    train_reason: str = ''
    if run_backtest and backtest_fn is not None:
        # For the CHAMPION specifically, extend K so the green "Historical
        # forecast" line on the chart spans more of history — up to 8
        # rolling-origin points (down from 12), capped at history-EVAL_HORIZON-2
        # to leave the earliest origins with enough leading data.
        # Cap chosen at 8 as a perf/quality trade-off — each extra window is
        # one extra model fit, and beyond 8 the chart already covers >half the
        # series for most SKUs without the additional cost.
        #
        # PERF: When CV already ran (Stable High SKUs auto-force CV; user
        # can also enable cv_mode globally), the engine already fit the
        # champion across 3 expanding-window folds. Running 8 MORE
        # rolling-origin fits on top is largely duplicate work — they
        # cover similar territory. Drop K to 4 in that case to keep the
        # chart's historical-fit line populated without re-doing the
        # heavy fit work. Saves ~4 SARIMAX fits per Stable High SKU.
        if cv_selected_flag:
            K_TRAIN_WINDOWS = max(3, min(4, max(0, len(history) - EVAL_HORIZON - 2)))
        else:
            K_TRAIN_WINDOWS = max(6, min(8, max(0, len(history) - EVAL_HORIZON - 2)))
        train_mape, train_smape, train_bias_pct, tr_actual, tr_pred, train_reason = \
            rolling_origin_train_backtest(
                history, backtest_fn, k_windows=K_TRAIN_WINDOWS, test_h=EVAL_HORIZON,
            )
        # ── Apply Stage-3 guardrails to tr_pred too ──────────────────
        # The rolling-origin predictions are what populates the green
        # dotted "In-sample fit" line on the chart and the Train WMAPE
        # headline. Raw model output here can produce wild spikes (the
        # SARIMAX numerical-blowup pattern) that bloat Train WMAPE into
        # the hundreds of percent. We clip them with the same MoM/YoY
        # band the production forecast gets — using a per-point training
        # slice so each predicted month sees only the data available at
        # that origin (no leakage).
        if tr_pred is not None and len(tr_pred) > 0:
            try:
                tr_pred_clipped = tr_pred.copy()
                for _ts in tr_pred_clipped.index:
                    # History strictly BEFORE this rolling origin
                    _slice = history[history.index < _ts]
                    if len(_slice) < 2:
                        continue
                    _one = tr_pred_clipped.loc[[_ts]]
                    _clipped, _ = apply_business_rules(
                        history=_slice, forecast=_one, freq=freq,
                        mom_tolerance=0.50, yoy_z=3.0,
                    )
                    tr_pred_clipped.loc[_ts] = _clipped.iloc[0]
                tr_pred = tr_pred_clipped
                # Recompute Train WMAPE on the clipped predictions
                if tr_actual is not None and len(tr_actual) > 0:
                    _tr_overlap = tr_actual.index.intersection(tr_pred.index)
                    if len(_tr_overlap) > 0:
                        _ta = tr_actual.loc[_tr_overlap].astype(float).values
                        _tp = tr_pred.loc[_tr_overlap].astype(float).values
                        train_mape, train_smape = _compute_mape_smape(_ta, _tp)
                        _tsum = float(_ta.sum())
                        train_bias_pct = (float((_tp.sum() - _tsum) / _tsum * 100)
                                          if _tsum > 0 else None)
            except Exception:
                pass

    # ════════════════════════════════════════════════════════════════
    # 🚀 PIPELINE STAGE 2 — CONDITIONAL XGB RESIDUAL CORRECTION
    # Fires ONLY when the chosen base model's average in-sample residual
    # exceeds 20% (user-requested threshold). The conditional variant
    # injects a `high_residual_flag` feature so the booster learns the
    # calendar pattern of residual spikes (e.g. festive months) instead
    # of smearing the correction uniformly. Capped at 70% dampening.
    # ════════════════════════════════════════════════════════════════
    # ════════════════════════════════════════════════════════════════
    # 🚀 PIPELINE STAGE 2 — CONDITIONAL XGB RESIDUAL CORRECTION
    # PERF: Skip for short-history SKUs (< 12 months) to save time
    # ════════════════════════════════════════════════════════════════
    residual_pipeline_note: str = ''
    try:
        _arch = get_segment_architecture(profile_row or {})
        if (_arch.get('residual_booster') == 'xgb'
                and forecast is not None
                and tr_pred is not None and len(tr_pred) >= 6
                and tr_actual is not None
                and not skip_expensive_stages):  # ← NEW: skip for perf
            # Future-feature frame — use deterministic calendar-derived
            # columns only (Fourier, month/quarter/year). Anything lag /
            # rolling-based isn't safe to extrapolate.
            _det_cols = [c for c in (
                'month', 'quarter', 'year',
                'sin_month', 'cos_month',
                'sin_quarter', 'cos_quarter',
                'sin_week', 'cos_week',
                'sin_dow', 'cos_dow',
                'is_holiday', 'days_to_next_holiday', 'days_from_prev_holiday',
                'log_price', 'price_changed', 'price_change_pct',
                'festive', 'peak_month', 'scheme_days', 'weekends',
                # Calendar-deterministic temporal features (recomputed below).
                'days_in_month', 'business_days_in_month', 'weekends_in_month',
                'num_holidays_in_month', 'num_special_festivals',
                'num_other_holidays', 'seasonality_multiplier', 'is_peak_season',
            ) if c in sku_panel.columns]
            if _det_cols:
                _hist_exog = (
                    sku_panel.set_index(date_col)[_det_cols]
                    .reindex(history.index).fillna(0)
                )
                # Build future exog by extending the calendar — sin/cos and
                # month/quarter/year are pure date functions, so reconstruct
                # them on the forecast index directly.
                _fut_idx = forecast.index
                _fut_df = pd.DataFrame(index=_fut_idx)
                _fut_df['month'] = _fut_idx.month
                _fut_df['quarter'] = _fut_idx.quarter
                _fut_df['year'] = _fut_idx.year
                _fut_df['sin_month'] = np.sin(2 * np.pi * _fut_df['month'] / 12.0)
                _fut_df['cos_month'] = np.cos(2 * np.pi * _fut_df['month'] / 12.0)
                _fut_df['sin_quarter'] = np.sin(2 * np.pi * _fut_df['quarter'] / 4.0)
                _fut_df['cos_quarter'] = np.cos(2 * np.pi * _fut_df['quarter'] / 4.0)
                # Recompute the richer calendar-deterministic temporal features
                # exactly on the horizon (days_in_month, holiday/festival counts,
                # seasonality, …) rather than backfilling them with the last
                # observed value — those vary year-to-year.
                if build_temporal_features_for_index is not None:
                    try:
                        _fc = build_temporal_features_for_index(
                            _fut_idx, freq=freq, holiday_country='IN')
                        for c in _det_cols:
                            if c not in _fut_df.columns and c in _fc.columns \
                                    and pd.api.types.is_numeric_dtype(_fc[c]):
                                _fut_df[c] = pd.to_numeric(
                                    _fc[c], errors='coerce').reindex(_fut_idx).to_numpy()
                    except Exception:
                        pass
                # Backfill any remaining engineered columns with the last
                # in-sample value — cheap-and-correct for slow-moving exogs.
                for c in _det_cols:
                    if c not in _fut_df.columns:
                        _last = _hist_exog[c].iloc[-1] if len(_hist_exog) else 0
                        _fut_df[c] = _last
                # Build an in-sample prediction Series aligned to history's
                # final K_TRAIN_WINDOWS — using tr_pred + tr_actual.
                _in_sample = pd.Series(index=history.index, dtype=float)
                _in_sample.loc[tr_pred.index] = tr_pred.values
                _in_sample = _in_sample.fillna(method='ffill').fillna(history.mean())
                # Per-segment residual gate — Stable High uses a 10%
                # threshold (defined on the segment recipe) because hero
                # SKUs should sit at 5-15% WMAPE; the global 20% gate
                # leaves the booster dormant exactly where it would help
                # most. Other segments keep the global 20% threshold.
                _seg_resid_thr = float(_arch.get('residual_threshold_pct', 20.0))
                forecast_corrected, _xgb_note = conditional_xgb_residual_correction(
                    history=history,
                    base_in_sample=_in_sample,
                    base_forecast=forecast,
                    exog_history=_hist_exog,
                    exog_future=_fut_df.reindex(columns=_det_cols),
                    residual_threshold=_seg_resid_thr, # % units, per-segment
                    validation_mape=champion_val_mape, # honest out-of-sample gate (%)
                )
                forecast = forecast_corrected
                residual_pipeline_note = _xgb_note
    except Exception as _re:
        # Residual booster is a best-effort enhancement — never fail the
        # forecast because of it. Surface as a note for debugging.
        residual_pipeline_note = f"xgb_residual: skipped ({type(_re).__name__})"

    # ════════════════════════════════════════════════════════════════
    # 🛡  PIPELINE STAGE 3 — BUSINESS-RULE GUARDRAILS (MoM + YoY)
    # User requested: "Then add business rules where Month over month
    # and also Year over Year check and make sure that will also
    # consider these while giving final forecast".
    #
    # Final clip-only pass — MoM band (5th/95th historical quantile
    # ± 50% tolerance) and YoY band (±3σ around same-period-last-year
    # ratio). Never invents demand, only constrains extreme moves.
    # ════════════════════════════════════════════════════════════════
    business_rules_note: str = ''
    try:
        if forecast is not None and len(history) >= 2:
            forecast_br, _br_note = apply_business_rules(
                history=history, forecast=forecast, freq=freq,
                mom_tolerance=0.50, yoy_z=3.0,
            )
            forecast = forecast_br
            business_rules_note = _br_note
            # Append a hint so the audit trail surfaces that the same
            # guardrails were applied to backtest predictions too (which
            # affects the headline WMAPE — important when planners ask why
            # the chart's test line no longer shows wild spikes).
            business_rules_note += (
                " · applied to backtest_pred and train_pred too "
                "(WMAPE reflects clipped predictions)"
            )
    except Exception as _be:
        business_rules_note = f"business_rules: skipped ({type(_be).__name__})"

    # ════════════════════════════════════════════════════════════════
    # 🎯 PIPELINE STAGE 3b — CONFORMAL PREDICTION INTERVALS (hero SKUs)
    # SARIMAX's analytical CIs are unreliable when the optimiser is
    # borderline (which is common on Stable High contributors with promo
    # spikes). Conformal intervals are distribution-free — they use the
    # empirical residual quantile from the rolling-origin backtest, so
    # they reflect the model's ACTUAL out-of-sample error rather than
    # its assumed-Gaussian theoretical error. Activated only for
    # Stable High; other segments keep their model-native CIs (cheaper
    # and good enough on their typical accuracy band).
    # ════════════════════════════════════════════════════════════════
    conformal_note: str = ''
    try:
        _arch_cf = get_segment_architecture(profile_row or {})
        _seg_for_conformal = str((profile_row or {}).get('segment') or '')
        if (_seg_for_conformal == 'Stable High contributors'
                and forecast is not None and len(forecast) > 0
                and tr_actual is not None and tr_pred is not None
                and len(tr_actual) >= 4):
            # Residuals from the rolling-origin in-sample fit — these are
            # genuine 1-step-ahead errors the model would make on next
            # month's data, exactly what conformal needs.
            _overlap = tr_actual.index.intersection(tr_pred.index)
            if len(_overlap) >= 4:
                _resid = (tr_actual.loc[_overlap].astype(float).values
                          - tr_pred.loc[_overlap].astype(float).values)
                conformal_ci = conformal_intervals(
                    forecast, _resid, alpha=0.10  # 90% interval
                )
                # Sanity check — only adopt if the conformal interval is
                # narrower (i.e., tighter) than the model-native CI on
                # average. If model-native didn't produce a CI, take
                # conformal unconditionally.
                if ci is None:
                    ci = conformal_ci
                    conformal_note = ('conformal_ci: replaced empty model CI '
                                       f'(90% from {len(_resid)} residuals)')
                else:
                    _native_width = float((ci['upper'] - ci['lower']).mean())
                    _conf_width = float((conformal_ci['upper']
                                          - conformal_ci['lower']).mean())
                    if _conf_width < _native_width and _conf_width > 0:
                        ci = conformal_ci
                        conformal_note = ('conformal_ci: tighter than SARIMAX '
                                           f'({_conf_width:.0f} vs '
                                           f'{_native_width:.0f}) — adopted')
                    else:
                        conformal_note = ('conformal_ci: SARIMAX CI was '
                                           'tighter — kept native')
    except Exception as _ce:
        conformal_note = f"conformal_ci: skipped ({type(_ce).__name__})"

    # ── Merge all pipeline-stage traces into `notes` ───────────────
    # Final pipeline order (each stage is a separate "·" segment):
    #   1.  Champion-by-holdout      → champion_pipeline_note
    #   1b. Hyperparameter tuning    → tuning_pipeline_note
    #   2.  Conditional XGB residual → residual_pipeline_note
    #   3.  Business-rule guardrails → business_rules_note
    #   3b. Conformal CIs (hero SKUs)→ conformal_note
    # The planner can read the chain top-down to audit *why* a forecast
    # looks the way it does.
    for _stage_note in (champion_pipeline_note,
                        tuning_pipeline_note,
                        blend_pipeline_note,
                        residual_pipeline_note,
                        business_rules_note,
                        conformal_note):
        if _stage_note:
            notes = f"{notes} · {_stage_note}" if notes else _stage_note

    # ---- Always-on candidate-pool evaluation ----
    # Reuses the candidate_fns pool built ONCE at the top of this function
    # (shared with CV path). Cost is now strictly the test-backtest fits;
    # CV-mode SKUs no longer pay double.
    #
    # When `run_backtest=False` we still record every candidate's future
    # forecast — so the All-models per SKU table can show one row per
    # Primary + Blend member even when WMAPE evaluation is disabled.
    all_algo_metrics: Dict[str, Dict[str, Any]] = {}
    if run_backtest and candidate_fns:
        try:
            all_algo_metrics = evaluate_all_candidates_test_mape(
                history=history, candidate_fns=candidate_fns,
                test_h=TEST_HORIZON,
            )
        except Exception as _eve:
            all_algo_metrics = {}
            # Surface the evaluator failure so the debug expander shows it.
            _eval_err = f"evaluate_all_candidates_test_mape failed: {type(_eve).__name__}: {_eve}"
            pool_build_error = (
                f"{pool_build_error} | {_eval_err}" if pool_build_error else _eval_err
            )
        # Even if evaluation didn't raise, it may have returned empty
        # silently — record that too so we know to look elsewhere.
        if not all_algo_metrics and candidate_fns and not pool_build_error:
            pool_build_error = (
                f"evaluate_all_candidates_test_mape returned empty for "
                f"{len(candidate_fns)} candidates: {list(candidate_fns.keys())}"
            )
    elif candidate_fns:
        # Backtest disabled — still surface each candidate's future_forecast
        # so the planner can compare Primary + Blend projections side-by-side.
        for _strat, (_bt_fn, _future_fc) in candidate_fns.items():
            all_algo_metrics[_strat] = {
                'test_mape': None, 'test_smape': None,
                'future_forecast': _future_fc,
                'test_reason': 'backtest disabled — WMAPE not computed',
                'test_pred': None, 'test_actual': None,
            }

    # If the champion is in the pool, overwrite its test_mape with the one
    # we already computed at the top (might differ slightly from the
    # pool-evaluated version if the pool can't reproduce the leak-free
    # global-LGBM backtest path). This keeps the champion row consistent
    # with the headline metrics shown elsewhere.
    if strategy in all_algo_metrics and mape is not None:
        all_algo_metrics[strategy]['test_mape'] = mape
        all_algo_metrics[strategy]['test_smape'] = smape
        if forecast is not None:
            all_algo_metrics[strategy]['future_forecast'] = forecast
    elif strategy not in all_algo_metrics and forecast is not None:
        # Ensure the champion always has an entry, even if pool build skipped it
        all_algo_metrics[strategy] = {
            'test_mape': mape, 'test_smape': smape,
            'future_forecast': forecast, 'test_reason': mape_reason,
        }

    # Mark the champion + merge CV scores AND the val-WMAPE used for
    # champion selection into the same dict so the UI has one place to
    # look. The val WMAPE is what the selector actually ranked — it's on
    # a STRICTLY EARLIER slice than the test WMAPE, so a non-champion can
    # legitimately have a lower test WMAPE without contradicting the pick.
    for strat, m in all_algo_metrics.items():
        m['is_champion'] = (strat == strategy)
        cv_entry = (cv_results_dict or {}).get(strat, {})
        m['cv_mape'] = cv_entry.get('mean_mape')
        m['cv_smape'] = cv_entry.get('mean_smape')
        val_entry = champion_val_metrics.get(strat, {}) or {}
        m['val_mape'] = val_entry.get('test_mape')
        m['val_smape'] = val_entry.get('test_smape')

    # ---- Back-compat: keep benchmark_* fields populated (legacy callers) ----
    # The "extras" the user toggled in the segment portfolio surface as the
    # legacy benchmark_forecasts/mapes/smapes; they're now a strict subset of
    # all_algorithm_metrics, but downstream code (report, exports) still
    # reads the old shape.
    benchmark_forecasts: Dict[str, pd.Series] = {}
    benchmark_mapes: Dict[str, Optional[float]] = {}
    benchmark_smapes: Dict[str, Optional[float]] = {}
    for extra in extras:
        if extra == strategy or extra not in all_algo_metrics:
            continue
        m = all_algo_metrics[extra]
        benchmark_forecasts[extra] = m.get('future_forecast')
        benchmark_mapes[extra] = m.get('test_mape')
        benchmark_smapes[extra] = m.get('test_smape')

    return ForecastResult(sku=sku, strategy_used=strategy, forecast=forecast,
                          ci=ci, backtest_mape=mape, backtest_smape=smape,
                          backtest_bias_pct=bias_pct,
                          backtest_actual=bt_actual, backtest_pred=bt_pred,
                          test_horizon=TEST_HORIZON,
                          mape_reason=mape_reason, notes=notes,
                          train_mape=train_mape, train_smape=train_smape,
                          train_bias_pct=train_bias_pct,
                          train_actual=tr_actual, train_pred=tr_pred,
                          train_reason=train_reason,
                          auto_routed_strategy=auto_strategy,
                          benchmark_forecasts=benchmark_forecasts,
                          benchmark_mapes=benchmark_mapes,
                          benchmark_smapes=benchmark_smapes,
                          cv_selected=cv_selected_flag,
                          cv_winner=cv_winner_strat,
                          cv_k=cv_k if cv_mode else None,
                          cv_results=cv_results_dict,
                          cv_reason=cv_reason_msg,
                          all_algorithm_metrics=all_algo_metrics,
                          pool_build_note=pool_build_error,
                          lookalikes=lookalikes,
                          lookalike_reason=lookalike_reason)


# =================================================================
# 10. STREAMLIT UI
# =================================================================

def _load_logo_b64(filename: str) -> Optional[str]:
    """Best-effort load a logo from the app directory and return a
    base64 data URL. Returns None if missing/unreadable, so callers can
    fall back to a CSS-styled text logo.

    Lookup is case-insensitive — handy because macOS APFS can be either
    case-sensitive or case-insensitive depending on volume settings, and
    file-naming conventions in this project mix cases (e.g. the actual
    file on disk is `times Lens.png` with a lowercase 't').
    """
    try:
        from pathlib import Path as _P
        import base64 as _b64
        search_dirs = [_P(__file__).parent, _P.cwd()]
        target_lower = filename.lower()
        for d in search_dirs:
            if not d.exists():
                continue
            # Exact match first (fast path)
            exact = d / filename
            if exact.exists() and exact.is_file():
                p = exact
            else:
                # Case-insensitive scan
                p = None
                try:
                    for child in d.iterdir():
                        if child.is_file() and child.name.lower() == target_lower:
                            p = child
                            break
                except Exception:
                    p = None
                if p is None:
                    continue
            mime = 'png'
            ext = p.suffix.lower().lstrip('.')
            if ext in ('jpg', 'jpeg'):
                mime = 'jpeg'
            elif ext == 'svg':
                mime = 'svg+xml'
            elif ext == 'webp':
                mime = 'webp'
            return f"data:image/{mime};base64,{_b64.b64encode(p.read_bytes()).decode()}"
    except Exception:
        pass
    return None


def apply_theme():
    """Professional polish: hide Streamlit chrome, Inter typography, card UI,
    Dhisha brand colours throughout. Designed for client demos."""
    st.markdown(f"""
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
            /* ===== Global typography ===== */
            html, body, [class*="css"] {{
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            }}
            .stApp {{
                background: linear-gradient(180deg, #fafbfc 0%, #f5f7fa 100%);
            }}

            /* ===== Hide Streamlit chrome ===== */
            #MainMenu {{ visibility: hidden; }}
            header[data-testid="stHeader"] {{ background: transparent; height: 0; }}
            footer {{ visibility: hidden; }}
            .stDeployButton {{ display: none !important; }}
            [data-testid="stToolbar"] {{ display: none !important; }}
            [data-testid="stDecoration"] {{ display: none !important; }}
            .viewerBadge_container__1QSob,
            .viewerBadge_link__1S137,
            .styles_viewerBadge__1yB5_ {{ display: none !important; }}

            /* ===== Headings ===== */
            h1, h2, h3, h4, h5, h6 {{
                color: {DHISHAAI_BLUE};
                font-weight: 700;
                letter-spacing: -0.01em;
            }}
            h1 {{ font-size: 2.2rem; font-weight: 800; }}
            h2 {{ font-size: 1.55rem; margin-top: 1.4rem; }}
            h3 {{ font-size: 1.2rem; margin-top: 1rem; }}

            /* ===== Buttons ===== */
            .stButton > button {{
                background: {DHISHAAI_ORANGE};
                color: #fff;
                border: none;
                border-radius: 8px;
                padding: 0.55rem 1.2rem;
                font-weight: 600;
                font-size: 0.95rem;
                transition: all 0.18s ease;
                box-shadow: 0 1px 3px rgba(239,118,2,0.25);
            }}
            .stButton > button:hover {{
                background: #d96a02;
                box-shadow: 0 3px 12px rgba(239,118,2,0.35);
                transform: translateY(-1px);
            }}
            .stButton > button:focus {{
                box-shadow: 0 0 0 3px rgba(239,118,2,0.25) !important;
            }}
            .stDownloadButton > button {{
                background: {DHISHAAI_BLUE};
                color: #fff;
                border: none;
                border-radius: 8px;
                font-weight: 600;
            }}
            .stDownloadButton > button:hover {{
                background: #0a527a;
            }}

            /* ===== Tabs ===== */
            .stTabs [data-baseweb="tab-list"] {{
                gap: 4px;
                background: #fff;
                border-radius: 10px;
                padding: 6px;
                box-shadow: 0 1px 3px rgba(7,62,92,0.06);
                border: 1px solid #e5e9ee;
            }}
            .stTabs [data-baseweb="tab"] {{
                background: transparent;
                border-radius: 7px;
                padding: 8px 16px;
                font-weight: 500;
                color: #5a6878;
                border: none !important;
            }}
            .stTabs [data-baseweb="tab"][aria-selected="true"] {{
                background: {DHISHAAI_BLUE};
                color: #fff !important;
                font-weight: 600;
                box-shadow: 0 2px 6px rgba(7,62,92,0.18);
            }}
            .stTabs [data-baseweb="tab"]:hover:not([aria-selected="true"]) {{
                background: #f0f3f7;
                color: {DHISHAAI_BLUE};
            }}

            /* ===== Sidebar ===== */
            [data-testid="stSidebar"] {{
                background: linear-gradient(180deg, #fff 0%, #f7f9fb 100%);
                border-right: 1px solid #e5e9ee;
            }}
            [data-testid="stSidebar"] h1 {{ font-size: 1.3rem; }}
            [data-testid="stSidebar"] h2 {{ font-size: 1.1rem; }}
            [data-testid="stSidebar"] h3 {{ font-size: 1rem; }}
            [data-testid="stSidebar"] .stButton > button {{
                width: 100%;
            }}

            /* ===== Expanders ===== */
            [data-testid="stExpander"] {{
                background: #fff;
                border: 1px solid #e5e9ee;
                border-radius: 10px;
                box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            }}
            [data-testid="stExpander"] summary {{
                font-weight: 600;
                color: {DHISHAAI_BLUE};
                font-size: 0.95rem;
            }}

            /* ===== Inputs ===== */
            .stTextInput input, .stNumberInput input, .stTextArea textarea,
            .stSelectbox div[data-baseweb="select"] > div {{
                border-radius: 8px !important;
                border: 1px solid #d8dee5 !important;
                font-family: 'Inter', sans-serif !important;
            }}
            .stTextInput input:focus, .stNumberInput input:focus {{
                border-color: {DHISHAAI_ORANGE} !important;
                box-shadow: 0 0 0 3px rgba(239,118,2,0.1) !important;
            }}

            /* ===== DataFrame ===== */
            [data-testid="stDataFrame"] {{
                border-radius: 10px;
                border: 1px solid #e5e9ee;
                overflow: hidden;
            }}

            /* ===== Metric cards (st.metric) ===== */
            [data-testid="stMetric"] {{
                background: #fff;
                padding: 16px 20px;
                border-radius: 12px;
                border: 1px solid #e5e9ee;
                box-shadow: 0 1px 3px rgba(7,62,92,0.04);
            }}
            [data-testid="stMetricLabel"] {{
                color: #6b7785;
                font-weight: 500;
                font-size: 0.82rem;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }}
            [data-testid="stMetricValue"] {{
                color: {DHISHAAI_BLUE};
                font-weight: 700;
                font-size: 1.7rem;
            }}

            /* ===== Custom helper classes ===== */
            .strategy-pill {{
                display: inline-block; padding: 3px 12px; border-radius: 12px;
                background: {DHISHAAI_BLUE}; color: white; font-size: 0.82em;
                font-weight: 600;
            }}
            .pill-stable-high  {{ background:#10b981; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}
            .pill-stable-mid   {{ background:#3b82f6; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}
            .pill-stable-low   {{ background:#94a3b8; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}
            .pill-volatile-high{{ background:#dc2626; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}
            .pill-volatile-mid {{ background:#f59e0b; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}
            .pill-volatile-low {{ background:#fb7185; color:#fff; padding:3px 10px; border-radius:12px; font-size:0.8em; font-weight:600; }}

            .kpi-card {{
                background: #fff;
                padding: 18px 22px;
                border-radius: 12px;
                border: 1px solid #e5e9ee;
                box-shadow: 0 1px 4px rgba(7,62,92,0.05);
                margin-bottom: 8px;
            }}
            .kpi-label {{
                color: #6b7785; font-size: 0.8rem; text-transform: uppercase;
                letter-spacing: 0.04em; font-weight: 600;
            }}
            .kpi-value {{
                color: {DHISHAAI_BLUE}; font-size: 1.9rem; font-weight: 700;
                line-height: 1.1; margin-top: 4px;
            }}
            .kpi-sub {{ color: #6b7785; font-size: 0.8rem; margin-top: 4px; }}

            /* ===== Top brand header (FIXED, premium) =====
               Pinned to the viewport via `position: fixed`. The layered
               gradient + radial highlights + accent stripes are designed
               to feel like a high-end fintech / analytics product header,
               not a plain document banner. */
            .brand-header-wrap {{
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                width: 100%;
                height: 92px;
                z-index: 9999;
                /* Layered background: subtle white sheen + soft radial
                   brand glows on each side */
                background:
                    radial-gradient(ellipse 30% 100% at 0% 50%,
                                    rgba(7,62,92,0.06), transparent 70%),
                    radial-gradient(ellipse 30% 100% at 100% 50%,
                                    rgba(239,118,2,0.06), transparent 70%),
                    linear-gradient(90deg, #ffffff 0%, #fbfcfe 50%, #ffffff 100%);
                box-shadow: 0 8px 28px rgba(7,62,92,0.10),
                            0 2px 6px rgba(7,62,92,0.05);
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                overflow: hidden;
            }}
            /* Top hairline — slim multi-stop brand stripe */
            .brand-header-wrap::before {{
                content: '';
                position: absolute; top: 0; left: 0; right: 0;
                height: 2px;
                background: linear-gradient(90deg,
                    {DHISHAAI_BLUE} 0%,
                    {DHISHAAI_ORANGE} 50%,
                    {DHISHAAI_BLUE} 100%);
            }}
            /* Bottom brand stripe — bold orange with shimmer */
            .brand-header-wrap::after {{
                content: '';
                position: absolute; bottom: 0; left: 0; right: 0;
                height: 4px;
                background: linear-gradient(90deg,
                    {DHISHAAI_ORANGE} 0%,
                    #ffa552 50%,
                    {DHISHAAI_ORANGE} 100%);
                box-shadow: 0 0 18px rgba(239,118,2,0.35);
            }}
            .brand-header {{
                display: flex; align-items: center; justify-content: space-between;
                gap: 20px;
                padding: 4px 24px 4px 12px;  /* left flush; right with breathing room */
                width: 100%;
                margin: 0;
                height: 100%;
            }}
            /* TOP-LEFT logo — flush with the screen edge, larger and more
               prominent than the right-side brand logo. */
            .brand-header .logo-left {{
                display: flex; align-items: center;
                padding: 0;
                margin-left: 4px;
                border-radius: 12px;
                transition: transform 0.25s ease;
                flex-shrink: 0;
            }}
            .brand-header .logo-right {{
                display: flex; align-items: center;
                padding: 4px 10px;
                margin-right: 4px;
                border-radius: 12px;
                transition: transform 0.25s ease;
                flex-shrink: 0;
            }}
            .brand-header .logo-left:hover,
            .brand-header .logo-right:hover {{
                transform: translateY(-1px);
            }}
            .brand-header .logo-left img,
            .brand-header .logo-right img {{
                width: auto; display: block;
                object-fit: contain;
                filter: drop-shadow(0 2px 4px rgba(7,62,92,0.10));
            }}
            .brand-header .logo-left img {{ height: 82px; }}   /* more prominent */
            .brand-header .logo-right img {{ height: 50px; }}

            /* Centre — title block with refined typography. flex:1 lets
               it absorb the remaining width between the two corner logos
               so it always renders centred relative to the screen. */
            .brand-header .center {{
                flex: 1 1 auto;
                min-width: 0;
                text-align: center; line-height: 1.18;
                padding: 0 12px;
            }}
            .brand-header .title {{
                font-size: 1.55rem;
                font-weight: 800;
                letter-spacing: -0.015em;
                /* Gradient text on the brand name for premium feel */
                background: linear-gradient(135deg,
                    {DHISHAAI_BLUE} 0%,
                    #1a6f95 60%,
                    {DHISHAAI_BLUE} 100%);
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                color: {DHISHAAI_BLUE}; /* fallback */
                text-shadow: 0 1px 0 rgba(255,255,255,0.4);
            }}
            .brand-header .title .accent {{
                background: linear-gradient(135deg,
                    {DHISHAAI_ORANGE} 0%,
                    #ff8a3d 100%);
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                color: {DHISHAAI_ORANGE};
            }}
            .brand-header .title .pipe {{
                color: #cbd5e1; font-weight: 300; margin: 0 8px;
                font-size: 1.3rem; vertical-align: middle;
            }}
            .brand-header .title .product {{
                font-weight: 600; color: #334155;
                background: none; -webkit-text-fill-color: #334155;
                letter-spacing: 0.01em;
            }}
            .brand-header .subtitle {{
                color: #64748b; font-size: 0.78rem; font-weight: 500;
                margin-top: 4px; letter-spacing: 0.02em;
            }}
            .brand-header .subtitle .badge {{
                display: inline-block;
                padding: 2px 9px;
                background: rgba(7,62,92,0.08);
                color: {DHISHAAI_BLUE};
                border-radius: 6px;
                font-weight: 700;
                font-size: 0.7rem;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                margin: 0 2px;
            }}
            .brand-header .subtitle .badge-orange {{
                background: rgba(239,118,2,0.10);
                color: {DHISHAAI_ORANGE};
            }}
            .brand-header .subtitle .dot {{
                display: inline-block; width: 4px; height: 4px;
                border-radius: 50%; background: #cbd5e1;
                vertical-align: middle; margin: 0 9px;
            }}

            /* Text-logo fallbacks used when the PNG files aren't on disk */
            .logo-fallback-tl {{
                font-family: 'Inter', sans-serif; font-weight: 800;
                font-size: 1.55rem; letter-spacing: 0.02em;
                color: {DHISHAAI_BLUE}; line-height: 1;
            }}
            .logo-fallback-tl .lens {{ color: {DHISHAAI_ORANGE}; }}
            .logo-fallback-tl .tag {{
                display: block; font-size: 0.62rem; font-weight: 600;
                letter-spacing: 0.12em; color: #6b7785; margin-top: 4px;
                text-transform: uppercase;
            }}
            .logo-fallback-dh {{
                font-family: 'Inter', sans-serif; font-weight: 800;
                font-size: 1.55rem; color: {DHISHAAI_BLUE}; line-height: 1;
            }}
            .logo-fallback-dh .ai {{ color: {DHISHAAI_ORANGE}; }}

            /* ===== Sidebar Times-Lens logo block =====
               Compact — fixed height keeps it from dominating the
               sidebar so the data-upload controls below stay above
               the fold. */
            .sidebar-logo-block {{
                display: flex; flex-direction: column; align-items: center;
                gap: 4px;
                padding: 2px 4px 10px 4px;
                margin: -4px -10px 10px -10px;
                background: linear-gradient(180deg,
                    rgba(7,62,92,0.04) 0%, transparent 100%);
                border-bottom: 1px solid #e5e9ee;
            }}
            .sidebar-logo-block img {{
                height: 72px;            /* compact, fixed height  */
                width: auto;
                max-width: 100%;
                display: block;
                filter: drop-shadow(0 2px 4px rgba(7,62,92,0.10));
            }}
            .sidebar-logo-block .tag {{
                font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em;
                color: {DHISHAAI_BLUE}; text-transform: uppercase;
                margin-top: 0;
            }}

            /* ===== Frozen top navigation — professional dashboard pattern =====
               Two-tier fixed top region:
                 (1) Brand header  — top:0,  height:92px, z:9999
                 (2) Tab strip     — top:92, height:auto, z:9998
               Both use `position: fixed` (NOT sticky) — fixed is rock-solid
               regardless of overflow rules anywhere in the DOM, which is
               the standard pattern in production dashboards (Stripe, Linear,
               Datadog, Grafana). Sticky is fragile in Streamlit because
               nested flex containers create implicit scroll contexts. */

            /* Restore body as the scroll container so content scrolls naturally
               under the fixed top region. We don't touch html/body overflow
               — Streamlit's default body scroll is correct. */
            [data-testid="stMainBlockContainer"], .block-container {{
                overflow: visible !important;
            }}

            /* Outer tab strip — fixed at top:92px, full viewport width.
               Default applies to ALL .stTabs tab-lists. The specificity-
               higher reset rule below RE-positions sub-tabs (those nested
               inside a tab-panel) back to normal flow. This cascade-based
               approach is robust across Streamlit DOM-structure variations. */
            .stTabs > [data-baseweb="tab-list"] {{
                position: fixed !important;
                top: 92px !important;        /* directly under brand header */
                left: 0 !important;
                right: 0 !important;
                z-index: 9998 !important;
                background: linear-gradient(180deg, #ffffff 0%, #f4f7fa 100%) !important;
                margin: 0 !important;
                padding: 6px 32px 0 32px !important;
                box-shadow: 0 4px 12px rgba(7,62,92,0.10);
                border-bottom: 1px solid #e5e9ee;
                display: flex !important;
                gap: 4px !important;
                overflow-x: auto !important;
                overflow-y: hidden !important;
                white-space: nowrap !important;
                min-height: 52px !important;
                align-items: flex-end !important;
            }}
            /* The fixed tab bar spans full viewport width — the standard
               "global top-nav" pattern (GitHub, Stripe, Vercel). When the
               sidebar is expanded, the tab bar simply draws over the
               sidebar's top region (sidebar starts below at y=158).
               This avoids fragile DOM-sibling selectors and keeps the
               layout stable across Streamlit versions and sidebar states. */

            /* Sub-tabs reset — any .stTabs nested inside another tab-panel
               returns to normal flow. Two attribute selectors + class +
               attribute = specificity (0,0,4,0), strictly higher than the
               outer rule (0,0,2,0) above, so this wins on the cascade. */
            [data-baseweb="tab-panel"] .stTabs > [data-baseweb="tab-list"] {{
                position: relative !important;
                top: auto !important;
                left: auto !important;
                right: auto !important;
                z-index: auto !important;
                background: transparent !important;
                box-shadow: none !important;
                border-bottom: 1px solid #eef1f5 !important;
                padding: 4px 0 !important;
                margin: 8px 0 12px 0 !important;
                overflow: visible !important;
                min-height: auto !important;
                display: flex !important;
                align-items: flex-end !important;
                white-space: normal !important;
            }}

            /* ===== Sidebar — frozen via Streamlit defaults, but
               aggressively trimmed of top whitespace =====
               Goal: the logo + Quick Start sit directly under the
               brand bar, with no dead zone. */
            [data-testid="stSidebar"] {{
                box-shadow: 2px 0 12px rgba(7,62,92,0.06);
            }}
            /* Outer wrapper — clears the fixed top region (brand 92 +
               tabs 52 = 144px). 4px breathing gap is enough; previously
               14px left a visible empty band before the logo. */
            [data-testid="stSidebar"] > div:first-child {{
                padding-top: 148px !important;
                padding-bottom: 24px !important;
            }}
            /* Collapse Streamlit's native sidebar header to zero height
               but KEEP IT VISIBLE — the close/minimize button lives
               inside this element, so `display: none` would hide the
               button too. By zeroing height/padding/margin and allowing
               overflow, the dead space disappears but the (absolute-
               positioned) collapse button inside remains clickable. */
            [data-testid="stSidebarHeader"] {{
                min-height: 0 !important;
                height: 0 !important;
                padding: 0 !important;
                margin: 0 !important;
                overflow: visible !important;
            }}
            [data-testid="stSidebarNav"] {{
                display: none !important;
            }}
            /* Ensure absolute-positioned children of the sidebar (the
               collapse button) anchor to the sidebar itself. */
            [data-testid="stSidebar"] {{
                position: relative;
            }}
            /* Zero out all inner top spacing */
            [data-testid="stSidebarUserContent"],
            [data-testid="stSidebarContent"],
            [data-testid="stSidebar"] [data-testid="stVerticalBlock"] {{
                padding-top: 0 !important;
                margin-top: 0 !important;
                gap: 0.6rem !important;
            }}
            [data-testid="stSidebar"] [data-testid="stVerticalBlock"] > div:first-child {{
                margin-top: 0 !important;
                padding-top: 0 !important;
            }}
            /* First heading flush — kill the default top margin on h3 */
            [data-testid="stSidebar"] h1:first-of-type,
            [data-testid="stSidebar"] h2:first-of-type,
            [data-testid="stSidebar"] h3:first-of-type {{
                margin-top: 0 !important;
                padding-top: 0 !important;
            }}
            [data-testid="stSidebar"] h3 {{
                margin-top: 0.4rem !important;
                margin-bottom: 0.3rem !important;
            }}
            /* Sidebar buttons — snug height, single-line text by default,
               crisp brand hover. Stops "Load Synthetic Retail Demo
               (all-scenarios)" from wrapping awkwardly to two lines. */
            [data-testid="stSidebar"] .stButton > button {{
                padding: 0.45rem 0.8rem !important;
                font-size: 0.88rem !important;
                font-weight: 600 !important;
                min-height: 0 !important;
                border-radius: 8px !important;
                border: 1px solid #cbd5e1 !important;
                background: #ffffff !important;
                color: {DHISHAAI_BLUE} !important;
                line-height: 1.25 !important;
                transition: all 0.12s ease !important;
            }}
            [data-testid="stSidebar"] .stButton > button:hover {{
                background: #fff5e6 !important;
                border-color: {DHISHAAI_ORANGE} !important;
                color: {DHISHAAI_ORANGE} !important;
                transform: translateY(-1px);
            }}

            /* ===== Sidebar COLLAPSE / EXPAND toggle =====
               When the sidebar is minimized, Streamlit shows a small
               "show sidebar" arrow at the top-left of the page. That
               button sits under our fixed brand header (z-index 9999)
               and becomes un-clickable, leaving the user stuck.
               We raise it ABOVE the header and restyle so it's always
               visible and obvious — like a floating chip. Same treatment
               for the collapse button inside the expanded sidebar. */
            [data-testid="collapsedControl"],
            [data-testid="stSidebarCollapsedControl"],
            [data-testid="stSidebarCollapseButton"] {{
                position: fixed !important;
                top: 22px !important;
                left: 12px !important;
                z-index: 10001 !important;     /* above the 9999 brand header */
                background: #ffffff !important;
                border: 1px solid {DHISHAAI_BLUE} !important;
                border-radius: 10px !important;
                padding: 4px 8px !important;
                box-shadow: 0 4px 14px rgba(7,62,92,0.20) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 44px !important;
                height: 44px !important;
                cursor: pointer !important;
            }}
            [data-testid="collapsedControl"] svg,
            [data-testid="stSidebarCollapsedControl"] svg,
            [data-testid="stSidebarCollapseButton"] svg {{
                color: {DHISHAAI_BLUE} !important;
                fill: {DHISHAAI_BLUE} !important;
                width: 22px !important;
                height: 22px !important;
            }}
            [data-testid="collapsedControl"]:hover,
            [data-testid="stSidebarCollapsedControl"]:hover,
            [data-testid="stSidebarCollapseButton"]:hover {{
                background: {DHISHAAI_BLUE} !important;
                transform: translateY(-1px);
                box-shadow: 0 6px 18px rgba(7,62,92,0.30) !important;
            }}
            [data-testid="collapsedControl"]:hover svg,
            [data-testid="stSidebarCollapsedControl"]:hover svg,
            [data-testid="stSidebarCollapseButton"]:hover svg {{
                color: #ffffff !important;
                fill: #ffffff !important;
            }}
            /* When sidebar IS expanded, the collapse button lives at the
               sidebar's top edge. Streamlit usually positions it inside
               the sidebar — we leave its native position but raise its
               z-index so it stays clickable above our padding. */
            [data-testid="stSidebar"] [data-testid="stSidebarCollapseButton"],
            [data-testid="stSidebar"] [data-testid="baseButton-headerNoPadding"] {{
                position: absolute !important;
                top: 12px !important;
                right: 8px !important;
                left: auto !important;
                z-index: 10002 !important;
                width: 32px !important;
                height: 32px !important;
                padding: 4px !important;
            }}

            /* Nudge the Time Lens logo over slightly so it doesn't sit
               right under the floating expand button at top-left. */
            .brand-header {{
                padding-left: 64px !important;
            }}
            /* Pull the first sidebar heading flush to the top of the
               panel so "Quick Start" sits right under the brand bar. */
            [data-testid="stSidebar"] [data-testid="stMarkdownContainer"]:first-of-type h1,
            [data-testid="stSidebar"] [data-testid="stMarkdownContainer"]:first-of-type h2,
            [data-testid="stSidebar"] [data-testid="stMarkdownContainer"]:first-of-type h3 {{
                margin-top: 0 !important;
                padding-top: 0 !important;
            }}
            /* Collapse Streamlit's first wrapper spacer in the sidebar */
            [data-testid="stSidebar"] [data-testid="stVerticalBlock"]:first-child > div:first-child {{
                margin-top: 0 !important;
                padding-top: 0 !important;
            }}
            /* Trim default top margin on the first element of the main
               content area too — keeps the page feeling tight. */
            .block-container > div:first-child {{
                margin-top: 0 !important;
                padding-top: 0 !important;
            }}
            /* Tab buttons — pill-style with crisp hover + active states.
               Default styles apply to all tabs. Sub-tab override (higher
               specificity) lightens them. */
            .stTabs {{
                margin-top: 0 !important;
            }}
            .stTabs [data-baseweb="tab-list"] [data-baseweb="tab"] {{
                padding: 9px 18px !important;
                font-weight: 600 !important;
                font-size: 0.92rem !important;
                color: #475569 !important;
                background: transparent !important;
                border: none !important;
                border-radius: 8px 8px 0 0 !important;
                transition: color 150ms ease, background 150ms ease;
                margin-right: 2px !important;
                white-space: nowrap !important;
            }}
            .stTabs [data-baseweb="tab-list"] [data-baseweb="tab"]:hover {{
                color: {DHISHAAI_BLUE} !important;
                background: rgba(7,62,92,0.05) !important;
            }}
            .stTabs [data-baseweb="tab-list"] [data-baseweb="tab"][aria-selected="true"] {{
                color: {DHISHAAI_BLUE} !important;
                background: #ffffff !important;
                box-shadow: 0 -3px 0 {DHISHAAI_ORANGE} inset !important;
            }}
            /* Hide BaseWeb's default underline indicator — our inset
               shadow handles the active-tab indicator more crisply. */
            .stTabs [data-baseweb="tab-highlight"],
            .stTabs [data-baseweb="tab-border"] {{
                background: transparent !important;
                display: none !important;
            }}
            .stTabs [data-baseweb="tab-panel"] {{
                padding-top: 8px !important;
            }}
            /* Sub-tabs keep a smaller, lighter styling — they live inside
               a parent tab panel and shouldn't compete visually with the
               outer top-nav. Higher specificity = overrides defaults. */
            [data-baseweb="tab-panel"] .stTabs [data-baseweb="tab-list"] [data-baseweb="tab"] {{
                padding: 6px 14px !important;
                font-size: 0.86rem !important;
                font-weight: 500 !important;
            }}
            [data-baseweb="tab-panel"] .stTabs [data-baseweb="tab-list"] [data-baseweb="tab"][aria-selected="true"] {{
                box-shadow: 0 -2px 0 {DHISHAAI_BLUE} inset !important;
            }}

            /* ===== Section dividers ===== */
            hr {{ border: none; border-top: 1px solid #e5e9ee; margin: 1.5rem 0; }}

            /* ===== Block padding =====
               The fixed top region occupies 144px:
                 92px brand header + 52px tabs bar (incl. shadow).
               Add 14px breathing gap → content starts at y=158px. */
            .block-container {{
                padding-top: 158px !important;
                padding-bottom: 2rem !important;
                max-width: 1400px;
            }}
        </style>
    """, unsafe_allow_html=True)

    # Branded header strip — sticky, with Time Lens logo (left) and
    # DhishaAI logo (right). Logos are embedded as base64 so the entire
    # header is a single HTML node that participates in the sticky scroll.
    # If a logo file isn't on disk we fall back to a styled text logo so
    # the demo still looks finished.
    import datetime as _dt
    today_str = _dt.date.today().strftime('%b %d, %Y')

    # Time Lens logo — search several common filenames (loader is
    # case-insensitive, so 'Times Lens.png' will also match 'times Lens.png'.
    # NOTE: filename candidates stay 'Times Lens' / 'times Lens' because
    # that's how the actual PNG on disk is named; only the brand display
    # text was renamed to 'Time Lens'.
    # which is the actual filename in the repo).
    tl_src = (_load_logo_b64('times Lens.png')
              or _load_logo_b64('Times Lens.png')
              or _load_logo_b64('times_lens_logo.png')
              or _load_logo_b64('timeslens.png')
              or _load_logo_b64('TimesLens.png')
              or _load_logo_b64('time_lens.png'))
    if tl_src:
        left_logo_html = (
            f'<div class="logo-left">'
            f'<img src="{tl_src}" alt="Time Lens"/></div>'
        )
    else:
        left_logo_html = (
            '<div class="logo-left">'
            '<div class="logo-fallback-tl">'
            'TIMES <span class="lens">LENS</span>'
            '<span class="tag">Trend Forecasting &amp; Insights</span>'
            '</div></div>'
        )

    # DhishaAI logo — bundled in repo as "Branding Files.png"
    dh_src = (_load_logo_b64('Branding Files.png')
              or _load_logo_b64('dhishaai_logo.png')
              or _load_logo_b64('dhisha_logo.png')
              or _load_logo_b64('DhishaAI.png'))
    if dh_src:
        right_logo_html = (
            f'<div class="logo-right">'
            f'<img src="{dh_src}" alt="DhishaAI"/></div>'
        )
    else:
        right_logo_html = (
            '<div class="logo-right">'
            '<div class="logo-fallback-dh">'
            'Dhisha<span class="ai">AI</span>'
            '</div></div>'
        )

    st.markdown(f"""
        <div class="brand-header-wrap">
          <div class="brand-header">
            {left_logo_html}
            <div class="center">
                <div class="title">
                  <span class="product">Time Lens</span>
                  <span class="pipe">|</span>
                  <span>Dhisha<span class="accent">AI</span></span>
                </div>
                <div class="subtitle">
                  Retail demand intelligence
                  <span class="dot"></span>
                  SKU segmentation, forecasting &amp; what-if
                  <span class="dot"></span>
                  <span class="badge">Build v2.6</span>
                  <span class="badge badge-orange">{today_str}</span>
                </div>
            </div>
            {right_logo_html}
          </div>
        </div>
    """, unsafe_allow_html=True)

    # NOTE: We deliberately do NOT call `st.logo()` here. The fixed brand
    # header above already shows the Time Lens icon on the left, so it
    # remains visible even when the sidebar is collapsed. Calling st.logo()
    # in addition would render a duplicate logo at the top of the sidebar
    # alongside the custom sidebar-logo-block — which was the "two logos
    # on top of data upload" problem the user reported.


@st.cache_data(show_spinner=False, max_entries=4)
def _read_bytes_to_df(name: str, raw_bytes: bytes) -> Optional[pd.DataFrame]:
    """Pure parse step — cached by (filename, bytes) so re-uploading the same
    file (or hitting Load twice) is instant.
    """
    import io
    buf = io.BytesIO(raw_bytes)
    lname = name.lower()
    if lname.endswith('.csv'):
        return pd.read_csv(buf)
    if lname.endswith('.tsv') or lname.endswith('.txt'):
        return pd.read_csv(buf, sep='\t')
    if lname.endswith(('.xlsx', '.xls', '.xlsm')):
        return pd.read_excel(buf)
    if lname.endswith('.parquet') or lname.endswith('.pq'):
        return pd.read_parquet(buf)
    if lname.endswith('.json'):
        return pd.read_json(buf)
    if lname.endswith('.feather'):
        return pd.read_feather(buf)
    return pd.read_csv(buf)


def _read_uploaded_file(uploaded_file) -> Optional[pd.DataFrame]:
    """Load CSV/Excel/Parquet/JSON/TSV/Feather from a Streamlit file_uploader.
    Thin wrapper around the cached `_read_bytes_to_df` so the actual parse
    only runs once per (filename, content) pair.
    """
    if uploaded_file is None:
        return None
    try:
        raw = uploaded_file.getvalue()  # Streamlit's UploadedFile API
        return _read_bytes_to_df(uploaded_file.name, raw)
    except Exception as e:
        st.error(f"Could not read {uploaded_file.name}: {e}")
        return None


def render_sidebar():
    with st.sidebar:
        # ------------------------------------------------------------
        # Time Lens logo at the top of the sidebar (visible whenever
        # the sidebar is expanded). Sized compact so it doesn't dominate
        # the panel. Falls back to a styled text mark if the PNG isn't
        # on disk.
        # ------------------------------------------------------------
        tl_src_side = (_load_logo_b64('times Lens.png')
                       or _load_logo_b64('Times Lens.png')
                       or _load_logo_b64('times_lens_logo.png')
                       or _load_logo_b64('timeslens.png')
                       or _load_logo_b64('TimesLens.png'))
        # Fixed-position logo block at the top of the sidebar. Uses
        # `position: sticky` against the sidebar's own scrolling region
        # (which Streamlit creates automatically for stSidebar). The
        # logo stays put; everything below — Quick Start, uploads,
        # column mappers, etc. — scrolls underneath it.
        #
        # IMPORTANT: the entire CSS+HTML payload is dedented to column 0
        # BEFORE being handed to st.markdown(). If even one line of the
        # `<style>` or `<div>` block has 4+ leading spaces the Markdown
        # parser treats it as a code block and renders the raw HTML as
        # source text (the bug seen in the screenshot).
        _logo_inner = (
            f'<img src="{tl_src_side}" alt="Time Lens" />' if tl_src_side
            else '<div class="text-mark">TIME <span>LENS</span></div>'
        )
        _logo_html = textwrap.dedent("""\
            <style>
            /* Pin this block to the top of the sidebar's own scroll area.
               The :has() selector applies sticky to the Streamlit-injected
               stMarkdownContainer that wraps our .sticky-sidebar-logo, so
               only this one element pins (no other markdown blocks). */
            section[data-testid="stSidebar"] div[data-testid="stMarkdownContainer"]:has(> .sticky-sidebar-logo) {
                position: sticky;
                top: 0;
                z-index: 100;
                background: linear-gradient(180deg, #ffffff 0%, #fdfcfa 100%);
                margin: -1rem -1rem 0.6rem -1rem;
                padding: 0.4rem 1rem 0.5rem 1rem;
            }
            .sticky-sidebar-logo {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 0.15rem 0 0.45rem 0;
                border-bottom: 1px solid #e5e9ee;
                box-shadow: 0 4px 8px -6px rgba(7,62,92,0.18);
            }
            .sticky-sidebar-logo img {
                width: auto;
                max-width: 150px;
                max-height: 56px;
                height: auto;
                object-fit: contain;
                filter: drop-shadow(0 2px 4px rgba(7,62,92,0.10));
            }
            .sticky-sidebar-logo .text-mark {
                font-weight: 700;
                font-size: 1.05rem;
                letter-spacing: 0.04em;
                color: #073e5c;
            }
            .sticky-sidebar-logo .text-mark span { color: #ef7602; }
            .sticky-sidebar-logo .tagline {
                font-size: 0.66rem;
                color: #94a3b8;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                font-weight: 700;
                margin-top: 4px;
            }
            </style>
            <div class="sticky-sidebar-logo">
                __LOGO_INNER__
                <div class="tagline">Time Lens</div>
            </div>
        """).replace('__LOGO_INNER__', _logo_inner)
        st.markdown(_logo_html, unsafe_allow_html=True)

        # =============================================================
        # 0. QUICK START — preloaded retail demo dataset
        # =============================================================
        # Compact label + sub-caption pattern so button text never wraps
        # awkwardly in a narrow sidebar. CSS gives buttons a snug height
        # and a clear hover state.
        st.markdown(textwrap.dedent("""\
            <style>
            .qs-head {
                display: flex; align-items: baseline; gap: 8px;
                margin-bottom: 4px;
            }
            .qs-title {
                font-size: 0.95rem; font-weight: 800;
                color: #073e5c; letter-spacing: -0.01em;
            }
            .qs-sub {
                font-size: 0.7rem; color: #94a3b8;
                text-transform: uppercase; letter-spacing: 0.08em;
                font-weight: 600;
            }
            [data-testid="stSidebar"] .qs-meta {
                font-size: 0.72rem; color: #64748b;
                margin: -4px 0 8px 4px; line-height: 1.35;
            }
            </style>
            <div class="qs-head">
                <div class="qs-title">⚡ Quick Start</div>
                <div class="qs-sub">demo data</div>
            </div>
        """), unsafe_allow_html=True)

        # ---- Synthetic retail demo (covers all segment+intermittency cells,
        #      and every SKU has enough history to surface Train WMAPE,
        #      Test WMAPE, AND a Historical-prediction chart trace).
        synth_path = "retail_demo_data.csv"
        if os.path.exists(synth_path):
            if st.button("📊 Synthetic Demo",
                         use_container_width=True, key="btn_demo_synth",
                         help=("120 SKUs · 36 months · engineered to populate every "
                               "segment + intermittency cell, with cold-start SKUs "
                               "having 6–8 months of history so EVERY SKU shows "
                               "Train WMAPE / Test WMAPE / Historical forecast.")):
                with st.spinner("Loading synthetic retail demo…"):
                    try:
                        df_synth = pd.read_csv(synth_path)
                        st.session_state.df_raw = df_synth
                        st.session_state.profiled = False
                        st.session_state.global_trained = False
                        st.session_state.forecasts_run = False
                        st.session_state.demo_mode = True
                        sku_col_guess = 'sku' if 'sku' in df_synth.columns else df_synth.columns[1]
                        st.success(f"Loaded {len(df_synth):,} rows · "
                                   f"{df_synth[sku_col_guess].nunique():,} SKUs")
                        st.rerun()
                    except Exception as e:
                        st.error(f"Synthetic demo load failed: {e}")
            st.markdown(
                "<div class='qs-meta'>120 SKUs · 36 mo · all segments &amp; "
                "intermittency cells</div>",
                unsafe_allow_html=True,
            )

        demo_path = "MP-Till Apr 25.csv"
        if os.path.exists(demo_path):
            if st.button("🏪 Retail Demo (MP-Till)",
                          use_container_width=True, key="btn_demo",
                          help="Loads the Titan watches retail dataset · 3,166 SKUs · 40 months · Jan 2022 – Apr 2025."):
                with st.spinner("Loading retail demo dataset…"):
                    try:
                        df_demo = pd.read_csv(demo_path)
                        st.session_state.df_raw = df_demo
                        st.session_state.profiled = False
                        st.session_state.global_trained = False
                        st.session_state.forecasts_run = False
                        st.session_state.demo_mode = True
                        st.success(f"Loaded {len(df_demo):,} rows · {df_demo['latest_sku'].nunique():,} SKUs")
                        st.rerun()
                    except Exception as e:
                        st.error(f"Demo load failed: {e}")
            st.markdown(
                "<div class='qs-meta'>3,166 SKUs · 40 mo · Jan 2022 – Apr 2025</div>",
                unsafe_allow_html=True,
            )
        # Subtle divider — full-width, faint, no big margin.
        st.markdown(
            "<hr style='margin:8px 0 6px;border:none;border-top:1px solid #e2e8f0;' />",
            unsafe_allow_html=True,
        )

        # =============================================================
        # 1. DATA INPUT — multi-format file OR MySQL (mirrors app_96.py)
        # =============================================================
        data_input_expanded = 'df_raw' not in st.session_state
        with st.expander("1. Data Input", expanded=data_input_expanded):
            st.subheader("Sales Data Source")
            sales_source = st.radio(
                "Select source",
                ["Upload File", "MySQL Database"],
                key="sales_src", horizontal=True,
                help="File supports CSV, Excel, Parquet, JSON, TSV, Feather.",
            )

            uploaded_file = None
            sales_query = ""
            db_host = db_user = db_password = db_name = None

            if sales_source == "Upload File":
                uploaded_file = st.file_uploader(
                    "Upload your sales data",
                    type=['csv', 'tsv', 'txt', 'xlsx', 'xls', 'xlsm',
                          'parquet', 'pq', 'json', 'feather'],
                    help="Long format: one row per SKU per period.",
                )
            else:
                st.markdown("**Database Credentials**")
                c1, c2 = st.columns(2)
                db_host = c1.text_input("Host", "localhost", key="db_host")
                db_user = c2.text_input("User", "root", key="db_user")
                db_password = c1.text_input("Password", type="password", key="db_pw")
                db_name = c2.text_input("Database", key="db_name")
                sales_query = st.text_area(
                    "SQL Query for Sales Data",
                    "SELECT date, latest_sku, sales FROM your_sales_table;",
                    height=100, key="sales_query",
                )

            st.markdown("---")
            if st.button("Load & Process Data", use_container_width=True, key="btn_load_data"):
                df_loaded = None
                with st.spinner("Loading data..."):
                    if sales_source == "Upload File" and uploaded_file is not None:
                        df_loaded = _read_uploaded_file(uploaded_file)
                    elif sales_source == "MySQL Database":
                        df_loaded = load_data_from_mysql(db_host, db_user, db_password, db_name, sales_query)
                    else:
                        st.warning("Please upload a file or configure a MySQL query.")
                if df_loaded is not None and not df_loaded.empty:
                    st.session_state.df_raw = df_loaded
                    st.session_state.profiled = False
                    st.session_state.global_trained = False
                    st.session_state.forecasts_run = False
                    st.success(f"Loaded {len(df_loaded):,} rows × {len(df_loaded.columns)} cols")
                    st.rerun()

        if 'df_raw' not in st.session_state:
            st.info("Load a sales dataset above to begin. Supports CSV / Excel / Parquet / JSON / TSV / Feather files, or connect directly to MySQL.")
            _render_workflow_progress(step=0)
            return None

        df = st.session_state.df_raw
        cols = list(df.columns)
        n_cols_numeric = len(df.select_dtypes(include=np.number).columns)
        n_rows = len(df)

        # Mini data preview right after load
        with st.expander("Data Preview", expanded=False):
            st.caption(f"{n_rows:,} rows × {len(cols)} columns · {n_cols_numeric} numeric")
            st.dataframe(df.head(8), use_container_width=True, height=200)

        with st.expander("2. Column Configuration", expanded=True):
            # Smart defaults — exact match first, substring match second, fallback last.
            # Fixes the prior bug where SKU defaulted to `cols[0]` (often 'date') on any
            # dataset that didn't use the MP-Till schema.
            def _smart_default(candidates, cols, fallback):
                for c in candidates:                       # exact match
                    if c in cols:
                        return c
                for c in cols:                             # substring match
                    cl = c.lower()
                    if any(k.lower() in cl for k in candidates):
                        return c
                return fallback
            defaults = {
                'date': _smart_default(
                    ['month_', 'date', 'period', 'month', 'week', 'time'], cols, cols[0]),
                'sku': _smart_default(
                    ['latest_sku', 'sku', 'product_id', 'item_id', 'product_code',
                     'item_code', 'item'], cols, cols[0]),
                'sales': _smart_default(
                    ['sales', 'quantity', 'qty', 'units', 'volume', 'demand'], cols, cols[-1]),
                # Prefer the computed `segment` column (injected after validation) over
                # any pre-existing raw `segments` column from the source file.
                'segment': ('segment' if 'segment' in cols
                            else ('segments' if 'segments' in cols else None)),
                'brand': _smart_default(['brand', 'mfg', 'manufacturer', 'vendor'], cols, None),
            }
            date_col = st.selectbox("Date column", cols,
                                     index=cols.index(defaults['date']),
                                     help="Column holding the timestamp of each observation.")

            date_format_options = {
                "Auto-detect": None,
                "DD-MM-YYYY": "%d-%m-%Y",
                "MM-DD-YYYY": "%m-%d-%Y",
                "YYYY-MM-DD": "%Y-%m-%d",
                "DD/MM/YYYY": "%d/%m/%Y",
                "MM/DD/YYYY": "%m/%d/%Y",
                "YYYY/MM/DD": "%Y/%m/%d",
                "DD-MMM-YY (e.g. 01-Jan-22)": "%d-%b-%y",
                "MMM-YY (e.g. Jan-22)": "%b-%y",
                "YYYY-MM (e.g. 2022-01)": "%Y-%m",
                "Custom...": "__custom__",
            }
            date_format_label = st.selectbox(
                "Date format",
                list(date_format_options.keys()),
                help="Pick the format that matches your date column, or 'Auto-detect'.",
            )
            if date_format_options[date_format_label] == "__custom__":
                date_format = st.text_input("Custom format string",
                                             value="%Y-%m-%d",
                                             help="strftime, e.g. %Y-%m-%d or %b-%y")
            else:
                date_format = date_format_options[date_format_label]

            # Auto-detect: actually inspect the column so monthly data stored
            # as '01/01/22', '01/02/22', ... doesn't get mis-parsed as
            # different days in January (pandas default = MM/DD/YY). Also
            # handles ISO datetime with time + ms ('2024-10-01 00:00:00.000').
            if date_format is None:
                _inferred = _smart_detect_date_format(df[date_col])
                if _inferred:
                    date_format = _inferred

            # ---- Historical-data starting date ----------------------------
            # Peek at the date column with the chosen format so the picker
            # has sensible bounds. Errors-coerced; if the column doesn't
            # parse we just default to today and let the user override.
            try:
                if date_format:
                    _dt_peek = pd.to_datetime(df[date_col], format=date_format,
                                              errors='coerce')
                else:
                    _dt_peek = pd.to_datetime(df[date_col], dayfirst=True,
                                              errors='coerce')
                _dt_peek = _dt_peek.dropna()
                _peek_min = _dt_peek.min().date() if len(_dt_peek) else None
                _peek_max = _dt_peek.max().date() if len(_dt_peek) else None
            except Exception:
                _peek_min = _peek_max = None
                _dt_peek = pd.Series([], dtype='datetime64[ns]')

            # ---- Cadence detection -----------------------------------------
            # Use the freshly-parsed peek series so the gap analysis sees
            # real Timestamps, not raw strings. Pin the result so the
            # frequency dropdown below can auto-select the right cadence.
            _detected_freq, _freq_label, _gap_days = _detect_period_frequency(
                _dt_peek if len(_dt_peek) else None
            )

            # Render a single combined "what we found" card so the planner
            # sees BOTH format + cadence at a glance — no scrolling, no
            # guessing whether dates were parsed correctly.
            _fmt_chip = (f"<code style='color:#073e5c;font-weight:600'>{date_format}</code>"
                         if date_format
                         else "<i style='color:#6b7785'>pandas inference</i>")
            _cad_color = '#10b981' if _detected_freq != '?' else '#f59e0b'
            _cad_icon = ({'D': '📆', 'W': '🗓', 'MS': '📅', 'QS': '📊', 'YS': '📈'}
                         .get(_detected_freq, '⚠'))
            _range_str = (f"{_peek_min} → {_peek_max}"
                          if _peek_min and _peek_max else "—")
            st.markdown(textwrap.dedent(f"""
                <div style='background:linear-gradient(135deg,#f8fafc 0%,#eff6ff 100%);
                            border:1px solid #e2e8f0; border-left:4px solid {_cad_color};
                            border-radius:10px; padding:12px 14px; margin:8px 0 12px 0;
                            font-size:0.84rem;'>
                  <div style='display:flex; flex-wrap:wrap; gap:18px;'>
                    <div>
                      <div style='font-size:0.66rem; color:#64748b; text-transform:uppercase;
                                  letter-spacing:0.08em; font-weight:700;'>Format detected</div>
                      <div style='color:#1e293b; margin-top:2px;'>📅 {_fmt_chip}</div>
                    </div>
                    <div>
                      <div style='font-size:0.66rem; color:#64748b; text-transform:uppercase;
                                  letter-spacing:0.08em; font-weight:700;'>Cadence</div>
                      <div style='color:{_cad_color}; margin-top:2px; font-weight:700;'>
                        {_cad_icon} {_freq_label}
                        <span style='color:#94a3b8; font-weight:500; font-size:0.78rem;'>
                          (median gap {_gap_days:.1f}d)
                        </span>
                      </div>
                    </div>
                    <div>
                      <div style='font-size:0.66rem; color:#64748b; text-transform:uppercase;
                                  letter-spacing:0.08em; font-weight:700;'>Date range</div>
                      <div style='color:#1e293b; margin-top:2px;'>{_range_str}</div>
                    </div>
                  </div>
                </div>
            """), unsafe_allow_html=True)

            if _detected_freq == '?':
                st.warning(
                    "⚠ Could not detect a regular cadence. Dates may be "
                    "irregular, mis-parsed, or aggregated unevenly. Pick the "
                    "frequency manually in the dropdown below — or set a "
                    "specific date format if the values look wrong."
                )

            use_full_history = st.checkbox(
                "Use full available history",
                value=True,
                help="Untick to restrict the model's training window to data "
                     "from a specific date onwards. Useful when older periods "
                     "reflect a different business regime (rebrand, store "
                     "rollout, COVID, pricing reset).",
            )
            if use_full_history:
                history_start_date = None
                if _peek_min and _peek_max:
                    st.caption(f"Detected range: **{_peek_min}** → **{_peek_max}** "
                               f"· using all rows.")
            else:
                history_start_date = st.date_input(
                    "Historical data starts from",
                    value=_peek_min or pd.Timestamp.today().date(),
                    min_value=_peek_min,
                    max_value=_peek_max,
                    help="Rows older than this date are dropped before "
                         "profiling, EDA, and forecasting. Events on the "
                         "calendar that fall before this cutoff are ignored.",
                )

            sku_col = st.selectbox("SKU column", cols,
                                    index=cols.index(defaults['sku']),
                                    help="Per-item identifier (e.g. SKU, product code).")
            sales_col = st.selectbox(
                "Sales / target", cols,
                index=cols.index(defaults['sales']),
                help="Numeric column to forecast — must be numeric.",
            )
            # Validation: ensure sales column is numeric
            if not pd.api.types.is_numeric_dtype(df[sales_col]):
                st.warning(f"⚠ Column '{sales_col}' is not numeric. "
                            f"Forecasting requires a numeric target.")

            seg_options = ["(none)"] + cols
            segment_col = st.selectbox(
                "Segment column",
                seg_options,
                index=seg_options.index(defaults['segment']) if defaults['segment'] in cols else 0,
                help="Optional categorical grouping (e.g. Stable High / Volatile Mid).",
            )
            brand_options = ["(none)"] + cols
            brand_col = st.selectbox(
                "Brand column",
                brand_options,
                index=brand_options.index(defaults['brand']) if defaults['brand'] in cols else 0,
                help="Optional — used for hierarchical reconciliation.",
            )
            freq_options = {
                'MS': 'Month Start (recommended for monthly demand)',
                'W': 'Weekly',
                'D': 'Daily',
                'QS': 'Quarter Start',
                'YS': 'Year Start',
            }
            # Default the dropdown to the auto-detected cadence so the user
            # doesn't have to retype "Monthly" when their data is monthly.
            # Falls back to MS (the historical default) when the detector
            # couldn't pin a cadence.
            _freq_keys = list(freq_options.keys())
            _freq_default_idx = (_freq_keys.index(_detected_freq)
                                  if _detected_freq in _freq_keys else 0)
            freq = st.selectbox(
                "Forecast frequency",
                _freq_keys,
                index=_freq_default_idx,
                format_func=lambda k: (f"{k} — {freq_options[k]}"
                                       + (" · 🤖 auto-detected"
                                          if k == _detected_freq else "")),
                help="Pandas resampling code. Most retail demand is MS (monthly).",
            )

        # =================================================================
        # 2b. ADDITIONAL EXOGENOUS VARIABLES
        # =================================================================
        # The engine already auto-detects price / festive / scheme / weekends
        # columns. This expander lets the planner explicitly add ANY column
        # from the source file as an exogenous driver. Numeric columns are
        # carried as regressors (SARIMAX + LightGBM); text columns become
        # categorical encodings the LightGBM model can split on.
        with st.expander("2b. Additional Exogenous Variables", expanded=False):
            st.caption(
                "Every column from your data is listed below. Select the ones "
                "you want to influence the forecast — for each selected numeric "
                "feature you'll be able to choose how it's projected into the future."
            )
            # Engine-internal column names (created by build_panel_features at
            # runtime, never in the raw CSV) — keep them out of the offer for
            # clarity even though they shouldn't appear anyway.
            _DERIVED_COLS = {'log_price', 'price_changed', 'price_change_pct',
                             'month', 'quarter', 'year'}
            # Columns the engine *also* uses automatically when present.
            # Listing them in the picker lets the planner take projection
            # control; leaving them unselected keeps the engine's auto-handling.
            _AUTO_USED_HINT = {'festive', 'other_imp_festivals', 'peak_month',
                               'scheme_days', 'weekends', 'days', 'price_band',
                               'current_price', 'previous_price'}
            # Deterministic functions of the target — selecting these as exog
            # causes leakage (perfect training fit, broken forecast). Flagged
            # but still shown — the planner is the final judge.
            _LEAKAGE_COLS = {'revenue', 'avg_price'}

            _reserved = {date_col, sku_col, sales_col}
            if segment_col and segment_col != '(none)':
                _reserved.add(segment_col)
            if brand_col and brand_col != '(none)':
                _reserved.add(brand_col)
            offer_cols = [c for c in cols
                          if c not in _reserved and c not in _DERIVED_COLS]
            numeric_offer = [c for c in offer_cols
                             if pd.api.types.is_numeric_dtype(df[c])]
            categorical_offer = [c for c in offer_cols if c not in numeric_offer]

            # Contextual hints so the planner understands the lists they see.
            _auto_present = [c for c in (numeric_offer + categorical_offer)
                             if c in _AUTO_USED_HINT]
            if _auto_present:
                st.caption(
                    "💡 The engine already auto-uses: **"
                    + ", ".join(_auto_present)
                    + "**. Select one to take control of how it's projected to "
                      "the future; leave it unselected to keep auto-handling."
                )
            _leak_present = [c for c in (numeric_offer + categorical_offer)
                             if c in _LEAKAGE_COLS]
            if _leak_present:
                st.caption(
                    "⚠️ Likely target leakage: **"
                    + ", ".join(_leak_present)
                    + "** are deterministic functions of sales × price — "
                      "selecting them usually breaks the forecast (perfect "
                      "training fit, no honest future signal)."
                )

            exog_user_numeric = st.multiselect(
                f"Numeric exogenous variables ({len(numeric_offer)} available)",
                options=numeric_offer,
                default=st.session_state.get('exog_user_numeric', []),
                key='exog_user_numeric',
                help="Continuous regressors. SARIMAX uses them directly; "
                     "LightGBM treats them as features.",
            )
            exog_user_categorical = st.multiselect(
                f"Categorical exogenous variables ({len(categorical_offer)} available)",
                options=categorical_offer,
                default=st.session_state.get('exog_user_categorical', []),
                key='exog_user_categorical',
                help="Encoded as category dtype; LightGBM splits on them. "
                     "SARIMAX ignores these (it needs numeric).",
            )

            # ── Per-column future-projection strategy ──────────────────────
            # Every regressor needs a value in the forecast horizon, where the
            # target is unknown. "Auto" routes each column by future-knowability:
            #   • calendar/festival features → recomputed exactly from the date
            #   • planned-event (evt_*) flags → fire on their event dates
            #   • price/outlier flags         → 0 (assume no change)
            #   • everything else             → repeat the seasonal pattern
            # The planner can override per column (e.g. a known peak month →
            # Hold flat; a macro index with no future scenario → Assume zero).
            exog_future_strategy: Dict[str, str] = {}
            exog_future_values: Dict[str, List[float]] = {}
            if exog_user_numeric:
                _STRAT_OPTS = {
                    'Auto (recommended)': 'auto',
                    'Repeat seasonal (same month last year)': 'repeat_seasonal',
                    'Hold flat (last value)': 'flat',
                    'Assume zero / no change': 'zero',
                    'Calendar (recompute from date)': 'calendar',
                    'Enter future values (comma-separated)': 'explicit',
                }
                _auto_preview = dict(summarize_exog_projection(exog_user_numeric))
                # NOTE: a plain container (not st.expander) — this block already
                # renders inside the "2b" expander and Streamlit forbids nesting
                # expanders.
                st.markdown("**How each exog is projected into the future**")
                st.caption(
                    "Pick how each numeric exog is filled past the last "
                    "observation. ‘Auto’ chooses by how knowable the feature "
                    "is; the hint shows what Auto would do."
                )
                for _c in exog_user_numeric:
                    _label = st.selectbox(
                        _c,
                        options=list(_STRAT_OPTS.keys()),
                        index=0,
                        key=f'exog_strat_{_c}',
                        help=f"Auto → {_auto_preview.get(_c, 'repeat seasonal')}",
                    )
                    _sel = _STRAT_OPTS[_label]
                    if _sel == 'explicit':
                        # Reveal a text input for the planner's explicit values.
                        # Parsed at forecast time when the horizon is known —
                        # missing tail falls back to seasonal repeat.
                        _raw = st.text_input(
                            f"Future values for {_c} (comma-separated, one per period)",
                            value=st.session_state.get(f'exog_vals_{_c}', ''),
                            key=f'exog_vals_{_c}',
                            placeholder="e.g. 5000, 8000, 6000, 4000, 7000, 9000",
                        )
                        _vals: List[float] = []
                        for _tok in str(_raw or '').split(','):
                            _tok = _tok.strip()
                            if not _tok:
                                continue
                            try:
                                _vals.append(float(_tok))
                            except ValueError:
                                pass  # silently skip un-parsable tokens
                        if _vals:
                            exog_future_values[_c] = _vals
                            exog_future_strategy[_c] = 'explicit'
                            st.caption(
                                f"✓ {len(_vals)} explicit value(s) for **{_c}** — "
                                "applied first, then seasonal repeat for any remaining periods."
                            )
                        else:
                            st.caption(
                                f"⚠ No values entered for **{_c}** — falls back to "
                                "seasonal repeat until you enter some."
                            )
                    elif _sel != 'auto':
                        exog_future_strategy[_c] = _sel
                exog_extrap = 'per-column (auto + overrides)'
            else:
                exog_extrap = 'Same month last year'

            if exog_user_numeric or exog_user_categorical:
                st.caption(
                    f"✅ {len(exog_user_numeric)} numeric + "
                    f"{len(exog_user_categorical)} categorical exog selected."
                )

        # =================================================================
        # 2c. FUTURE EVENTS CALENDAR
        # =================================================================
        # The planner pins specific upcoming events (Diwali, store launches,
        # supplier-driven outages, promo blasts) so the engine can attribute
        # demand swings to them rather than blame the model. Each row carries
        # a date, name, type, expected % impact, and an applicability scope.
        with st.expander("2c. Future Events Calendar", expanded=False):
            st.caption(
                "Pin upcoming events (and their expected demand impact) so "
                "the model + planner know what's coming. Adds an event-flag "
                "column to the exog set AND applies your impact % as a "
                "post-forecast adjustment to every month inside the event's "
                "date range."
            )

            # ── Column schema (used by editor, template download, upload) ──
            # event_start_date + event_end_date replace the old single-date
            # column. Past uploads that still use `event_date` are migrated
            # transparently by _event_date_range on the engine side.
            _EVENTS_COLUMNS = [
                'event_start_date', 'event_end_date',
                'event_name', 'event_type', 'impact_pct',
                'applies_to', 'notes',
            ]

            def _new_events_df() -> pd.DataFrame:
                """Empty frame with the canonical column order + dtypes."""
                return pd.DataFrame({
                    'event_start_date': pd.Series(dtype='datetime64[ns]'),
                    'event_end_date': pd.Series(dtype='datetime64[ns]'),
                    'event_name': pd.Series(dtype='object'),
                    'event_type': pd.Series(dtype='object'),
                    'impact_pct': pd.Series(dtype='float64'),
                    'applies_to': pd.Series(dtype='object'),
                    'notes': pd.Series(dtype='object'),
                })

            def _migrate_legacy_event_date(df_evt: pd.DataFrame) -> pd.DataFrame:
                """Promote an uploaded `event_date` column into start+end."""
                out = df_evt.copy()
                if 'event_date' in out.columns:
                    legacy = pd.to_datetime(out['event_date'], errors='coerce')
                    if 'event_start_date' not in out.columns:
                        out['event_start_date'] = legacy
                    else:
                        out['event_start_date'] = (
                            pd.to_datetime(out['event_start_date'], errors='coerce')
                            .fillna(legacy))
                    if 'event_end_date' not in out.columns:
                        out['event_end_date'] = legacy
                    else:
                        out['event_end_date'] = (
                            pd.to_datetime(out['event_end_date'], errors='coerce')
                            .fillna(legacy))
                    out = out.drop(columns=['event_date'])
                # Ensure every canonical column exists, in canonical order
                for c in _EVENTS_COLUMNS:
                    if c not in out.columns:
                        out[c] = pd.NA
                return out[_EVENTS_COLUMNS]

            if 'future_events_df' not in st.session_state:
                st.session_state.future_events_df = _new_events_df()

            # ── Toolbar: Download template + Upload CSV ──
            tb1, tb2, tb3 = st.columns([1.2, 1.4, 1.1])
            with tb1:
                # Template CSV — empty schema + one example row so the user
                # can edit in Excel and re-upload without guessing columns.
                _today = pd.Timestamp.today().normalize()
                _template_df = pd.DataFrame([
                    {
                        'event_start_date': (_today + pd.DateOffset(months=2)).strftime('%Y-%m-%d'),
                        'event_end_date':   (_today + pd.DateOffset(months=2)).strftime('%Y-%m-%d'),
                        'event_name': 'Diwali Promo',
                        'event_type': 'Promo',
                        'impact_pct': 15.0,
                        'applies_to': 'ALL',
                        'notes': 'Festive-season uplift (replace / remove this row).',
                    },
                    {
                        'event_start_date': (_today + pd.DateOffset(months=5)).strftime('%Y-%m-%d'),
                        'event_end_date':   (_today + pd.DateOffset(months=6)).strftime('%Y-%m-%d'),
                        'event_name': 'Year-end Clearance',
                        'event_type': 'Promo',
                        'impact_pct': -10.0,
                        'applies_to': 'Footwear, Apparel',
                        'notes': 'Multi-month markdown event.',
                    },
                ], columns=_EVENTS_COLUMNS)
                st.download_button(
                    "📥 Download template",
                    data=_template_df.to_csv(index=False).encode('utf-8'),
                    file_name="events_calendar_template.csv",
                    mime="text/csv",
                    use_container_width=True,
                    help="Edit in Excel / Google Sheets and re-upload via "
                         "the button on the right.",
                )
            with tb2:
                _up = st.file_uploader(
                    "📤 Upload events CSV (replaces current list)",
                    type=['csv'],
                    key='events_csv_uploader',
                    help="CSV must include event_start_date, event_end_date, "
                         "event_name and impact_pct columns. Legacy files "
                         "with a single `event_date` column are auto-migrated.",
                )
                if _up is not None and st.session_state.get('_events_last_upload_name') != _up.name:
                    try:
                        _uploaded = pd.read_csv(_up)
                        _uploaded = _migrate_legacy_event_date(_uploaded)
                        # Coerce date columns to proper datetime so the editor
                        # renders the DateColumn cells, not free-text strings.
                        for _dc in ('event_start_date', 'event_end_date'):
                            _uploaded[_dc] = pd.to_datetime(
                                _uploaded[_dc], errors='coerce')
                        # Drop rows where both dates fail to parse — protect
                        # the engine from junk inputs.
                        _uploaded = _uploaded[
                            _uploaded['event_start_date'].notna()
                            | _uploaded['event_end_date'].notna()
                        ].reset_index(drop=True)
                        st.session_state.future_events_df = _uploaded
                        st.session_state._events_last_upload_name = _up.name
                        st.success(
                            f"✅ Loaded **{len(_uploaded)}** event(s) from "
                            f"`{_up.name}`. Edit below or re-upload to replace."
                        )
                        st.rerun()
                    except Exception as _ue:
                        st.error(f"Couldn't parse uploaded file: {_ue}")
            with tb3:
                if st.button("🗑 Clear all events",
                             use_container_width=True,
                             help="Discard every row in the calendar below."):
                    st.session_state.future_events_df = _new_events_df()
                    st.session_state._events_last_upload_name = None
                    st.rerun()

            # ── Editor ──
            events_edited = st.data_editor(
                st.session_state.future_events_df,
                num_rows='dynamic',
                use_container_width=True,
                hide_index=True,
                column_config={
                    'event_start_date': st.column_config.DateColumn(
                        'Start date', required=True,
                        help='First calendar day of the event (inclusive). '
                             'For a single-month event, set Start = End to '
                             'the same day.'),
                    'event_end_date': st.column_config.DateColumn(
                        'End date', required=True,
                        help='Last calendar day of the event (inclusive). '
                             'Multi-month ranges flag every month between '
                             'Start and End — useful for clearance windows, '
                             'campaign bursts, supplier outages.'),
                    'event_name': st.column_config.TextColumn(
                        'Event name', required=True,
                        help='Short label (e.g. "Diwali", "New Store Launch").'),
                    'event_type': st.column_config.SelectboxColumn(
                        'Type',
                        options=['Holiday', 'Promo', 'Launch', 'Closure',
                                 'Stock-out', 'Price change', 'Marketing burst',
                                 'External shock', 'Other'],
                        required=False),
                    'impact_pct': st.column_config.NumberColumn(
                        'Impact %', format='%.1f', step=1.0,
                        help='Expected demand change in % '
                             '(positive = uplift, negative = drop). '
                             'Applied to every month in the date range.'),
                    'applies_to': st.column_config.TextColumn(
                        'Applies to',
                        help='Comma-separated values matching category / brand / '
                             'segment / sku. Use "ALL" for the entire portfolio. '
                             'Example: "Footwear, Apparel" or "Strider, Urbano".'),
                    'notes': st.column_config.TextColumn(
                        'Notes',
                        help='Internal note — captured in the audit trail.'),
                },
                key='future_events_editor',
                column_order=_EVENTS_COLUMNS,
            )
            st.session_state.future_events_df = events_edited

            if not events_edited.empty:
                n_events = len(events_edited)
                n_with_impact = int((events_edited.get('impact_pct',
                                                       pd.Series(dtype=float))
                                     .fillna(0) != 0).sum())
                # Count multi-month events to surface the new range feature.
                _multi_month = 0
                _total_months_flagged = 0
                for _, _r in events_edited.iterrows():
                    _s, _e = _event_date_range(_r)
                    if _s is None:
                        continue
                    _months = _event_months_in_range(_s, _e)
                    _total_months_flagged += len(_months)
                    if len(_months) > 1:
                        _multi_month += 1
                st.caption(
                    f"✅ {n_events} event(s) pinned · {n_with_impact} with "
                    f"non-zero impact % · {_multi_month} multi-month range(s) · "
                    f"{_total_months_flagged} month-flags will be applied. "
                    f"Past-dated events feed historical feature flags; "
                    f"future-dated events apply on the forecast horizon."
                )

                # Download the CURRENTLY-EDITED frame — round-trip with Excel
                # without losing in-flight edits.
                _export = events_edited.copy()
                for _dc in ('event_start_date', 'event_end_date'):
                    if _dc in _export.columns:
                        _export[_dc] = pd.to_datetime(
                            _export[_dc], errors='coerce'
                        ).dt.strftime('%Y-%m-%d')
                st.download_button(
                    "💾 Download current events as CSV",
                    data=_export.to_csv(index=False).encode('utf-8'),
                    file_name="events_calendar_current.csv",
                    mime="text/csv",
                    help="Snapshot of what's in the editor right now — "
                         "useful for sharing or version control.",
                )

        with st.expander("3. Routing Thresholds", expanded=False):
            st.caption("Defaults are tuned for monthly retail data; adjust if your series differ.")
            cold_thr = st.number_input(
                "Cold-start threshold (months)", 1, 24, 6,
                help="SKUs with fewer months than this go to Chronos zero-shot.",
            )
            short_thr = st.number_input(
                "Short-history threshold (months)", 1, 36, 12,
                help="SKUs between cold-start and short-history use the global LightGBM model.",
            )
            if short_thr <= cold_thr:
                st.warning("Short-history threshold should be greater than cold-start.")

        with st.expander("4. Forecast Horizon", expanded=True):
            horizon = st.number_input(
                "Periods to forecast", 1, 36, 12,
                help="Number of future periods to predict (in the units of the frequency above).",
            )

        # Workflow progress indicator
        step = 1  # data loaded
        if st.session_state.get('eda_object') is not None:
            step = 2
        if st.session_state.get('profiled'):
            step = 3
        if st.session_state.get('forecasts_run'):
            step = 4
        _render_workflow_progress(step=step)

        # Resolve segment/brand cfg values:
        # If user has these on '(none)' but the dataframe already has a real
        # 'segment' (or 'brand') column — e.g. injected by the Data-tab Retail
        # Segmentation flow — auto-pick it so downstream profiling /
        # panel-feature builders see the labels instead of falling back to
        # 'unknown'. This breaks the Streamlit widget-state drift where the
        # selectbox stays on '(none)' across reruns after segmentation runs.
        _resolved_seg = None if segment_col == '(none)' else segment_col
        if (_resolved_seg is None) and ('segment' in cols):
            _resolved_seg = 'segment'
        _resolved_brand = None if brand_col == '(none)' else brand_col
        if (_resolved_brand is None) and ('brand' in cols):
            _resolved_brand = 'brand'

        return {
            'date_col': date_col, 'date_format': date_format or None,
            'sku_col': sku_col, 'sales_col': sales_col,
            'segment_col': _resolved_seg,
            'brand_col': _resolved_brand,
            'freq': freq, 'horizon': horizon,
            'cold_thr': cold_thr, 'short_thr': short_thr,
            # Optional cutoff: rows with date_col < this are dropped before
            # profiling / forecasting (filter is applied in the profile + EDA
            # tabs so df_processed always carries the filtered view).
            'history_start_date': (pd.Timestamp(history_start_date)
                                   if history_start_date else None),
            # User-supplied exogenous drivers (2b)
            'exog_user_numeric': list(exog_user_numeric or []),
            'exog_user_categorical': list(exog_user_categorical or []),
            'exog_extrap_rule': exog_extrap,
            # Per-column future-projection overrides ({col: strategy}); empty
            # dict means every column uses Auto (future-knowability routing).
            'exog_future_strategy': dict(exog_future_strategy or {}),
            # Planner-supplied explicit future values per column ({col: [v0,…]}).
            # Highest precedence at forecast time — any per-period value present
            # here overrides the projection strategy; any missing tail falls
            # back to the strategy (seasonal repeat by default).
            'exog_future_values': dict(exog_future_values or {}),
            'holiday_country': 'IN',
            # Future events calendar (2c) — DataFrame or None
            'future_events': (st.session_state.get('future_events_df')
                              if 'future_events_df' in st.session_state
                              and not st.session_state.future_events_df.empty
                              else None),
        }


def _render_workflow_progress(step: int):
    """Visual indicator of where the user is in the standard TS workflow."""
    stages = [
        ("Load Data", 1),
        ("EDA", 2),
        ("Profile", 3),
        ("Forecast", 4),
        ("Report", 5),
    ]
    parts = []
    for label, idx in stages:
        if step >= idx:
            parts.append(f"<span style='color:{DHISHAAI_ORANGE};font-weight:600;'>● {label}</span>")
        else:
            parts.append(f"<span style='color:#bbb;'>○ {label}</span>")
    st.markdown("---")
    st.markdown(
        f"<div style='font-size:0.85rem; line-height:1.8;'>"
        f"<strong>Workflow:</strong><br/>{'<br/>'.join(parts)}"
        f"</div>",
        unsafe_allow_html=True,
    )


def render_profiling_tab(cfg):
    """Step 3 of the workflow: SKU intermittency classification & forecasting strategy routing."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 3 · Profile &amp; Route</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                SKU Classification &amp; Forecasting Strategy
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Intermittency-aware routing — every SKU gets the best-fit model family
            </div>
        </div>
    """, unsafe_allow_html=True)

    # Reparse dates ONCE per df_raw — once parsed, the result lives in
    # session_state.df_processed_dates and tab switches reuse it. Previously
    # every render of this tab copied the full df (potentially hundreds of MB)
    # and re-coerced the date column, which dominated tab-switch latency on
    # large portfolios.
    df_raw = st.session_state.df_raw
    # Cache key MUST include the columns tuple — the Data-tab Retail
    # Segmentation flow mutates df_raw in place to add a 'segment' column,
    # so id(df_raw) doesn't change. Without the column-tuple sentinel, the
    # profile tab kept reusing a stale snapshot that lacked the 'segment'
    # column and every SKU's segment came out as 'unknown'.
    _hist_start = cfg.get('history_start_date')
    _cache_key = (
        id(df_raw),
        tuple(df_raw.columns),
        cfg.get('date_col'),
        cfg.get('date_format'),
        _hist_start,
    )
    if st.session_state.get('_profile_df_cache_key') != _cache_key:
        df = df_raw.copy()
        if cfg['date_format']:
            df[cfg['date_col']] = pd.to_datetime(
                df[cfg['date_col']], format=cfg['date_format'], errors='coerce')
        else:
            # Auto-detect failed to infer a format upstream — fall back to
            # dayfirst=True so monthly placeholders like '01/02/22' parse as
            # Feb-1 (DD/MM/YY) instead of pandas' US default Jan-2 (MM/DD/YY),
            # which would collapse every observation into January.
            df[cfg['date_col']] = pd.to_datetime(
                df[cfg['date_col']], dayfirst=True, errors='coerce')
        # Drop rows older than the planner-chosen cutoff (if any).
        if _hist_start is not None:
            _before = len(df)
            df = df[df[cfg['date_col']] >= pd.Timestamp(_hist_start)].copy()
            st.session_state['_profile_filter_dropped'] = _before - len(df)
        else:
            st.session_state['_profile_filter_dropped'] = 0
        st.session_state['_profile_df_cache'] = df
        st.session_state['_profile_df_cache_key'] = _cache_key
    else:
        df = st.session_state['_profile_df_cache']

    _dropped = st.session_state.get('_profile_filter_dropped', 0)
    if _dropped:
        st.info(f"📅 Training window: dropped **{_dropped:,}** rows older than "
                f"**{pd.Timestamp(_hist_start).date()}** "
                f"(using {len(df):,} rows for profiling & forecasting).")

    # =================================================================
    # PHASE 1 · SEGMENT — Volatility × Contribution
    # Relocated here from the Data tab so segmentation, intermittency
    # profiling, and routing form ONE unified step after EDA. The state
    # machine below (DB-load / compute / validate & save) injects the
    # 'segment' column into df_raw, which Phase 2 then reads. Both phases
    # share a single per-SKU statistical pass: compute_retail_segmentation
    # now also emits the SBC intermittency that profile_all_skus reuses
    # (see the `_seg_stats` argument at the Run-profiling call below).
    # =================================================================
    _df_seg = st.session_state.df_raw
    _sku_c, _date_c, _sales_c = cfg['sku_col'], cfg['date_col'], cfg['sales_col']
    _has_rev = 'revenue' in _df_seg.columns
    try:
        if cfg.get('date_format'):
            _dts = pd.to_datetime(_df_seg[_date_c], format=cfg['date_format'], errors='coerce')
        else:
            _dts = pd.to_datetime(_df_seg[_date_c], errors='coerce')
        _date_min, _date_max = _dts.min().date(), _dts.max().date()
    except Exception:
        _date_min = _date_max = None
    _render_data_segmentation_subtab(
        df=_df_seg, cfg=cfg, sku_col=_sku_c, date_col=_date_c, sales_col=_sales_c,
        has_revenue=_has_rev, has_brand=('brand' in _df_seg.columns),
        has_truth=('segments' in _df_seg.columns),
        rev_col_to_use=('revenue' if _has_rev else None),
        n_total=_df_seg[_sku_c].nunique(),
        date_min=_date_min, date_max=_date_max,
    )
    st.markdown("---")

    # ---- Pattern → model routing (same classification as the segment) ----
    st.markdown("### Demand Pattern → Model Routing")
    st.caption("Same single classification as the segment above — the SBC demand "
                "pattern (Smooth / Erratic / Intermittent / Lumpy) is what defines "
                "Stable vs Volatile, and here it routes each SKU to the matching "
                "model family. Stable SKUs are smooth by definition, so the two "
                "views can never disagree.")

    if not st.session_state.get('profiled'):
        if st.button("Run intermittency profiling", use_container_width=True, key='btn_profile'):
            with st.spinner(f"Profiling {df[cfg['sku_col']].nunique():,} SKUs…"):
                # Reuse Phase-1's per-SKU stats (ADI/CV²/intermittency) instead
                # of re-grouping the panel — but ONLY when the segmentation ran
                # on the same data scope. A history-window filter makes the
                # profiling df a strict subset of the segmentation df, so the
                # cached stats would be wrong; in that case pass None and let
                # profile_all_skus recompute on the filtered panel.
                _seg_stats = st.session_state.get('retail_seg_df')
                if st.session_state.get('_profile_filter_dropped', 0):
                    _seg_stats = None
                profiles = profile_all_skus(
                    df, cfg['sku_col'], cfg['sales_col'], cfg['date_col'],
                    cfg['segment_col'], cfg['brand_col'],
                    cold_start_threshold=cfg['cold_thr'],
                    short_history_threshold=cfg['short_thr'],
                    _seg_stats=_seg_stats,
                )
                st.session_state.profiles = profiles
                st.session_state.df_processed = df
                st.session_state.profiled = True
                # Pin the segment signature in use at profile time — lets render_data_tab
                # detect drift and invalidate this run when the user re-segments.
                if 'segment' in df.columns:
                    _sig_map = (df[[cfg['sku_col'], 'segment']].drop_duplicates()
                                .set_index(cfg['sku_col'])['segment']
                                .astype(str).to_dict())
                    st.session_state._seg_signature_at_profile = (
                        st.session_state.get('seg_flow_run_id')
                        or hash(tuple(sorted(_sig_map.items())))
                    )
                st.rerun()
        else:
            st.info("Click *Run intermittency profiling* to classify every SKU by demand pattern. "
                    "This takes ~5–15 seconds on a 3K-SKU portfolio.")
            return

    profiles = st.session_state.profiles

    # KPI strip
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("SKUs profiled", f"{len(profiles):,}")
    c2.metric("Cold-start", f"{profiles['is_cold_start'].sum():,}",
              help="< cold-start threshold months → Chronos zero-shot")
    c3.metric("Short history", f"{profiles['is_short_history'].sum():,}",
              help="Routed to global LightGBM")
    c4.metric("Intermittent / Lumpy", f"{profiles['intermittency'].isin(['intermittent','lumpy']).sum():,}",
              help="Many zeros — handled by Croston / SBA")
    c5.metric("Brands", profiles['brand'].nunique() if 'brand' in profiles else 0)

    st.write("")

    # ---- Strategy distribution + intermittency split — side by side ----
    col1, col2 = st.columns(2)

    with col1:
        st.markdown("##### Recommended forecasting strategy")
        strat_counts = profiles['recommended_strategy'].value_counts().reset_index()
        strat_counts.columns = ['strategy', 'count']
        fig = px.bar(strat_counts, x='count', y='strategy', orientation='h',
                     color='strategy', text='count',
                     color_discrete_sequence=[DHISHAAI_BLUE, DHISHAAI_ORANGE,
                                              '#10b981', '#f59e0b', '#dc2626', '#94a3b8'])
        fig.update_layout(showlegend=False, height=320, margin=dict(l=0,r=0,t=10,b=0),
                          plot_bgcolor='white', xaxis_title='', yaxis_title='')
        st.plotly_chart(fig, use_container_width=True)

    with col2:
        st.markdown("##### Demand pattern (intermittency)")
        int_counts = profiles['intermittency'].value_counts().reset_index()
        int_counts.columns = ['pattern', 'count']
        fig2 = px.pie(int_counts, names='pattern', values='count', hole=0.5,
                      color_discrete_sequence=[DHISHAAI_BLUE, DHISHAAI_ORANGE,
                                               '#10b981', '#f59e0b', '#dc2626'])
        fig2.update_layout(height=320, margin=dict(l=0,r=0,t=10,b=0),
                           legend=dict(orientation='v', yanchor='middle', y=0.5))
        st.plotly_chart(fig2, use_container_width=True)

    # ---- Algorithm recommendation per SEGMENT (or intermittency fallback) ----
    # Always rendered after profiling so the planner can see — at a glance —
    # which algorithm the engine picked for each group of SKUs. Uses the
    # 'segment' column if profiles has meaningful segment values, otherwise
    # groups by intermittency class (which is always populated post-profiling).
    has_real_segments = (
        'segment' in profiles.columns
        and profiles['segment'].astype(str).str.lower().nunique() > 1
        and profiles['segment'].astype(str).str.lower().ne('unknown').any()
    )
    group_col = 'segment' if has_real_segments else 'intermittency'
    group_label = "Segment" if has_real_segments else "Intermittency class"

    # ════════════════════════════════════════════════════════════════
    # 🏗 Segment Model Architecture (NEW — merged from app_96 design)
    # Show the full forecasting stack for each segment: primary model,
    # blend members, feature pipeline, residual booster, CI source,
    # and reconciliation level. This is the engineering view sitting
    # *under* the per-segment count table further down.
    # ════════════════════════════════════════════════════════════════
    if has_real_segments:
        st.markdown("##### 🏗 Per-Segment Model Architecture")
        st.caption(
            "Each segment runs a curated forecasting stack — *primary* model "
            "+ *blend* members + *residual* booster + *features* + "
            "*confidence-interval* method + *reconciliation* level. "
            "The Per-segment overrides panel below lets you customise any of these."
        )

        seg_sku_counts = profiles['segment'].astype(str).value_counts().to_dict()
        # Render segments in catalogue order (largest first)
        for seg in sorted(seg_sku_counts.keys(),
                          key=lambda s: -seg_sku_counts.get(s, 0)):
            arch = SEGMENT_ARCHITECTURE.get(seg)
            if arch is None:
                continue
            pb = SEGMENT_PLAYBOOK.get(seg, {})
            color = pb.get('color', DHISHAAI_BLUE)
            n_sk = seg_sku_counts.get(seg, 0)

            primary_label = STRATEGY_INFO.get(
                arch['primary'], {'name': arch['primary'], 'icon': '•'})
            blend_labels = [
                STRATEGY_INFO.get(b, ADDITIONAL_ALGORITHMS.get(b, {})).get('name', b)
                for b in arch.get('blend', [])
            ]
            feature_labels = {
                'lag_rolling':  '📊 Lag + Rolling',
                'price':        '💲 Price',
                'fourier':      '🌀 Fourier seasonality',
                'holiday':      '📅 Holidays',
                'promo':        '🎁 Promo / Scheme',
                'events':       '🎉 User events',
                'cross_sku':    '🔗 Cross-SKU pool',
            }
            feat_chips = " ".join(
                f"<span style='background:#e0f2fe;color:#0c4a6e;"
                f"padding:2px 8px;border-radius:10px;font-size:0.72rem;"
                f"margin-right:4px;'>{feature_labels.get(f, f)}</span>"
                for f in arch.get('features', [])
            )
            residual = arch.get('residual_booster')
            residual_chip = (
                f"<span style='background:#fef3c7;color:#92400e;padding:3px 10px;"
                f"border-radius:10px;font-size:0.74rem;font-weight:600;'>"
                f"🚀 {residual.upper()} residual</span>"
                if residual else
                "<span style='color:#94a3b8;font-size:0.74rem;'>— no residual layer</span>"
            )
            cold_chip = (
                "<span style='background:#fce7f3;color:#9d174d;padding:3px 10px;"
                "border-radius:10px;font-size:0.74rem;font-weight:600;'>"
                "❄ DTW proxy</span>"
                if arch.get('cold_start_proxy') else ""
            )
            ci_label = arch.get('ci_source', '—')
            reconcile = arch.get('reconcile', '—')

            st.markdown(
                f"<div style='border:1px solid #e5e9ee;border-left:5px solid {color};"
                f"border-radius:10px;padding:14px 16px;margin-bottom:10px;"
                f"background:linear-gradient(180deg,#fafbfc 0%,#ffffff 100%);'>"
                # Header
                f"<div style='display:flex;justify-content:space-between;"
                f"align-items:baseline;margin-bottom:8px;'>"
                f"<div style='font-weight:700;color:#1e293b;font-size:1.0rem;'>"
                f"{seg} "
                f"<span style='font-weight:500;color:#6b7785;font-size:0.82rem;'>"
                f"· {n_sk} SKUs</span></div>"
                f"<div style='background:{color};color:#fff;padding:3px 10px;"
                f"border-radius:12px;font-size:0.72rem;font-weight:700;'>"
                f"{pb.get('priority', '—')}</div>"
                f"</div>"
                # Tagline
                f"<div style='font-size:0.82rem;color:#475569;margin-bottom:10px;"
                f"font-style:italic;'>{arch.get('tagline', '')}</div>"
                # Primary
                f"<div style='display:flex;gap:18px;flex-wrap:wrap;"
                f"font-size:0.82rem;margin-bottom:8px;'>"
                f"<div><b style='color:#1e293b;'>Primary:</b> "
                f"<span style='color:{color};font-weight:600;'>"
                f"{primary_label['icon']} {primary_label['name']}</span></div>"
                f"<div><b style='color:#1e293b;'>Blend method:</b> "
                f"<span style='color:#475569;'>{arch.get('blend_method', '—')}</span></div>"
                f"<div><b style='color:#1e293b;'>CI source:</b> "
                f"<span style='color:#475569;'>{ci_label}</span></div>"
                f"<div><b style='color:#1e293b;'>Reconcile:</b> "
                f"<span style='color:#475569;'>{reconcile}</span></div>"
                f"</div>"
                # Blend chips
                f"<div style='font-size:0.78rem;margin-bottom:8px;'>"
                f"<b style='color:#1e293b;'>Blend members:</b> "
                + " · ".join(
                    f"<span style='color:#0f766e;'>{b}</span>" for b in blend_labels
                ) + "</div>"
                # Features + boosters
                f"<div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap;'>"
                f"<div style='font-size:0.78rem;'><b style='color:#1e293b;'>Features:</b></div>"
                f"<div>{feat_chips}</div>"
                f"<div>{residual_chip}</div>"
                f"<div>{cold_chip}</div>"
                f"</div>"
                f"</div>",
                unsafe_allow_html=True,
            )
        st.markdown("---")

    st.markdown(f"##### 🎯 Recommended algorithm per {group_label.lower()}")
    if not has_real_segments:
        st.caption(
            "No segment column was supplied — showing recommendations grouped "
            "by intermittency class. Run **Data → Retail Segmentation** "
            "(or pick a Segment column in the sidebar) to see the full "
            "Volatility × Contribution breakdown."
        )

    # Build a tidy pivot: rows = group value, cols = strategy → SKU count.
    rec_pivot = (
        profiles.groupby([group_col, 'recommended_strategy'])
        .size().reset_index(name='count')
    )
    if not rec_pivot.empty:
        # Per-group: total SKUs + top strategy
        per_group = (
            rec_pivot.sort_values('count', ascending=False)
                     .groupby(group_col, as_index=False)
                     .agg(top_strategy=('recommended_strategy', 'first'),
                          top_count=('count', 'first'),
                          n_skus=('count', 'sum'))
        )
        # Full breakdown string for each group
        def _breakdown_for(g):
            sub = rec_pivot[rec_pivot[group_col] == g].sort_values('count', ascending=False)
            return ", ".join(
                f"{STRATEGY_INFO.get(s, {}).get('name', s)} ({c})"
                for s, c in zip(sub['recommended_strategy'], sub['count'])
            )
        per_group['breakdown'] = per_group[group_col].apply(_breakdown_for)
        # Human-friendly top-strategy label
        per_group['Top recommended algorithm'] = per_group['top_strategy'].apply(
            lambda s: STRATEGY_INFO.get(s, {}).get('name', s)
        )
        per_group = per_group.rename(columns={
            group_col: group_label,
            'n_skus': 'SKUs',
            'top_count': 'Top algo SKU count',
            'breakdown': 'All recommended algorithms (count)',
        })[[group_label, 'SKUs', 'Top recommended algorithm',
            'Top algo SKU count', 'All recommended algorithms (count)']]
        per_group = per_group.sort_values('SKUs', ascending=False)
        st.dataframe(per_group, use_container_width=True, hide_index=True)
    else:
        st.info("No recommendations to show — profiling produced an empty table.")

    # Intermittency × segment crosstab
    if has_real_segments:
        with st.expander("Intermittency × Segment crosstab"):
            ct = pd.crosstab(profiles['segment'], profiles['intermittency'])
            st.dataframe(ct, use_container_width=True)

    with st.expander("Per-SKU profile (sortable, searchable)"):
        show = profiles.copy()
        show['mean_sales'] = show['mean_sales'].round(2)
        show['cv'] = show['cv'].round(2)
        show['adi'] = show['adi'].replace(np.inf, np.nan).round(2)
        st.dataframe(show, use_container_width=True, height=400)

    # =================================================================
    # FINAL ALGORITHM SELECTION
    # After segmentation + intermittency routing have decided the
    # auto-routed algorithm per SKU, give the user explicit control:
    #   • View the auto-routed portfolio (which algorithms / SKU counts)
    #   • Disable any auto-routed algorithm (SKUs fall back to Ensemble)
    #   • Add additional algorithms that run alongside (for benchmarking
    #     or building ensembles)
    # The selection persists in st.session_state.algo_portfolio and
    # gates the Forecast tab's run.
    # =================================================================
    st.markdown("---")
    _render_algorithm_portfolio(profiles)


# ====================================================================
# Algorithm-portfolio metadata + UI
# ====================================================================

# Human-friendly metadata for every auto-routed strategy. Keyed by the
# string returned from `recommend_strategy()`.
STRATEGY_INFO = {
    'chronos_zero_shot': {
        'name': 'Chronos (Zero-Shot)', 'family': 'Foundation Model', 'icon': '🧊',
        'use_case': 'Cold-start SKUs — too little history to fit any model.',
    },
    'global_lgbm': {
        'name': 'Global LightGBM', 'family': 'Machine Learning', 'icon': '🌳',
        'use_case': 'Short history (6–12 mo) or Volatile Low — pools across SKUs.',
    },
    'croston_sba': {
        'name': 'Croston / SBA', 'family': 'Intermittent Demand', 'icon': '〰️',
        'use_case': 'Intermittent or lumpy demand — many zeros, sporadic spikes.',
    },
    'local_sarimax_promo': {
        'name': 'Local SARIMAX + Exog', 'family': 'Statistical', 'icon': '📈',
        'use_case': 'Stable High contributors — enough data, strong exog signal.',
    },
    'ensemble_local': {
        'name': 'Ensemble Local', 'family': 'Ensemble', 'icon': '🎯',
        'use_case': 'Stable Mid / Volatile Mid-High — median of 3 local models.',
    },
    'global_lgbm_full': {
        'name': 'Global LightGBM (Full Pool)', 'family': 'Machine Learning', 'icon': '🌲',
        'use_case': 'Stable Low — bulk of catalogue with similar curve shape.',
    },
    'naive_zero': {
        'name': 'Naive Zero', 'family': 'Baseline', 'icon': '⚫',
        'use_case': 'Dead SKUs — no recent sales, forecast = 0.',
    },
    'moe': {
        'name': 'Mixture of Experts', 'family': 'Decomposition Ensemble', 'icon': '🧩',
        'use_case': ('Specialist experts for trend, seasonality, events and '
                     'price/promo, combined by a validation-optimised gate. '
                     'Strong on SKUs with several distinct demand drivers.'),
    },
    'dl_moe': {
        'name': 'Deep MoE (Keras)', 'family': 'Deep Learning', 'icon': '🧠',
        'use_case': ('Neural Mixture-of-Experts (trend + Fourier-seasonality + '
                     'transformer experts, softmax gating). Needs TensorFlow and '
                     '≥31 months; opt-in only (heavy to train).'),
    },
}

# Additional algorithms NOT in the auto-routing logic. Users can opt-in
# to run any of these *alongside* the auto-routed model for benchmarking
# or ensembling. Each entry lists a brief description of when it shines.
ADDITIONAL_ALGORITHMS = {
    'prophet': {
        'name': 'Prophet', 'family': 'Statistical',
        'description': 'Additive trend + seasonality + holidays (Meta).',
        'best_for': 'Strong yearly + holiday seasonality.',
    },
    'autoarima': {
        'name': 'AutoARIMA', 'family': 'Statistical',
        'description': 'Automatic ARIMA(p,d,q) order selection via pmdarima.',
        'best_for': 'When you want classical stats without manual tuning.',
    },
    'holt_winters': {
        'name': 'Holt-Winters', 'family': 'Statistical',
        'description': 'Triple exponential smoothing (level / trend / season).',
        'best_for': 'Smooth series with stable seasonality.',
    },
    'tsb': {
        'name': 'TSB (Teunter-Syntetos-Babai)', 'family': 'Intermittent Demand',
        'description': 'Probability × magnitude with separate decay rates.',
        'best_for': 'Lumpy demand where Croston over-shoots.',
    },
    'naive_seasonal': {
        'name': 'Naive Seasonal', 'family': 'Baseline',
        'description': 'Last year same period — the no-skill baseline.',
        'best_for': 'Benchmark — any model worth shipping must beat this.',
    },
    'theta': {
        'name': 'Theta Method', 'family': 'Statistical',
        'description': 'M3 competition winner; trend / level decomposition.',
        'best_for': 'Univariate series with mild trend, no exog.',
    },
    # ── Phase 2 enhancements (see phase2_enhancements.py) ──
    'catboost': {
        'name': 'CatBoost', 'family': 'Gradient Boosting',
        'description': 'Gradient boosting with native categorical-feature support.',
        'best_for': 'Promo/event-flag-rich, price-elastic series (Volatile/Stable Mid).',
    },
    'xgb_quantile_90': {
        'name': 'Quantile Regression (P90)', 'family': 'Risk-Aware',
        'description': '90th-percentile forecast for safety-stock / risk planning.',
        'best_for': 'High-stakes spiky demand where upside risk matters (Volatile High).',
    },
    'neural_elasticity': {
        'name': 'Neural Elasticity (LSTM)', 'family': 'Deep Learning',
        'description': 'LSTM that learns nonlinear price–demand elasticity curves.',
        'best_for': 'Price-sensitive hero/promo SKUs with long history (needs TensorFlow).',
    },
    'dl_moe': {
        'name': 'Deep MoE (Keras)', 'family': 'Deep Learning',
        'description': ('Neural Mixture-of-Experts: trend + Fourier-seasonality + '
                        'transformer experts with a softmax gating network.'),
        'best_for': ('Long-history SKUs (≥31 months) with rich exog signal. '
                     'Heavy — opt-in only; needs TensorFlow.'),
    },
}


def _render_algorithm_portfolio(profiles: pd.DataFrame) -> None:
    """Final algorithm selection UI — auto-routed view + customization.

    Reads / writes `st.session_state.algo_portfolio` which has shape:
        {
            'auto_routed':  {strategy_key: {'enabled': bool, 'count': int}},
            'additional':   {algo_key: bool},
        }
    """
    st.markdown("### 🎛 Final Algorithm Selection")
    st.caption(
        "Auto-routing has decided one algorithm per SKU. Review the portfolio "
        "below, disable anything you don't want to run, and optionally add "
        "additional algorithms for benchmarking. Disabled algorithms route "
        "their SKUs to the **Ensemble Local** fallback."
    )

    # ---- Initialize / refresh session state ----
    auto_counts = profiles['recommended_strategy'].value_counts().to_dict()

    # Build the segment → SKU-count map and per-segment auto-routed split
    seg_present = (
        profiles['segment'].dropna().astype(str).tolist()
        if 'segment' in profiles.columns else []
    )
    seg_counts = (
        profiles.groupby('segment').size().to_dict()
        if 'segment' in profiles.columns else {}
    )
    if 'algo_portfolio' not in st.session_state:
        st.session_state.algo_portfolio = {
            'auto_routed': {s: {'enabled': True, 'count': c}
                            for s, c in auto_counts.items()},
            'additional': {a: False for a in ADDITIONAL_ALGORITHMS},
            'segment_overrides': {
                seg: {'primary': None, 'extras': []}
                for seg in seg_counts
            },
        }
    else:
        # Reconcile with current profiles — counts may have changed if
        # the user re-ran segmentation / profiling.
        ap = st.session_state.algo_portfolio.setdefault('auto_routed', {})
        for s, c in auto_counts.items():
            if s in ap:
                ap[s]['count'] = c
            else:
                ap[s] = {'enabled': True, 'count': c}
        # Drop entries for strategies that vanished from the routing table.
        for s in list(ap.keys()):
            if s not in auto_counts:
                ap[s]['count'] = 0
        # Backfill any new additional-algo keys.
        add = st.session_state.algo_portfolio.setdefault('additional', {})
        for a in ADDITIONAL_ALGORITHMS:
            if a not in add:
                add[a] = False
        # Backfill per-segment override slots for any new segments.
        seg_ov = st.session_state.algo_portfolio.setdefault('segment_overrides', {})
        for seg in seg_counts:
            if seg not in seg_ov:
                seg_ov[seg] = {'primary': None, 'extras': []}

    portfolio = st.session_state.algo_portfolio

    # ---- Section 1: Auto-routed algorithms ----
    st.markdown("##### 🤖 Auto-routed algorithms")
    st.caption(
        "These are the algorithms the routing engine assigned automatically "
        "based on each SKU's segment, intermittency, and history length."
    )

    auto_keys_sorted = sorted(
        portfolio['auto_routed'].keys(),
        key=lambda k: -portfolio['auto_routed'][k]['count'],
    )

    for ak in auto_keys_sorted:
        info = STRATEGY_INFO.get(
            ak, {'name': ak, 'family': '—', 'icon': '•', 'use_case': '—'}
        )
        count = portfolio['auto_routed'][ak]['count']
        if count == 0:
            continue  # don't show empty algorithms after a re-run
        current = portfolio['auto_routed'][ak]['enabled']
        cA, cB, cC = st.columns([6, 1.4, 1])
        with cA:
            st.markdown(
                f"<div style='display:flex;align-items:center;gap:14px;"
                f"padding:10px 14px;background:#f8fafc;border-radius:10px;"
                f"border:1px solid #e5e9ee;'>"
                f"<div style='font-size:1.6rem;line-height:1;'>{info['icon']}</div>"
                f"<div style='flex:1;'>"
                f"<div style='font-weight:700;color:#1e293b;font-size:0.95rem;'>"
                f"{info['name']}"
                f" <span style='font-weight:500;color:#6b7785;font-size:0.78rem;'>"
                f"· {info['family']}</span>"
                f"</div>"
                f"<div style='font-size:0.82rem;color:#475569;margin-top:2px;'>"
                f"{info['use_case']}</div></div></div>",
                unsafe_allow_html=True,
            )
        with cB:
            st.markdown(
                f"<div style='display:flex;align-items:center;justify-content:center;"
                f"height:100%;padding-top:18px;'>"
                f"<div style='background:{DHISHAAI_BLUE};color:#fff;padding:6px 14px;"
                f"border-radius:14px;font-size:0.82rem;font-weight:700;'>"
                f"{count:,} SKUs</div></div>",
                unsafe_allow_html=True,
            )
        with cC:
            st.markdown("<div style='padding-top:18px;'></div>",
                        unsafe_allow_html=True)
            new_val = st.checkbox(
                "Enable", value=current,
                key=f"algo_auto_{ak}",
                label_visibility="collapsed",
            )
            portfolio['auto_routed'][ak]['enabled'] = new_val

    # ---- Section 2: Additional algorithms (opt-in) ----
    st.markdown("")
    st.markdown("##### ➕ Add additional algorithms")
    st.caption(
        "These are **not** auto-routed. Tick any to run alongside the "
        "auto-routed model on every SKU — useful for benchmarking or "
        "building blended ensembles in the Forecast step."
    )

    add_keys = list(ADDITIONAL_ALGORITHMS.keys())
    add_cols = st.columns(2)
    for i, ak in enumerate(add_keys):
        info = ADDITIONAL_ALGORITHMS[ak]
        with add_cols[i % 2]:
            new_val = st.checkbox(
                f"**{info['name']}**  · _{info['family']}_",
                value=portfolio['additional'][ak],
                key=f"algo_add_{ak}",
                help=f"{info['description']}  \n**Best for:** {info['best_for']}",
            )
            portfolio['additional'][ak] = new_val

    # ---- Section 2b: Per-segment overrides ----
    # Only show per-segment overrides when there are REAL segment labels —
    # if profiles has only 'unknown' (no segmentation flow run), there's
    # nothing meaningful to override per-segment. The user should run
    # **Data → Retail Segmentation** first to get real labels.
    _real_seg_keys = [
        s for s in seg_counts.keys()
        if s and str(s).strip().lower() != 'unknown'
    ]
    if _real_seg_keys:
        seg_counts = {s: seg_counts[s] for s in _real_seg_keys}
    else:
        seg_counts = {}
        st.info(
            "ℹ️ Per-segment overrides will appear once you've run "
            "**Data → Retail Segmentation** (or selected a segment column "
            "in the sidebar). Without segment labels there's nothing to "
            "override per-segment — every SKU just uses its auto-routed model."
        )
    if seg_counts:
        st.markdown("")
        st.markdown("##### 🎯 Per-segment overrides  ·  _(optional)_")
        st.caption(
            "By default each segment uses the model picked by auto-routing. "
            "You can pick a different **primary** model for any segment (replaces "
            "the auto-routed choice for every SKU in that segment), and/or add "
            "**extra** algorithms that run alongside *only* for those SKUs."
        )

        # Build the dropdown choice list: auto-routed strategies first, then additional
        auto_choice_keys = list(STRATEGY_INFO.keys())
        add_choice_keys = list(ADDITIONAL_ALGORITHMS.keys())

        def _algo_label(k: str) -> str:
            if k in STRATEGY_INFO:
                return f"{STRATEGY_INFO[k]['icon']} {STRATEGY_INFO[k]['name']} (auto)"
            if k in ADDITIONAL_ALGORITHMS:
                return f"➕ {ADDITIONAL_ALGORITHMS[k]['name']}"
            return k

        # Stable ordering for the seg list
        seg_list = sorted(seg_counts.keys(),
                          key=lambda s: -seg_counts.get(s, 0))

        for seg in seg_list:
            pb = SEGMENT_PLAYBOOK.get(seg, {})
            seg_color = pb.get('color', DHISHAAI_BLUE)
            n_skus = int(seg_counts.get(seg, 0))
            # Auto-routed strategy distribution within this segment
            seg_profiles = profiles[profiles['segment'] == seg]
            auto_split = (
                seg_profiles['recommended_strategy']
                .value_counts().to_dict()
                if not seg_profiles.empty else {}
            )
            auto_split_str = ", ".join(
                f"{STRATEGY_INFO.get(s, {}).get('name', s)} ({c})"
                for s, c in auto_split.items()
            ) or "—"

            ov = portfolio['segment_overrides'].setdefault(
                seg, {'primary': None, 'extras': []})

            cHdr, cPri, cExt = st.columns([3.2, 2.2, 3.2])
            with cHdr:
                st.markdown(
                    f"<div style='padding:8px 12px;background:#f8fafc;"
                    f"border-left:4px solid {seg_color};border-radius:8px;"
                    f"border:1px solid #e5e9ee;'>"
                    f"<div style='font-weight:700;color:#1e293b;font-size:0.92rem;'>"
                    f"{seg} "
                    f"<span style='font-weight:500;color:#6b7785;font-size:0.78rem;'>"
                    f"· {n_skus} SKUs</span></div>"
                    f"<div style='font-size:0.74rem;color:#6b7785;margin-top:3px;'>"
                    f"Auto-routed: {auto_split_str}</div>"
                    f"</div>",
                    unsafe_allow_html=True,
                )
            with cPri:
                primary_options = ["(use auto-routed)"] + auto_choice_keys + add_choice_keys
                current_primary = ov.get('primary')
                try:
                    idx = (primary_options.index(current_primary)
                           if current_primary in primary_options else 0)
                except ValueError:
                    idx = 0
                pick = st.selectbox(
                    "Primary model",
                    options=primary_options,
                    index=idx,
                    format_func=lambda k: "(use auto-routed)" if k == "(use auto-routed)"
                                          else _algo_label(k),
                    key=f"seg_primary_{seg}",
                    label_visibility="visible",
                )
                ov['primary'] = None if pick == "(use auto-routed)" else pick
            with cExt:
                extra_options = auto_choice_keys + add_choice_keys
                # Filter existing extras to those still available
                current_extras = [e for e in ov.get('extras', [])
                                  if e in extra_options]
                # Don't allow selecting the same algo as primary in extras
                if ov.get('primary') in extra_options:
                    extra_pool = [e for e in extra_options if e != ov['primary']]
                else:
                    extra_pool = extra_options
                picked = st.multiselect(
                    "Extra algorithms (benchmark)",
                    options=extra_pool,
                    default=[e for e in current_extras if e in extra_pool],
                    format_func=_algo_label,
                    key=f"seg_extras_{seg}",
                    help="Run alongside the primary for these SKUs — useful for "
                         "side-by-side accuracy comparison in the Forecast step.",
                )
                ov['extras'] = picked

    # ---- Section 3: Portfolio summary ----
    st.markdown("")
    enabled_auto = [s for s, v in portfolio['auto_routed'].items()
                    if v['enabled'] and v['count'] > 0]
    disabled_auto = [s for s, v in portfolio['auto_routed'].items()
                     if (not v['enabled']) and v['count'] > 0]
    enabled_add = [a for a, v in portfolio['additional'].items() if v]
    disabled_sku_count = sum(portfolio['auto_routed'][s]['count']
                             for s in disabled_auto)
    # Per-segment overrides — count of segments and SKUs affected
    seg_overrides = portfolio.get('segment_overrides', {})
    overridden_segs = [s for s, v in seg_overrides.items()
                       if v.get('primary') is not None]
    overridden_skus = sum(int(seg_counts.get(s, 0)) for s in overridden_segs)
    segs_with_extras = [s for s, v in seg_overrides.items()
                        if v.get('extras')]
    total_active = len(enabled_auto) + len(enabled_add)
    fallback_note = (
        f"<span style='color:#b45309;'>· <b>{disabled_sku_count:,} SKU(s)</b> "
        f"will fall back to <b>Ensemble Local</b>.</span>"
        if disabled_sku_count else ""
    )
    extra_note = (
        f"<br><span style='color:#0f766e;'>· Additional running alongside: "
        f"<b>{', '.join([ADDITIONAL_ALGORITHMS[a]['name'] for a in enabled_add])}</b>.</span>"
        if enabled_add else ""
    )
    seg_override_note = (
        f"<br><span style='color:#7c3aed;'>· Per-segment overrides: "
        f"<b>{len(overridden_segs)} segment(s)</b> "
        f"({overridden_skus:,} SKUs) using a custom primary model"
        + (f", <b>{len(segs_with_extras)}</b> with extra benchmark algorithms"
           if segs_with_extras else "")
        + ".</span>"
        if (overridden_segs or segs_with_extras) else ""
    )
    st.markdown(
        f"<div style='background:linear-gradient(135deg,#f0f9ff 0%,#eff6ff 100%);"
        f"border-left:4px solid {DHISHAAI_BLUE};border-radius:10px;"
        f"padding:14px 18px;margin-top:6px;'>"
        f"<div style='font-weight:700;color:{DHISHAAI_BLUE};font-size:1.05rem;'>"
        f"🎯 Algorithm Portfolio · {total_active} active "
        f"<span style='font-weight:500;color:#6b7785;font-size:0.9rem;'>"
        f"({len(enabled_auto)} auto-routed + {len(enabled_add)} additional)</span>"
        f"</div>"
        f"<div style='font-size:0.9rem;color:#1e293b;margin-top:6px;line-height:1.5;'>"
        f"This portfolio will drive every forecast in the next step. "
        f"{fallback_note}{extra_note}{seg_override_note}"
        f"</div></div>",
        unsafe_allow_html=True,
    )

    # Reset link
    cR, _ = st.columns([1, 4])
    with cR:
        if st.button("↺ Reset to defaults", key='btn_reset_algo_portfolio',
                     help="Re-enable all auto-routed, clear additional selections, "
                          "and clear per-segment overrides.",
                     use_container_width=True):
            for s in portfolio['auto_routed']:
                portfolio['auto_routed'][s]['enabled'] = True
            for a in portfolio['additional']:
                portfolio['additional'][a] = False
            for seg in portfolio.get('segment_overrides', {}):
                portfolio['segment_overrides'][seg] = {
                    'primary': None, 'extras': []}
            st.rerun()


def render_forecast_tab(cfg):
    """Tab 2: Run the routing engine on selected SKUs and show results."""
    st.subheader("Forecast Engine")

    if not st.session_state.get('profiled'):
        st.warning("Run profiling first (Tab 1).")
        return

    profiles = st.session_state.profiles
    # Defensive read — df_processed should always exist when profiled=True,
    # but if state got out of sync (e.g. seg flow refresh) fall back to
    # df_raw rather than crashing with AttributeError. NOTE: must use
    # explicit `is None` — `bool(df)` on a DataFrame raises ValueError.
    df = st.session_state.get('df_processed')
    if df is None:
        df = st.session_state.get('df_raw')
    if df is None:
        st.error("No dataset loaded. Go back to **Step 1 · Load Data**.")
        return

    # SKU selection — sample by default to keep things responsive
    selection_mode = st.radio(
        "What to forecast",
        ["Pick specific SKUs", "Sample N SKUs per strategy", "All SKUs (slow)"],
        horizontal=True,
    )

    if selection_mode == "Pick specific SKUs":
        # Cascading Brand / Segment filters so picking SKUs on a large
        # portfolio is tractable — narrow first, then choose.
        _pf = profiles.copy()
        fca, fcb = st.columns(2)
        if 'brand' in _pf.columns and _pf['brand'].nunique() > 1:
            _brands = sorted(_pf['brand'].dropna().astype(str).unique())
            pick_brand = fca.multiselect("Filter by brand", _brands, default=[],
                                         key='fc_pick_brand',
                                         placeholder="All brands")
            if pick_brand:
                _pf = _pf[_pf['brand'].astype(str).isin(pick_brand)]
        if 'segment' in _pf.columns and _pf['segment'].nunique() > 1:
            _segs = sorted(_pf['segment'].dropna().astype(str).unique())
            pick_seg = fcb.multiselect("Filter by segment", _segs, default=[],
                                       key='fc_pick_seg',
                                       placeholder="All segments")
            if pick_seg:
                _pf = _pf[_pf['segment'].astype(str).isin(pick_seg)]
        _sku_opts = sorted(_pf['sku'].unique())
        st.caption(f"{len(_sku_opts):,} SKU(s) match the brand/segment filter.")
        skus = st.multiselect("SKUs", _sku_opts,
                              default=list(_sku_opts[:5]))
    elif selection_mode == "Sample N SKUs per strategy":
        n_per = st.number_input("N per strategy", 1, 50, 3)
        skus = []
        for strat, g in profiles.groupby('recommended_strategy'):
            skus.extend(g['sku'].head(n_per).tolist())
    else:
        skus = profiles['sku'].tolist()
        if len(skus) > 200:
            st.warning(f"Forecasting {len(skus):,} SKUs may take several minutes.")

    use_global = st.checkbox(
        "Train global LightGBM (recommended — needed for ~80% of SKUs)",
        value=True,
        help="Trains once across all SKUs and uses categorical embeddings for brand/segment/price_band."
    )

    enable_chronos = st.checkbox(
        "Enable Chronos for cold-start (downloads ~150MB on first run)",
        value=ChronosPipeline is not None,
        disabled=ChronosPipeline is None,
    )

    reconcile = st.checkbox("Reconcile to brand totals", value=cfg['brand_col'] is not None,
                            disabled=cfg['brand_col'] is None)

    run_bt = st.checkbox(
        "Evaluate out-of-sample accuracy over the forecast horizon",
        value=True,
        help="Holds out the last H periods per SKU (H = forecast horizon, "
             "capped at half of history for short SKUs) and trains a SECOND "
             "global LightGBM with that window removed (leak-free). Reports "
             "Train vs Test WMAPE over the forecast horizon."
    )

    # K-fold CV algorithm selection — only fires for data-rich SKUs.
    # Compares a candidate pool of algorithms across 3 expanding-window
    # folds and picks the lowest-WMAPE winner per SKU. SKUs with < 24 mo
    # of history fall through to the auto-router + portfolio resolution.
    cv_mode = st.checkbox(
        f"🏆 Auto-select best algorithm via K=3 CV (for SKUs with ≥ {MIN_HISTORY_FOR_CV} months)",
        value=False,
        help=f"For each SKU with at least {MIN_HISTORY_FOR_CV} months of "
             f"history, runs 3-fold time-series cross-validation across a "
             f"candidate algorithm pool (auto-routed pick + portfolio extras "
             f"+ default shortlist) and uses the lowest-WMAPE algorithm as "
             f"the primary forecast. SKUs with shorter history keep the "
             f"router/portfolio choice. The per-SKU CV scoreboard appears "
             f"in the drill-down."
    )

    # ── Algorithms to compare ─────────────────────────────────────────
    # Checklist of every algorithm in the tool. The chosen set is scored for
    # each selected SKU and the champion is picked from it (by validation
    # WMAPE). Default = the recommended shortlist; "Select all" runs everything.
    _all_algos = ['moe', 'global_lgbm', 'local_sarimax_promo', 'prophet',
                  'autoarima', 'theta', 'holt_winters', 'croston_sba', 'tsb',
                  'naive_seasonal']
    if PHASE2_AVAILABLE:
        _all_algos += ['catboost', 'xgb_quantile_90']
    if tf is not None:
        _all_algos += ['dl_moe']
    _reco_algos = ['moe', 'global_lgbm', 'prophet', 'theta', 'holt_winters', 'autoarima']

    def _algo_lbl(k):
        info = ADDITIONAL_ALGORITHMS.get(k) or STRATEGY_INFO.get(k) or {}
        return f"{info.get('icon', '•')} {info.get('name', k)}"

    if 'fc_compare_algos' not in st.session_state:
        st.session_state.fc_compare_algos = _reco_algos
    st.markdown("**Algorithms to compare** — scored per SKU; champion picked from this set")
    bcol1, bcol2, _ = st.columns([1, 1.4, 4])
    if bcol1.button("Select all", key='fc_algos_all', use_container_width=True):
        st.session_state.fc_compare_algos = list(_all_algos)
        st.rerun()
    if bcol2.button("Reset to recommended", key='fc_algos_reset', use_container_width=True):
        st.session_state.fc_compare_algos = list(_reco_algos)
        st.rerun()
    # Keep only still-valid keys (e.g. dl_moe drops out if TF unavailable).
    st.session_state.fc_compare_algos = [
        a for a in st.session_state.fc_compare_algos if a in _all_algos]
    compare_sel = st.multiselect(
        "Algorithms", _all_algos, format_func=_algo_lbl,
        key='fc_compare_algos',
        help="Every selected algorithm is backtested for each SKU. The most "
             "accurate one (by validation WMAPE) becomes that SKU's forecast; "
             "the rest are shown as candidates in the comparison table.",
    )
    if not compare_sel:
        st.caption("⚠ No algorithms selected — the engine will fall back to each "
                   "SKU's auto-routed default.")

    if st.button("Run forecasts", type='primary', use_container_width=True):
        if not skus:
            st.error("No SKUs selected.")
            return
        run_forecasts(cfg, df, profiles, skus, use_global, enable_chronos,
                      reconcile, run_bt, cv_mode=cv_mode,
                      compare_algos=list(compare_sel) or None)

    if st.session_state.get('forecasts_run'):
        render_results(cfg)


def run_forecasts(cfg, df, profiles, skus, use_global, enable_chronos, reconcile,
                  run_backtest: bool = True, cv_mode: bool = False,
                  compare_algos: Optional[List[str]] = None):
    """Execute the full pipeline: feature build → global train → per-SKU route → reconcile.

    When `run_backtest` is True, a second global LightGBM is trained on the panel
    with the last `horizon` periods removed per SKU, and used exclusively for the
    backtest leg. This prevents the test period from leaking into the global
    model's training set when computing WMAPE.
    """
    horizon = cfg['horizon']
    pipeline_start = time.time()

    def _fmt_dur(s: float) -> str:
        if s >= 60:
            return f"{int(s // 60)}m {int(s % 60)}s"
        return f"{s:.1f}s"

    with st.status("🚀 Running forecast pipeline…", expanded=True) as status:
        progress = st.progress(0.0)
        live = st.empty()  # one-line dynamic status (updates in place)

        # ── Step 1 · Enrich data with planner-supplied event flags ──────
        status.update(label="📅 Step 1/6 · Enriching dataset with future event flags…")
        live.markdown("Adding `evt_*` columns so SARIMAX can learn each event's historical lift.")
        future_events_df = cfg.get('future_events')
        df_enriched, event_cols = enrich_df_with_events(df, future_events_df, cfg)
        st.write(f"✓ Enriched **{len(df_enriched):,} rows** with **{len(event_cols)}** event flags")
        progress.progress(0.08)

        # ── Step 2 · Build panel features (lags, calendar, price) ───────
        status.update(label="🔧 Step 2/6 · Building panel features (lags, calendar, price)…")
        live.markdown("Per-SKU lags, rolling means, price-change flags, holiday calendars, Fourier seasonality.")
        user_exog_numeric = [c for c in (cfg.get('exog_user_numeric') or [])
                             if c in df_enriched.columns]
        user_exog_categorical = [c for c in (cfg.get('exog_user_categorical') or [])
                                 if c in df_enriched.columns]
        panel = build_panel_features(
            df_enriched, cfg['date_col'], cfg['sales_col'], cfg['sku_col'],
            freq=cfg['freq'],
            exog_numeric=event_cols + user_exog_numeric,
            exog_categorical=[c for c in [cfg['brand_col'], cfg['segment_col'], 'price_band']
                              if c and c in df_enriched.columns] + user_exog_categorical,
        )
        st.write(f"✓ Built panel: **{len(panel):,} rows × {len(panel.columns)} features**")
        progress.progress(0.14)

        cats = [c for c in ([cfg['brand_col'], cfg['segment_col'], 'price_band']
                            + user_exog_categorical)
                if c and c in panel.columns]

        # ── Step 3 · Train global LightGBM (forecast model) ─────────────
        global_pkg = None
        if use_global:
            status.update(label="🌲 Step 3/6 · Training global LightGBM (forecast model)…")
            live.markdown("One pooled model across **all SKUs** — borrows strength via brand/segment/price-band embeddings.")
            _t = time.time()
            global_pkg = train_global_lightgbm(
                panel, cfg['sku_col'], cfg['date_col'], cfg['sales_col'],
                cfg['freq'], cats, holdout_periods=0,
            )
            if global_pkg:
                st.write(f"✓ Forecast LGBM trained in **{_fmt_dur(time.time()-_t)}** "
                         f"({len(panel):,} rows × {len(global_pkg.feature_cols)} features)")
            else:
                st.warning("LightGBM unavailable — SKUs needing it will fall back to Holt-Winters.")
            progress.progress(0.28)

        # ── Step 4 · Train leak-free LightGBM (backtest model) ──────────
        # Holds out the FULL forecast horizon per SKU (not just 1 month) so the
        # Test WMAPE measures error over the same horizon we ship to production.
        # Per-SKU, the actual test window may be shorter (short-history SKUs are
        # capped at half their history by `_smart_test_horizon`); excluding the
        # full horizon here is the safe upper bound, so no test month can ever
        # leak into this model regardless of each SKU's effective test window.
        global_pkg_backtest = None
        if use_global and run_backtest and global_pkg is not None:
            status.update(label="🌲 Step 4/6 · Training leak-free LightGBM (backtest model)…")
            live.markdown(f"Same model retrained with the **last {horizon} period(s) removed per SKU** "
                          f"— gives an unbiased Test WMAPE over the {horizon}-period forecast horizon.")
            _t = time.time()
            global_pkg_backtest = train_global_lightgbm(
                panel, cfg['sku_col'], cfg['date_col'], cfg['sales_col'],
                cfg['freq'], cats, holdout_periods=horizon,
            )
            if global_pkg_backtest:
                kept = len(global_pkg_backtest.panel_history)
                st.write(f"✓ Backtest LGBM trained in **{_fmt_dur(time.time()-_t)}** "
                         f"(last {horizon} period(s) excluded, {kept:,} rows kept)")
            progress.progress(0.40)

        # ── Step 4b · Load Chronos (only when cold-start SKUs are present)
        chronos_pipeline = None
        if enable_chronos and (profiles[profiles['sku'].isin(skus)]['is_cold_start']).any():
            status.update(label="🧊 Step 4b/6 · Loading Chronos foundation model…")
            live.markdown("Zero-shot transformer for cold-start SKUs (≈150 MB on first download).")
            _t = time.time()
            chronos_pipeline = load_chronos_pipeline()
            st.write(f"✓ Chronos loaded in **{_fmt_dur(time.time()-_t)}**")
            progress.progress(0.45)

        # ── Step 5 · Per-SKU forecasting (parallel) ─────────────────────
        results: List[ForecastResult] = []
        profile_lookup = profiles.set_index('sku').to_dict('index')
        portfolio = st.session_state.get('algo_portfolio')

        def _run(sku):
            return forecast_one_sku(
                sku, panel, profile_lookup[sku], horizon, cfg['freq'],
                cfg['sku_col'], cfg['date_col'], cfg['sales_col'],
                global_pkg=global_pkg,
                global_pkg_backtest=global_pkg_backtest,
                chronos_pipeline=chronos_pipeline,
                run_backtest=run_backtest,
                portfolio=portfolio,
                cfg=cfg,
                cv_mode=cv_mode,
                compare_algos=compare_algos,
            )

        max_workers = min(8, len(skus))
        status.update(label=f"📈 Step 5/6 · Forecasting {len(skus)} SKUs (parallel × {max_workers})…")
        sku_start = time.time()
        # Update on every SKU (was 1/50) — gives a live, never-stuck-looking
        # progress bar even on small batches.
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
            for i, (sku_name, res) in enumerate(zip(skus, ex.map(_run, skus))):
                results.append(res)
                done = i + 1
                elapsed = time.time() - sku_start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (len(skus) - done) / rate if rate > 0 else 0
                pct_done = done / len(skus)
                progress.progress(min(0.9, 0.45 + 0.45 * pct_done))
                live.markdown(
                    f"**SKU {done}/{len(skus)}** ({pct_done*100:.0f}%) · "
                    f"latest: `{sku_name}` · champion: `{res.strategy_used}` · "
                    f"{rate:.2f} SKUs/s · elapsed **{_fmt_dur(elapsed)}** · "
                    f"ETA **{_fmt_dur(eta)}**"
                )
        st.write(f"✓ Forecasted **{len(skus)} SKUs** in **{_fmt_dur(time.time()-sku_start)}** "
                 f"({(time.time()-sku_start)/max(1, len(skus)):.2f}s per SKU on average)")
        progress.progress(0.90)

        # ── Step 6 · Event-impact overlay + brand reconciliation ────────
        # (Note: this block used to be duplicated — the second copy was a
        # silent perf bug that doubled the work on every Run-forecasts click.)
        if future_events_df is not None and not future_events_df.empty:
            status.update(label="🎉 Step 6/6 · Applying user-supplied event impact overlay…")
            live.markdown("Applying planner-set Diwali / EOSS / Republic-Day uplift to affected SKUs.")
            sku_col_name = cfg['sku_col']
            attr_cols = [c for c in ('category', 'brand', 'segment', sku_col_name)
                         if c in df_enriched.columns]
            if attr_cols:
                sku_attr_lookup = (df_enriched[attr_cols]
                                   .drop_duplicates(subset=[sku_col_name])
                                   .set_index(sku_col_name)
                                   .to_dict('index'))
            else:
                sku_attr_lookup = {}
            for r in results:
                attrs = sku_attr_lookup.get(r.sku, {})
                if r.forecast is not None:
                    r.forecast = apply_event_impact_to_forecast(
                        r.forecast, r.sku, attrs, future_events_df, sku_col_name)
            st.write("✓ Event impact overlay applied")
            progress.progress(0.93)

        if reconcile and cfg.get('brand_col'):
            status.update(label="🔁 Step 6/6 · Reconciling SKU forecasts to brand totals…")
            live.markdown("Bottom-up Σ SKU vs Top-down brand HW → 50/50 reconciled blend, then push back to SKU level.")
            forecasts_dict = {r.sku: r.forecast for r in results}
            try:
                recon_pkg = compute_brand_reconciliation(
                    sku_forecasts=forecasts_dict, profiles=profiles, df=df,
                    cfg=cfg, horizon=horizon, blend_weight_bu=0.5,
                )
                st.session_state.brand_reconciliation = recon_pkg
                st.session_state.brand_totals = dict(recon_pkg.get('reconciled', {}))
                st.write(f"✓ Reconciled across **{len(recon_pkg.get('reconciled', {}))}** brands")

                # ── Push the reconciled per-SKU forecasts BACK into the
                # individual ForecastResult.forecast series for Stable High
                # contributors. For other segments the unreconciled forecast
                # stays primary (the reconciled values are still available
                # in the CSV download). Rationale: hero SKUs benefit most
                # from brand-level consistency; tail SKUs are better left
                # as their local fit.
                #
                # GUARDRAILS — three layers protect against the partial-
                # coverage bug where a small sample makes bottom-up ≪
                # top-down and the scaling explodes:
                #   1. Coverage ≥ 90% — bottom-up must be representative
                #      of the brand for the proportional push-back to be
                #      meaningful. Below 90% we don't know enough about
                #      the other SKUs to redistribute the brand total.
                #   2. Adjusted ≤ 3× SKU historical max — a sanity floor
                #      for the rare case scaling slips past coverage
                #      (e.g., brand has only 5 SKUs total but they all
                #      had a tiny local fit). Any adjustment that would
                #      triple the SKU vs anything it's ever sold is
                #      discarded.
                #   3. (Inside compute_brand_reconciliation) the per-date
                #      scale factor is already clipped to [0.5, 2.0] —
                #      see SCALE_MIN/SCALE_MAX there. So even when
                #      coverage is 100% the push-back can only nudge a
                #      forecast by ±2×, not 20×.
                COVERAGE_MIN_PCT = 90.0
                SANITY_MULT = 3.0
                adj_map = recon_pkg.get('adjusted_sku_forecasts', {}) or {}
                cov_map = recon_pkg.get('coverage', {}) or {}
                _seg_lookup = profiles.set_index('sku')['segment'].astype(str).to_dict()
                _brand_lookup = profiles.set_index('sku')['brand'].astype(str).to_dict()
                _n_reconciled = 0
                _n_skipped_cov = 0
                _n_skipped_sane = 0
                df_lookup_idx = df.groupby(cfg['sku_col']).groups
                for _r in results:
                    if (_seg_lookup.get(_r.sku) != 'Stable High contributors'
                            or _r.sku not in adj_map):
                        continue
                    _brand = _brand_lookup.get(_r.sku)
                    _cov_pct = float(
                        (cov_map.get(_brand) or {}).get('pct', 0.0)
                    )
                    if _cov_pct < COVERAGE_MIN_PCT:
                        _n_skipped_cov += 1
                        continue
                    _adj = adj_map[_r.sku]
                    if _adj is None or len(_adj) == 0 or _r.forecast is None:
                        continue
                    _overlap_fc = _r.forecast.index.intersection(_adj.index)
                    if len(_overlap_fc) == 0:
                        continue
                    # Per-SKU historical max — a hard sanity ceiling. If
                    # the adjusted forecast ever exceeds 3× this, the
                    # reconciliation has produced something not supported
                    # by the SKU's own demand history → trust the local
                    # fit instead.
                    try:
                        _sku_idx = df_lookup_idx.get(_r.sku)
                        if _sku_idx is not None:
                            _sku_hist_vals = pd.to_numeric(
                                df.iloc[_sku_idx][cfg['sales_col']],
                                errors='coerce',
                            ).dropna().astype(float)
                            _hist_max = float(_sku_hist_vals.max()) \
                                if len(_sku_hist_vals) else 0.0
                        else:
                            _hist_max = 0.0
                    except Exception:
                        _hist_max = 0.0
                    if (_hist_max > 0
                            and float(_adj.loc[_overlap_fc].max()) > SANITY_MULT * _hist_max):
                        _n_skipped_sane += 1
                        continue
                    # Preserve any forecast values outside the adjustment
                    # window; overwrite only the overlapping months.
                    new_fc = _r.forecast.copy().astype(float)
                    new_fc.loc[_overlap_fc] = _adj.loc[_overlap_fc].astype(float).values
                    _r.forecast = new_fc.clip(lower=0)
                    _r.notes = (
                        (_r.notes + ' · ' if _r.notes else '')
                        + f'reconciled_to_brand: applied (coverage {_cov_pct:.0f}%)'
                    )
                    _n_reconciled += 1
                _summary_bits = []
                if _n_reconciled:
                    _summary_bits.append(f"✓ Reconciled push-back applied to "
                                          f"**{_n_reconciled}** Stable High SKUs")
                if _n_skipped_cov:
                    _summary_bits.append(f"⏭ Skipped **{_n_skipped_cov}** SKUs "
                                          f"(brand coverage < {COVERAGE_MIN_PCT:.0f}%)")
                if _n_skipped_sane:
                    _summary_bits.append(f"⏭ Skipped **{_n_skipped_sane}** SKUs "
                                          f"(adjusted forecast > {SANITY_MULT}× historical max — "
                                          f"local fit kept)")
                for _line in _summary_bits:
                    st.write(_line)
            except Exception as e:
                st.warning(f"Brand reconciliation skipped: {type(e).__name__}: {e}")
                st.session_state.brand_reconciliation = None
                st.session_state.brand_totals = {}
            progress.progress(0.97)
        else:
            st.session_state.brand_reconciliation = None
            st.session_state.brand_totals = {}
            progress.progress(0.95)

        st.session_state.forecast_results = results
        st.session_state.forecasts_run = True
        progress.progress(1.0)
        total = time.time() - pipeline_start
        live.empty()  # clear the dynamic line
        status.update(
            label=f"✅ Pipeline complete · {len(skus)} SKUs · {_fmt_dur(total)}",
            state="complete", expanded=False,
        )


def _effective_mape(mape: Optional[float], smape: Optional[float]
                    ) -> Tuple[Optional[float], str]:
    """Pick a single accuracy number per SKU. Prefer standard WMAPE; fall back
    to SMAPE when WMAPE is undefined (i.e. actuals contained zeros). Returns
    `(value, source)` where source ∈ {'WMAPE', 'SMAPE', 'n/a'}.

    Used so EVERY SKU shows a number in the summary/accuracy columns — even
    intermittent / zero-heavy SKUs where standard WMAPE can't be computed.
    """
    if mape is not None:
        return float(mape), 'WMAPE'
    if smape is not None:
        return float(smape), 'SMAPE'
    return None, 'n/a'


def _build_summary_frame(results: List[ForecastResult]) -> pd.DataFrame:
    """Build the Run-summary DataFrame from forecast results.

    Pulled out of `render_results` so the result can be memoized across
    Streamlit reruns (tab switches, selectbox changes, etc.). For a portfolio
    with thousands of SKUs this loop is the dominant tab-switch cost.
    """
    summary_rows = []
    for r in results:
        # Effective WMAPE = WMAPE if defined, else SMAPE (so every SKU gets a
        # number even when actuals are zero / intermittent). The `_src` cols
        # tell the user which metric was actually used.
        eff_train_mape, train_src = _effective_mape(
            getattr(r, 'train_mape', None), getattr(r, 'train_smape', None))
        eff_test_mape, test_src = _effective_mape(
            r.backtest_mape, r.backtest_smape)
        row = {
            'sku': r.sku,
            'strategy': r.strategy_used,
            'auto_routed': getattr(r, 'auto_routed_strategy', None) or r.strategy_used,
            'overridden': (getattr(r, 'auto_routed_strategy', None) is not None
                           and r.auto_routed_strategy != r.strategy_used),
            # K-fold CV selection metadata
            'cv_selected': bool(getattr(r, 'cv_selected', False)),
            'cv_winner': getattr(r, 'cv_winner', None),
            'cv_mape': ((getattr(r, 'cv_results', None) or {})
                        .get(getattr(r, 'cv_winner', None) or '', {}) or {}).get('mean_mape'),
            # Training accuracy (rolling-origin 1-step in-sample) — always
            # surfaces a value: raw WMAPE when defined, otherwise SMAPE.
            'train_mape': eff_train_mape,
            'train_mape_src': train_src,
            'train_smape': getattr(r, 'train_smape', None),
            # Test accuracy (single-shot out-of-sample horizon holdout)
            'backtest_mape': eff_test_mape,
            'backtest_mape_src': test_src,
            'backtest_smape': r.backtest_smape,
            'mape_reason': r.mape_reason,
            'forecast_total': float(r.forecast.sum()) if r.forecast is not None else np.nan,
            # Quick flag for "has historical prediction line on chart".
            # `train_pred` is a pandas Series, so `pred or default` would
            # raise the ambiguous-truth-value error — explicitly check `is
            # not None` first, then use len() directly.
            'has_historical_pred': (
                getattr(r, 'train_pred', None) is not None
                and len(getattr(r, 'train_pred')) > 0
            ),
            'notes': r.notes,
        }
        # Flatten benchmark WMAPEs into "mape_<algo>" columns so the user can
        # see side-by-side accuracy of any extras they enabled per-segment or
        # globally.
        for algo, mape_val in (getattr(r, 'benchmark_mapes', {}) or {}).items():
            row[f'mape_{algo}'] = mape_val
        summary_rows.append(row)
    return pd.DataFrame(summary_rows)


def _render_forecast_interpretation(res, history: pd.Series, cfg: dict,
                                    sku: str, champion_label: str):
    """Per-month natural-language explanation of *why* the forecast value is
    what it is.

    Pulls together all the drivers the pipeline already computed:
      • YoY anchor (same month last year)
      • MoM anchor (prior month)
      • Last-3-month baseline
      • Pinned events from the planner's calendar
      • Underlying trend (last 12 vs prior 12 mo)
      • Seasonality index (same calendar month across history)
      • Champion model + audit-trail notes (champion / tuning /
        xgb_residual / business_rules)
    """
    fc = getattr(res, 'forecast', None)
    if fc is None or len(fc) == 0:
        return

    st.markdown("---")
    st.markdown(
        f"<div style='font-size:1.05rem;font-weight:700;color:{DHISHAAI_BLUE};"
        f"margin-bottom:4px;'>🧭 Forecast interpretation — why this number?</div>"
        f"<div style='font-size:0.85rem;color:#64748b;margin-bottom:14px;'>"
        f"Pick a forecast month to see comparisons to LY/prior month, pinned "
        f"events, seasonality, trend, and the model's pipeline trail."
        f"</div>",
        unsafe_allow_html=True,
    )

    # ── Month selector ─────────────────────────────────────────────
    month_options = list(fc.index)
    if len(month_options) > 1:
        sel = st.select_slider(
            "Forecast month",
            options=month_options,
            format_func=lambda d: pd.Timestamp(d).strftime('%b %Y'),
            value=month_options[0],
            key=f'_interp_month_{sku}',
        )
    else:
        sel = month_options[0]
        st.caption(f"Forecast month: **{pd.Timestamp(sel).strftime('%b %Y')}**")
    sel = pd.Timestamp(sel)

    val = float(fc.loc[sel])

    # ── Driver computation ─────────────────────────────────────────
    # 1. Last year same month
    ly_date = sel - pd.DateOffset(years=1)
    ly_val = (float(history.loc[ly_date])
              if ly_date in history.index else None)
    yoy_delta = (((val - ly_val) / ly_val * 100)
                 if ly_val is not None and ly_val > 0 else None)

    # 2. Prior month (use prior forecast month if exists, else last actual)
    fc_idx = list(fc.index)
    pos = fc_idx.index(sel)
    if pos > 0:
        prev_val = float(fc.loc[fc_idx[pos - 1]])
        prev_lbl = f"{pd.Timestamp(fc_idx[pos - 1]).strftime('%b %Y')} forecast"
    elif len(history) > 0:
        prev_val = float(history.iloc[-1])
        prev_lbl = f"{pd.Timestamp(history.index[-1]).strftime('%b %Y')} actual"
    else:
        prev_val = None
        prev_lbl = None
    mom_delta = (((val - prev_val) / prev_val * 100)
                 if prev_val is not None and prev_val > 0 else None)

    # 3. Last-3-month baseline
    last3 = float(history.iloc[-3:].mean()) if len(history) >= 3 else None
    last3_delta = (((val - last3) / last3 * 100)
                   if last3 is not None and last3 > 0 else None)

    # 4. Pinned events matching this month — supports multi-month ranges
    events_df = cfg.get('future_events')
    matching_events = []
    if events_df is not None and len(events_df) > 0:
        for _, row in events_df.iterrows():
            ev_start, ev_end = _event_date_range(row)
            if ev_start is None:
                continue
            # Match when the selected month falls inside [start, end] window
            sel_ym = (sel.year, sel.month)
            if sel_ym not in set(_event_months_in_range(ev_start, ev_end)):
                continue
            matching_events.append({
                    'name': str(row.get('event_name') or 'unnamed event'),
                    'type': str(row.get('event_type') or '—'),
                    'impact': float(row.get('impact_pct') or 0),
                    'notes': str(row.get('notes') or ''),
                })

    # 5. Trend direction (last 12 vs prior 12)
    trend_word, trend_pct = None, None
    if len(history) >= 24:
        recent_12 = float(history.iloc[-12:].mean())
        prior_12 = float(history.iloc[-24:-12].mean())
        if prior_12 > 0:
            trend_pct = (recent_12 - prior_12) / prior_12 * 100
            if abs(trend_pct) < 3:
                trend_word = 'flat'
            elif trend_pct > 0:
                trend_word = 'rising'
            else:
                trend_word = 'declining'

    # 6. Seasonality index for the selected calendar month
    season_word, season_index = None, None
    if len(history) >= 12:
        same_month_vals = history[history.index.month == sel.month]
        overall_mean = float(history.mean()) if len(history) else 0
        if len(same_month_vals) > 0 and overall_mean > 0:
            season_index = float(same_month_vals.mean() / overall_mean)
            if season_index >= 1.15:
                season_word = 'a HIGH-season month'
            elif season_index <= 0.85:
                season_word = 'a LOW-season month'
            else:
                season_word = 'a neutral-season month'

    # 7. Pipeline notes already captured by the engine
    notes_str = (getattr(res, 'notes', '') or '').strip()

    # ── Headline card ──────────────────────────────────────────────
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,#fff8f1 0%,#fef3e2 100%);
                    border-left:5px solid {DHISHAAI_ORANGE};
                    border-radius:12px;padding:18px 22px;margin:8px 0 16px 0;
                    box-shadow:0 2px 8px rgba(239,118,2,0.08);'>
            <div style='font-size:0.72rem;color:#92400e;text-transform:uppercase;
                        letter-spacing:0.10em;font-weight:700;'>
                Forecast · {sku}
            </div>
            <div style='margin-top:6px;'>
                <span style='font-size:2.0rem;font-weight:700;color:{DHISHAAI_ORANGE};
                             font-family:Inter, system-ui, sans-serif;'>
                    {val:,.0f}
                </span>
                <span style='font-size:1.0rem;color:#64748b;margin-left:8px;'>
                    units in <b style='color:#1e293b;'>{sel.strftime('%B %Y')}</b>
                </span>
            </div>
        </div>
    """, unsafe_allow_html=True)

    # ── Anchor-comparison KPI strip (YoY / MoM / 3mo-avg) ──────────
    def _delta_card(label: str, base_val: Optional[float], base_lbl: str,
                    delta_pct: Optional[float]):
        if delta_pct is None or base_val is None:
            return (f"<div class='kpi-card' style='opacity:0.55;'>"
                    f"<div class='kpi-label'>{label}</div>"
                    f"<div class='kpi-value'>—</div>"
                    f"<div class='kpi-sub'>{base_lbl}</div></div>")
        if delta_pct > 0.5:
            color, arrow = '#10b981', '▲'
        elif delta_pct < -0.5:
            color, arrow = '#dc2626', '▼'
        else:
            color, arrow = '#64748b', '◆'
        return (f"<div class='kpi-card' style='border-left:3px solid {color};'>"
                f"<div class='kpi-label'>{label}</div>"
                f"<div class='kpi-value' style='color:{color};font-size:1.35rem;'>"
                f"{arrow} {delta_pct:+.1f}%</div>"
                f"<div class='kpi-sub'>{base_lbl}: <b>{base_val:,.0f}</b></div></div>")

    c1, c2, c3 = st.columns(3)
    c1.markdown(_delta_card('vs same month last year',
                            ly_val, ly_date.strftime('%b %Y') if ly_val else 'no LY data',
                            yoy_delta), unsafe_allow_html=True)
    c2.markdown(_delta_card(f'vs prior period',
                            prev_val, prev_lbl or '—', mom_delta),
                unsafe_allow_html=True)
    c3.markdown(_delta_card('vs last 3-month avg',
                            last3, 'L3M baseline' if last3 else 'no L3M data',
                            last3_delta), unsafe_allow_html=True)

    # ── Key drivers list ───────────────────────────────────────────
    drivers = []
    # Events first — usually the most actionable
    for ev in matching_events:
        impact = ev['impact']
        sign = '+' if impact > 0 else ''
        body = (f"Type: <b>{ev['type']}</b>"
                + (f" · expected impact <b style='color:"
                   f"{'#10b981' if impact > 0 else '#dc2626'}'>{sign}{impact:.1f}%</b>"
                   if impact else "")
                + (f"<br><span style='color:#64748b;'>{ev['notes']}</span>"
                   if ev['notes'] else ""))
        drivers.append({
            'icon': '📅', 'title': f"Pinned event: {ev['name']}",
            'body': body, 'color': '#8b5cf6',
        })
    if season_word and season_index is not None:
        drivers.append({
            'icon': '🌊', 'title': 'Seasonality',
            'body': (f"{sel.strftime('%B')} is {season_word} for this SKU "
                     f"(<b>{(season_index-1)*100:+.0f}%</b> vs historical mean)."),
            'color': '#0ea5e9',
        })
    if trend_word and trend_pct is not None and trend_word != 'flat':
        arrow = '📈' if trend_word == 'rising' else '📉'
        color = '#10b981' if trend_word == 'rising' else '#dc2626'
        drivers.append({
            'icon': arrow, 'title': f"Underlying trend: {trend_word}",
            'body': (f"Last 12 months vs prior 12: "
                     f"<b style='color:{color};'>{trend_pct:+.1f}%</b>"),
            'color': color,
        })
    elif trend_word == 'flat':
        drivers.append({
            'icon': '➡️', 'title': 'Underlying trend: flat',
            'body': f"Last 12 months vs prior 12: <b>{trend_pct:+.1f}%</b> (within ±3%).",
            'color': '#64748b',
        })

    # Parse pipeline notes for adjustments actually applied
    for part in [p.strip() for p in notes_str.split('·') if p.strip()]:
        if part.startswith('xgb_residual: applied'):
            drivers.append({
                'icon': '🔧', 'title': 'Error correction applied',
                'body': ("The base model's validation WMAPE crossed the 20% "
                         "threshold, so an XGB residual booster was layered "
                         "on top to learn the calendar pattern of past misses. "
                         f"<br><code style='color:#64748b;font-size:0.8rem;'>{part}</code>"),
                'color': '#f59e0b',
            })
        elif 'MoM-clipped' in part or 'YoY-clipped' in part:
            drivers.append({
                'icon': '🛡️', 'title': 'Guardrail clipping fired',
                'body': ("Business rules constrained an extreme move — forecast "
                         "was clipped to the historical MoM/YoY band. "
                         f"<br><code style='color:#64748b;font-size:0.8rem;'>{part}</code>"),
                'color': '#dc2626',
            })
        elif part.startswith('champion:') and 'picked' in part:
            drivers.append({
                'icon': '🏆', 'title': 'Champion model swap',
                'body': (f"The segment-routed primary lost on the leak-free "
                         f"validation slice — a better candidate was promoted."
                         f"<br><code style='color:#64748b;font-size:0.8rem;'>{part}</code>"),
                'color': DHISHAAI_BLUE,
            })

    if drivers:
        st.markdown("##### 🎯 Key drivers for this month")
        for d in drivers:
            st.markdown(f"""
                <div style='background:#ffffff;border:1px solid #e2e8f0;
                            border-left:4px solid {d['color']};
                            border-radius:8px;padding:12px 16px;margin-bottom:8px;'>
                    <div style='display:flex;align-items:flex-start;gap:12px;'>
                        <span style='font-size:1.3rem;line-height:1.2;'>{d['icon']}</span>
                        <div style='flex:1;'>
                            <div style='font-weight:600;color:#1e293b;font-size:0.95rem;'>
                                {d['title']}
                            </div>
                            <div style='font-size:0.85rem;color:#475569;margin-top:4px;
                                        line-height:1.45;'>
                                {d['body']}
                            </div>
                        </div>
                    </div>
                </div>
            """, unsafe_allow_html=True)
    else:
        st.caption(
            "No specific drivers detected for this month — the forecast tracks "
            "the SKU's normal demand pattern."
        )

    # ── Model + audit trail card ───────────────────────────────────
    mape_str = (f" · headline test WMAPE: <b>{res.mape:.1f}%</b>"
                if getattr(res, 'mape', None) is not None else "")
    st.markdown(f"""
        <div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
                    padding:12px 16px;margin-top:14px;'>
            <div style='font-size:0.70rem;color:#64748b;text-transform:uppercase;
                        letter-spacing:0.08em;font-weight:700;'>
                Model &amp; pipeline trail
            </div>
            <div style='color:#1e293b;margin-top:6px;font-size:0.95rem;'>
                Champion: <b style='color:{DHISHAAI_ORANGE};'>{champion_label}</b>{mape_str}
            </div>
            <div style='font-size:0.78rem;color:#475569;margin-top:8px;
                        font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
                        background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;
                        padding:8px 10px;line-height:1.5;word-break:break-word;'>
                {notes_str if notes_str else '<i style="color:#94a3b8;">No pipeline notes recorded.</i>'}
            </div>
        </div>
    """, unsafe_allow_html=True)

    # ── Final natural-language summary ─────────────────────────────
    summary_parts = [
        f"**{sku}** is forecasted at **{val:,.0f}** units for "
        f"**{sel.strftime('%B %Y')}**."
    ]
    if yoy_delta is not None:
        direction = "above" if yoy_delta > 0 else "below"
        summary_parts.append(
            f"That's **{abs(yoy_delta):.1f}% {direction}** the same month "
            f"last year ({ly_val:,.0f})."
        )
    if mom_delta is not None and prev_lbl:
        direction = "up" if mom_delta > 0 else "down"
        summary_parts.append(
            f"It's **{abs(mom_delta):.1f}% {direction}** vs {prev_lbl}."
        )
    if matching_events:
        ev_names = ', '.join(
            f"**{e['name']}** ({e['impact']:+.0f}%)" for e in matching_events
        )
        summary_parts.append(f"Pinned events: {ev_names}.")
    if season_word:
        summary_parts.append(f"{sel.strftime('%B')} is {season_word} historically.")
    if trend_word and trend_word != 'flat':
        summary_parts.append(f"The SKU is on a **{trend_word}** trend.")

    lookalikes = list(getattr(res, 'lookalikes', None) or [])
    if lookalikes:
        summary_parts.append(
            f"Forecast borrows shape from **{lookalikes[0]['sku']}** "
            f"(closest analogue) and {len(lookalikes) - 1} others."
        )

    st.info(' '.join(summary_parts))

    # ── Lookalike / proxy SKUs (only for new-product or short-history) ──
    if lookalikes:
        _render_lookalike_panel(res, history, sku)


def _render_lookalike_panel(res, target_history: pd.Series, sku: str):
    """Surfaces the top-K analogue SKUs the engine is borrowing shape from.

    Shown only when the target has too little own-history to fit a local
    model (cold-start / short-history / lifecycle = New product or
    Short history). Each row renders the lookalike's recent shape as a
    sparkline next to its DTW distance, history length, and mean sales,
    so the planner can sanity-check the analogue choice before signing
    off on the forecast.
    """
    lookalikes = list(getattr(res, 'lookalikes', None) or [])
    if not lookalikes:
        return

    reason = (getattr(res, 'lookalike_reason', '') or '').strip()

    st.markdown("---")
    st.markdown(
        f"<div style='font-size:1.05rem;font-weight:700;color:{DHISHAAI_BLUE};"
        f"margin-bottom:4px;'>🔗 Lookalike SKUs — analogues used for this forecast</div>"
        f"<div style='font-size:0.85rem;color:#64748b;margin-bottom:14px;'>"
        f"{reason or 'Top SKUs whose historical shape most resembles this one.'}"
        f"</div>",
        unsafe_allow_html=True,
    )

    # Distance is unitless and only meaningful in relative terms. Convert
    # to a 0–100 similarity score (closer to 100 = better) so planners
    # can read it without DTW intuition. Linear rescale on the visible
    # range avoids implying meaning beyond "first is closest".
    dists = [float(r.get('distance', 0)) for r in lookalikes]
    if dists:
        _max_d = max(dists) if max(dists) > 0 else 1.0
        _min_d = min(dists)
        _span = max(_max_d - _min_d, 1e-9)
    else:
        _max_d = _min_d = _span = 1.0

    def _similarity(d: float) -> float:
        # Closest match → 100; weakest in top-K → ~60. Compresses the
        # absolute DTW magnitude into a planner-friendly band.
        return float(100 - 40 * (d - _min_d) / _span)

    # ── Compact comparison chart: target + top-3 lookalikes ─────────
    try:
        cmp_fig = go.Figure()
        # Target SKU's own series — z-normalised so shape is comparable.
        t_vals = target_history.dropna().values.astype(float)
        if len(t_vals) >= 2:
            t_norm = (t_vals - t_vals.mean()) / (t_vals.std() + 1e-8)
            cmp_fig.add_trace(go.Scatter(
                x=list(target_history.dropna().index),
                y=t_norm,
                mode='lines+markers',
                name=f'{sku} (target)',
                line=dict(color=DHISHAAI_ORANGE, width=3.4,
                          shape='spline', smoothing=0.5),
                marker=dict(size=7, color=DHISHAAI_ORANGE,
                            line=dict(width=1.5, color='#ffffff')),
                hovertemplate=f'<b>{sku}</b>: %{{y:.2f}}σ<extra></extra>',
            ))
        # Top-3 lookalikes — z-normalised onto the same scale.
        _palette = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899']
        for i, r in enumerate(lookalikes[:3]):
            s = r.get('tail_series')
            if s is None or len(s) < 2:
                continue
            s_vals = s.values.astype(float)
            s_norm = (s_vals - s_vals.mean()) / (s_vals.std() + 1e-8)
            color = _palette[i % len(_palette)]
            cmp_fig.add_trace(go.Scatter(
                x=list(s.index), y=s_norm,
                mode='lines+markers',
                name=f"{r['sku']} (sim {_similarity(r['distance']):.0f})",
                line=dict(color=color, width=2.2, dash='dot',
                          shape='spline', smoothing=0.5),
                marker=dict(size=5, color=color,
                            line=dict(width=1.2, color='#ffffff')),
                opacity=0.85,
                hovertemplate=f"<b>{r['sku']}</b>: %{{y:.2f}}σ<extra></extra>",
            ))
        cmp_fig.update_layout(
            title=dict(
                text=("<span style='font-size:14px;font-weight:600;color:#475569;'>"
                      "Shape comparison · z-normalised "
                      "(same y-scale lets shape ≠ magnitude be compared)"
                      "</span>"),
                x=0.02, xanchor='left',
            ),
            template='plotly_white',
            plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
            height=320,
            margin=dict(l=20, r=20, t=50, b=60),
            hovermode='x unified',
            hoverlabel=dict(bgcolor='rgba(255,255,255,0.96)',
                            bordercolor='#e2e8f0',
                            font=dict(size=11, color='#1e293b')),
            legend=dict(orientation='h', yanchor='top', y=-0.18,
                        xanchor='center', x=0.5,
                        bgcolor='rgba(248,250,252,0.85)',
                        bordercolor='#e2e8f0', borderwidth=1,
                        font=dict(size=10, color='#475569')),
            font=dict(family='Inter, system-ui, sans-serif', color='#475569'),
            xaxis=dict(showgrid=True, gridcolor='#f1f5f9', zeroline=False,
                       tickformat='%b %Y',
                       tickfont=dict(size=10, color='#64748b')),
            yaxis=dict(title=dict(text='σ from mean',
                                   font=dict(size=11, color='#475569')),
                       showgrid=True, gridcolor='#f1f5f9',
                       zeroline=True, zerolinecolor='#cbd5e1',
                       tickfont=dict(size=10, color='#64748b')),
        )
        st.plotly_chart(cmp_fig, use_container_width=True,
                        config={'displaylogo': False, 'responsive': True})
    except Exception:
        # Chart is purely diagnostic — never let a bad SKU shape kill the panel.
        pass

    # ── Per-lookalike cards with sparkline + metadata ──────────────
    for i, r in enumerate(lookalikes):
        sim = _similarity(float(r.get('distance', 0)))
        rank_badge = f"#{i+1}"
        is_primary = (i == 0)
        accent = DHISHAAI_ORANGE if is_primary else '#3b82f6'
        # Render a tiny inline sparkline for this lookalike's recent shape.
        spark_svg = ""
        try:
            s = r.get('tail_series')
            if s is not None and len(s) >= 2:
                vals = s.values.astype(float)
                vmin, vmax = float(vals.min()), float(vals.max())
                span = max(vmax - vmin, 1e-9)
                W, H = 140, 32
                pts = []
                for idx, v in enumerate(vals):
                    x = idx * (W - 4) / max(len(vals) - 1, 1) + 2
                    y = H - 2 - (v - vmin) / span * (H - 4)
                    pts.append(f"{x:.1f},{y:.1f}")
                path = ' '.join(pts)
                # End-of-series dot to anchor the eye on "latest".
                last_x, last_y = pts[-1].split(',')
                spark_svg = (
                    f"<svg width='{W}' height='{H}' "
                    f"style='overflow:visible;display:block;'>"
                    f"<polyline points='{path}' fill='none' "
                    f"stroke='{accent}' stroke-width='1.8' "
                    f"stroke-linecap='round' stroke-linejoin='round'/>"
                    f"<circle cx='{last_x}' cy='{last_y}' r='2.2' "
                    f"fill='{accent}'/></svg>"
                )
        except Exception:
            spark_svg = ""

        brand_chip = ""
        b = r.get('brand')
        if b and str(b).lower() != 'none':
            brand_chip = (f"<span style='background:#f1f5f9;color:#475569;"
                          f"padding:2px 8px;border-radius:10px;font-size:0.72rem;"
                          f"font-weight:600;margin-left:6px;'>{b}</span>")

        primary_badge = (
            "<span style='background:#fed7aa;color:#9a3412;padding:2px 8px;"
            "border-radius:10px;font-size:0.68rem;font-weight:700;"
            "letter-spacing:0.04em;margin-left:6px;'>PRIMARY ANALOGUE</span>"
            if is_primary else ""
        )

        st.markdown(f"""
            <div style='background:#ffffff;border:1px solid #e2e8f0;
                        border-left:4px solid {accent};
                        border-radius:10px;padding:12px 16px;margin-bottom:8px;
                        display:flex;align-items:center;gap:16px;'>
                <div style='font-size:0.85rem;font-weight:700;color:{accent};
                            background:{accent}1a;padding:8px 10px;border-radius:8px;
                            min-width:38px;text-align:center;'>{rank_badge}</div>
                <div style='flex:1;'>
                    <div style='font-size:0.95rem;font-weight:700;color:#1e293b;'>
                        {r['sku']}{brand_chip}{primary_badge}
                    </div>
                    <div style='font-size:0.78rem;color:#64748b;margin-top:3px;'>
                        Similarity <b style='color:{accent};'>{sim:.0f}</b>/100 ·
                        {r['n_periods']} months of history ·
                        mean sales <b>{r['mean_sales']:,.0f}</b>
                    </div>
                </div>
                <div style='flex-shrink:0;'>{spark_svg}</div>
            </div>
        """, unsafe_allow_html=True)

    st.caption(
        "💡 Distance is computed by Dynamic Time Warping on **z-normalised** "
        "series — so matches are on *shape* (seasonality, ramp, decline), not "
        "absolute volume. The primary analogue's recent trajectory is what the "
        "engine borrows from when fitting this new/short-history SKU."
    )


def render_results(cfg):
    """Render forecast tables, plots, and downloads."""
    results: List[ForecastResult] = st.session_state.forecast_results
    profiles = st.session_state.profiles

    # Summary table — memoized by results-identity to keep tab-switches snappy.
    # `id(results)` is a stable handle for the list while it lives in
    # session_state; the cached frame gets invalidated automatically the next
    # time `run_forecasts` writes a new list.
    st.subheader("Run summary")
    _cached_summary = st.session_state.get('_summary_cache')
    _cached_results_id = st.session_state.get('_summary_cache_results_id')
    if _cached_summary is not None and _cached_results_id == id(results):
        summary = _cached_summary
    else:
        summary = _build_summary_frame(results)
        st.session_state['_summary_cache'] = summary
        st.session_state['_summary_cache_results_id'] = id(results)

    # KPI strip — Train (in-sample fit) vs Test (out-of-sample, over the
    # forecast horizon) WMAPE. Numbers use the WMAPE→SMAPE fallback inside
    # `_build_summary_frame`, so intermittent / zero-actual SKUs still
    # contribute a value (SMAPE silently substituted; counted in the help).
    h_cfg = cfg.get('horizon')
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("SKUs forecasted", len(summary))
    valid_train = summary['train_mape'].dropna()
    n_train_smape_fallback = int((summary.get('train_mape_src', pd.Series(dtype=str))
                                  == 'SMAPE').sum()) if 'train_mape_src' in summary.columns else 0
    c2.metric(
        "Median TRAIN WMAPE",
        f"{valid_train.median():.1f}%" if len(valid_train) else "n/a",
        help=(f"In-sample fit (rolling-origin) — how well the model fits history. "
              f"Computed on {len(valid_train)}/{len(summary)} SKUs. "
              f"SMAPE silently substituted on {n_train_smape_fallback} zero-actual SKUs."),
    )
    valid_mape = summary['backtest_mape'].dropna()
    n_test_smape_fallback = int((summary.get('backtest_mape_src', pd.Series(dtype=str))
                                 == 'SMAPE').sum()) if 'backtest_mape_src' in summary.columns else 0
    c3.metric(
        "Median TEST WMAPE",
        f"{valid_mape.median():.1f}%" if len(valid_mape) else "n/a",
        help=(f"Out-of-sample accuracy over the {h_cfg}-period forecast horizon "
              f"(shrinks to fit SKUs with limited history). "
              f"Computed on {len(valid_mape)}/{len(summary)} SKUs. "
              f"SMAPE silently substituted on {n_test_smape_fallback} zero-actual SKUs. "
              f"A large gap vs Train = overfitting."),
    )
    c4.metric("Total forecast units", f"{summary['forecast_total'].sum():,.0f}")

    # ── Accuracy bands + shared filter bar ────────────────────────────
    # Build one enriched frame (summary + brand/segment + band) that drives
    # BOTH the All-models table and the drill-down picker, so the planner
    # narrows once and both views follow.
    _bs_cols = [c for c in ('sku', 'brand', 'segment') if c in profiles.columns]
    _sm = summary.merge(profiles[_bs_cols], on='sku', how='left') \
        if 'sku' in summary.columns and len(_bs_cols) > 1 else summary.copy()

    def _band_of(v):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return 'No metric'
        if v < WMAPE_GOOD:
            return 'Good'
        if v < WMAPE_POOR:
            return 'Review'
        return 'Poor'
    _sm['band'] = _sm['backtest_mape'].apply(_band_of)

    n_good = int((_sm['band'] == 'Good').sum())
    n_review = int((_sm['band'] == 'Review').sum())
    n_poor = int((_sm['band'] == 'Poor').sum())
    n_none = int((_sm['band'] == 'No metric').sum())
    n_all = max(len(_sm), 1)
    st.markdown("##### Forecast quality bands")

    def _band_card(label, n, color, sub):
        return (f"<div style='padding:12px 14px;background:{color}1A;border-radius:8px;"
                f"border-left:4px solid {color};'>"
                f"<div style='font-size:0.78rem;color:#64748b;'>{label}</div>"
                f"<div style='font-size:1.5rem;font-weight:700;color:{color};'>{n:,}</div>"
                f"<div style='font-size:0.76rem;color:#64748b;'>{sub}</div></div>")
    bcol = st.columns(4)
    bcol[0].markdown(_band_card('GOOD (&lt;20%)', n_good, COLOR_GOOD,
                                f"{n_good/n_all*100:.0f}% of SKUs"), unsafe_allow_html=True)
    bcol[1].markdown(_band_card('REVIEW (20–50%)', n_review, COLOR_REVIEW,
                                f"{n_review/n_all*100:.0f}% of SKUs"), unsafe_allow_html=True)
    bcol[2].markdown(_band_card('POOR (&gt;50%)', n_poor, COLOR_POOR,
                                f"{n_poor/n_all*100:.0f}% of SKUs"), unsafe_allow_html=True)
    bcol[3].markdown(_band_card('NO METRIC', n_none, COLOR_NEUTRAL,
                                "too short to score"), unsafe_allow_html=True)

    st.markdown("##### Filter SKUs (applies to the table and drill-down below)")
    flt1, flt2, flt3 = st.columns(3)
    _f = _sm.copy()
    if 'brand' in _f.columns and _f['brand'].nunique() > 1:
        _bopts = sorted(_f['brand'].dropna().astype(str).unique())
        _bsel = flt1.multiselect("Brand", _bopts, default=[],
                                 key='res_filter_brand', placeholder="All brands")
        if _bsel:
            _f = _f[_f['brand'].astype(str).isin(_bsel)]
    if 'segment' in _f.columns and _f['segment'].nunique() > 1:
        _sopts = sorted(_f['segment'].dropna().astype(str).unique())
        _ssel = flt2.multiselect("Segment", _sopts, default=[],
                                 key='res_filter_segment', placeholder="All segments")
        if _ssel:
            _f = _f[_f['segment'].astype(str).isin(_ssel)]
    _band_sel = flt3.multiselect("Accuracy band", ['Good', 'Review', 'Poor', 'No metric'],
                                 default=[], key='res_filter_band',
                                 placeholder="All bands")
    if _band_sel:
        _f = _f[_f['band'].isin(_band_sel)]
    filtered_skus = set(_f['sku'].astype(str))
    if len(filtered_skus) < len(_sm):
        st.caption(f"Filter active → **{len(filtered_skus):,}** of {len(_sm):,} SKUs shown.")

    # CV summary banner — only visible when at least one SKU was CV-selected
    n_cv_selected = int(summary['cv_selected'].sum())
    if n_cv_selected > 0:
        cv_mape_series = summary[summary['cv_selected']]['cv_mape'].dropna()
        median_cv_mape = (f"{cv_mape_series.median():.1f}%"
                          if len(cv_mape_series) else "n/a")
        # Distribution of winning algorithms
        winners = summary[summary['cv_selected']]['cv_winner'].value_counts()
        winners_str = ', '.join(f"{algo} ({n})" for algo, n in winners.head(5).items())
        if len(winners) > 5:
            winners_str += f" (+{len(winners) - 5} more)"
        st.info(
            f"🏆 **K-fold CV selection** ran on **{n_cv_selected}/{len(summary)} "
            f"SKUs** (those with ≥ {MIN_HISTORY_FOR_CV} months of history). "
            f"Median winning CV WMAPE: **{median_cv_mape}**. "
            f"Top winners: {winners_str}."
        )

    # Diagnose missing-WMAPE reasons. With the WMAPE→SMAPE fallback in place
    # only SKUs with NO accuracy data at all end up here — typically those
    # with too little history to do any holdout backtest.
    missing = summary[summary['backtest_mape'].isna()]
    if len(missing):
        with st.expander(f"Why {len(missing)} SKUs have no accuracy metric — click to see breakdown"):
            reason_counts = missing['mape_reason'].fillna('(no reason recorded)').value_counts()
            for reason, n in reason_counts.items():
                st.write(f"• **{n} SKU{'s' if n > 1 else ''}**: {reason}")
            st.caption(
                "After applying the WMAPE→SMAPE fallback every SKU with ≥ 2 months "
                "of history should have a number. Remaining gaps are typically: "
                "(a) cold-start SKUs with < 2 months of data, or (b) strategies "
                "that errored on this SKU's specific data."
            )

    st.dataframe(summary, use_container_width=True, height=300)

    # ─────────────────────────────────────────────────────────────
    # All models × all SKUs — Primary + Blend WMAPE comparison
    # ─────────────────────────────────────────────────────────────
    # One row PER (SKU × algorithm) so the planner can see every model's
    # accuracy for every SKU in a single table. Champion (the model whose
    # forecast was actually used) is marked with ⭐.
    st.subheader("All models per SKU — Primary + Blend comparison")
    st.caption(
        "Each SKU is scored on every candidate algorithm (segment Primary + "
        "Blend members + safety defaults). Champion row per SKU is marked ⭐ "
        "— that's the model whose forecast was used. Use this to inspect "
        "the runner-up Blend members and decide whether to override the "
        "champion via the per-segment Portfolio settings."
    )

    # Detect stale results: if MOST SKUs have only the champion in their
    # all_algorithm_metrics dict, the run was probably done before the
    # candidate-pool fix landed. Prompt the user to re-run. Trigger when
    # >50% of SKUs only have one row — strict (all-SKUs) was too forgiving
    # because a handful of long-history SKUs would suppress the banner.
    _pool_multi_n = sum(
        1 for r in results
        if len(getattr(r, 'all_algorithm_metrics', None) or {}) > 1
    )
    _pool_total = len(results)
    if _pool_total > 0 and _pool_multi_n < _pool_total // 2:
        _pool_single_n = _pool_total - _pool_multi_n
        st.warning(
            f"ℹ️ {_pool_single_n}/{_pool_total} SKUs in these results have "
            f"only the Champion model — most likely because this run was "
            f"made before the candidate-pool fix, or because **Evaluate "
            f"out-of-sample accuracy** was unchecked. Click **Run "
            f"forecasts** at the top of the tab again (with that checkbox "
            f"ticked) to populate Primary + Blend rows for every SKU."
        )

    # Is K-fold CV available in these results at all?
    _cv_ran = any(
        any(m.get('cv_mape') is not None
            for m in (getattr(r, 'all_algorithm_metrics', None) or {}).values())
        for r in results
    )
    if not _cv_ran:
        st.caption(
            "ℹ️ **CV WMAPE** column is blank for every row because K-fold CV "
            "was not enabled at run time. Tick **🏆 Auto-select best "
            "algorithm via K=3 CV** before clicking *Run forecasts* to "
            "populate it."
        )

    # Is the per-candidate validation WMAPE available?
    _val_ran = any(
        any(m.get('val_mape') is not None
            for m in (getattr(r, 'all_algorithm_metrics', None) or {}).values())
        for r in results
    )
    st.caption("**Accuracy (WMAPE %)** is the honest out-of-sample error (lower = "
               "better). The ⭐ champion is the model auto-chosen for each SKU. "
               "Open a SKU in the drill-down below to see *why* it won.")

    all_model_rows = []
    for r in results:
        algo_metrics = getattr(r, 'all_algorithm_metrics', None) or {}
        if not algo_metrics:
            # Fallback for SKUs where the candidate pool was skipped — keep
            # at least the champion row so the table covers every SKU.
            algo_metrics = {r.strategy_used: {
                'test_mape': r.backtest_mape,
                'test_smape': r.backtest_smape,
                'future_forecast': r.forecast,
                'is_champion': True,
                'cv_mape': None, 'cv_smape': None,
                'val_mape': None, 'val_smape': None,
                'test_reason': (r.mape_reason
                                or 'candidate pool skipped for this SKU '
                                   '(dead / too-short history)'),
            }}
        for algo, m in algo_metrics.items():
            is_champ = bool(m.get('is_champion', algo == r.strategy_used))
            label = (ADDITIONAL_ALGORITHMS.get(algo, {}).get('name')
                     or STRATEGY_INFO.get(algo, {}).get('name')
                     or algo)
            ff = m.get('future_forecast')
            eff_test, test_src = _effective_mape(
                m.get('test_mape'), m.get('test_smape'))
            eff_val, _val_src = _effective_mape(
                m.get('val_mape'), m.get('val_smape'))
            # Build a single-line note explaining WHY a column is blank
            note_bits = []
            if eff_test is None:
                # Both WMAPE and SMAPE are missing — surface the engine's reason
                reason = m.get('test_reason') or ''
                if not reason and is_champ:
                    reason = r.mape_reason or ''
                note_bits.append(reason or 'backtest could not score this algorithm')
            if m.get('cv_mape') is None and _cv_ran:
                # CV ran globally but this row doesn't have a value
                note_bits.append('CV: candidate not evaluated in K-fold pool')
            row = {
                'SKU': r.sku,
                'Algorithm': f"⭐ {label}" if is_champ else label,
                'Role': 'Champion' if is_champ else 'Candidate',
                # Single headline accuracy = honest out-of-sample WMAPE.
                'Accuracy (WMAPE %)': eff_test,
                'Metric': test_src,
                'CV WMAPE': m.get('cv_mape'),
                'Forecast total (horizon)': float(ff.sum()) if ff is not None else None,
                'Note': ' · '.join(note_bits) if note_bits else '',
                # Champion pinned first per SKU; the rest sorted by accuracy.
                '_sort_key': (
                    r.sku, 0 if is_champ else 1,
                    eff_test if eff_test is not None else float('inf')),
            }
            all_model_rows.append(row)
    if all_model_rows:
        all_model_df = pd.DataFrame(all_model_rows)
        all_model_df = all_model_df.sort_values('_sort_key').drop(columns=['_sort_key'])
        # Drop the CV column entirely when CV wasn't run this session.
        if not _cv_ran and 'CV WMAPE' in all_model_df.columns:
            all_model_df = all_model_df.drop(columns=['CV WMAPE'])
        # Format % / count columns for display
        for col in ['Accuracy (WMAPE %)', 'CV WMAPE']:
            if col in all_model_df.columns:
                all_model_df[col] = all_model_df[col].apply(
                    lambda x: f"{x:.1f}%" if pd.notna(x) else "—")
        all_model_df['Forecast total (horizon)'] = all_model_df['Forecast total (horizon)'].apply(
            lambda x: f"{x:,.0f}" if pd.notna(x) else "—")
        all_model_df['Metric'] = all_model_df['Metric'].replace('n/a', '—')
        # Driven by the shared filter bar (brand/segment/band) above; Role here.
        role_filter = st.radio(
            "Show", ['All', 'Champion only', 'Candidates only'],
            horizontal=True, key='allmodels_role_filter',
        )
        view_df = all_model_df[all_model_df['SKU'].astype(str).isin(filtered_skus)].copy()
        if role_filter == 'Champion only':
            view_df = view_df[view_df['Role'] == 'Champion']
        elif role_filter == 'Candidates only':
            view_df = view_df[view_df['Role'] == 'Candidate']
        st.dataframe(view_df, use_container_width=True, hide_index=True, height=420)
        # Download button so planners can drop the whole comparison into Excel
        buf = io.StringIO()
        all_model_df.to_csv(buf, index=False)
        st.download_button(
            "Download all-models comparison (CSV)", buf.getvalue(),
            "all_models_per_sku.csv", "text/csv",
            use_container_width=True,
        )

    # SKU drill-down
    st.subheader("SKU drill-down")
    # Driven by the shared brand/segment/band filter above so finding a SKU is
    # easy on large portfolios. Falls back to all SKUs if the filter is empty.
    _drill_opts = [r.sku for r in results if str(r.sku) in filtered_skus] \
        or [r.sku for r in results]
    if filtered_skus and len(_drill_opts) < len(results):
        st.caption(f"Showing {len(_drill_opts):,} SKU(s) from the active filter.")
    selected = st.selectbox("Inspect SKU", _drill_opts)
    res = next(r for r in results if r.sku == selected)
    profile = profiles[profiles['sku'] == selected].iloc[0]

    cc1, cc2, cc3 = st.columns(3)
    _cv_badge = " 🏆 <em>(K-fold CV winner)</em>" if getattr(res, 'cv_selected', False) else ""
    cc1.markdown(
        f"**Strategy:** <span class='strategy-pill'>{res.strategy_used}</span>"
        f"{_cv_badge}",
        unsafe_allow_html=True)
    cc2.markdown(f"**Segment:** {profile['segment']}")
    cc3.markdown(f"**Pattern:** {profile['intermittency']} ({profile['n_months']} months)")

    # Accuracy block — TRAIN (in-sample fit) vs TEST (out-of-sample over the
    # forecast horizon) side-by-side. The gap between them tells the planner
    # whether the model is overfitting. When standard WMAPE is undefined
    # (actuals contained zeros) we silently fall back to SMAPE so EVERY SKU
    # still shows a number (a small "(SMAPE)" suffix flags which were).
    raw_train_mape = getattr(res, 'train_mape', None)
    tr_smape = getattr(res, 'train_smape', None)
    eff_train_mape, train_src = _effective_mape(raw_train_mape, tr_smape)
    raw_test_mape = res.backtest_mape
    te_smape = res.backtest_smape
    eff_test_mape, test_src = _effective_mape(raw_test_mape, te_smape)
    # For the overfitting check use the effective value (same metric on
    # both sides — apples-to-apples).
    tr_mape = eff_train_mape
    _th = getattr(res, 'test_horizon', None)
    _test_window_lbl = f" ({_th}-period)" if _th else ""

    cc_a, cc_b = st.columns(2)
    _train_suffix = "" if train_src == 'WMAPE' else (" (SMAPE)" if train_src == 'SMAPE' else "")
    cc_a.metric(
        f"Train WMAPE{_train_suffix}",
        f"{eff_train_mape:.1f}%" if eff_train_mape is not None else "—",
        help=("In-sample fit (rolling-origin) — how well the model fits history. "
              "If WMAPE is undefined (zero actuals), SMAPE is shown instead — "
              "the suffix reflects which one."),
    )
    _test_suffix = "" if test_src == 'WMAPE' else (" (SMAPE)" if test_src == 'SMAPE' else "")
    cc_b.metric(
        f"Test WMAPE{_test_suffix}{_test_window_lbl}",
        f"{eff_test_mape:.1f}%" if eff_test_mape is not None else "—",
        help=("Out-of-sample WMAPE over the forecast horizon (held-out tail of "
              "history). The window shrinks for SKUs with limited history. "
              "SMAPE fallback applies the same way as Train."),
    )
    # Reason lines — one for test, one for train (only when missing)
    if res.mape_reason:
        st.info(f"📋 Test backtest: {res.mape_reason}")
    if getattr(res, 'train_reason', '') and eff_train_mape is None:
        st.caption(f"ℹ️ Train backtest: {res.train_reason}")
    # Overfitting hint — if gap is large, surface it. Both sides use the
    # effective metric (WMAPE-with-SMAPE-fallback) so the comparison is
    # apples-to-apples even on intermittent SKUs.
    if tr_mape is not None and eff_test_mape is not None:
        gap = eff_test_mape - tr_mape
        if gap > 15:
            _label = "WMAPE" if test_src == 'WMAPE' and train_src == 'WMAPE' else "WMAPE/SMAPE"
            st.warning(
                f"⚠️ Test {_label} ({eff_test_mape:.1f}%) is {gap:.1f}pp worse "
                f"than Train {_label} ({tr_mape:.1f}%) — model may be overfitting."
            )

    # ---- K-fold CV scoreboard for this SKU ----
    # When CV ran for this SKU, show the per-algorithm CV WMAPE so the planner
    # can SEE why a particular algorithm was picked. When CV was *enabled*
    # but skipped (short history, etc.), surface that reason instead.
    cv_results = getattr(res, 'cv_results', None) or {}
    if cv_results:
        with st.expander(
            f"🔍 K-fold CV per-fold detail "
            f"({len(cv_results)} candidates × {res.cv_k or 3} folds)",
            expanded=False,
        ):
            st.caption(
                f"Per-fold WMAPE breakdown — useful for spotting algorithms "
                f"that win on average but are unstable across folds (high "
                f"variance). Mean CV WMAPE summary is in the main 'All "
                f"algorithms' table above."
            )
            cv_rows = []
            for strat, scores in cv_results.items():
                is_winner = (strat == getattr(res, 'cv_winner', None))
                label = (ADDITIONAL_ALGORITHMS.get(strat, {}).get('name')
                         or STRATEGY_INFO.get(strat, {}).get('name')
                         or strat)
                if is_winner:
                    label = f"⭐ {label} (winner)"
                fold_mapes = scores.get('fold_mapes') or []
                row = {
                    'Algorithm': label,
                    'Mean CV WMAPE': scores.get('mean_mape'),
                    'Mean CV SMAPE': scores.get('mean_smape'),
                    'Folds scored': f"{scores.get('n_folds_scored', 0)}/{len(fold_mapes) or (res.cv_k or 3)}",
                }
                # Per-fold WMAPEs (Fold 1..K)
                for i, fm in enumerate(fold_mapes):
                    row[f'Fold {i+1} WMAPE'] = fm
                # Add note for failed CV
                if scores.get('reason'):
                    row['Note'] = scores['reason']
                cv_rows.append(row)
            cv_df = pd.DataFrame(cv_rows)
            # Sort: winner first, then ascending by mean WMAPE
            cv_df = cv_df.sort_values(
                by=['Mean CV WMAPE'], na_position='last'
            ).reset_index(drop=True)
            # Format % columns
            pct_cols = [c for c in cv_df.columns
                        if 'WMAPE' in c or 'SMAPE' in c]
            for col in pct_cols:
                cv_df[col] = cv_df[col].apply(
                    lambda x: f"{x:.1f}%" if pd.notna(x) else "—")
            st.dataframe(cv_df, use_container_width=True, hide_index=True)
    elif getattr(res, 'cv_reason', ''):
        st.caption(f"ℹ️ K-fold CV: {res.cv_reason}")

    # Defensive read — if state was reset (e.g. seg-flow refresh) fall back
    # to df_raw to avoid an AttributeError on the drill-down section.
    # Use explicit None-check — `bool(df)` on a DataFrame is ambiguous.
    df = st.session_state.get('df_processed')
    if df is None:
        df = st.session_state.get('df_raw')
    if df is None:
        return
    # Per-SKU lookup is O(1) via a session-cached groupby index — previously
    # the drill-down re-scanned the full df on every selectbox change,
    # quadratic in number of SKU switches.
    sku_col_name = cfg['sku_col']
    _idx_key = (id(df), sku_col_name)
    if st.session_state.get('_sku_index_key') != _idx_key:
        # `groupby(..., sort=False)` builds the indexer in one pass.
        try:
            st.session_state['_sku_index'] = df.groupby(sku_col_name, sort=False).indices
        except Exception:
            st.session_state['_sku_index'] = None
        st.session_state['_sku_index_key'] = _idx_key
    _sku_index = st.session_state.get('_sku_index')
    if _sku_index is not None and selected in _sku_index:
        sku_history = df.iloc[_sku_index[selected]].sort_values(cfg['date_col'])
    else:
        sku_history = df[df[sku_col_name] == selected].sort_values(cfg['date_col'])
    history = sku_history.set_index(cfg['date_col'])[cfg['sales_col']]

    # The "champion" is the strategy that actually produced this SKU's
    # primary forecast (either auto-routed, portfolio-overridden, or
    # CV-selected).
    champion_label = (ADDITIONAL_ALGORITHMS.get(res.strategy_used, {}).get('name')
                      or STRATEGY_INFO.get(res.strategy_used, {}).get('name')
                      or res.strategy_used)

    # ──────────────────────────────────────────────────────────────────
    # Champion forecast chart — beautified
    #
    #   Design notes:
    #   • Smooth spline lines (smoothing=0.5) tame month-to-month jitter
    #     without hiding the discrete observations underneath — markers
    #     with white-stroke borders preserve "this is a real reading".
    #   • Actual history gets a faint area fill to anchor the eye on the
    #     known past; predicted segments stay line-only to read as
    #     "model output, not ground truth".
    #   • In-sample fit uses a dotted dash — visually says "this is a
    #     rolling backfit, not new information."
    #   • Test holdout uses a long-dash purple line — emphasises this is
    #     the leak-free evaluation slice.
    #   • Future forecast is the boldest line (solid orange, larger
    #     markers) because it's the deliverable.
    #   • Vertical dashed dividers + soft region tint visually separate
    #     History / Test / Forecast so planners stop confusing them.
    #   • Unified-x hover is the cleanest way to compare all 4 series
    #     at the same point in time.
    # ──────────────────────────────────────────────────────────────────
    fig = go.Figure()

    tr_pred_series = getattr(res, 'train_pred', None)
    bt_pred_series = getattr(res, 'backtest_pred', None)
    fc_series = getattr(res, 'forecast', None)

    HIST_COLOR = '#10B981'   # green  — historical (in-sample rolling) prediction
    TEST_COLOR = '#7c3aed'   # purple — held-out test prediction
    FUT_COLOR = DHISHAAI_ORANGE  # orange — future forecast

    # ── 1. Actual history — soft area fill anchors the eye on the past ──
    fig.add_trace(go.Scatter(
        x=history.index, y=history,
        mode='lines+markers',
        name='Actual',
        line=dict(color=DHISHAAI_BLUE, width=2.4, shape='spline', smoothing=0.5),
        marker=dict(size=6, color=DHISHAAI_BLUE,
                    line=dict(width=1.5, color='#ffffff')),
        fill='tozeroy',
        fillcolor='rgba(7, 62, 92, 0.06)',
        hovertemplate='<b>Actual</b>: %{y:,.0f}<extra></extra>',
    ))

    # ── 2/3/4. Champion's prediction segments (with bridge endpoints) ──
    last_bridge: Optional[Tuple[Any, float]] = None

    # 2. In-sample (rolling-origin) prediction — dotted so it reads as a fit
    if tr_pred_series is not None and len(tr_pred_series) > 0:
        fig.add_trace(go.Scatter(
            x=list(tr_pred_series.index),
            y=list(tr_pred_series.values),
            mode='lines+markers',
            name=f'In-sample fit · {champion_label}',
            line=dict(color=HIST_COLOR, width=2.4,
                      shape='spline', smoothing=0.5, dash='dot'),
            marker=dict(size=6, symbol='diamond', color=HIST_COLOR,
                        line=dict(width=1.5, color='#ffffff')),
            hovertemplate='<b>In-sample fit</b>: %{y:,.0f}<extra></extra>',
        ))
        last_bridge = (tr_pred_series.index[-1], float(tr_pred_series.values[-1]))

    # 3. Test-holdout prediction — long-dash (it's leak-free evaluation)
    if bt_pred_series is not None and len(bt_pred_series) > 0:
        xs = list(bt_pred_series.index)
        ys = list(bt_pred_series.values)
        if last_bridge is not None and last_bridge[0] != xs[0]:
            xs = [last_bridge[0]] + xs
            ys = [last_bridge[1]] + ys
        fig.add_trace(go.Scatter(
            x=xs, y=ys,
            mode='lines+markers',
            name=f'Test prediction · {champion_label}',
            line=dict(color=TEST_COLOR, width=2.6,
                      shape='spline', smoothing=0.5, dash='longdash'),
            marker=dict(size=7, symbol='square', color=TEST_COLOR,
                        line=dict(width=1.5, color='#ffffff')),
            hovertemplate='<b>Test prediction</b>: %{y:,.0f}<extra></extra>',
        ))
        last_bridge = (bt_pred_series.index[-1], float(bt_pred_series.values[-1]))

    # 4. Future forecast — the deliverable; boldest visual weight
    if fc_series is not None and len(fc_series) > 0:
        xs = list(fc_series.index)
        ys = list(fc_series.values)
        if last_bridge is not None and last_bridge[0] != xs[0]:
            xs = [last_bridge[0]] + xs
            ys = [last_bridge[1]] + ys
        fig.add_trace(go.Scatter(
            x=xs, y=ys,
            mode='lines+markers',
            name=f'🏆 Future forecast · {champion_label}',
            line=dict(color=FUT_COLOR, width=3.4, shape='spline', smoothing=0.5),
            marker=dict(size=8, color=FUT_COLOR, symbol='circle',
                        line=dict(width=1.8, color='#ffffff')),
            hovertemplate='<b>Forecast</b>: %{y:,.0f}<extra></extra>',
        ))

    # ── Prediction interval — gradient fill, thin dashed border ──
    if res.ci is not None:
        fig.add_trace(go.Scatter(
            x=list(res.ci.index) + list(res.ci.index[::-1]),
            y=list(res.ci['upper']) + list(res.ci['lower'][::-1]),
            fill='toself',
            fillcolor='rgba(239, 118, 2, 0.10)',
            line=dict(color='rgba(239, 118, 2, 0.30)', width=1, dash='dot'),
            name='Prediction interval (80%)',
            hoverinfo='skip',
            showlegend=True,
        ))

    # ── Region dividers + subtle background tint for the forecast horizon ──
    last_actual_date = history.index[-1] if len(history) else None
    if (fc_series is not None and len(fc_series) > 0 and last_actual_date is not None):
        # Soft tint behind the forecast region so the eye locks onto it.
        fig.add_vrect(
            x0=last_actual_date, x1=fc_series.index[-1],
            fillcolor='rgba(239, 118, 2, 0.045)',
            line_width=0, layer='below',
        )
        # Hairline divider at the "today" boundary.
        fig.add_vline(
            x=last_actual_date,
            line=dict(color='#94a3b8', width=1.2, dash='dash'),
        )
        # "Forecast horizon" floating label inside the tinted region.
        _mid_idx = fc_series.index[len(fc_series) // 2]
        fig.add_annotation(
            x=_mid_idx, y=1.06, xref='x', yref='paper',
            text="Forecast horizon",
            showarrow=False,
            font=dict(size=11, color=FUT_COLOR, family='Inter, system-ui, sans-serif'),
            opacity=0.85,
        )
    # Test-region divider (faint) when a test segment exists.
    if (bt_pred_series is not None and len(bt_pred_series) > 0
            and last_actual_date is not None):
        _test_start = bt_pred_series.index[0]
        if _test_start != last_actual_date:
            fig.add_vline(
                x=_test_start,
                line=dict(color='#cbd5e1', width=1, dash='dot'),
                opacity=0.7,
            )

    # ── Layout — clean white template, polished typography & spacing ──
    fig.update_layout(
        title=dict(
            text=(f"<span style='font-size:18px;font-weight:700;color:{DHISHAAI_BLUE};"
                  f"font-family:Inter, system-ui, sans-serif'>{selected}</span>"
                  f"&nbsp;&nbsp;<span style='font-size:12px;color:#94a3b8'>"
                  f"actual history → in-sample fit → test holdout → future forecast"
                  f"</span><br>"
                  f"<span style='font-size:12px;color:#6b7785'>"
                  f"Champion model: <b style='color:{FUT_COLOR}'>{champion_label}</b>"
                  f"</span>"),
            x=0.02, xanchor='left', y=0.97, yanchor='top',
            pad=dict(b=14),
        ),
        template='plotly_white',
        plot_bgcolor='rgba(0,0,0,0)',
        paper_bgcolor='rgba(0,0,0,0)',
        height=480,
        margin=dict(l=20, r=20, t=90, b=80),
        hovermode='x unified',
        hoverlabel=dict(
            bgcolor='rgba(255,255,255,0.96)',
            bordercolor='#e2e8f0',
            font=dict(size=12, color='#1e293b',
                      family='Inter, system-ui, sans-serif'),
        ),
        legend=dict(
            orientation='h',
            yanchor='top', y=-0.18,
            xanchor='center', x=0.5,
            bgcolor='rgba(248, 250, 252, 0.85)',
            bordercolor='#e2e8f0', borderwidth=1,
            font=dict(size=11, color='#475569',
                      family='Inter, system-ui, sans-serif'),
            itemsizing='constant',
        ),
        font=dict(family='Inter, system-ui, sans-serif', color='#475569'),
        xaxis=dict(
            title=None,
            showgrid=True, gridcolor='#f1f5f9', gridwidth=1,
            zeroline=False,
            showspikes=True, spikemode='across', spikethickness=1,
            spikecolor='#cbd5e1', spikedash='dot',
            tickformat='%b %Y',
            tickfont=dict(size=11, color='#64748b'),
            rangeslider=dict(visible=False),
        ),
        yaxis=dict(
            title=dict(text=cfg['sales_col'],
                       font=dict(size=12, color='#475569')),
            showgrid=True, gridcolor='#f1f5f9', gridwidth=1,
            zeroline=True, zerolinecolor='#e2e8f0', zerolinewidth=1,
            tickformat=',.0f',
            tickfont=dict(size=11, color='#64748b'),
            rangemode='tozero',
        ),
    )

    # NOTE: Other candidate algorithms are intentionally NOT plotted — only
    # the champion's forecast is shown so the planner sees one clean
    # recommendation per SKU. Per-algorithm metrics still surface in the
    # "All algorithms" table below.
    st.plotly_chart(fig, use_container_width=True,
                    config={'displaylogo': False, 'responsive': True})

    # ---- Per-month forecast interpretation ----
    # Lets the planner pick any forecast month and see the drivers
    # (YoY/MoM anchors, pinned events, seasonality, trend, pipeline
    # adjustments) plus the champion model's full audit trail.
    _render_forecast_interpretation(res, history, cfg, selected, champion_label)

    # ---- Unified All-Algorithms WMAPE comparison ----
    # Lists every candidate algorithm evaluated for this SKU (not just the
    # portfolio extras), with their VALIDATION WMAPE (what the champion
    # selector used), test WMAPE (headline on a strictly later slice),
    # CV WMAPE (when CV ran), and the future forecast total. The champion
    # row is highlighted with ⭐ and pinned to the top.
    algo_metrics = getattr(res, 'all_algorithm_metrics', {}) or {}
    if algo_metrics:
        cv_ran = any(m.get('cv_mape') is not None for m in algo_metrics.values())
        val_ran = any(m.get('val_mape') is not None for m in algo_metrics.values())
        st.markdown("##### 📊 All algorithms — accuracy comparison")
        rows = []
        for algo, m in algo_metrics.items():
            label_base = (ADDITIONAL_ALGORITHMS.get(algo, {}).get('name')
                          or STRATEGY_INFO.get(algo, {}).get('name')
                          or algo)
            is_champ = m.get('is_champion', False)
            label = f"⭐ {label_base} (champion)" if is_champ else label_base
            role = '🏆 Champion' if is_champ else 'Candidate'
            ff = m.get('future_forecast')
            # WMAPE→SMAPE fallback per algorithm so every row shows a number.
            eff_test, test_src = _effective_mape(
                m.get('test_mape'), m.get('test_smape'))
            row = {
                'Algorithm': label,
                'Role': role,
                'Accuracy (WMAPE %)': eff_test,
                'Metric': test_src,
                'Forecast total (horizon)': float(ff.sum()) if ff is not None else None,
                # Champion pinned first; the rest sorted by accuracy.
                '_sort_key': (0 if is_champ else 1,
                              eff_test if eff_test is not None else float('inf')),
            }
            if cv_ran:
                eff_cv, cv_src = _effective_mape(
                    m.get('cv_mape'), m.get('cv_smape'))
                row['CV WMAPE'] = eff_cv
            rows.append(row)
        algo_df = pd.DataFrame(rows)
        algo_df = algo_df.sort_values('_sort_key').drop(columns=['_sort_key'])
        for col in ['Accuracy (WMAPE %)', 'CV WMAPE']:
            if col in algo_df.columns:
                algo_df[col] = algo_df[col].apply(
                    lambda x: f"{x:.1f}%" if pd.notna(x) else "—")
        if 'Forecast total (horizon)' in algo_df.columns:
            algo_df['Forecast total (horizon)'] = algo_df['Forecast total (horizon)'].apply(
                lambda x: f"{x:,.0f}" if pd.notna(x) else "—")
        algo_df['Metric'] = algo_df['Metric'].replace('n/a', '—')
        st.dataframe(algo_df, use_container_width=True, hide_index=True)
        st.caption(
            "**Accuracy (WMAPE %)** = error on a held-out slice the model never "
            "saw (lower = better). **Forecast total** = each algorithm's summed "
            "prediction over the horizon."
        )

        # ── Why this model won (validation detail, on demand) ──────────
        # The champion is chosen on a SEPARATE, strictly-earlier validation
        # slice so the headline Accuracy stays unbiased. That nuance lives
        # here instead of cluttering the table with a second WMAPE column.
        if val_ran:
            champ_algo = next((a for a, m in algo_metrics.items()
                               if m.get('is_champion')), res.strategy_used)
            champ_m = algo_metrics.get(champ_algo, {})
            champ_val, _ = _effective_mape(champ_m.get('val_mape'),
                                           champ_m.get('val_smape'))
            champ_test, _ = _effective_mape(champ_m.get('test_mape'),
                                            champ_m.get('test_smape'))
            champ_label = (ADDITIONAL_ALGORITHMS.get(champ_algo, {}).get('name')
                           or STRATEGY_INFO.get(champ_algo, {}).get('name')
                           or champ_algo)
            with st.expander("🛈 Why this model won"):
                # Ranked by the selection metric (validation WMAPE)
                val_rows = []
                for algo, m in algo_metrics.items():
                    ev, _ = _effective_mape(m.get('val_mape'), m.get('val_smape'))
                    if ev is None:
                        continue
                    nm = (ADDITIONAL_ALGORITHMS.get(algo, {}).get('name')
                          or STRATEGY_INFO.get(algo, {}).get('name') or algo)
                    val_rows.append((ev, nm, bool(m.get('is_champion'))))
                val_rows.sort(key=lambda t: t[0])
                st.markdown(
                    f"**{champ_label}** was selected because it had the lowest "
                    f"**validation WMAPE** "
                    f"({champ_val:.1f}%)" if champ_val is not None else
                    f"**{champ_label}** was selected as the champion")
                st.caption(
                    "Models are chosen on a *validation* slice (earlier hold-out) "
                    "and then scored for the table on a *later, unseen* slice — so "
                    "a candidate can occasionally show a lower table Accuracy than "
                    "the champion without being the better pick. "
                    + (f"Champion's reported Accuracy: {champ_test:.1f}%."
                       if champ_test is not None else ""))
                if val_rows:
                    st.dataframe(
                        pd.DataFrame(
                            [{'Algorithm': ('⭐ ' + nm) if ch else nm,
                              'Validation WMAPE': f"{ev:.1f}%"}
                             for ev, nm, ch in val_rows]),
                        use_container_width=True, hide_index=True)

    if res.notes:
        st.caption(f"💡 {res.notes}")
    auto_strat = getattr(res, 'auto_routed_strategy', None)
    if auto_strat and auto_strat != res.strategy_used:
        st.caption(
            f"🔁 Auto-routed → **{auto_strat}**, but a per-segment override "
            f"swapped it for **{res.strategy_used}**."
        )

    # ----------------------------------------------------------------
    # Brand-level reconciled view
    # ----------------------------------------------------------------
    # Three series per brand:
    #   • Bottom-up (BU)   — Σ of the forecasted SKU forecasts in this brand
    #   • Top-down  (TD)   — Holt-Winters fitted on the brand-aggregated history
    #   • Reconciled       — blend of BU + TD; the SKU forecasts are scaled to
    #                        match this total (parts equal the whole)
    recon_pkg = st.session_state.get('brand_reconciliation')
    if recon_pkg and recon_pkg.get('reconciled'):
        st.subheader("Brand-level totals — Bottom-up vs Top-down vs Reconciled")
        st.caption(recon_pkg.get('method_notes', ''))

        brands = sorted(recon_pkg['reconciled'].keys())
        coverage = recon_pkg.get('coverage', {})

        # --- Coverage summary table ---
        cov_rows = []
        for b in brands:
            cov = coverage.get(b, {})
            cov_rows.append({
                'brand': b,
                'SKUs forecasted': cov.get('n_forecasted', 0),
                'SKUs total in brand': cov.get('n_total', 0),
                'coverage %': round(cov.get('pct', 0.0), 1),
                'top-down available': '✓' if cov.get('has_top_down') else '—',
                'reconciled total (horizon)': float(
                    recon_pkg['reconciled'][b].sum()
                ),
            })
        cov_df = pd.DataFrame(cov_rows)
        st.dataframe(cov_df, use_container_width=True, hide_index=True)

        # Sanity warning: any brand where only a sample of SKUs was forecasted
        partial = [r for r in cov_rows if 0 < r['coverage %'] < 100]
        if partial:
            partial_names = ', '.join(r['brand'] for r in partial[:5])
            extra = f" (+{len(partial) - 5} more)" if len(partial) > 5 else ''
            st.warning(
                f"⚠️ Partial-coverage brands: **{partial_names}{extra}**. "
                f"Bottom-up totals reflect only the forecasted SKUs, not the "
                f"whole brand. Top-down (which uses the full brand history) is "
                f"more representative of the actual brand size in these cases."
            )

        # --- Per-brand chooser + 3-line chart with history continuation ---
        chosen_brand = st.selectbox(
            "Inspect brand", brands, key='brand_recon_selector',
        )
        if chosen_brand:
            bu = recon_pkg['bottom_up'].get(chosen_brand)
            td = recon_pkg['top_down'].get(chosen_brand)
            rec = recon_pkg['reconciled'].get(chosen_brand)
            hist = recon_pkg.get('history', {}).get(chosen_brand)

            fig_b = go.Figure()
            # History — soft area fill anchors the eye on what's known
            if hist is not None and len(hist) > 0:
                fig_b.add_trace(go.Scatter(
                    x=hist.index, y=hist.values, mode='lines+markers',
                    name='History (actual)',
                    line=dict(color=DHISHAAI_BLUE, width=2.4,
                              shape='spline', smoothing=0.5),
                    marker=dict(size=6, color=DHISHAAI_BLUE,
                                line=dict(width=1.5, color='#ffffff')),
                    fill='tozeroy', fillcolor='rgba(7, 62, 92, 0.06)',
                    hovertemplate='<b>History</b>: %{y:,.0f}<extra></extra>',
                ))
            if bu is not None:
                fig_b.add_trace(go.Scatter(
                    x=bu.index, y=bu.values, mode='lines+markers',
                    name='Bottom-up (Σ SKU)',
                    line=dict(color=DHISHAAI_ORANGE, width=2.2, dash='dot',
                              shape='spline', smoothing=0.5),
                    marker=dict(size=6, color=DHISHAAI_ORANGE,
                                line=dict(width=1.5, color='#ffffff')),
                    hovertemplate='<b>Bottom-up</b>: %{y:,.0f}<extra></extra>',
                ))
            if td is not None:
                fig_b.add_trace(go.Scatter(
                    x=td.index, y=td.values, mode='lines+markers',
                    name='Top-down (HW on brand)',
                    line=dict(color='#9333EA', width=2.2, dash='dash',
                              shape='spline', smoothing=0.5),
                    marker=dict(size=6, color='#9333EA',
                                line=dict(width=1.5, color='#ffffff')),
                    hovertemplate='<b>Top-down</b>: %{y:,.0f}<extra></extra>',
                ))
            if rec is not None:
                fig_b.add_trace(go.Scatter(
                    x=rec.index, y=rec.values, mode='lines+markers',
                    name='🏆 Reconciled (blended)',
                    line=dict(color='#10B981', width=3.4,
                              shape='spline', smoothing=0.5),
                    marker=dict(size=8, color='#10B981',
                                line=dict(width=1.8, color='#ffffff')),
                    hovertemplate='<b>Reconciled</b>: %{y:,.0f}<extra></extra>',
                ))
            cov = coverage.get(chosen_brand, {})
            # Divider + tinted band for the forecast horizon
            if hist is not None and len(hist) > 0 and rec is not None and len(rec) > 0:
                _split = hist.index[-1]
                fig_b.add_vrect(
                    x0=_split, x1=rec.index[-1],
                    fillcolor='rgba(16, 185, 129, 0.04)',
                    line_width=0, layer='below',
                )
                fig_b.add_vline(x=_split,
                                line=dict(color='#94a3b8', width=1.2, dash='dash'))
            fig_b.update_layout(
                title=dict(
                    text=(f"<span style='font-size:17px;font-weight:700;color:{DHISHAAI_BLUE};"
                          f"font-family:Inter, system-ui, sans-serif'>{chosen_brand}</span>"
                          f"<br><span style='font-size:12px;color:#6b7785'>"
                          f"Brand-level reconciled forecast · coverage "
                          f"{cov.get('n_forecasted', 0)}/{cov.get('n_total', 0)} SKUs "
                          f"({cov.get('pct', 0.0):.0f}%)</span>"),
                    x=0.02, xanchor='left', y=0.97, yanchor='top', pad=dict(b=10),
                ),
                template='plotly_white',
                plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                height=460,
                margin=dict(l=20, r=20, t=80, b=70),
                hovermode='x unified',
                hoverlabel=dict(
                    bgcolor='rgba(255,255,255,0.96)', bordercolor='#e2e8f0',
                    font=dict(size=12, color='#1e293b',
                              family='Inter, system-ui, sans-serif'),
                ),
                legend=dict(
                    orientation='h', yanchor='top', y=-0.18,
                    xanchor='center', x=0.5,
                    bgcolor='rgba(248, 250, 252, 0.85)',
                    bordercolor='#e2e8f0', borderwidth=1,
                    font=dict(size=11, color='#475569',
                              family='Inter, system-ui, sans-serif'),
                ),
                font=dict(family='Inter, system-ui, sans-serif', color='#475569'),
                xaxis=dict(showgrid=True, gridcolor='#f1f5f9', zeroline=False,
                           tickformat='%b %Y', tickfont=dict(size=11, color='#64748b')),
                yaxis=dict(title=dict(text=cfg['sales_col'],
                                       font=dict(size=12, color='#475569')),
                           showgrid=True, gridcolor='#f1f5f9',
                           zeroline=True, zerolinecolor='#e2e8f0',
                           tickformat=',.0f', rangemode='tozero',
                           tickfont=dict(size=11, color='#64748b')),
            )
            st.plotly_chart(fig_b, use_container_width=True,
                            config={'displaylogo': False, 'responsive': True})

            if not cov.get('has_top_down'):
                st.info(
                    "ℹ️ Top-down was not available for this brand "
                    "(insufficient history). Reconciled = Bottom-up in this case."
                )

        # --- Combined small multiples: reconciled totals across all brands ---
        with st.expander("All brands — reconciled totals on one chart"):
            rec_df = pd.DataFrame({b: recon_pkg['reconciled'][b] for b in brands})
            fig_all = px.line(rec_df, title='Reconciled brand-level forecast totals')
            fig_all.update_layout(height=420, yaxis_title=cfg['sales_col'])
            st.plotly_chart(fig_all, use_container_width=True)

        # --- Download: reconciled brand series + adjusted SKU forecasts ---
        with st.expander("Download brand reconciliation outputs"):
            # Wide CSV: one column per brand × method
            rows = []
            for b in brands:
                for method, ser in [
                    ('bottom_up', recon_pkg['bottom_up'].get(b)),
                    ('top_down', recon_pkg['top_down'].get(b)),
                    ('reconciled', recon_pkg['reconciled'].get(b)),
                ]:
                    if ser is None:
                        continue
                    for d, v in ser.items():
                        rows.append({
                            'brand': b, 'method': method,
                            'date': d, 'forecast': float(v),
                        })
            recon_long = pd.DataFrame(rows)
            if len(recon_long) > 0:
                buf1 = io.StringIO()
                recon_long.to_csv(buf1, index=False)
                st.download_button(
                    "Download brand reconciliation (CSV)", buf1.getvalue(),
                    "brand_reconciliation.csv", "text/csv",
                    use_container_width=True,
                )

            # Adjusted SKU forecasts (after proportional push-back)
            adj = recon_pkg.get('adjusted_sku_forecasts', {})
            if adj:
                adj_rows = []
                for sku, ser in adj.items():
                    for d, v in ser.items():
                        adj_rows.append({
                            cfg['sku_col']: sku, cfg['date_col']: d,
                            'forecast_adjusted': float(v),
                        })
                buf2 = io.StringIO()
                pd.DataFrame(adj_rows).to_csv(buf2, index=False)
                st.download_button(
                    "Download SKU forecasts after reconciliation (CSV)",
                    buf2.getvalue(),
                    "sku_forecasts_reconciled.csv", "text/csv",
                    use_container_width=True,
                    help="Each SKU forecast scaled by reconciled/bottom-up per "
                         "date, so the SKU forecasts sum to the reconciled "
                         "brand total.",
                )

    # Download
    st.subheader("Export")
    forecast_long = pd.concat([
        pd.DataFrame({
            cfg['sku_col']: r.sku,
            cfg['date_col']: r.forecast.index,
            'forecast': r.forecast.values,
            'strategy': r.strategy_used,
        }) for r in results
    ], ignore_index=True)
    csv_buf = io.StringIO()
    forecast_long.to_csv(csv_buf, index=False)
    st.download_button("Download forecasts (CSV)", csv_buf.getvalue(),
                       "forecasts.csv", "text/csv", use_container_width=True)


# =================================================================
# MAIN
# =================================================================

def main():
    st.set_page_config(page_title="DhishaAI Time Lens v2", layout="wide")
    apply_theme()

    if 'profiled' not in st.session_state:
        st.session_state.profiled = False
        st.session_state.forecasts_run = False

    cfg = render_sidebar()
    if cfg is None:
        return

    tab1, tab2, tab3, tab4 = st.tabs([
        "1. Profile & Route",
        "2. Forecast",
        "3. Performance",
        "4. About the architecture",
    ])

    with tab1:
        render_profiling_tab(cfg)
    with tab2:
        render_forecast_tab(cfg)
    with tab3:
        render_performance_tab(cfg)
    with tab4:
        render_about()


# =================================================================
# 11. PERFORMANCE TAB
#     Cross-level accuracy diagnostics: SKU → Segment → Brand → Overall.
#     The key principle is to separate three concerns at every level:
#       (a) how accurate is the forecast (WMAPE/SMAPE),
#       (b) is it biased (signed error — over- or under-forecasting),
#       (c) how trustworthy is the metric (coverage: backtested / total).
#     Volume-weighting is applied wherever an unweighted average would
#     misrepresent business impact (top 10% of SKUs = 64% of volume).
# =================================================================

def _build_residuals_long(results, profiles_lookup) -> pd.DataFrame:
    """Stack every SKU's holdout actuals/predictions into a long DataFrame.

    Returns columns: sku, brand, segment, strategy, date, actual, pred, residual.
    Rows are only present for SKUs whose backtest produced aligned series.
    This is the foundation table for all aggregated metrics.
    """
    rows = []
    for r in results:
        if r.backtest_actual is None or r.backtest_pred is None:
            continue
        prof = profiles_lookup.get(r.sku, {})
        for date, actual in r.backtest_actual.items():
            pred = r.backtest_pred.get(date, np.nan)
            rows.append({
                'sku': r.sku,
                'brand': prof.get('brand', 'unknown'),
                'segment': prof.get('segment', 'unknown'),
                'strategy': r.strategy_used,
                'date': date,
                'actual': float(actual),
                'pred': float(pred),
                'residual': float(pred - actual),
            })
    return pd.DataFrame(rows)


def _aggregate_metrics(long_df: pd.DataFrame, group_cols: List[str],
                       all_skus_df: pd.DataFrame = None) -> pd.DataFrame:
    """Compute pooled WMAPE/SMAPE/bias and coverage at any aggregation level.

    Pooled metrics treat the holdout actuals across all SKUs in a group as a
    single pooled vector — this is what a planner cares about (does the
    aggregated forecast match aggregated actuals). It's NOT the average of
    per-SKU WMAPEs (which would weight a $10 SKU equal to a $10,000 SKU).

    `all_skus_df` (optional) provides total-SKU counts per group so we can
    report coverage = (backtested SKUs / total SKUs) — important because
    a great WMAPE on 30% of a brand isn't actually great.

    Pass `group_cols=[]` to get a single overall-aggregate row (used for the
    headline KPIs); pandas's groupby cannot accept an empty key list, so we
    handle that case by aggregating over the whole frame.
    """
    if long_df.empty:
        return pd.DataFrame()

    def _smape_for(g: pd.DataFrame) -> float:
        denom = (np.abs(g['actual']) + np.abs(g['pred'])) / 2
        mask = denom > 0
        if not mask.any():
            return np.nan
        return float(np.mean(np.abs(g['actual'][mask] - g['pred'][mask]) / denom[mask]) * 100)

    if not group_cols:
        # Whole-frame single-row aggregate (groupby([]) raises ValueError)
        sum_actual = float(long_df['actual'].sum())
        sum_pred = float(long_df['pred'].sum())
        sum_abs_resid = float(long_df['residual'].abs().sum())
        out = pd.DataFrame([{
            'n_skus_backtested': long_df['sku'].nunique(),
            'sum_actual': sum_actual,
            'sum_pred': sum_pred,
            'sum_abs_residual': sum_abs_resid,
            'weighted_mape': (sum_abs_resid / sum_actual * 100) if sum_actual > 0 else np.nan,
            'smape': _smape_for(long_df),
            'bias_pct': ((sum_pred - sum_actual) / sum_actual * 100) if sum_actual > 0 else np.nan,
        }])
        if all_skus_df is not None and not all_skus_df.empty:
            total = all_skus_df['sku'].nunique()
            out['n_skus_total'] = total
            out['coverage_pct'] = round(out['n_skus_backtested'] / total * 100, 0) if total else np.nan
        return out.round(2)

    grouped = long_df.groupby(group_cols)

    out = grouped.agg(
        n_skus_backtested=('sku', 'nunique'),
        sum_actual=('actual', 'sum'),
        sum_pred=('pred', 'sum'),
        sum_abs_residual=('residual', lambda r: np.abs(r).sum()),
    ).reset_index()

    # Pooled WMAPE: sum of |residual| / sum of |actual| (also called WAPE).
    # This is the right metric for aggregated business impact.
    out['weighted_mape'] = np.where(
        out['sum_actual'] > 0,
        out['sum_abs_residual'] / out['sum_actual'] * 100,
        np.nan,
    )

    # Pooled SMAPE — symmetric, robust to zero actuals.
    out['smape'] = [_smape_for(g) for _, g in grouped]

    # Bias — signed total error as % of total actual; positive = over-forecasting.
    out['bias_pct'] = np.where(
        out['sum_actual'] > 0,
        (out['sum_pred'] - out['sum_actual']) / out['sum_actual'] * 100,
        np.nan,
    )

    # Coverage: how many SKUs in the group did we actually backtest?
    # Only compute when ALL grouping columns are present in all_skus_df —
    # otherwise the groupby raises KeyError (e.g. asking for strategy-level
    # coverage when all_skus_df doesn't carry the strategy column).
    if (all_skus_df is not None and not all_skus_df.empty
            and all(c in all_skus_df.columns for c in group_cols)):
        total_per_group = all_skus_df.groupby(group_cols)['sku'].nunique().reset_index()
        total_per_group = total_per_group.rename(columns={'sku': 'n_skus_total'})
        out = out.merge(total_per_group, on=group_cols, how='left')
        out['coverage_pct'] = (out['n_skus_backtested'] / out['n_skus_total'] * 100).round(0)

    return out.round(2)



# =================================================================
# 11. PERFORMANCE DASHBOARD
#     Four levels: Segment → Brand → Brand × Segment → SKU.
#     Design rules:
#       - Lead with a chart, not a table. Tables are for reference.
#       - Color = severity (red bad, green good); never decorative.
#       - Bubble size = held-out volume — every visual respects that the
#         top 10% of SKUs are 64% of the business.
#       - Each tab fits in roughly 1.5 viewports; no scroll-marathons.
#       - Three traffic-light bands match standard demand-planning practice:
#           good < 20% WMAPE, review 20-50%, poor > 50%.
# =================================================================

# Traffic-light thresholds (industry-standard demand-planning bands)
WMAPE_GOOD = 20.0
WMAPE_POOR = 50.0
COLOR_GOOD = "#16a34a"     # green-600
COLOR_REVIEW = "#f59e0b"   # amber-500
COLOR_POOR = "#dc2626"     # red-600
COLOR_NEUTRAL = "#94a3b8"  # slate-400


def _mape_band(mape: float) -> Tuple[str, str]:
    """Return (band_label, hex_color) for a WMAPE value."""
    if pd.isna(mape):
        return "no data", COLOR_NEUTRAL
    if mape < WMAPE_GOOD:
        return "good", COLOR_GOOD
    if mape < WMAPE_POOR:
        return "review", COLOR_REVIEW
    return "poor", COLOR_POOR


def _format_perf_table(df: pd.DataFrame) -> pd.DataFrame:
    """Pretty column names + sensible defaults for st.dataframe display."""
    if df.empty:
        return df
    rename_map = {
        'weighted_mape': 'WMAPE %',
        'smape': 'SMAPE %',
        'bias_pct': 'Bias %',
        'sum_actual': 'Actual',
        'sum_pred': 'Forecast',
        'n_skus_backtested': 'SKUs',
        'n_skus_total': 'SKUs total',
        'coverage_pct': 'Coverage %',
    }
    return (df.drop(columns=['sum_abs_residual'], errors='ignore')
              .rename(columns=rename_map))


def _render_kpi_strip(long_df: pd.DataFrame, all_skus_df: pd.DataFrame):
    """Top-of-page KPI strip with traffic-light treatment on the headline WMAPE."""
    overall = _aggregate_metrics(long_df, [], all_skus_df)
    if overall.empty:
        return
    m = overall.iloc[0]
    band, color = _mape_band(m['weighted_mape'])

    # Build the four KPI cards. We use markdown HTML for the headline so we can
    # apply the traffic-light color directly to the number — st.metric doesn't
    # support per-value coloring.
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        mape_val = f"{m['weighted_mape']:.1f}%" if pd.notna(m['weighted_mape']) else "—"
        st.markdown(
            f"""<div style='padding:16px; border-left:4px solid {color};
                background:#f8fafc; border-radius:6px;'>
                <div style='font-size:0.85em; color:#64748b;'>WEIGHTED WMAPE</div>
                <div style='font-size:2em; font-weight:700; color:{color};'>{mape_val}</div>
                <div style='font-size:0.8em; color:#64748b;'>{band.upper()} · &lt;20% good</div>
            </div>""",
            unsafe_allow_html=True,
        )
    c2.metric(
        "SMAPE",
        f"{m['smape']:.1f}%" if pd.notna(m['smape']) else "—",
        help="Symmetric MAPE — defined even when actuals are zero.",
    )
    bias = m['bias_pct']
    bias_str = f"{bias:+.1f}%" if pd.notna(bias) else "—"
    bias_help = (
        "Negative = under-forecasting; positive = over-forecasting. "
        "Watched separately from WMAPE because bias compounds into inventory."
    )
    c3.metric("Bias", bias_str, help=bias_help)
    cov = m.get('coverage_pct', np.nan)
    c4.metric(
        "Backtest coverage",
        f"{cov:.0f}%" if pd.notna(cov) else "—",
        help=(f"{int(m['n_skus_backtested'])} of {int(m.get('n_skus_total', 0))} "
              f"SKUs in this run produced an out-of-sample evaluation. The rest "
              f"had history shorter than 2 months — see Tab 2 for the breakdown."),
    )


def _bar_chart_with_bands(perf: pd.DataFrame, dim_col: str, title: str,
                          height: int = 380):
    """Horizontal bar chart of WMAPE per group, traffic-light coloured.

    Sorted ascending so the worst group is at the bottom (where the eye lands
    last and lingers). Each bar's fill is the traffic-light color of its WMAPE.
    SMAPE shown as a secondary marker so the user sees both at once.
    """
    if perf.empty or 'weighted_mape' not in perf.columns:
        return None
    df = perf.dropna(subset=['weighted_mape']).sort_values('weighted_mape')
    if df.empty:
        return None
    df = df.copy()
    df['color'] = df['weighted_mape'].apply(lambda v: _mape_band(v)[1])
    df['label'] = df['weighted_mape'].round(1).astype(str) + '%'

    fig = go.Figure()
    fig.add_trace(go.Bar(
        y=df[dim_col], x=df['weighted_mape'], orientation='h',
        marker=dict(color=df['color']),
        text=df['label'], textposition='outside',
        name='WMAPE',
        hovertemplate=(f"<b>%{{y}}</b><br>WMAPE: %{{x:.1f}}%<br>"
                       "SKUs backtested: %{customdata[0]}<br>"
                       "Held-out volume: %{customdata[1]:,.0f}<extra></extra>"),
        customdata=df[['n_skus_backtested', 'sum_actual']].values,
    ))
    # Traffic-light reference lines
    fig.add_vline(x=WMAPE_GOOD, line_dash='dot', line_color=COLOR_GOOD,
                  annotation_text='20% good', annotation_position='top')
    fig.add_vline(x=WMAPE_POOR, line_dash='dot', line_color=COLOR_POOR,
                  annotation_text='50% poor', annotation_position='top')

    fig.update_layout(
        title=title, height=height, showlegend=False,
        xaxis_title='Weighted WMAPE %', yaxis_title='',
        margin=dict(l=10, r=20, t=50, b=40),
        plot_bgcolor='white',
    )
    return fig


def _bias_volume_scatter(perf: pd.DataFrame, dim_col: str, title: str):
    """Bias vs WMAPE scatter; bubble = volume; color = traffic-light WMAPE band.

    Quadrant reading:
      - Top-right: high WMAPE + over-forecast → cutting overstock unlocks value
      - Top-left:  high WMAPE + under-forecast → stockout risk; raise forecast
      - Bottom: low WMAPE — no action needed
    """
    if perf.empty or 'bias_pct' not in perf.columns:
        return None
    df = perf.dropna(subset=['weighted_mape', 'bias_pct']).copy()
    if df.empty:
        return None
    df['band'] = df['weighted_mape'].apply(lambda v: _mape_band(v)[0])
    df['color'] = df['weighted_mape'].apply(lambda v: _mape_band(v)[1])

    fig = go.Figure()
    for band in ['good', 'review', 'poor']:
        sub = df[df['band'] == band]
        if sub.empty:
            continue
        fig.add_trace(go.Scatter(
            x=sub['bias_pct'], y=sub['weighted_mape'],
            mode='markers+text',
            marker=dict(
                size=sub['sum_actual'] / max(df['sum_actual'].max(), 1) * 80 + 12,
                color=_mape_band(sub['weighted_mape'].iloc[0])[1],
                opacity=0.75, line=dict(width=1, color='white'),
            ),
            text=sub[dim_col], textposition='top center',
            name=band.upper(),
            hovertemplate=(f"<b>%{{text}}</b><br>WMAPE: %{{y:.1f}}%<br>"
                           "Bias: %{x:+.1f}%<br>"
                           "Volume: %{marker.size:.0f}<extra></extra>"),
        ))

    fig.add_vline(x=0, line_color='#cbd5e1', line_width=1)
    fig.add_hline(y=WMAPE_GOOD, line_dash='dot', line_color=COLOR_GOOD, opacity=0.4)
    fig.add_hline(y=WMAPE_POOR, line_dash='dot', line_color=COLOR_POOR, opacity=0.4)
    fig.update_layout(
        title=title, height=460,
        xaxis_title='Bias %  ←  under-forecast    over-forecast  →',
        yaxis_title='Weighted WMAPE %',
        plot_bgcolor='white',
        legend=dict(orientation='h', y=-0.18),
    )
    return fig


# =================================================================
# FORECAST SUBMISSION — planner's final-review screen
# =================================================================
# Once the engine has produced a forecast, planners need to:
#   1. Sanity-check it against history (MoM trend, YoY anchor, LY same month)
#   2. Apply business knowledge the model can't see (promo, supply, market)
#   3. Document each override with a reason (audit trail)
#   4. Drill down through Category → Brand → Product → SKU and Segment
#   5. Submit + download the final plan
# This is the "human in the loop" gate before the forecast becomes a plan.

REASON_OPTIONS = [
    "(no override)",
    "New promotion launching",
    "Promotion ending",
    "Supplier delay / stock-out projected",
    "Trend break — recent uptick",
    "Trend break — recent decline",
    "Competitor activity",
    "Market expansion / new channel",
    "Discontinuation planned",
    "Seasonality model under-reacting",
    "Seasonality model over-reacting",
    "Price change",
    "External event (weather, holiday shift, etc.)",
    "Other (see notes)",
]


def _signature_of_results(results: List[Any]) -> str:
    """Cheap signature so we know when to rebuild the submission frame.
    Changes when the user re-runs forecasts (different SKU set or new forecast values).
    """
    if not results:
        return ""
    h = hashlib.md5()
    for r in results:
        h.update(r.sku.encode())
        h.update(r.strategy_used.encode())
        if r.forecast is not None and len(r.forecast):
            h.update(f"{float(r.forecast.sum()):.4f}|{len(r.forecast)}".encode())
    return h.hexdigest()[:16]


def build_submission_frame(results: List[Any], df: pd.DataFrame,
                           profiles: pd.DataFrame, cfg: Dict[str, Any]) -> pd.DataFrame:
    """Build a long-format (SKU × forecast-month) DataFrame the planner edits.

    Each row carries:
        - Identity:   sku, product_name, category, brand, segment, strategy, mape
        - The model's forecast (immutable reference)
        - History anchors: last-year-same-month (YoY), last-3-month avg (MoM)
        - Derived deltas: mom_pct (vs prev row in same SKU's submission),
                          yoy_pct (vs LY same month), delta_vs_model_pct
        - **Editable**: submitted_forecast (starts = model_forecast), reason, notes
    """
    sku_col = cfg['sku_col']
    date_col = cfg['date_col']
    sales_col = cfg['sales_col']

    # Pre-index full history per SKU for fast lookups
    df_local = df.copy()
    df_local[date_col] = pd.to_datetime(df_local[date_col], errors='coerce')
    hist_by_sku = {
        sku: g.set_index(date_col)[sales_col].sort_index()
        for sku, g in df_local.groupby(sku_col)
    }

    # Build a quick lookup of static attributes per SKU
    # — these may live in df_raw (category, product_name) or the profile (segment, brand)
    static_cols = {}
    for col in ('product_name', 'category'):
        if col in df_local.columns:
            static_cols[col] = (df_local.groupby(sku_col)[col]
                                .agg(lambda s: s.dropna().iloc[0]
                                     if s.dropna().size else None)
                                .to_dict())
    seg_lookup = (profiles.set_index('sku')['segment'].to_dict()
                  if 'segment' in profiles.columns else {})
    brand_lookup = (profiles.set_index('sku')['brand'].to_dict()
                    if 'brand' in profiles.columns else {})
    mape_lookup = {r.sku: r.backtest_mape for r in results}

    rows = []
    for r in results:
        if r.forecast is None or len(r.forecast) == 0:
            continue
        hist = hist_by_sku.get(r.sku)
        if hist is None:
            hist = pd.Series(dtype=float)

        last_3mo_avg = (float(hist.iloc[-3:].mean())
                        if len(hist) >= 3
                        else (float(hist.mean()) if len(hist) else np.nan))

        for i, (period, val) in enumerate(r.forecast.items()):
            period_ts = pd.Timestamp(period)
            # Last-year-same-month anchor (exact match if monthly freq)
            ly_target = period_ts - pd.DateOffset(years=1)
            # Tolerate small index differences: accept any history value
            # within ±15 days of the LY target
            ly_val = np.nan
            if len(hist):
                # pandas Index subtraction yields a TimedeltaIndex; take the
                # closest absolute-days match within ±15 days as our YoY anchor.
                ly_idx = (hist.index - ly_target).map(lambda td: abs(td.days))
                ly_pos = int(np.argmin(ly_idx)) if len(ly_idx) else None
                if ly_pos is not None and ly_idx[ly_pos] <= 15:
                    ly_val = float(hist.iloc[ly_pos])

            model_val = float(val)
            yoy_pct = ((model_val - ly_val) / ly_val * 100
                       if (ly_val and not np.isnan(ly_val) and ly_val != 0)
                       else np.nan)

            # MoM% is computed below after the frame is built (needs prev row);
            # use a placeholder here.
            rows.append({
                'sku': r.sku,
                'product_name': static_cols.get('product_name', {}).get(r.sku, r.sku),
                'category': static_cols.get('category', {}).get(r.sku, '(uncategorised)'),
                'brand': brand_lookup.get(r.sku, '—'),
                'segment': seg_lookup.get(r.sku, '—'),
                'strategy': r.strategy_used,
                'mape': mape_lookup.get(r.sku),
                'forecast_month': period_ts,
                'last_year_same_month': ly_val,
                'last_3mo_avg': last_3mo_avg,
                'model_forecast': round(model_val, 1),
                'submitted_forecast': round(model_val, 1),  # default = model
                'mom_pct': np.nan,           # filled after sort
                'yoy_pct': yoy_pct,
                'delta_vs_model_pct': 0.0,
                'reason': REASON_OPTIONS[0],
                'notes': '',
            })

    if not rows:
        return pd.DataFrame()

    frame = pd.DataFrame(rows).sort_values(['sku', 'forecast_month']).reset_index(drop=True)

    # MoM% — first month references last_3mo_avg as the "previous", subsequent
    # months reference the previous forecast month within the same SKU. Using
    # last_3mo_avg avoids a NaN on the first row and ties MoM to recent reality.
    def _mom(g: pd.DataFrame) -> pd.DataFrame:
        g = g.copy()
        prev = g['submitted_forecast'].shift(1).astype(float)
        if len(g):
            anchor = g['last_3mo_avg'].iloc[0]
            prev.iat[0] = anchor if pd.notna(anchor) else np.nan
        g['mom_pct'] = (g['submitted_forecast'] - prev) / prev.replace(0, np.nan) * 100
        return g
    frame = frame.groupby('sku', group_keys=False).apply(_mom)

    return frame


def _recompute_derived_columns(frame: pd.DataFrame) -> pd.DataFrame:
    """After the user edits `submitted_forecast`, refresh the dependent
    columns (MoM%, delta vs model). YoY stays anchored to LY actuals — it
    doesn't depend on the user's edit.
    """
    if frame is None or frame.empty:
        return frame
    frame = frame.sort_values(['sku', 'forecast_month']).reset_index(drop=True)
    frame['delta_vs_model_pct'] = np.where(
        frame['model_forecast'].replace(0, np.nan).notna(),
        (frame['submitted_forecast'] - frame['model_forecast'])
            / frame['model_forecast'].replace(0, np.nan) * 100,
        np.nan,
    )

    def _mom(g: pd.DataFrame) -> pd.DataFrame:
        g = g.copy()
        prev = g['submitted_forecast'].shift(1).astype(float)
        if len(g):
            anchor = g['last_3mo_avg'].iloc[0]
            prev.iat[0] = anchor if pd.notna(anchor) else np.nan
        g['mom_pct'] = (g['submitted_forecast'] - prev) / prev.replace(0, np.nan) * 100
        return g
    return frame.groupby('sku', group_keys=False).apply(_mom)


def render_submission_tab(cfg):
    """Tab 5: Planner reviews + edits the forecast before submission.

    Layout (top → bottom):
      1. Header banner
      2. Filter bar: Category → Brand → Product → SKU (cascaded) + Segment + Status
      3. KPI strip for the current filter (units, Δ vs model, MoM, YoY, overrides)
      4. Bulk-action toolbar (apply uplift / copy LY / reset)
      5. Editable grid (data_editor) with MoM, YoY context columns + reason dropdown
      6. SKU drill-down: history + model + submitted overlay chart
      7. Submission audit + Submit button + CSV download
    """
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 5 · Forecast Submission</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                Review · Adjust · Submit
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Edit any forecast month, log the business reason, and lock in the
                final plan — MoM trend + YoY anchor shown for every row.
            </div>
        </div>
    """, unsafe_allow_html=True)

    if not st.session_state.get('forecasts_run'):
        st.warning("Run forecasts in **Step 4 · Forecast** before submitting.")
        return

    results = st.session_state.get('forecast_results') or []
    if not results:
        st.warning("No forecast results in session. Re-run the Forecast step.")
        return

    # Defensive read — if state was reset (e.g. user re-segmented) fall back
    # to df_raw so the submission tab doesn't crash with AttributeError.
    # Use explicit None-check — `bool(df)` on a DataFrame is ambiguous.
    df_proc = st.session_state.get('df_processed')
    if df_proc is None:
        df_proc = st.session_state.get('df_raw')
    if df_proc is None:
        st.error("No dataset loaded. Go back to **Step 1 · Load Data**.")
        return
    profiles = st.session_state.profiles

    # ---- (Re)build the submission frame when forecasts change ----
    sig = _signature_of_results(results)
    if (st.session_state.get('submission_frame_sig') != sig
            or st.session_state.get('submission_frame') is None):
        with st.spinner("Preparing submission worksheet — joining history anchors…"):
            frame = build_submission_frame(results, df_proc, profiles, cfg)
            st.session_state.submission_frame = frame
            st.session_state.submission_frame_sig = sig
            st.session_state.submission_audit = []  # reset audit on fresh run

    frame: pd.DataFrame = st.session_state.submission_frame
    if frame is None or frame.empty:
        st.error("Submission frame is empty — no forecasts to review.")
        return

    # =================================================================
    # 1. FILTER BAR  — Category → Brand → Product → SKU + Segment
    # =================================================================
    with st.container():
        st.markdown("#### 🔎 Filters")
        f1, f2, f3, f4 = st.columns(4)

        # Cascading: each level's options come from the rows that pass earlier filters.
        # Start with the full frame and narrow.
        cur = frame.copy()

        has_category = 'category' in cur.columns and cur['category'].nunique() > 1
        has_brand = 'brand' in cur.columns and cur['brand'].nunique() > 1
        has_product = 'product_name' in cur.columns and cur['product_name'].nunique() > 1
        has_segment = 'segment' in cur.columns and cur['segment'].nunique() > 1

        with f1:
            if has_category:
                cats = sorted(cur['category'].dropna().unique().tolist())
                pick_cat = st.multiselect("Category", cats, default=[],
                                          placeholder="All categories",
                                          key='sub_filter_cat')
                if pick_cat:
                    cur = cur[cur['category'].isin(pick_cat)]
            else:
                st.markdown("&nbsp;", unsafe_allow_html=True)
        with f2:
            if has_brand:
                brands = sorted(cur['brand'].dropna().unique().tolist())
                pick_brand = st.multiselect("Brand", brands, default=[],
                                            placeholder="All brands",
                                            key='sub_filter_brand')
                if pick_brand:
                    cur = cur[cur['brand'].isin(pick_brand)]
            else:
                st.markdown("&nbsp;", unsafe_allow_html=True)
        with f3:
            if has_product:
                prods = sorted(cur['product_name'].dropna().unique().tolist())
                pick_prod = st.multiselect("Product", prods, default=[],
                                           placeholder="All products",
                                           key='sub_filter_prod')
                if pick_prod:
                    cur = cur[cur['product_name'].isin(pick_prod)]
            else:
                st.markdown("&nbsp;", unsafe_allow_html=True)
        with f4:
            if has_segment:
                segs = sorted(cur['segment'].dropna().unique().tolist())
                pick_seg = st.multiselect("Segment", segs, default=[],
                                          placeholder="All segments",
                                          key='sub_filter_seg')
                if pick_seg:
                    cur = cur[cur['segment'].isin(pick_seg)]
            else:
                st.markdown("&nbsp;", unsafe_allow_html=True)

        f5, f6, f7 = st.columns([2, 1.5, 1.5])
        with f5:
            sku_options = sorted(cur['sku'].unique().tolist())
            pick_sku = st.multiselect("SKU (drill to specific SKUs)", sku_options,
                                      default=[], placeholder="All SKUs in selection",
                                      key='sub_filter_sku')
            if pick_sku:
                cur = cur[cur['sku'].isin(pick_sku)]
        with f6:
            only_overrides = st.checkbox("Show overridden only", value=False,
                                         key='sub_filter_overrides',
                                         help="Rows where the planner has changed the value.")
            if only_overrides:
                cur = cur[cur['submitted_forecast'] != cur['model_forecast']]
        with f7:
            mape_threshold = st.number_input("Low-confidence (WMAPE >)",
                                             min_value=0.0, value=0.0, step=10.0,
                                             help="Filter SKUs whose backtest WMAPE "
                                                  "exceeds this %. 0 = no filter.",
                                             key='sub_filter_mape')
            if mape_threshold > 0:
                cur = cur[cur['mape'].fillna(0) > mape_threshold]

    st.caption(f"**{cur['sku'].nunique():,} SKU(s)** · "
               f"**{len(cur):,} month-rows** in current view "
               f"(out of {frame['sku'].nunique():,} SKUs · {len(frame):,} total rows).")

    if cur.empty:
        st.info("No rows match the current filter. Adjust filters to continue.")
        return

    # =================================================================
    # 2. KPI STRIP for the current filter
    # =================================================================
    units_model = float(cur['model_forecast'].sum())
    units_sub = float(cur['submitted_forecast'].sum())
    delta_units = units_sub - units_model
    delta_pct = (delta_units / units_model * 100) if units_model else 0.0
    n_overrides = int((cur['submitted_forecast'] != cur['model_forecast']).sum())
    n_skus_changed = int(cur.loc[cur['submitted_forecast'] != cur['model_forecast'],
                                 'sku'].nunique())
    mom_avg = cur['mom_pct'].replace([np.inf, -np.inf], np.nan).dropna().mean()
    yoy_avg = cur['yoy_pct'].replace([np.inf, -np.inf], np.nan).dropna().mean()

    k1, k2, k3, k4, k5 = st.columns(5)
    k1.metric("Model forecast units", f"{units_model:,.0f}")
    k2.metric("Submitted units", f"{units_sub:,.0f}",
              delta=f"{delta_pct:+.1f}%" if units_model else None)
    k3.metric("Avg MoM trend",
              f"{mom_avg:+.1f}%" if pd.notna(mom_avg) else "—",
              help="Average month-over-month change across visible rows.")
    k4.metric("Avg YoY trend",
              f"{yoy_avg:+.1f}%" if pd.notna(yoy_avg) else "—",
              help="Average vs last-year-same-month across visible rows.")
    k5.metric("Overrides",
              f"{n_overrides:,} cells",
              delta=f"{n_skus_changed} SKU(s)",
              delta_color="off")

    # =================================================================
    # 3. BULK ACTIONS on the current filter
    # =================================================================
    with st.expander("⚡ Bulk actions on the current filter", expanded=False):
        st.caption(
            "Apply a change to **all month-rows currently visible**. Useful for "
            "blanket adjustments (e.g. +10% across a category during Diwali, or "
            "reset a segment to model)."
        )
        b1, b2, b3, b4 = st.columns([2, 2, 2, 2])
        with b1:
            uplift_pct = st.number_input("Apply % uplift", value=0.0, step=5.0,
                                         help="Positive = increase, negative = decrease",
                                         key='sub_bulk_uplift')
            if st.button("➕ Apply uplift", key='btn_apply_uplift',
                         use_container_width=True):
                idx = cur.index
                frame.loc[idx, 'submitted_forecast'] = (
                    frame.loc[idx, 'submitted_forecast'] * (1 + uplift_pct / 100)
                ).round(1).clip(lower=0)
                st.session_state.submission_frame = _recompute_derived_columns(frame)
                st.rerun()
        with b2:
            if st.button("📅 Copy LY same month →",
                         help="Set submitted = last-year-same-month for visible rows.",
                         key='btn_copy_ly',
                         use_container_width=True):
                idx = cur.index
                ly = frame.loc[idx, 'last_year_same_month']
                # Fall back to model where LY is missing
                frame.loc[idx, 'submitted_forecast'] = np.where(
                    ly.notna(), ly.round(1), frame.loc[idx, 'submitted_forecast']
                )
                st.session_state.submission_frame = _recompute_derived_columns(frame)
                st.rerun()
        with b3:
            if st.button("↺ Reset to model",
                         help="Discard overrides on visible rows.",
                         key='btn_reset_model',
                         use_container_width=True):
                idx = cur.index
                frame.loc[idx, 'submitted_forecast'] = frame.loc[idx, 'model_forecast']
                frame.loc[idx, 'reason'] = REASON_OPTIONS[0]
                frame.loc[idx, 'notes'] = ''
                st.session_state.submission_frame = _recompute_derived_columns(frame)
                st.rerun()
        with b4:
            bulk_reason = st.selectbox("Bulk-set reason", REASON_OPTIONS,
                                       index=0, key='sub_bulk_reason')
            if st.button("✍️ Apply reason", key='btn_apply_reason',
                         use_container_width=True):
                idx = cur.index
                frame.loc[idx, 'reason'] = bulk_reason
                st.session_state.submission_frame = frame
                st.rerun()

    # =================================================================
    # 4. EDITABLE GRID
    # =================================================================
    st.markdown("#### ✏️ Edit forecast values")
    st.caption(
        "Click **Submitted** to edit a forecast month. Adjust → tab out → "
        "MoM/Δ-vs-model recompute on the next interaction. "
        "**Reason** is required when the value differs from the model."
    )

    # Pick a subset of columns to display — same data, friendlier order
    display_cols = ['sku', 'product_name', 'category', 'brand', 'segment',
                    'forecast_month', 'last_year_same_month', 'last_3mo_avg',
                    'model_forecast', 'submitted_forecast', 'delta_vs_model_pct',
                    'mom_pct', 'yoy_pct', 'reason', 'notes', 'mape', 'strategy']
    display_cols = [c for c in display_cols if c in cur.columns]
    view = cur[display_cols].copy()

    column_config = {
        'sku': st.column_config.TextColumn('SKU', disabled=True, width='small'),
        'product_name': st.column_config.TextColumn('Product', disabled=True),
        'category': st.column_config.TextColumn('Category', disabled=True, width='small'),
        'brand': st.column_config.TextColumn('Brand', disabled=True, width='small'),
        'segment': st.column_config.TextColumn('Segment', disabled=True, width='small'),
        'forecast_month': st.column_config.DateColumn('Month', disabled=True,
                                                      format='MMM YYYY'),
        'last_year_same_month': st.column_config.NumberColumn(
            'LY same mo.', disabled=True, format='%.0f',
            help='Same calendar month last year — your YoY anchor.'),
        'last_3mo_avg': st.column_config.NumberColumn(
            'Last 3mo avg', disabled=True, format='%.0f',
            help='Average of the last 3 historical months — your MoM anchor.'),
        'model_forecast': st.column_config.NumberColumn(
            'Model fcst', disabled=True, format='%.0f'),
        'submitted_forecast': st.column_config.NumberColumn(
            '✏️ Submitted', format='%.0f', min_value=0,
            help='EDIT THIS — your final forecast value for the month.'),
        'delta_vs_model_pct': st.column_config.NumberColumn(
            'Δ vs model', disabled=True, format='%.1f%%',
            help='How much your edit differs from the model forecast.'),
        'mom_pct': st.column_config.NumberColumn(
            'MoM Δ%', disabled=True, format='%.1f%%',
            help='Change vs the previous month in this submission '
                 '(or last-3-mo avg for the first month).'),
        'yoy_pct': st.column_config.NumberColumn(
            'YoY Δ%', disabled=True, format='%.1f%%',
            help='Change vs the same calendar month last year.'),
        'reason': st.column_config.SelectboxColumn(
            'Reason', options=REASON_OPTIONS, required=False,
            help='Pick a category that justifies the change.'),
        'notes': st.column_config.TextColumn(
            'Notes', help='Free-text justification (audit trail).'),
        'mape': st.column_config.NumberColumn('WMAPE %', disabled=True, format='%.1f'),
        'strategy': st.column_config.TextColumn('Model', disabled=True),
    }

    edited = st.data_editor(
        view,
        column_config={k: v for k, v in column_config.items() if k in view.columns},
        use_container_width=True,
        hide_index=True,
        num_rows='fixed',
        height=480,
        key=f'submission_editor_{sig}',
    )

    # Merge edits back into the master frame keyed by (sku, forecast_month)
    # Only the editable columns can change; everything else is ignored.
    EDITABLE = ['submitted_forecast', 'reason', 'notes']
    changed = False
    if not edited.equals(view):
        for col in EDITABLE:
            if col not in edited.columns:
                continue
            # Align by index — `view` is a slice of `frame`, so indices match.
            new_vals = edited[col].values
            old_vals = frame.loc[view.index, col].values
            if not np.array_equal(
                pd.Series(new_vals).fillna('').values,
                pd.Series(old_vals).fillna('').values,
            ):
                frame.loc[view.index, col] = new_vals
                changed = True
        if changed:
            st.session_state.submission_frame = _recompute_derived_columns(frame)

    # =================================================================
    # 5. SKU DRILL-DOWN — history + model + submitted overlay
    # =================================================================
    st.markdown("#### 📈 SKU drill-down")
    drill_sku = st.selectbox(
        "Inspect SKU (overlays your submitted forecast on history)",
        options=sorted(cur['sku'].unique().tolist()),
        key='sub_drill_sku',
    )
    if drill_sku:
        sku_hist_df = df_proc[df_proc[cfg['sku_col']] == drill_sku].sort_values(cfg['date_col'])
        sku_hist = sku_hist_df.set_index(cfg['date_col'])[cfg['sales_col']]
        sku_frame = frame[frame['sku'] == drill_sku].set_index('forecast_month')

        fig = go.Figure()
        # Show last 24 months of history for readability
        recent_hist = sku_hist.iloc[-24:]
        fig.add_trace(go.Scatter(
            x=recent_hist.index, y=recent_hist.values,
            mode='lines+markers', name='Actual (last 24 mo.)',
            line=dict(color=DHISHAAI_BLUE, width=2)))
        fig.add_trace(go.Scatter(
            x=sku_frame.index, y=sku_frame['model_forecast'],
            mode='lines+markers', name='Model forecast',
            line=dict(color='#94a3b8', dash='dash', width=2)))
        # Highlight submitted in orange/red when it differs from model
        overridden_mask = (sku_frame['submitted_forecast'] != sku_frame['model_forecast'])
        fig.add_trace(go.Scatter(
            x=sku_frame.index, y=sku_frame['submitted_forecast'],
            mode='lines+markers', name='✏️ Submitted forecast',
            line=dict(color=DHISHAAI_ORANGE, width=3),
            marker=dict(size=[12 if m else 7 for m in overridden_mask],
                        line=dict(width=[2 if m else 0 for m in overridden_mask],
                                  color='#7c2d12'))))
        # YoY anchors as faint dots
        if 'last_year_same_month' in sku_frame.columns:
            fig.add_trace(go.Scatter(
                x=sku_frame.index, y=sku_frame['last_year_same_month'],
                mode='markers', name='LY same month',
                marker=dict(color='#7c3aed', size=8, symbol='diamond-open')))
        fig.update_layout(
            title=f"{drill_sku} · history vs model vs submitted",
            xaxis_title='Date', yaxis_title=cfg['sales_col'], height=420,
            legend=dict(orientation='h', y=-0.15))
        st.plotly_chart(fig, use_container_width=True)

        # Compact summary card
        sku_sub_total = float(sku_frame['submitted_forecast'].sum())
        sku_mod_total = float(sku_frame['model_forecast'].sum())
        sku_n_changes = int(overridden_mask.sum())
        cdc1, cdc2, cdc3, cdc4 = st.columns(4)
        cdc1.metric("Submitted (next horizon)", f"{sku_sub_total:,.0f}")
        cdc2.metric("Model (next horizon)", f"{sku_mod_total:,.0f}",
                    delta=f"{(sku_sub_total - sku_mod_total) / sku_mod_total * 100:+.1f}%"
                          if sku_mod_total else None)
        cdc3.metric("Months overridden", f"{sku_n_changes}")
        sku_mape = sku_frame['mape'].dropna().iloc[0] if sku_frame['mape'].notna().any() else None
        cdc4.metric("Backtest WMAPE",
                    f"{sku_mape:.1f}%" if sku_mape is not None else "—")

    # =================================================================
    # 6. SUBMISSION + DOWNLOAD
    # =================================================================
    st.markdown("---")
    st.markdown("#### 📤 Submit final forecast")

    # Audit: how many overrides have a reason and how many don't
    overrides_mask = frame['submitted_forecast'] != frame['model_forecast']
    overrides_total = int(overrides_mask.sum())
    overrides_with_reason = (
        int((overrides_mask & (frame['reason'] != REASON_OPTIONS[0])).sum())
        if overrides_total else 0
    )
    overrides_missing_reason = overrides_total - overrides_with_reason

    cS1, cS2 = st.columns([2, 1])
    with cS1:
        submitter = st.text_input("Submitter name / planner ID",
                                  value=st.session_state.get('submitter_name', 'demo_planner'),
                                  key='submitter_name')
        submission_notes = st.text_area(
            "Submission notes (overall context for this plan cycle)",
            value=st.session_state.get('submission_notes', ''),
            key='submission_notes', height=80,
            placeholder='e.g. "Diwali plan v2 — adjusted Footwear up 10% based on regional sell-through, '
                        'flat across Apparel pending pricing decision."')
    with cS2:
        st.markdown(f"""
            <div style='background:#f8fafc;border-left:4px solid {DHISHAAI_BLUE};
                        border-radius:8px;padding:14px 16px;'>
                <div style='font-size:0.75rem;font-weight:700;letter-spacing:.06em;
                            text-transform:uppercase;color:#475569;'>Audit Summary</div>
                <div style='margin-top:6px;font-size:0.92rem;color:#1e293b;line-height:1.6;'>
                    <b>{overrides_total:,}</b> month-cells overridden<br>
                    <b style='color:#0f766e;'>{overrides_with_reason:,}</b> with a reason<br>
                    <b style='color:{"#b45309" if overrides_missing_reason else "#0f766e"};'>
                        {overrides_missing_reason:,}</b> missing a reason
                </div>
            </div>
        """, unsafe_allow_html=True)

    if overrides_missing_reason:
        st.warning(
            f"⚠️ {overrides_missing_reason:,} override(s) have no reason recorded. "
            "Adding a reason makes the plan auditable. You can still submit."
        )

    submit_cols = st.columns([1, 1, 2])
    with submit_cols[0]:
        if st.button("📤 Submit forecast", type='primary', use_container_width=True,
                     key='btn_submit_forecast'):
            audit_entry = {
                'submitted_at': datetime.now().isoformat(timespec='seconds'),
                'submitter': submitter,
                'n_skus': int(frame['sku'].nunique()),
                'n_rows': int(len(frame)),
                'n_overrides_cells': overrides_total,
                'n_overrides_with_reason': overrides_with_reason,
                'units_model': round(float(frame['model_forecast'].sum()), 1),
                'units_submitted': round(float(frame['submitted_forecast'].sum()), 1),
                'pct_change_vs_model': round(
                    (float(frame['submitted_forecast'].sum())
                     - float(frame['model_forecast'].sum()))
                    / max(float(frame['model_forecast'].sum()), 1) * 100, 2),
                'notes': submission_notes,
            }
            audit_list = st.session_state.get('submission_audit') or []
            audit_list.append(audit_entry)
            st.session_state.submission_audit = audit_list
            st.session_state.submitted_forecast_frame = frame.copy()
            st.success(
                f"✅ Forecast submitted by **{submitter}** at "
                f"{audit_entry['submitted_at']}. "
                f"{overrides_total:,} overrides applied "
                f"({audit_entry['pct_change_vs_model']:+.1f}% vs model)."
            )
    with submit_cols[1]:
        # Download the full submission as CSV — sources of truth for downstream systems
        csv_bytes = frame.to_csv(index=False).encode('utf-8')
        st.download_button(
            "📥 Download CSV", data=csv_bytes,
            file_name=f"forecast_submission_{datetime.now():%Y%m%d_%H%M%S}.csv",
            mime='text/csv', use_container_width=True,
            key='btn_download_submission')

    # Audit trail
    audit_list = st.session_state.get('submission_audit') or []
    if audit_list:
        with st.expander(f"📜 Submission audit trail ({len(audit_list)} entries)",
                         expanded=False):
            audit_df = pd.DataFrame(audit_list)
            st.dataframe(audit_df, use_container_width=True, hide_index=True)


# ---------------- TAB ENTRY POINTS ----------------

def render_performance_tab(cfg):
    """Step 5: four-level out-of-sample (forecast-horizon) performance dashboard."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 5 · Performance</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                Forecast Accuracy Diagnostics
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                WMAPE · SMAPE · bias — by SKU, segment, brand and strategy
            </div>
        </div>
    """, unsafe_allow_html=True)

    if not st.session_state.get('forecasts_run'):
        st.info(
            "Run **Step 4 — Forecast** first.\n\n"
            "The performance dashboard needs an out-of-sample hold-out per SKU "
            "to compute accuracy metrics."
        )
        return

    results: List[ForecastResult] = st.session_state.forecast_results
    profiles = st.session_state.profiles
    profiles_lookup = profiles.set_index('sku').to_dict('index')

    long_df = _build_residuals_long(results, profiles_lookup)
    if long_df.empty:
        st.warning(
            "No out-of-sample evaluation results available. Re-run from Tab 2 with "
            "'Evaluate out-of-sample accuracy over the forecast horizon' enabled."
        )
        return

    # Coverage denominator is the SET of SKUs we attempted, not the full portfolio
    attempted_skus = {r.sku for r in results}
    all_skus_df = profiles[profiles['sku'].isin(attempted_skus)][
        ['sku', 'brand', 'segment']
    ].copy()

    # Headline KPI strip (traffic-light)
    _render_kpi_strip(long_df, all_skus_df)
    st.markdown(
        "<div style='color:#64748b; font-size:0.9em; margin-top:8px;'>"
        "Drill in below — every level uses pooled metrics (∑|error| / ∑actual), "
        "weighted by held-out volume. Tables sortable; charts are read top-to-bottom."
        "</div>", unsafe_allow_html=True,
    )

    sub1, sub2, sub3, sub4 = st.tabs(["📊 Segment", "🏷 Brand", "🔥 Brand × Segment", "🔍 SKU"])

    with sub1:
        _render_perf_segment(long_df, all_skus_df)
    with sub2:
        _render_perf_brand(long_df, all_skus_df)
    with sub3:
        _render_perf_brand_segment(long_df, all_skus_df)
    with sub4:
        _render_perf_sku(long_df, results, profiles_lookup)


def _render_perf_segment(long_df: pd.DataFrame, all_skus_df: pd.DataFrame):
    """Segment-level: which kind of SKU is hardest to forecast?"""
    seg_perf = _aggregate_metrics(long_df, ['segment'], all_skus_df)
    if seg_perf.empty:
        st.info("No backtested data at segment level.")
        return

    st.markdown("#### Which segments are hardest to forecast?")
    st.caption(
        "Segments are how the business already groups its portfolio. "
        "If a segment's WMAPE is poor despite being routed to its 'best' "
        "strategy, the segment definition itself may need revisiting."
    )

    fig = _bar_chart_with_bands(seg_perf, 'segment',
                                 title='WMAPE by segment (sorted; worst at bottom)')
    if fig:
        st.plotly_chart(fig, use_container_width=True)

    st.markdown("---")
    col_left, col_right = st.columns([1.2, 1])

    with col_left:
        st.markdown("##### Bias × WMAPE per segment")
        st.caption("Bubble = held-out volume. Bottom row = no problem.")
        bias_fig = _bias_volume_scatter(seg_perf, 'segment',
                                         title='')
        if bias_fig:
            st.plotly_chart(bias_fig, use_container_width=True)

    with col_right:
        st.markdown("##### Detail")
        display = (seg_perf[['segment', 'weighted_mape', 'bias_pct',
                             'n_skus_backtested', 'sum_actual', 'coverage_pct']]
                    .sort_values('weighted_mape')
                    .round(1))
        st.dataframe(_format_perf_table(display),
                     use_container_width=True, height=380, hide_index=True)


def _render_perf_brand(long_df: pd.DataFrame, all_skus_df: pd.DataFrame):
    """Brand-level: which brand needs the most attention?"""
    brand_perf = _aggregate_metrics(long_df, ['brand'], all_skus_df)
    if brand_perf.empty:
        st.info("No backtested data at brand level.")
        return

    st.markdown("#### How is each brand performing?")
    st.caption(
        "Pooled WMAPE — i.e., does the brand-total forecast match the brand-total "
        "actual? This is the right metric for planning, not the average of "
        "per-SKU WMAPEs."
    )

    fig = _bar_chart_with_bands(brand_perf, 'brand',
                                 title='WMAPE by brand (sorted; worst at bottom)',
                                 height=420)
    if fig:
        st.plotly_chart(fig, use_container_width=True)

    st.markdown("---")
    st.markdown("#### Drill into a brand")
    selected_brand = st.selectbox(
        "Brand", sorted(long_df['brand'].unique()),
        label_visibility='collapsed',
    )

    brand_long = long_df[long_df['brand'] == selected_brand]
    by_date = (brand_long.groupby('date')
               .agg(actual=('actual', 'sum'), pred=('pred', 'sum'))
               .reset_index().sort_values('date'))

    # Per-brand KPIs on a single row
    brand_row = brand_perf[brand_perf['brand'] == selected_brand].iloc[0]
    band_label, band_color = _mape_band(brand_row['weighted_mape'])
    k1, k2, k3, k4 = st.columns(4)
    k1.metric("WMAPE", f"{brand_row['weighted_mape']:.1f}%",
              delta=band_label.upper(), delta_color='off')
    k2.metric("Bias", f"{brand_row['bias_pct']:+.1f}%")
    k3.metric("SKUs evaluated", int(brand_row['n_skus_backtested']))
    k4.metric("Held-out volume", f"{brand_row['sum_actual']:,.0f}")

    # Aggregated time-series — actual vs forecast bars side-by-side
    fig2 = go.Figure()
    fig2.add_trace(go.Bar(x=by_date['date'], y=by_date['actual'],
                          name='Actual', marker_color=DHISHAAI_BLUE))
    fig2.add_trace(go.Bar(x=by_date['date'], y=by_date['pred'],
                          name='Backtest forecast',
                          marker_color=DHISHAAI_ORANGE, opacity=0.85))
    fig2.update_layout(
        title=f"{selected_brand} — held-out actual vs backtest forecast",
        barmode='group', height=320, plot_bgcolor='white',
        xaxis_title='', yaxis_title='Units',
        legend=dict(orientation='h', y=1.1),
    )
    st.plotly_chart(fig2, use_container_width=True)

    # Within-brand segment breakdown
    bs = _aggregate_metrics(
        brand_long, ['segment'],
        all_skus_df[all_skus_df['brand'] == selected_brand],
    )
    if not bs.empty:
        st.markdown(f"##### Segment breakdown within {selected_brand}")
        bs_display = (bs[['segment', 'weighted_mape', 'bias_pct',
                          'n_skus_backtested', 'sum_actual', 'coverage_pct']]
                       .sort_values('weighted_mape').round(1))
        st.dataframe(_format_perf_table(bs_display),
                     use_container_width=True, hide_index=True)


def _render_perf_brand_segment(long_df: pd.DataFrame, all_skus_df: pd.DataFrame):
    """Brand × Segment heatmap — the most spatial view of where pain lives."""
    bs_perf = _aggregate_metrics(long_df, ['brand', 'segment'], all_skus_df)
    if bs_perf.empty:
        st.info("No backtested data at brand × segment level.")
        return

    st.markdown("#### Where is the pain — which brand AND which segment?")
    st.caption(
        "Each cell pools all SKUs in that brand-segment combo. "
        "Hot cells (red) tell you the routing rules may be wrong for that "
        "specific combination — different from saying 'TITAN is bad' "
        "or 'Volatile Low is bad' in isolation."
    )

    pivot_mape = bs_perf.pivot(index='brand', columns='segment', values='weighted_mape')
    pivot_n = bs_perf.pivot(index='brand', columns='segment', values='n_skus_backtested')
    pivot_vol = bs_perf.pivot(index='brand', columns='segment', values='sum_actual')

    # Sort brands by held-out volume (biggest brand at top — biggest impact)
    brand_order = (bs_perf.groupby('brand')['sum_actual'].sum()
                    .sort_values(ascending=False).index.tolist())
    pivot_mape = pivot_mape.reindex(brand_order)
    pivot_n = pivot_n.reindex(brand_order)
    pivot_vol = pivot_vol.reindex(brand_order)

    # Annotations: "WMAPE%\n(n=X)" — small font, light color for n
    annotations = []
    for i, brand in enumerate(pivot_mape.index):
        for j, seg in enumerate(pivot_mape.columns):
            val = pivot_mape.iloc[i, j]
            n = pivot_n.iloc[i, j]
            if pd.notna(val) and pd.notna(n):
                # Pick text color for contrast on dark cells
                text_color = 'white' if val > 60 else '#1e293b'
                annotations.append(dict(
                    x=seg, y=brand,
                    text=(f"<b>{val:.0f}%</b><br>"
                          f"<span style='font-size:9px;opacity:0.85'>n={int(n)}</span>"),
                    showarrow=False,
                    font=dict(size=11, color=text_color),
                ))

    # Custom colorscale with the three traffic-light bands
    fig = px.imshow(
        pivot_mape,
        color_continuous_scale=[
            [0.0, COLOR_GOOD],
            [WMAPE_GOOD / 100, COLOR_GOOD],
            [WMAPE_GOOD / 100 + 0.001, COLOR_REVIEW],
            [WMAPE_POOR / 100, COLOR_REVIEW],
            [WMAPE_POOR / 100 + 0.001, COLOR_POOR],
            [1.0, COLOR_POOR],
        ],
        zmin=0, zmax=100,
        aspect='auto',
        labels=dict(color='WMAPE %'),
    )
    fig.update_layout(
        annotations=annotations,
        height=max(420, 60 * len(pivot_mape.index) + 100),
        xaxis_title='Segment', yaxis_title='Brand (sorted by volume)',
        plot_bgcolor='white',
        margin=dict(l=10, r=10, t=20, b=40),
    )
    fig.update_xaxes(side='top', tickangle=-30)
    st.plotly_chart(fig, use_container_width=True)

    # Companion: top-N worst cells with full context
    st.markdown("---")
    st.markdown("##### Worst brand × segment combinations")
    st.caption(
        "Sorted by error contribution (volume × WMAPE) — these are the "
        "combinations whose forecast quality moves the needle most."
    )
    bs_perf['error_contribution'] = (
        bs_perf['sum_actual'] * bs_perf['weighted_mape'].fillna(0) / 100
    )
    worst = (bs_perf.dropna(subset=['weighted_mape'])
              .sort_values('error_contribution', ascending=False)
              .head(10)
              [['brand', 'segment', 'weighted_mape', 'bias_pct',
                'n_skus_backtested', 'sum_actual', 'error_contribution']]
              .round(1))
    worst.columns = ['Brand', 'Segment', 'WMAPE %', 'Bias %',
                      'SKUs', 'Volume', 'Error contribution']
    st.dataframe(worst, use_container_width=True, hide_index=True)


def _render_perf_sku(long_df: pd.DataFrame, results: List[ForecastResult],
                     profiles_lookup: dict):
    """SKU-level: which specific SKUs hurt most?"""

    # Build per-SKU metrics frame
    rows = []
    for r in results:
        if r.backtest_actual is None:
            continue
        prof = profiles_lookup.get(r.sku, {})
        rows.append({
            'sku': r.sku,
            'brand': prof.get('brand', '—'),
            'segment': prof.get('segment', '—'),
            'mape': r.backtest_mape,
            'smape': r.backtest_smape,
            'bias_pct': r.backtest_bias_pct,
            'sum_actual': float(r.backtest_actual.sum()),
        })
    sku_df = pd.DataFrame(rows)
    if sku_df.empty:
        st.info("No SKU-level backtest data available.")
        return

    sku_df['error_contribution'] = (
        sku_df['sum_actual'] * sku_df['mape'].fillna(sku_df['smape']).fillna(0) / 100
    )

    # SKU portfolio overview metrics
    n_total = len(sku_df)
    n_good = (sku_df['mape'] < WMAPE_GOOD).sum()
    n_review = ((sku_df['mape'] >= WMAPE_GOOD) & (sku_df['mape'] < WMAPE_POOR)).sum()
    n_poor = (sku_df['mape'] >= WMAPE_POOR).sum()
    vol_good = sku_df.loc[sku_df['mape'] < WMAPE_GOOD, 'sum_actual'].sum()
    vol_total = sku_df['sum_actual'].sum()
    pct_vol_good = vol_good / vol_total * 100 if vol_total > 0 else 0

    st.markdown("#### Forecast quality by SKU")
    st.caption(
        "Two views — the scatter shows you where SKUs sit (low-volume bad-forecast "
        "is rarely worth fixing); the table ranks by *error contribution* "
        "(volume × WMAPE) so the top of the list is the place to start work."
    )

    # SKU portfolio split — three colored boxes
    p1, p2, p3, p4 = st.columns(4)
    p1.markdown(
        f"""<div style='padding:14px; background:{COLOR_GOOD}1A;
            border-radius:6px; border-left:4px solid {COLOR_GOOD};'>
            <div style='font-size:0.8em; color:#64748b;'>GOOD (&lt;20%)</div>
            <div style='font-size:1.6em; font-weight:700; color:{COLOR_GOOD};'>{n_good}</div>
            <div style='font-size:0.8em; color:#64748b;'>{n_good/n_total*100:.0f}% of SKUs</div>
        </div>""", unsafe_allow_html=True)
    p2.markdown(
        f"""<div style='padding:14px; background:{COLOR_REVIEW}1A;
            border-radius:6px; border-left:4px solid {COLOR_REVIEW};'>
            <div style='font-size:0.8em; color:#64748b;'>REVIEW (20–50%)</div>
            <div style='font-size:1.6em; font-weight:700; color:{COLOR_REVIEW};'>{n_review}</div>
            <div style='font-size:0.8em; color:#64748b;'>{n_review/n_total*100:.0f}% of SKUs</div>
        </div>""", unsafe_allow_html=True)
    p3.markdown(
        f"""<div style='padding:14px; background:{COLOR_POOR}1A;
            border-radius:6px; border-left:4px solid {COLOR_POOR};'>
            <div style='font-size:0.8em; color:#64748b;'>POOR (&gt;50%)</div>
            <div style='font-size:1.6em; font-weight:700; color:{COLOR_POOR};'>{n_poor}</div>
            <div style='font-size:0.8em; color:#64748b;'>{n_poor/n_total*100:.0f}% of SKUs</div>
        </div>""", unsafe_allow_html=True)
    p4.markdown(
        f"""<div style='padding:14px; background:#f1f5f9;
            border-radius:6px; border-left:4px solid {DHISHAAI_BLUE};'>
            <div style='font-size:0.8em; color:#64748b;'>VOLUME IN GOOD BAND</div>
            <div style='font-size:1.6em; font-weight:700; color:{DHISHAAI_BLUE};'>{pct_vol_good:.0f}%</div>
            <div style='font-size:0.8em; color:#64748b;'>of held-out volume</div>
        </div>""", unsafe_allow_html=True)

    # Volume vs WMAPE scatter
    st.markdown(" ")
    sku_df_plot = sku_df.dropna(subset=['mape']).copy()
    if not sku_df_plot.empty:
        sku_df_plot['mape_capped'] = sku_df_plot['mape'].clip(upper=200)
        sku_df_plot['band_color'] = sku_df_plot['mape'].apply(lambda v: _mape_band(v)[1])

        fig = go.Figure()
        # Three traces (one per band) for a clean legend
        for band_label, lo, hi, color in [
            ('Good (<20%)', 0, WMAPE_GOOD, COLOR_GOOD),
            ('Review (20–50%)', WMAPE_GOOD, WMAPE_POOR, COLOR_REVIEW),
            ('Poor (>50%)', WMAPE_POOR, 1e9, COLOR_POOR),
        ]:
            sub = sku_df_plot[(sku_df_plot['mape'] >= lo) & (sku_df_plot['mape'] < hi)]
            if sub.empty:
                continue
            fig.add_trace(go.Scatter(
                x=sub['sum_actual'], y=sub['mape_capped'],
                mode='markers',
                marker=dict(
                    size=np.sqrt(sub['sum_actual'] + 1) * 1.5 + 6,
                    color=color, opacity=0.65,
                    line=dict(width=0.5, color='white'),
                ),
                name=band_label,
                customdata=sub[['sku', 'brand', 'segment', 'mape', 'bias_pct']].values,
                hovertemplate=(
                    "<b>%{customdata[0]}</b><br>"
                    "%{customdata[1]} · %{customdata[2]}<br>"
                    "WMAPE: %{customdata[3]:.1f}% · Bias: %{customdata[4]:+.1f}%<br>"
                    "Volume: %{x:,.0f}<extra></extra>"
                ),
            ))
        fig.add_hline(y=WMAPE_GOOD, line_dash='dot', line_color=COLOR_GOOD, opacity=0.5)
        fig.add_hline(y=WMAPE_POOR, line_dash='dot', line_color=COLOR_POOR, opacity=0.5)
        fig.update_layout(
            title='SKU portfolio — volume vs forecast quality',
            xaxis=dict(title='Held-out volume (log scale)', type='log'),
            yaxis=dict(title='WMAPE %  (capped at 200 for display)'),
            height=460, plot_bgcolor='white',
            legend=dict(orientation='h', y=-0.18),
        )
        st.plotly_chart(fig, use_container_width=True)

    # Worst-offenders table — ranked by error contribution
    st.markdown("##### Top 50 SKUs by error contribution (volume × WMAPE)")
    worst = (sku_df.dropna(subset=['mape'])
              .sort_values('error_contribution', ascending=False)
              .head(50)
              .round(2))
    display_cols = ['sku', 'brand', 'segment', 'sum_actual', 'mape', 'bias_pct',
                     'error_contribution']
    worst_display = worst[display_cols].copy()
    worst_display.columns = ['SKU', 'Brand', 'Segment', 'Volume',
                              'WMAPE %', 'Bias %', 'Error contribution']
    st.dataframe(worst_display, use_container_width=True, hide_index=True, height=380)

    # Per-SKU drill-down
    st.markdown("---")
    st.markdown("##### Inspect a specific SKU")
    selected_sku = st.selectbox(
        "SKU",
        sku_df.sort_values('error_contribution', ascending=False)['sku'].tolist(),
        label_visibility='collapsed',
        key='perf_sku_picker',
    )
    res = next((r for r in results if r.sku == selected_sku), None)
    if res and res.backtest_actual is not None:
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("WMAPE",
                  f"{res.backtest_mape:.1f}%" if res.backtest_mape is not None else "—")
        m2.metric("SMAPE",
                  f"{res.backtest_smape:.1f}%" if res.backtest_smape is not None else "—")
        m3.metric("Bias",
                  f"{res.backtest_bias_pct:+.1f}%" if res.backtest_bias_pct is not None else "—")
        m4.metric("Strategy", res.strategy_used)

        fig = go.Figure()
        fig.add_trace(go.Scatter(
            x=res.backtest_actual.index, y=res.backtest_actual,
            mode='lines+markers', name='Actual (held-out)',
            line=dict(color=DHISHAAI_BLUE, width=2.5),
        ))
        fig.add_trace(go.Scatter(
            x=res.backtest_pred.index, y=res.backtest_pred,
            mode='lines+markers', name='Backtest forecast',
            line=dict(color=DHISHAAI_ORANGE, width=2.5, dash='dash'),
        ))
        fig.update_layout(
            title=f"{selected_sku} — held-out actual vs backtest forecast",
            height=340, plot_bgcolor='white',
            xaxis_title='', yaxis_title='Units',
            legend=dict(orientation='h', y=1.12),
        )
        st.plotly_chart(fig, use_container_width=True)

    # Export
    csv_buf = io.StringIO()
    sku_df.round(2).to_csv(csv_buf, index=False)
    c1, c2 = st.columns(2)
    with c1:
        st.download_button(
            "⬇ Download per-SKU performance (CSV)",
            csv_buf.getvalue(), 'sku_performance.csv', 'text/csv',
            use_container_width=True,
        )
    with c2:
        if st.button("Generate Performance HTML report", key='perf_html', use_container_width=True):
            try:
                results = st.session_state.get('forecast_results')
                profiles = st.session_state.get('profiles')
                if results is None or profiles is None:
                    st.warning("Run Forecast first.")
                else:
                    profiles_map = {p.sku: p for p in profiles} if isinstance(profiles, list) else profiles
                    html = build_routed_forecast_html_report(results, profiles_map, cfg)
                    st.session_state['_perf_html_buffer'] = html.encode('utf-8')
                    st.success("HTML report ready below.")
            except Exception as e:
                st.error(f"HTML report failed: {e}")
    if st.session_state.get('_perf_html_buffer') is not None:
        st.download_button(
            "⬇ Download Performance HTML",
            data=st.session_state['_perf_html_buffer'],
            file_name=f"dhishaai_performance_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
            mime='text/html', use_container_width=True, key='perf_html_dl',
        )


def render_about():
    st.markdown("""
### How this engine routes each SKU

Forecasting 3,000+ SKUs well means **not** running the same model on all of them.
This engine profiles each SKU on two axes — **history length** and **intermittency
pattern (ADI / CV²)** — then routes it to the best-suited strategy.

| SKU profile | Strategy | Why |
|---|---|---|
| < 6 months history | **Chronos zero-shot** | Pretrained foundation model; no training data needed |
| 6–12 months OR Volatile Low | **Global LightGBM** | Borrows strength from similar SKUs via shared model |
| Intermittent / Lumpy (ADI ≥ 1.32) | **Croston-SBA** | Classical models forecast wrong baseline when many zeros |
| Stable High contributors | **SARIMAX + price/promo** | Enough data to fit local model with rich exog signal |
| Stable Mid / Volatile Mid·High | **Median ensemble** | Robust to model failure; combines HW + SARIMAX + global |
| Stable Low (the bulk) | **Global LightGBM** | One model trained on all data with brand/segment embeddings |

### Features that drive the forecasts
- **Lag/rolling**: lag_1, lag_3, lag_12, rolling 3 and 6 month means (per-SKU, leak-free)
- **Price**: log price, price-change flag, price-change %  ← *84% of rows have price changes; this is your highest-value signal*
- **Promo**: festive, other_imp_festivals, peak_month, scheme_days, weekends
- **Categoricals**: brand, segments, price_band — encoded natively by LightGBM

### Hierarchical reconciliation
Brand-level forecasts = sum of SKU forecasts. The proportional bottom-up method
ensures consistency without distorting individual SKU forecasts.

### What's intentionally not here
- **Google Trends**: brand names like "TITAN" / "SONATA" are too ambiguous for
  meaningful trends signal (rocket, movie, etc.)
- **Heavy deep learning (LSTM/Transformer)**: 40 months × 3000 SKUs doesn't have
  enough data per series for these to beat LightGBM + Chronos
- **Per-SKU AutoARIMA loops**: replaced by global model — 50× faster, similar accuracy
""")


# =================================================================
# =================================================================
# MERGED FEATURES FROM app_96.py
# Single-series EDA + multi-model competition engine, causal analysis,
# what-if scenarios, PDF reporting. These coexist with the SKU-aware
# routing engine above — they are exposed via additional tabs in main().
# =================================================================
# =================================================================

# -----------------------------------------------------------------
# A1.  MySQL data loader (optional)
# -----------------------------------------------------------------
@st.cache_data(ttl=600, show_spinner=False)
def load_data_from_mysql(host, user, password, db, query):
    """Connects to MySQL and executes a query to load data into a DataFrame."""
    if create_engine is None or quote_plus is None:
        st.error("SQLAlchemy/pymysql not installed. Run: pip install SQLAlchemy pymysql")
        return None
    if not query or not query.strip():
        st.warning("Query is empty. Skipping database load.")
        return None
    try:
        connection_str = f"mysql+pymysql://{user}:{quote_plus(password)}@{host}/{db}"
        engine = create_engine(connection_str)
        return pd.read_sql(query, engine)
    except Exception as e:
        st.error(f"Failed to connect to the database or execute query: {e}")
        return None


# -----------------------------------------------------------------
# A1b. RETAIL SEGMENTATION — Volatility × Contribution (6-class matrix)
#      Reproduces MP-Till Apr 25 taxonomy:
#        Stable High / Stable Mid / Stable Low contributors
#        Volatile High / Volatile Mid / Volatile Low contributors
#      Volatility    ← Coefficient of Variation (std/mean) of monthly sales
#      Contribution  ← Pareto ABC on cumulative revenue share
# -----------------------------------------------------------------
def compute_retail_segmentation(
    df: pd.DataFrame,
    sku_col: str,
    sales_col: str,
    date_col: str,
    revenue_col: Optional[str] = None,
    cv_threshold: float = 1.15,
    high_cum_share: float = 0.40,
    mid_cum_share: float = 0.85,
    min_periods: int = 3,
    new_product_months: int = 3,
    churn_months: int = 3,
    short_history_months: int = 6,
    date_format: Optional[str] = None,
) -> pd.DataFrame:
    """Compute the 2-D retail segmentation matrix per SKU.

    Parameters
    ----------
    df : DataFrame in long format (one row per SKU per period).
    sku_col, sales_col, date_col : column names.
    revenue_col : optional. If provided, contribution is computed on revenue;
                  otherwise on sales × price proxy (mean sales × n_periods).
    cv_threshold : retained for the audit record / display only. Volatility is
                   now DERIVED from the SBC demand pattern (smooth ⇒ Stable;
                   erratic/intermittent/lumpy ⇒ Volatile; dead ⇒ CV NULL/0), so
                   segment and pattern are one consistent classification and
                   this threshold no longer changes any label.
    high_cum_share : SKUs whose cumulative revenue share reaches this fraction
                     (ranked by descending revenue) are tagged 'High'.
    mid_cum_share : SKUs reaching this fraction are 'Mid'; the rest are 'Low'.
    min_periods : SKUs with fewer than this many observations are tagged
                  'CV NULL/0' (insufficient data).

    Returns
    -------
    DataFrame indexed by sku_col with columns:
        n_periods, mean_sales, std_sales, cv, total_revenue, rev_share_pct,
        cum_rev_share, volatility, contribution, segment
    """
    work = df.copy()
    # Coerce sales numeric and dates to datetime so we can compute lifecycle
    # windows (first observation, last observation) per SKU. Honour the
    # caller-supplied date_format (or fall back to smart-detect) so ambiguous
    # strings like '01/02/22' aren't silently parsed as Jan 2 (MM/DD/YY US
    # default) when the data is really 1-Feb (DD/MM/YY).
    work[sales_col] = pd.to_numeric(work[sales_col], errors='coerce')
    _fmt = date_format or _smart_detect_date_format(work[date_col])
    if _fmt:
        work[date_col] = pd.to_datetime(work[date_col], format=_fmt, errors='coerce')
    else:
        work[date_col] = pd.to_datetime(work[date_col], errors='coerce')

    # Per-SKU aggregates — include first/last sale dates for lifecycle.
    agg = {
        'n_periods': (sales_col, 'count'),
        'mean_sales': (sales_col, 'mean'),
        'std_sales': (sales_col, 'std'),
        'first_date': (date_col, 'min'),
        'last_date': (date_col, 'max'),
    }
    if revenue_col is not None and revenue_col in work.columns:
        work[revenue_col] = pd.to_numeric(work[revenue_col], errors='coerce')
        agg['total_revenue'] = (revenue_col, 'sum')
    grouped = work.groupby(sku_col).agg(**agg).reset_index()

    # Dataset anchor — used to test "is this SKU new / churned relative to
    # the end of the loaded window?". Using max(last_date) instead of
    # pd.Timestamp.today() so back-dated demo datasets still classify
    # correctly without depending on wall-clock time.
    dataset_max_date = pd.to_datetime(work[date_col].max())
    new_cutoff = dataset_max_date - pd.DateOffset(months=int(new_product_months))
    churn_cutoff = dataset_max_date - pd.DateOffset(months=int(churn_months))

    # If no revenue column, approximate contribution from sales volume
    if 'total_revenue' not in grouped.columns:
        grouped['total_revenue'] = grouped['mean_sales'] * grouped['n_periods']

    # Volatility — CV
    grouped['cv'] = grouped['std_sales'] / grouped['mean_sales']

    # ── Intermittency (SBC) — computed in the SAME pass ──────────────────
    # Segment (volatility×contribution) and demand-pattern (smooth/erratic/
    # intermittent/lumpy) are two views of one per-SKU classification. We
    # compute both here so the downstream Profile & Route step can REUSE
    # these stats (see profile_all_skus' `_seg_stats` reuse path) instead of
    # re-grouping the whole panel a second time. ADI = mean inter-demand
    # interval; CV² = squared CV of the non-zero demand stream. Boundaries
    # 1.32 / 0.49 are the standard Syntetos-Boylan-Croston cutoffs.
    nz = work.loc[work[sales_col].fillna(0) != 0]
    nz_grp = nz.groupby(sku_col)[sales_col]
    nz_count = nz_grp.size().reindex(grouped[sku_col]).fillna(0).values.astype(float)
    nz_mean = nz_grp.mean().reindex(grouped[sku_col]).values.astype(float)
    nz_std = nz_grp.std().reindex(grouped[sku_col]).fillna(0.0).values.astype(float)
    # ADI numerator = total observed rows per SKU (NOT n_periods, which is the
    # non-null COUNT). profile_all_skus uses the group size, so matching it here
    # guarantees the reused intermittency is identical to a from-scratch pass.
    n_obs = (work.groupby(sku_col).size()
             .reindex(grouped[sku_col]).fillna(0).values.astype(float))
    with np.errstate(divide='ignore', invalid='ignore'):
        adi_arr = np.where(nz_count > 0, n_obs / np.where(nz_count > 0, nz_count, 1), np.inf)
        cv2_arr = np.where(nz_count > 1, (nz_std / nz_mean) ** 2, 0.0)
        cv2_arr = np.nan_to_num(cv2_arr, nan=0.0, posinf=0.0, neginf=0.0)
    int_arr = np.full(len(grouped), 'lumpy', dtype=object)
    dead_m = nz_count == 0
    int_arr[(adi_arr < 1.32) & (cv2_arr < 0.49) & ~dead_m] = 'smooth'
    int_arr[(adi_arr >= 1.32) & (cv2_arr < 0.49) & ~dead_m] = 'intermittent'
    int_arr[(adi_arr < 1.32) & (cv2_arr >= 0.49) & ~dead_m] = 'erratic'
    int_arr[dead_m] = 'dead'
    grouped['adi'] = adi_arr
    grouped['cv2'] = cv2_arr
    grouped['intermittency'] = int_arr

    # Volatility is DERIVED from the demand pattern, not from a separate CV
    # cut-off. This is the single-source-of-truth rule that removes the old
    # contradiction where a SKU could read "Stable" (overall CV ≤ threshold)
    # yet "erratic" (CV² of non-zero demand ≥ 0.49) at the same time. Now:
    #   smooth                         → Stable
    #   erratic / intermittent / lumpy → Volatile
    #   dead / insufficient history    → CV NULL/0 (triage)
    # So Stable ⇔ smooth by construction — segment and pattern can never
    # disagree. `cv` / `cv_threshold` are retained for display + the audit
    # record only; they no longer drive the label.
    def _volatility_label(row):
        if (row['n_periods'] < min_periods or pd.isna(row['cv'])
                or row['mean_sales'] == 0 or row['intermittency'] == 'dead'):
            return 'CV NULL/0'
        return 'Stable' if row['intermittency'] == 'smooth' else 'Volatile'

    grouped['volatility'] = grouped.apply(_volatility_label, axis=1)

    # Contribution — Pareto ABC on cumulative revenue share
    total_rev = grouped['total_revenue'].sum()
    if total_rev > 0:
        grouped['rev_share_pct'] = 100 * grouped['total_revenue'] / total_rev
    else:
        grouped['rev_share_pct'] = 0.0

    grouped = grouped.sort_values('total_revenue', ascending=False).reset_index(drop=True)
    grouped['cum_rev_share'] = grouped['rev_share_pct'].cumsum() / 100.0

    def _contribution_label(cum):
        if cum <= high_cum_share:
            return 'High'
        if cum <= mid_cum_share:
            return 'Mid'
        return 'Low'

    grouped['contribution'] = grouped['cum_rev_share'].apply(_contribution_label)

    # Lifecycle classification — applied BEFORE the volatility/contribution
    # label so a SKU that hasn't sold in the last `churn_months` is tagged
    # 'Churned product' regardless of how it performed historically. Priority
    # (highest first): Churned > New > Short history > standard segment.
    def _lifecycle_label(row):
        last_dt = row.get('last_date')
        first_dt = row.get('first_date')
        if pd.notna(last_dt) and last_dt < churn_cutoff:
            return 'Churned product'
        if pd.notna(first_dt) and first_dt >= new_cutoff:
            return 'New product'
        if row['n_periods'] < short_history_months:
            return 'Short history'
        return None

    grouped['lifecycle'] = grouped.apply(_lifecycle_label, axis=1)

    # Final segment label — exactly matches MP-Till Apr 25 wording
    def _segment_label(row):
        # Lifecycle wins when present — these SKUs need a different playbook
        # than the standard volatility×contribution matrix.
        if row.get('lifecycle'):
            return row['lifecycle']
        if row['volatility'] == 'CV NULL/0':
            return 'CV NULL/0'
        # Lowercase "stable" matches source spelling for stable rows
        # Canonical labels — Title-Case volatility + lowercase 'contributors'
        vol = 'Stable' if row['volatility'] == 'Stable' else 'Volatile'
        if row['contribution'] == 'High':
            tail = 'High contributors'
        elif row['contribution'] == 'Mid':
            tail = 'Mid contributors'
        else:
            tail = 'Low contributors'
        return f"{vol} {tail}"

    grouped['segment'] = grouped.apply(_segment_label, axis=1)

    return grouped


# Retail-context recommendation for each segment (used in HTML report + UI)
SEGMENT_PLAYBOOK = {
    'Stable High contributors': {
        'color': '#10b981', 'icon': 'star',
        'priority': 'Critical',
        'strategy': 'Hero SKUs — invest in forecast accuracy, OOS = revenue loss.',
        'forecast': 'Prophet (Bayesian trend+events) · Global LGBM (cross-learning) · XGB residual @ 10%.',
        'safety_stock': 'Tight target — 1.65σ (95% service level).',
    },
    'Stable Mid contributors': {
        'color': '#3b82f6', 'icon': 'briefcase',
        'priority': 'High',
        'strategy': 'Steady earners — automate replenishment, monitor for trend shifts.',
        'forecast': 'Global LGBM (pooled seasonality from 3K SKUs) · Prophet/Theta blend · XGB residual.',
        'safety_stock': 'Standard — 1.28σ (90% service level).',
    },
    'Stable Low contributors': {
        'color': '#94a3b8', 'icon': 'archive',
        'priority': 'Medium',
        'strategy': 'Tail SKUs — minimise carrying cost, group-level forecasts.',
        'forecast': 'Global LightGBM (cross-SKU pooled) — avoids overfitting per SKU.',
        'safety_stock': 'Lean — 1.04σ (85% service level) or move to make-to-order.',
    },
    'Volatile High contributors': {
        'color': '#dc2626', 'icon': 'flame',
        'priority': 'Critical',
        'strategy': 'High-stakes volatility — quantile forecasts + scenario buffers.',
        'forecast': 'Prophet (event-aware trend) · Global LGBM · Croston/SBA · XGB residual.',
        'safety_stock': 'Aggressive — 2.05σ (98% service level) due to spike risk.',
    },
    'Volatile Mid contributors': {
        'color': '#f59e0b', 'icon': 'zap',
        'priority': 'High',
        'strategy': 'Promo/seasonal sensitive — exogenous features critical.',
        'forecast': 'Global LGBM (price elasticity) · Prophet (events) · XGB residual (–35% WMAPE expected).',
        'safety_stock': 'Elevated — 1.65σ (95% service level).',
    },
    'Volatile Low contributors': {
        'color': '#fb7185', 'icon': 'shuffle',
        'priority': 'Low',
        'strategy': 'Intermittent tail — Croston / TSB family; consider rationalisation.',
        'forecast': 'Croston / SBA; aggregate to brand-level if SKU history too thin.',
        'safety_stock': 'Demand classification first (lumpy vs intermittent).',
    },
    'CV NULL/0': {
        'color': '#64748b', 'icon': 'help-circle',
        'priority': 'Triage',
        'strategy': 'Insufficient history — apply NPI proxy (similar SKU via DTW match).',
        'forecast': 'Cold-start: Chronos zero-shot or analogue product proxy.',
        'safety_stock': 'Reorder-on-demand until 3+ months of sales history.',
    },
    # ── Lifecycle segments (override volatility×contribution when active) ──
    'New product': {
        'color': '#8b5cf6', 'icon': 'sparkles',
        'priority': 'Launch',
        'strategy': 'NPI / recently introduced — sales pattern still forming. '
                    'Build forecast from analogue SKU(s) until 6+ months of own history.',
        'forecast': 'Chronos zero-shot OR DTW-matched analogue proxy with launch ramp.',
        'safety_stock': 'Conservative initial buffer; review weekly for the first quarter.',
    },
    'Churned product': {
        'color': '#475569', 'icon': 'archive',
        'priority': 'Phase-out',
        'strategy': 'No recent activity — likely de-listed / discontinued / out-of-stock. '
                    'Confirm status with merchandising before forecasting.',
        'forecast': 'Naive-zero baseline; exclude from automated replenishment.',
        'safety_stock': 'Run-down existing stock; no new procurement.',
    },
    'Short history': {
        'color': '#f97316', 'icon': 'clock',
        'priority': 'Borrow',
        'strategy': 'Limited history — pool with similar SKUs to stabilise the forecast.',
        'forecast': 'Global LightGBM (cross-SKU pooled) — borrows strength from peers.',
        'safety_stock': 'Standard lean buffer; tighten once 12+ months of history exist.',
    },
}


# -----------------------------------------------------------------
# A1b. Segment persistence layer  (SQLite — single file beside the app)
#      Audit-friendly: every saved label is tied to a parameterised run.
# -----------------------------------------------------------------
def _resolve_segment_db_path() -> Path:
    """Resolve the SKU-segmentation SQLite path from the TIMELENS_DB_PATH
    environment variable (default ``dhisha_segments.db``).

    - Unset/blank → ``dhisha_segments.db`` — identical to the previous hardcoded
      filename, so production behavior is unchanged.
    - A relative name resolves beside this module; an absolute path is used as-is.
    - For the demo environment, set ``TIMELENS_DB_PATH=dhisha_segments_demo.db``
      to isolate all segmentation reads/writes in a separate file.

    Resolved per-call so the variable can be set any time before the first
    segmentation read/write (e.g. before launching Streamlit or uvicorn).
    """
    raw = (os.environ.get("TIMELENS_DB_PATH") or "").strip() or "dhisha_segments.db"
    p = Path(raw)
    return p if p.is_absolute() else (Path(__file__).parent / p)


# Back-compat module attribute (default/import-time value). The live path is
# always re-resolved via _resolve_segment_db_path() at connection / existence
# checks, so this never goes stale relative to the env var.
SEGMENT_DB_PATH = _resolve_segment_db_path()


def _segment_db_connect() -> sqlite3.Connection:
    """Open (and create-if-needed) the segments DB. Idempotent. Path comes from
    TIMELENS_DB_PATH (see _resolve_segment_db_path)."""
    conn = sqlite3.connect(str(_resolve_segment_db_path()))
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS segmentation_runs (
            run_id TEXT PRIMARY KEY,
            run_at TEXT NOT NULL,
            cv_threshold REAL NOT NULL,
            high_cum_share REAL NOT NULL,
            mid_cum_share REAL NOT NULL,
            min_periods INTEGER NOT NULL,
            n_skus INTEGER NOT NULL,
            dataset_fingerprint TEXT,
            validated_by TEXT,
            notes TEXT
        );
        CREATE TABLE IF NOT EXISTS sku_segments (
            sku TEXT PRIMARY KEY,
            segment TEXT NOT NULL,
            volatility TEXT,
            contribution TEXT,
            cv REAL,
            mean_sales REAL,
            total_revenue REAL,
            n_periods INTEGER,
            rev_share_pct REAL,
            run_id TEXT NOT NULL,
            validated_at TEXT NOT NULL,
            FOREIGN KEY(run_id) REFERENCES segmentation_runs(run_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sku_segments_run ON sku_segments(run_id);
    """)
    conn.commit()
    return conn


def dataset_fingerprint(df: pd.DataFrame, sku_col: str, date_col: str,
                        sales_col: str) -> str:
    """Cheap content hash so we can tell whether the user is re-running on the
    same data or a refreshed extract. NOT cryptographic — just for audit."""
    h = hashlib.md5()
    h.update(f"{len(df)}|{df[sku_col].nunique()}".encode())
    try:
        dmin = pd.to_datetime(df[date_col], errors='coerce').min()
        dmax = pd.to_datetime(df[date_col], errors='coerce').max()
        h.update(f"{dmin}|{dmax}".encode())
    except Exception:
        pass
    try:
        h.update(f"{float(df[sales_col].sum()):.2f}".encode())
    except Exception:
        pass
    return h.hexdigest()[:12]


def save_validated_segments(
    seg_df: pd.DataFrame,
    sku_col: str,
    params: Dict[str, Any],
    dataset_fp: str,
    validated_by: str = "demo_user",
    notes: str = "",
) -> str:
    """Upsert validated SKU labels and a parent run record. Returns run_id."""
    run_id = f"run_{datetime.now():%Y%m%d_%H%M%S}_{dataset_fp}"
    now_iso = datetime.now().isoformat(timespec='seconds')
    conn = _segment_db_connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO segmentation_runs "
            "(run_id, run_at, cv_threshold, high_cum_share, mid_cum_share, "
            " min_periods, n_skus, dataset_fingerprint, validated_by, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_id, now_iso,
             float(params.get('cv_threshold', 1.15)),
             float(params.get('high_cum_share', 0.40)),
             float(params.get('mid_cum_share', 0.85)),
             int(params.get('min_periods', 3)),
             int(len(seg_df)), dataset_fp, validated_by, notes),
        )
        rows = []
        for _, r in seg_df.iterrows():
            rows.append((
                str(r[sku_col]), str(r['segment']),
                str(r.get('volatility', '')), str(r.get('contribution', '')),
                None if pd.isna(r.get('cv')) else float(r['cv']),
                float(r.get('mean_sales', 0) or 0),
                float(r.get('total_revenue', 0) or 0),
                int(r.get('n_periods', 0) or 0),
                float(r.get('rev_share_pct', 0) or 0),
                run_id, now_iso,
            ))
        conn.executemany(
            "INSERT OR REPLACE INTO sku_segments "
            "(sku, segment, volatility, contribution, cv, mean_sales, "
            " total_revenue, n_periods, rev_share_pct, run_id, validated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()
    return run_id


def load_existing_segments(sku_list: List[str]) -> pd.DataFrame:
    """Return the most-recently-validated segment record for each SKU in
    `sku_list`. Empty DataFrame if none. Joined with parent run for audit."""
    if not sku_list:
        return pd.DataFrame()
    if not _resolve_segment_db_path().exists():
        return pd.DataFrame()
    conn = _segment_db_connect()
    try:
        placeholders = ",".join(["?"] * len(sku_list))
        query = (
            "SELECT s.sku, s.segment, s.volatility, s.contribution, s.cv, "
            "       s.mean_sales, s.total_revenue, s.n_periods, s.rev_share_pct, "
            "       s.run_id, s.validated_at, "
            "       r.cv_threshold, r.high_cum_share, r.mid_cum_share, "
            "       r.min_periods, r.validated_by "
            "FROM sku_segments s LEFT JOIN segmentation_runs r ON s.run_id = r.run_id "
            f"WHERE s.sku IN ({placeholders})"
        )
        return pd.read_sql_query(query, conn, params=[str(s) for s in sku_list])
    finally:
        conn.close()


def list_segmentation_runs(limit: int = 10) -> pd.DataFrame:
    """Audit view: recent runs ordered newest first."""
    if not _resolve_segment_db_path().exists():
        return pd.DataFrame()
    conn = _segment_db_connect()
    try:
        return pd.read_sql_query(
            "SELECT run_id, run_at, n_skus, cv_threshold, high_cum_share, "
            "       mid_cum_share, min_periods, validated_by, notes, "
            "       dataset_fingerprint "
            "FROM segmentation_runs ORDER BY run_at DESC LIMIT ?",
            conn, params=[limit],
        )
    finally:
        conn.close()


def explain_sku_segment(seg_row: pd.Series, params: Dict[str, Any]) -> Dict[str, Any]:
    """Produce a step-by-step trace explaining *why* one SKU got its label.
    Used by the 'Trace this SKU' inspector in the UI."""
    hi = float(params.get('high_cum_share', 0.40))
    mid = float(params.get('mid_cum_share', 0.85))
    min_p = int(params.get('min_periods', 3))

    n_per = int(seg_row.get('n_periods', 0) or 0)
    mean_s = float(seg_row.get('mean_sales', 0) or 0)
    cv = seg_row.get('cv', None)
    cv_f = None if (cv is None or pd.isna(cv)) else float(cv)
    # std_sales isn't always persisted (DB-loaded rows omit it); recompute from CV×μ
    std_raw = seg_row.get('std_sales', None)
    if std_raw is None or pd.isna(std_raw) or float(std_raw) == 0:
        std_s = (cv_f * mean_s) if (cv_f is not None) else 0.0
    else:
        std_s = float(std_raw)
    rev = float(seg_row.get('total_revenue', 0) or 0)
    rev_pct = float(seg_row.get('rev_share_pct', 0) or 0)
    cum_share = float(seg_row.get('cum_rev_share', 0) or 0)

    steps = []

    # Step 1 — history sufficiency
    if n_per < min_p:
        steps.append({
            'step': 1, 'name': 'History check',
            'detail': f"Only {n_per} period(s) of sales — below the min-periods cut of {min_p}.",
            'verdict': 'FAIL → segment = "CV NULL/0" (insufficient history).',
            'outcome': 'CV NULL/0', 'stop': True,
        })
        return {'steps': steps, 'final': 'CV NULL/0'}
    steps.append({
        'step': 1, 'name': 'History check',
        'detail': f"{n_per} periods of sales ≥ minimum of {min_p}.",
        'verdict': 'PASS', 'outcome': None, 'stop': False,
    })

    # Step 2 — compute CV
    if mean_s == 0 or cv_f is None:
        steps.append({
            'step': 2, 'name': 'Coefficient of variation',
            'detail': f"Mean sales = {mean_s:.2f} → CV undefined.",
            'verdict': 'FAIL → segment = "CV NULL/0" (cannot measure volatility).',
            'outcome': 'CV NULL/0', 'stop': True,
        })
        return {'steps': steps, 'final': 'CV NULL/0'}
    steps.append({
        'step': 2, 'name': 'Coefficient of variation',
        'detail': (f"CV = σ / μ = {std_s:.2f} / {mean_s:.2f} = {cv_f:.3f} "
                   f"(descriptive only — no longer sets the label)."),
        'verdict': f"CV computed.", 'outcome': None, 'stop': False,
    })

    # Step 3 — demand pattern (SBC) → volatility.
    # Volatility is now DERIVED from the demand pattern (single source of
    # truth) so it can never contradict the pattern: smooth ⇒ Stable;
    # erratic / intermittent / lumpy ⇒ Volatile; dead ⇒ CV NULL/0.
    pat = str(seg_row.get('intermittency', '') or '').lower()
    adi_v = seg_row.get('adi', None)
    cv2_v = seg_row.get('cv2', None)
    adi_s = ('∞' if (adi_v is None or pd.isna(adi_v) or np.isinf(float(adi_v)))
             else f"{float(adi_v):.2f}")
    cv2_s = ('—' if (cv2_v is None or pd.isna(cv2_v)) else f"{float(cv2_v):.3f}")
    if pat == 'dead':
        steps.append({
            'step': 3, 'name': 'Demand pattern → volatility',
            'detail': f"No non-zero demand (ADI = ∞) ⇒ pattern = dead.",
            'verdict': 'Dead series → segment = "CV NULL/0".',
            'outcome': 'CV NULL/0', 'stop': True,
        })
        return {'steps': steps, 'final': 'CV NULL/0'}
    vol = 'Stable' if pat == 'smooth' else 'Volatile'
    steps.append({
        'step': 3, 'name': 'Demand pattern → volatility',
        'detail': f"ADI = {adi_s} (cut 1.32), CV² = {cv2_s} (cut 0.49) ⇒ pattern = **{pat or 'n/a'}**.",
        'verdict': f"smooth ⇒ Stable · erratic/intermittent/lumpy ⇒ Volatile  ⟹  Volatility = **{vol}**.",
        'outcome': None, 'stop': False,
    })

    # Step 4 — contribution / cumulative share
    steps.append({
        'step': 4, 'name': 'Revenue share',
        'detail': (f"This SKU contributes {rev_pct:.3f}% of total. "
                   f"Cumulative share (ranked) reaches {cum_share*100:.2f}%."),
        'verdict': "Pareto rank locked.", 'outcome': None, 'stop': False,
    })

    if cum_share <= hi:
        contrib = 'High'
        rule = f"cum-share {cum_share*100:.2f}% ≤ {hi*100:.0f}%"
    elif cum_share <= mid:
        contrib = 'Mid'
        rule = f"{hi*100:.0f}% < cum-share {cum_share*100:.2f}% ≤ {mid*100:.0f}%"
    else:
        contrib = 'Low'
        rule = f"cum-share {cum_share*100:.2f}% > {mid*100:.0f}%"

    steps.append({
        'step': 5, 'name': 'Contribution label',
        'detail': rule,
        'verdict': f"Contribution = **{contrib}**.", 'outcome': None, 'stop': False,
    })

    vol_word = 'Stable' if vol == 'Stable' else 'Volatile'
    final = f"{vol_word} {contrib} contributors"
    steps.append({
        'step': 6, 'name': 'Combine',
        'detail': f"{vol} (volatility) × {contrib} (contribution).",
        'verdict': f"Final segment = **{final}**.",
        'outcome': final, 'stop': True,
    })
    return {'steps': steps, 'final': final}


# -----------------------------------------------------------------
# A2.  TimeSeriesEDA class — single-series EDA with editable anomalies
# -----------------------------------------------------------------
class TimeSeriesEDA:
    """Comprehensive single-series EDA: anomaly detection, decomposition,
    ACF/PACF, holiday analysis, feature engineering."""

    def __init__(self, df: pd.DataFrame, date_col: str = 'date',
                 sales_col: str = 'sales', country_code: str = 'US',
                 contamination: float = 0.05, resample_freq: str = 'D',
                 date_format: str = None):
        if date_col not in df.columns or sales_col not in df.columns:
            raise ValueError(f"DataFrame must contain '{date_col}' and '{sales_col}' columns.")
        self.df = df.copy()
        self.date_col = date_col
        self.date_format = date_format
        self.sales_col = sales_col
        self.country_code = country_code
        self.contamination = contamination
        self.resample_freq = resample_freq
        self.df_prepared = self._prepare_dataframe_before_cleaning()
        self.potential_anomalies_df = self._detect_anomalies(self.df_prepared)
        self.corrected_anomalies = {}
        self.df_eda = self.df_prepared.copy()

    def _prepare_dataframe_before_cleaning(self) -> pd.DataFrame:
        df_prepared = self.df.copy()
        df_prepared[self.date_col] = pd.to_datetime(
            df_prepared[self.date_col],
            format=self.date_format,
            dayfirst=(self.date_format is None),
            errors="coerce",
        )
        df_prepared.dropna(subset=[self.date_col, self.sales_col], inplace=True)
        df_prepared = (
            df_prepared.groupby(self.date_col)[self.sales_col]
            .sum().reset_index()
        )
        df_prepared = df_prepared.set_index(self.date_col).sort_index()
        freq_map = {'M': 'MS', 'Q': 'QS', 'Y': 'YS'}
        effective_freq = freq_map.get(self.resample_freq, self.resample_freq)
        df_prepared = df_prepared.resample(effective_freq).sum().fillna(0)
        return df_prepared

    def _detect_anomalies(self, df: pd.DataFrame) -> pd.DataFrame:
        df_copy = df.copy()
        X = df_copy[[self.sales_col]]
        if len(X) < 2:
            return pd.DataFrame()
        model = IsolationForest(contamination=self.contamination, random_state=42)
        df_copy['anomaly_score'] = model.fit_predict(X)
        anomalies = df_copy[df_copy['anomaly_score'] == -1]

        country_holidays = set()
        if holidays is not None:
            try:
                country_holidays = set(
                    holidays.country_holidays(
                        self.country_code,
                        years=df_copy.index.year.unique(),
                    ).keys()
                )
            except Exception:
                country_holidays = set()

        rows = []
        for date, row in anomalies.iterrows():
            is_holiday = date.date() in country_holidays
            rows.append({
                'Date': date,
                'Value': row[self.sales_col],
                'Is Holiday': is_holiday,
                'Suggested Action': 'Keep' if is_holiday else 'Correct',
                'Correct Anomaly': not is_holiday,
            })
        return pd.DataFrame(rows)

    def apply_anomaly_corrections(self, edited_anomalies_df: pd.DataFrame):
        df_cleaned = self.df_prepared.copy()
        self.corrected_anomalies = {}
        if edited_anomalies_df is None or edited_anomalies_df.empty:
            self.df_eda = df_cleaned.drop(columns=['anomaly_score'], errors='ignore')
            return
        anomalies_to_correct = edited_anomalies_df[edited_anomalies_df['Correct Anomaly']]
        if anomalies_to_correct.empty:
            self.df_eda = df_cleaned.drop(columns=['anomaly_score'], errors='ignore')
            return
        rolling_mean = df_cleaned[self.sales_col].rolling(window=14, min_periods=1).mean()
        for _, row in anomalies_to_correct.iterrows():
            date = row['Date']
            original_value = row['Value']
            replacement_value = rolling_mean.loc[date] if date in rolling_mean.index else original_value
            self.corrected_anomalies[date] = {'original': original_value, 'replaced_with': replacement_value}
            df_cleaned.loc[date, self.sales_col] = replacement_value
        self.df_eda = df_cleaned.drop(columns=['anomaly_score'], errors='ignore')

    def display_data_summary_and_distribution(self):
        st.subheader("Data Quality & Summary")
        original_records = len(self.df)
        min_date = pd.to_datetime(self.df[self.date_col]).min()
        max_date = pd.to_datetime(self.df[self.date_col]).max()
        missing_values = self.df[self.sales_col].isnull().sum()
        summary_metrics = {
            "Total Records (Original)": f"{original_records}",
            "Min Date": min_date.strftime('%Y-%m-%d') if pd.notna(min_date) else '-',
            "Max Date": max_date.strftime('%Y-%m-%d') if pd.notna(max_date) else '-',
            "Missing Values": f"{missing_values}",
            "Resampling Frequency": f"{self.resample_freq}",
        }
        cols = st.columns(5)
        for i, (k, v) in enumerate(summary_metrics.items()):
            cols[i].metric(k, v)

        st.subheader("Target Variable Distribution")
        df_plot = self.df_eda.copy()
        df_plot['month'] = df_plot.index.month_name()
        fig = make_subplots(rows=2, cols=1, subplot_titles=("Overall Distribution", "Distribution by Month"))
        fig.add_trace(go.Histogram(x=df_plot[self.sales_col], name='Frequency'), row=1, col=1)
        fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[self.sales_col], name='Monthly'), row=2, col=1)
        fig.update_layout(height=600, showlegend=False, title_text=f'Distribution of {self.sales_col}')
        st.plotly_chart(fig, use_container_width=True)
        return fig, summary_metrics

    def plot_trend(self):
        # Smooth spline line with soft area fill — turns a bare line chart
        # into a polished story plot. Markers carry white strokes so each
        # observation stays legible against the fill.
        s = self.df_eda[self.sales_col]
        fig = go.Figure()
        fig.add_trace(go.Scatter(
            x=self.df_eda.index, y=s,
            mode='lines+markers',
            name=self.sales_col,
            line=dict(color=DHISHAAI_BLUE, width=2.4,
                      shape='spline', smoothing=0.5),
            marker=dict(size=6, color=DHISHAAI_BLUE,
                        line=dict(width=1.5, color='#ffffff')),
            fill='tozeroy', fillcolor='rgba(7, 62, 92, 0.08)',
            hovertemplate=f'<b>{self.sales_col}</b>: %{{y:,.0f}}<extra></extra>',
        ))
        # Light reference line at the mean — gives the eye an anchor.
        try:
            mean_v = float(s.dropna().mean())
            if np.isfinite(mean_v):
                fig.add_hline(
                    y=mean_v,
                    line=dict(color='#ef7602', width=1, dash='dot'),
                    annotation_text=f'mean {mean_v:,.0f}',
                    annotation_position='top right',
                    annotation_font=dict(size=10, color='#ef7602'),
                )
        except Exception:
            pass
        fig.update_layout(
            title=dict(
                text=(f"<span style='font-size:16px;font-weight:700;color:{DHISHAAI_BLUE};"
                      f"font-family:Inter, system-ui, sans-serif'>"
                      f"{self.sales_col} over time</span>"),
                x=0.02, xanchor='left', y=0.97, yanchor='top', pad=dict(b=8),
            ),
            template='plotly_white',
            plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
            height=380,
            margin=dict(l=20, r=20, t=60, b=50),
            hovermode='x unified',
            hoverlabel=dict(bgcolor='rgba(255,255,255,0.96)',
                            bordercolor='#e2e8f0',
                            font=dict(size=12, color='#1e293b')),
            font=dict(family='Inter, system-ui, sans-serif', color='#475569'),
            showlegend=False,
            xaxis=dict(showgrid=True, gridcolor='#f1f5f9', zeroline=False,
                       tickformat='%b %Y',
                       tickfont=dict(size=11, color='#64748b')),
            yaxis=dict(title=dict(text=self.sales_col,
                                   font=dict(size=12, color='#475569')),
                       showgrid=True, gridcolor='#f1f5f9',
                       zeroline=True, zerolinecolor='#e2e8f0',
                       tickformat=',.0f', rangemode='tozero',
                       tickfont=dict(size=11, color='#64748b')),
        )
        st.plotly_chart(fig, use_container_width=True,
                        config={'displaylogo': False, 'responsive': True})
        return fig

    def plot_decomposition(self):
        periods = {'D': 7, 'W': 4, 'M': 12, 'Q': 4, 'Y': 2}
        period = periods.get(self.resample_freq, 4)
        if len(self.df_eda) <= period * 2:
            st.warning("Not enough data for meaningful decomposition at the selected frequency.")
            return None
        try:
            decomposition = seasonal_decompose(self.df_eda[self.sales_col], model='additive', period=period)
            fig = make_subplots(rows=4, cols=1, shared_xaxes=True,
                                subplot_titles=("Observed", "Trend", "Seasonal", "Residuals"))
            fig.add_trace(go.Scatter(x=decomposition.observed.index, y=decomposition.observed, mode='lines', name='Observed'), row=1, col=1)
            fig.add_trace(go.Scatter(x=decomposition.trend.index, y=decomposition.trend, mode='lines', name='Trend'), row=2, col=1)
            fig.add_trace(go.Scatter(x=decomposition.seasonal.index, y=decomposition.seasonal, mode='lines', name='Seasonal'), row=3, col=1)
            fig.add_trace(go.Scatter(x=decomposition.resid.index, y=decomposition.resid, mode='markers', name='Residuals'), row=4, col=1)
            fig.update_layout(height=700, title_text='Time Series Decomposition', showlegend=False)
            st.plotly_chart(fig, use_container_width=True)
            return fig
        except Exception as e:
            st.warning(f"Decomposition failed: {e}")
            return None

    def plot_anomaly_detection(self):
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=self.df_eda.index, y=self.df_eda[self.sales_col],
                                 mode='lines', name=f'{self.sales_col} (Cleaned)'))
        if self.corrected_anomalies:
            dates = list(self.corrected_anomalies.keys())
            original_values = [v['original'] for v in self.corrected_anomalies.values()]
            fig.add_trace(go.Scatter(x=dates, y=original_values, mode='markers',
                                     name='Anomalies (Corrected)',
                                     marker=dict(color='red', symbol='x', size=10)))
        fig.update_layout(title='Anomaly Detection',
                          xaxis_title='Date', yaxis_title=self.sales_col)
        st.plotly_chart(fig, use_container_width=True)
        total_potential = len(self.potential_anomalies_df)
        corrected_count = len(self.corrected_anomalies)
        st.info(f"Identified **{total_potential}** potential anomalies; **{corrected_count}** were corrected.")
        return fig

    def plot_acf_pacf(self, lags: int = 20):
        try:
            series = self.df_eda[self.sales_col]
            if len(series) <= lags:
                st.warning(f"Not enough data for {lags}-lag ACF/PACF.")
                return None
            conf_level = 0.05
            acf_values, acf_confint = acf(series, nlags=lags, alpha=conf_level)
            pacf_values, pacf_confint = pacf(series, nlags=lags, alpha=conf_level)
            fig = make_subplots(rows=1, cols=2, subplot_titles=("ACF", "PACF"))
            fig.add_trace(go.Bar(x=np.arange(lags + 1), y=acf_values, name='ACF'), row=1, col=1)
            fig.add_trace(go.Bar(x=np.arange(lags + 1), y=pacf_values, name='PACF'), row=1, col=2)
            fig.update_layout(height=400, showlegend=False, title_text='ACF and PACF Plots')
            st.plotly_chart(fig, use_container_width=True)
            return fig
        except Exception as e:
            st.warning(f"Could not generate ACF/PACF: {e}")
            return None

    def analyze_holidays(self):
        if holidays is None:
            st.warning("'holidays' library not installed. Skipping.")
            return None
        years = self.df_eda.index.year.unique()
        try:
            country_holidays_dict = holidays.country_holidays(self.country_code, years=years)
        except Exception:
            country_holidays_dict = {}
        if not country_holidays_dict:
            st.info(f"No holidays found for country '{self.country_code}'.")
            return None
        holiday_dates = pd.to_datetime(list(country_holidays_dict.keys()))
        df_h = self.df_eda.copy()
        df_h['is_holiday'] = df_h.index.isin(holiday_dates)
        holiday_sales = df_h[df_h['is_holiday']]
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=self.df_eda.index, y=self.df_eda[self.sales_col],
                                 mode='lines', name=self.sales_col))
        if not holiday_sales.empty:
            fig.add_trace(go.Scatter(x=holiday_sales.index, y=holiday_sales[self.sales_col],
                                     mode='markers', name='Holidays',
                                     marker=dict(color='green', size=10)))
        fig.update_layout(title=f'{self.sales_col} with Holidays Highlighted')
        st.plotly_chart(fig, use_container_width=True)
        avg_h = holiday_sales[self.sales_col].mean() if not holiday_sales.empty else np.nan
        avg_nh = df_h[~df_h['is_holiday']][self.sales_col].mean()
        c1, c2 = st.columns(2)
        c1.metric(f"Avg {self.sales_col} (Holidays)", f"{avg_h:.2f}" if pd.notna(avg_h) else "—")
        c2.metric(f"Avg {self.sales_col} (Non-Holidays)", f"{avg_nh:.2f}")
        return fig

    def _engineer_features(self, use_tsfresh: bool = False,
                           df_override: pd.DataFrame = None) -> pd.DataFrame:
        df_to_feature = self.df_eda.copy() if df_override is None else df_override.copy()
        if not isinstance(df_to_feature.index, pd.DatetimeIndex):
            if 'date' in df_to_feature.columns:
                df_to_feature['date'] = pd.to_datetime(df_to_feature['date'])
                df_to_feature = df_to_feature.set_index('date')
            else:
                date_col_name = df_to_feature.columns[0]
                df_to_feature[date_col_name] = pd.to_datetime(df_to_feature[date_col_name])
                df_to_feature = df_to_feature.set_index(date_col_name)

        df_featured = df_to_feature.reset_index()
        date_col_name = df_to_feature.index.name or 'index'
        if date_col_name not in df_featured.columns and 'index' in df_featured.columns:
            date_col_name = 'index'
        elif date_col_name not in df_featured.columns:
            date_col_name = df_featured.columns[0]
        df_featured.rename(columns={date_col_name: 'date', self.sales_col: 'sales'},
                           inplace=True, errors='ignore')

        freq = self.resample_freq
        if freq == 'D':
            df_featured['day_of_week'] = df_featured['date'].dt.dayofweek
            df_featured['day_of_week_sin'] = np.sin(2 * np.pi * df_featured['day_of_week'] / 7)
            df_featured['day_of_week_cos'] = np.cos(2 * np.pi * df_featured['day_of_week'] / 7)
            lags = [7, 14, 28]; windows = [7, 14, 28]
        elif freq == 'W':
            lags = [1, 4, 8]; windows = [4, 8]
        elif freq == 'M':
            lags = [1, 6, 12]; windows = [3, 6]
        elif freq == 'Q':
            lags = [1, 2, 4]; windows = [2, 4]
        else:
            lags = [1, 2]; windows = [1, 2]

        df_featured['month'] = df_featured['date'].dt.month
        df_featured['week_of_year'] = df_featured['date'].dt.isocalendar().week.fillna(0).astype(int)
        df_featured['quarter'] = df_featured['date'].dt.quarter
        df_featured['month_sin'] = np.sin(2 * np.pi * df_featured['month'] / 12)
        df_featured['month_cos'] = np.cos(2 * np.pi * df_featured['month'] / 12)

        for lag in lags:
            df_featured[f'lag_{lag}'] = df_featured['sales'].shift(lag).fillna(0)
        for window in windows:
            df_featured[f'rolling_mean_{window}'] = df_featured['sales'].shift(1).rolling(window=window).mean().fillna(0)
            df_featured[f'rolling_std_{window}'] = df_featured['sales'].shift(1).rolling(window=window).std().fillna(0)

        if holidays is not None:
            years = df_featured['date'].dt.year.unique()
            min_y = years.min() if len(years) > 0 else pd.Timestamp.now().year
            max_y = years.max() if len(years) > 0 else pd.Timestamp.now().year
            try:
                country_holidays = holidays.country_holidays(self.country_code, years=np.arange(min_y - 1, max_y + 2))
            except Exception:
                country_holidays = {}
            if country_holidays:
                hdates = pd.DataFrame(list(country_holidays.items()), columns=['date', 'holiday_name'])
                hdates['date'] = pd.to_datetime(hdates['date'])
                hdates.sort_values('date', inplace=True)
                df_featured['is_holiday'] = df_featured['date'].isin(hdates['date']).astype(int)
                hd_prev = hdates.rename(columns={'date': 'date_prev'})
                hd_next = hdates.rename(columns={'date': 'date_next'})
                df_featured = df_featured.sort_values('date')
                df_featured = pd.merge_asof(df_featured, hd_prev, left_on='date', right_on='date_prev', direction='backward')
                df_featured = pd.merge_asof(df_featured, hd_next, left_on='date', right_on='date_next', direction='forward')
                df_featured['days_to_next_holiday'] = (df_featured['date_next'] - df_featured['date']).dt.days
                df_featured['days_from_prev_holiday'] = (df_featured['date'] - df_featured['date_prev']).dt.days
                df_featured.fillna({'days_to_next_holiday': 365, 'days_from_prev_holiday': 365}, inplace=True)
                df_featured.drop(columns=['holiday_name_x', 'date_prev', 'holiday_name_y', 'date_next'],
                                 inplace=True, errors='ignore')
            else:
                df_featured['is_holiday'] = 0
                df_featured['days_to_next_holiday'] = 365
                df_featured['days_from_prev_holiday'] = 365

        # Optional tsfresh
        if use_tsfresh and extract_features is not None:
            try:
                df_tsfresh = df_featured[['date', 'sales']].dropna(subset=['sales']).copy()
                df_tsfresh['id'] = 1
                X_ts = extract_features(df_tsfresh, column_id='id', column_sort='date',
                                        default_fc_parameters=MinimalFCParameters(),
                                        disable_progressbar=True)
                X_ts.columns = [str(c).replace('"', '').replace("'", "").replace("(", "_").replace(")", "").replace(",", "_") for c in X_ts.columns]
                df_featured = df_featured.merge(X_ts, left_on='date', right_index=True, how='left')
                df_featured.ffill(inplace=True)
                df_featured.fillna(0, inplace=True)
            except Exception as e:
                st.warning(f"tsfresh extraction failed: {e}")

        df_featured.set_index('date', inplace=True)
        if df_override is None and 'exog_df' in st.session_state and st.session_state.exog_df is not None:
            df_featured = df_featured.join(st.session_state.exog_df, how='left').ffill().fillna(0)
        return df_featured.reset_index()


# -----------------------------------------------------------------
# A3.  TimeSeriesForecaster — multi-model competition + error correction
# -----------------------------------------------------------------
class TimeSeriesForecaster:
    """Multi-model competition: AutoARIMA, Prophet, SARIMAX, ARIMA, Holt-Winters,
    Exponential Smoothing, LightGBM. Optional XGBoost residual correction."""

    def __init__(self, eda_analyzer: TimeSeriesEDA, proxy_files_data: List[Tuple[str, pd.DataFrame]] = None,
                 new_product_start_date: str = None):
        self.eda = eda_analyzer
        self.proxy_files_data = proxy_files_data
        self.new_product_start_date = new_product_start_date
        self.performance_results = []
        self.last_error_model = None
        self.last_X_train_columns = None
        self.last_run_details = []
        self.exog_forecast = None

    def _calculate_mape(self, y_true, y_pred) -> float:
        # Weighted WMAPE (WMAPE): sum|y_true-y_pred| / sum|y_true|.
        y_true, y_pred = np.array(y_true), np.array(y_pred)
        denom = float(np.abs(y_true).sum())
        if denom == 0:
            return 0.0
        return float(np.abs(y_true - y_pred).sum() / denom * 100)

    def _forecast_auto_arima(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        if pm is None:
            raise ImportError("pmdarima not installed.")
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)
        model = pm.auto_arima(train_data[self.eda.sales_col], X=exog_train,
                              m=seasonal_periods, seasonal=True, suppress_warnings=True,
                              stepwise=True, error_action='ignore')
        fitted = pd.Series(model.predict_in_sample(X=exog_train), index=train_data.index)
        forecast, conf_int = model.predict(n_periods=n_periods, X=exog_forecast, return_conf_int=True)
        forecast_ci = pd.DataFrame(conf_int, index=forecast.index, columns=['lower', 'upper'])
        return fitted, forecast, forecast_ci, model

    def _forecast_prophet(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        if Prophet is None:
            raise ImportError("Prophet not installed.")
        freq_map = {'M': 'MS', 'Q': 'QS', 'Y': 'YS'}
        effective_freq = freq_map.get(self.eda.resample_freq, self.eda.resample_freq)
        prophet_df = train_data.reset_index()
        prophet_df.rename(columns={self.eda.date_col: 'ds', self.eda.sales_col: 'y'}, inplace=True)
        if exog_train is not None:
            prophet_df = prophet_df.merge(exog_train, left_on='ds', right_index=True)
        model = Prophet()
        if exog_train is not None:
            for col in exog_train.columns:
                model.add_regressor(col)
        model.fit(prophet_df)
        future = model.make_future_dataframe(periods=n_periods, freq=effective_freq)
        if exog_forecast is not None:
            all_exog = pd.concat([exog_train, exog_forecast]) if exog_train is not None else exog_forecast
            future = future.merge(all_exog, left_on='ds', right_index=True, how='left').ffill().bfill()
        forecast_df = model.predict(future)
        fitted = forecast_df['yhat'][:-n_periods]
        fitted.index = train_data.index
        forecast_part = forecast_df.iloc[-n_periods:]
        forecasted = pd.Series(forecast_part['yhat'].values,
                               index=pd.date_range(start=train_data.index[-1], periods=n_periods + 1, freq=effective_freq)[1:])
        forecast_ci = forecast_part[['yhat_lower', 'yhat_upper']].rename(columns={'yhat_lower': 'lower', 'yhat_upper': 'upper'})
        forecast_ci.index = forecasted.index
        return fitted, forecasted, forecast_ci, (forecast_df, model)

    def _forecast_exponential_smoothing(self, train_data, n_periods, **kwargs):
        model = ExponentialSmoothing(train_data[self.eda.sales_col], initialization_method="estimated").fit()
        return model.fittedvalues, model.forecast(n_periods), None, model

    def _forecast_holt_winters(self, train_data, n_periods, **kwargs):
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)
        if seasonal_periods > 1 and len(train_data) > 2 * seasonal_periods:
            model_fit = ExponentialSmoothing(train_data[self.eda.sales_col],
                                              seasonal_periods=seasonal_periods,
                                              seasonal='add',
                                              initialization_method="estimated").fit()
        else:
            model_fit = ExponentialSmoothing(train_data[self.eda.sales_col],
                                              initialization_method="estimated").fit()
        fitted = model_fit.fittedvalues
        try:
            fp = model_fit.get_forecast(n_periods)
            forecast = fp.predicted_mean
            forecast_ci = fp.conf_int()
            forecast_ci.columns = ['lower', 'upper']
        except AttributeError:
            forecast = model_fit.forecast(n_periods)
            forecast_ci = None
        return fitted, forecast, forecast_ci, model_fit

    def _forecast_arima(self, train_data, n_periods, **kwargs):
        model_fit = ARIMA(train_data[self.eda.sales_col], order=(1, 1, 1)).fit()
        fitted = model_fit.fittedvalues
        fp = model_fit.get_forecast(steps=n_periods)
        forecast = fp.predicted_mean
        forecast_ci = fp.conf_int()
        forecast_ci.columns = ['lower', 'upper']
        return fitted, forecast, forecast_ci, model_fit

    def _forecast_sarimax(self, train_data, n_periods, exog_train, exog_forecast, **kwargs):
        seasonal_periods = {'D': 7, 'W': 52, 'M': 12, 'Q': 4, 'Y': 1}.get(self.eda.resample_freq, 0)
        if exog_train is not None:
            model_fit = SARIMAX(train_data[self.eda.sales_col], exog=exog_train,
                                order=(1, 1, 1),
                                seasonal_order=(1, 1, 0, seasonal_periods),
                                enforce_stationarity=False,
                                enforce_invertibility=False).fit(disp=False)
            fp = model_fit.get_forecast(steps=n_periods, exog=exog_forecast)
        else:
            model_fit = SARIMAX(train_data[self.eda.sales_col],
                                order=(1, 1, 1),
                                seasonal_order=(1, 1, 0, seasonal_periods),
                                enforce_stationarity=False,
                                enforce_invertibility=False).fit(disp=False)
            fp = model_fit.get_forecast(steps=n_periods)
        fitted = model_fit.fittedvalues
        forecast = fp.predicted_mean
        forecast_ci = fp.conf_int()
        forecast_ci.columns = ['lower', 'upper']
        return fitted, forecast, forecast_ci, model_fit

    def _forecast_lightgbm(self, train_data, n_periods, exog_train=None,
                           exog_forecast=None, use_tsfresh=False, **kwargs):
        if lgb is None:
            raise ImportError("lightgbm not installed.")
        full_features_df = self.eda._engineer_features(use_tsfresh=use_tsfresh).set_index('date')
        train_features_df = full_features_df.loc[train_data.index]
        y_train = train_features_df['sales']
        X_train = train_features_df.drop(columns=['sales'])
        model = lgb.LGBMRegressor(random_state=42, verbose=-1)
        model.fit(X_train, y_train)
        fitted = pd.Series(model.predict(X_train), index=X_train.index)
        forecast_dates = exog_forecast.index if exog_forecast is not None else pd.date_range(
            start=train_data.index[-1], periods=n_periods + 1, freq=self.eda.resample_freq)[1:]
        forecast_values = []
        for date in forecast_dates:
            if exog_forecast is not None:
                X_next = exog_forecast.loc[[date]].reindex(columns=X_train.columns, fill_value=0)
            else:
                X_next = pd.DataFrame(np.zeros((1, len(X_train.columns))),
                                      columns=X_train.columns, index=[date])
            forecast_values.append(float(model.predict(X_next)[0]))
        forecast = pd.Series(forecast_values, index=forecast_dates)
        return fitted, forecast, None, model

    def _forecast_dl_moe(self, train_data, n_periods, exog_train=None,
                         exog_forecast=None, **kwargs):
        """Deep-learning Mixture-of-Experts (Keras) â trend + Fourier-seasonality
        + transformer experts combined by a softmax gating network. Ported from
        app_96.py. Multivariate when exog is supplied."""
        if tf is None:
            raise ImportError("TensorFlow is not installed/working. "
                              "Run 'pip install tensorflow' to use Deep MoE.")
        target_series = train_data[[self.eda.sales_col]]
        if exog_train is not None:
            full_train_df = target_series.join(exog_train)
        else:
            full_train_df = target_series
        num_features = full_train_df.shape[1]

        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_data = scaler.fit_transform(full_train_df)

        INPUT_LEN, OUTPUT_LEN = 30, 1
        if len(scaled_data) < INPUT_LEN + OUTPUT_LEN:
            raise ValueError(f"Not enough data for DL MoE model. Need "
                             f"{INPUT_LEN + OUTPUT_LEN} points, have {len(scaled_data)}.")

        X_train, y_train = create_sequences(scaled_data, INPUT_LEN, OUTPUT_LEN)
        seasonal_period = {'D': 7, 'W': 52, 'M': 12, 'MS': 12,
                           'Q': 4, 'QS': 4, 'Y': 1}.get(self.eda.resample_freq, 7)
        moe_model = TimeSeriesMoE(input_len=INPUT_LEN, output_len=OUTPUT_LEN,
                                  num_features=num_features, period=seasonal_period, k=5)
        moe_model.compile(optimizer=Adam(learning_rate=0.001), loss='mae')
        moe_model.fit(X_train, y_train, epochs=30, batch_size=32,
                      validation_split=0.2, verbose=0,
                      callbacks=[tf.keras.callbacks.EarlyStopping(
                          monitor='val_loss', patience=5, restore_best_weights=True)])

        forecast_scaled = []
        current_sequence = scaled_data[-INPUT_LEN:].reshape(1, INPUT_LEN, num_features)
        for i in range(n_periods):
            next_pred_scaled = moe_model.predict(current_sequence, verbose=0)
            forecast_scaled.append(next_pred_scaled[0, 0])
            next_step = np.zeros((1, 1, num_features))
            next_step[0, 0, 0] = next_pred_scaled[0, 0]
            if num_features > 1 and exog_forecast is not None:
                future_exog_step = exog_forecast.iloc[[i]]
                dummy_target = pd.DataFrame(np.zeros((len(future_exog_step), 1)),
                                            columns=[self.eda.sales_col],
                                            index=future_exog_step.index)
                future_step_full_df = pd.concat([dummy_target, future_exog_step], axis=1)
                scaled_future_exog = scaler.transform(future_step_full_df)[:, 1:]
                next_step[0, 0, 1:] = scaled_future_exog
            current_sequence = np.append(current_sequence[:, 1:, :], next_step, axis=1)

        dummy_fc = np.zeros((len(forecast_scaled), num_features))
        dummy_fc[:, 0] = forecast_scaled
        forecast = scaler.inverse_transform(dummy_fc)[:, 0]
        forecast_dates = pd.date_range(start=train_data.index[-1], periods=n_periods + 1,
                                       freq=self.eda.resample_freq)[1:]

        fitted_scaled = moe_model.predict(X_train, verbose=0)
        dummy_fit = np.zeros((len(fitted_scaled), num_features))
        dummy_fit[:, 0] = fitted_scaled.flatten()
        fitted = scaler.inverse_transform(dummy_fit)[:, 0]
        padding = np.full(len(train_data) - len(fitted), np.nan)
        fitted_padded = np.concatenate([padding, fitted])
        return (pd.Series(fitted_padded, index=train_data.index),
                pd.Series(forecast, index=forecast_dates), None, moe_model)

    def _train_single_model(self, model_type, train_data, n_periods, exog_train, exog_forecast, use_tsfresh=False):
        model_map = {
            'auto_arima': self._forecast_auto_arima,
            'prophet': self._forecast_prophet,
            'exponential_smoothing': self._forecast_exponential_smoothing,
            'holt_winters': self._forecast_holt_winters,
            'lightgbm': self._forecast_lightgbm,
            'dl_moe': self._forecast_dl_moe,
            'arima': self._forecast_arima,
            'sarimax': self._forecast_sarimax,
        }
        args = {'exog_train': exog_train, 'exog_forecast': exog_forecast, 'use_tsfresh': use_tsfresh}
        fitted, forecast, forecast_ci, components_or_model = model_map[model_type](train_data, n_periods, **args)
        components, model_object = None, None
        if model_type == 'prophet':
            components, model_object = components_or_model
        else:
            model_object = components_or_model
        return fitted, forecast, forecast_ci, components, model_object

    def _evaluate_model_on_split(self, model_type, train_data, test_data, exog_train, exog_test,
                                  use_tsfresh=False, has_external_exog=False):
        try:
            n_periods_test = len(test_data) if test_data is not None else 0
            pass_exog = exog_train is not None
            if model_type == 'arima':
                pass_exog = False
            elif model_type == 'sarimax' and not has_external_exog:
                pass_exog = False
            current_exog_train = exog_train if pass_exog else None
            current_exog_test = exog_test if pass_exog else None

            fitted, forecast_on_test, _, components, model_object = self._train_single_model(
                model_type, train_data, n_periods_test, current_exog_train, current_exog_test, use_tsfresh)

            fitted_clean = fitted.dropna()
            common_index = train_data.index.intersection(fitted_clean.index)
            train_aligned = train_data.loc[common_index, self.eda.sales_col]
            fitted_aligned = fitted_clean.loc[common_index]
            train_mape = self._calculate_mape(train_aligned, fitted_aligned)
            train_mse = mean_squared_error(train_aligned, fitted_aligned)
            train_rmse = np.sqrt(train_mse)

            test_mape, test_rmse, test_mse = None, None, None
            if test_data is not None and not forecast_on_test.empty:
                common_test_index = test_data.index.intersection(forecast_on_test.index)
                test_aligned = test_data.loc[common_test_index, self.eda.sales_col]
                forecast_aligned = forecast_on_test.loc[common_test_index]
                if not forecast_aligned.empty:
                    test_mape = self._calculate_mape(test_aligned, forecast_aligned)
                    test_mse = mean_squared_error(test_aligned, forecast_aligned)
                    test_rmse = np.sqrt(test_mse)

            return {'model_name': model_type, 'status': 'success',
                    'train_mape': train_mape, 'train_rmse': train_rmse, 'train_mse': train_mse,
                    'test_mape': test_mape, 'test_rmse': test_rmse, 'test_mse': test_mse,
                    'components': components, 'model_object': model_object}
        except Exception as e:
            return {'model_name': model_type, 'status': 'failure', 'error': e}

    def forecast(self, n_periods: int, models_to_try: list, error_threshold: float,
                 new_product_strategy: str = 'proxy', use_tsfresh: bool = False):
        self.last_run_details = []

        df_full_features = self.eda._engineer_features(use_tsfresh=use_tsfresh).set_index('date')
        full_train_data = self.eda.df_eda.copy()
        if 'anomaly_score' in df_full_features.columns:
            df_full_features = df_full_features.drop(columns=['anomaly_score'])
        if 'anomaly_score' in full_train_data.columns:
            full_train_data = full_train_data.drop(columns=['anomaly_score'])

        test_size = n_periods
        if len(full_train_data) < test_size * 2:
            st.warning("Not enough data for a train-test split. Models compared on training only.")
            train_data, test_data = full_train_data, None
        else:
            train_data, test_data = full_train_data[:-test_size], full_train_data[-test_size:]

        exog_cols = [col for col in df_full_features.columns if col != 'sales']
        exog_train_eval, exog_test_eval = None, None
        full_exog_train_final, exog_forecast_final = None, None
        has_external_exog = 'exog_df' in st.session_state and st.session_state.exog_df is not None

        if exog_cols:
            full_exog_train_all = df_full_features.loc[full_train_data.index, exog_cols]
            temp_eda = copy.deepcopy(self.eda)
            future_dates = pd.date_range(start=full_train_data.index[-1], periods=n_periods + 1,
                                         freq=self.eda.resample_freq)[1:]
            future_skeleton = pd.DataFrame(index=future_dates, columns=temp_eda.df_eda.columns)
            combined_df = pd.concat([temp_eda.df_eda, future_skeleton])
            temp_eda.df_eda = combined_df
            all_features_df = temp_eda._engineer_features(use_tsfresh=False).set_index('date')
            exog_forecast_all = all_features_df.loc[future_dates, exog_cols]
            self.exog_forecast = exog_forecast_all
            if has_external_exog:
                full_exog_train_final = full_exog_train_all
                exog_forecast_final = exog_forecast_all
                if test_data is not None:
                    exog_train_eval = full_exog_train_final.loc[train_data.index]
                    exog_test_eval = full_exog_train_final.loc[test_data.index]
                else:
                    exog_train_eval = full_exog_train_final

        st.info("Evaluating models on a hold-out test set...")
        evaluation_results = []
        with st.spinner("Running model competition in parallel..."):
            with concurrent.futures.ThreadPoolExecutor() as executor:
                futures = [executor.submit(self._evaluate_model_on_split, m, train_data, test_data,
                                            exog_train_eval, exog_test_eval, use_tsfresh, has_external_exog)
                           for m in models_to_try]
                for fut in concurrent.futures.as_completed(futures):
                    r = fut.result()
                    if r['status'] == 'success':
                        evaluation_results.append(r)
                    else:
                        st.warning(f"Could not run model {r['model_name'].upper()}: {r['error']}")

        if not evaluation_results:
            raise ValueError("No models trained successfully during evaluation.")

        for res in evaluation_results:
            self.last_run_details.append({
                'Model': res['model_name'].upper(),
                'Train WMAPE (%)': f"{res['train_mape']:.2f}",
                'Train RMSE': f"{res['train_rmse']:.2f}",
                'Test WMAPE (%)': f"{res['test_mape']:.2f}" if res['test_mape'] is not None else "N/A",
                'Test RMSE': f"{res['test_rmse']:.2f}" if res['test_rmse'] is not None else "N/A",
            })

        sort_key = 'test_mape' if test_data is not None else 'train_mape'
        sorted_models = sorted(evaluation_results,
                               key=lambda x: x.get(sort_key) if x.get(sort_key) is not None else float('inf'))
        best = sorted_models[0]
        best_name = best['model_name']
        st.success(f"Best model: **{best_name.upper()}** ({sort_key}). Retraining on full data.")

        pass_exog_final = full_exog_train_final is not None
        if best_name == 'arima':
            pass_exog_final = False
        elif best_name == 'sarimax' and not has_external_exog:
            pass_exog_final = False
        cur_full_exog = full_exog_train_final if pass_exog_final else None
        cur_exog_fc = exog_forecast_final if pass_exog_final else None

        final_fitted, final_forecast, final_ci, final_components, final_model = self._train_single_model(
            best_name, full_train_data, n_periods, cur_full_exog, cur_exog_fc, use_tsfresh)

        best_model_result = {
            'model_name': best_name, 'mape': best.get(sort_key, 0),
            'fitted_values': final_fitted, 'forecast': final_forecast, 'forecast_ci': final_ci,
            'components': final_components, 'model_object': final_model,
        }
        result_summary = {
            'Model': best_name.upper(),
            'Train WMAPE (%)': f"{best['train_mape']:.2f}",
            'Test WMAPE (%)': f"{best['test_mape']:.2f}" if best['test_mape'] is not None else "N/A",
            'Error Correction Applied': False,
        }
        final_forecast_output = final_forecast
        best_model_name_final = best_name.upper()

        err_metric = best['test_mape'] if test_data is not None else best['train_mape']
        if (has_external_exog and full_exog_train_final is not None and err_metric is not None
                and err_metric > error_threshold and xgb is not None):
            st.info("Base model test error is high. Applying XGBoost error correction.")
            residuals = full_train_data[self.eda.sales_col] - final_fitted
            valid_residuals = residuals.dropna()
            if not valid_residuals.empty:
                result_summary['Error Correction Applied'] = True
                aligned_exog = full_exog_train_final.loc[valid_residuals.index]
                self.last_error_model = xgb.XGBRegressor(objective='reg:squarederror',
                                                         n_estimators=200, random_state=42)
                self.last_X_train_columns = aligned_exog.columns
                self.last_error_model.fit(aligned_exog.values, valid_residuals.values)
                predicted_errors = self.last_error_model.predict(
                    exog_forecast_final.reindex(columns=self.last_X_train_columns, fill_value=0).values)
                final_forecast_output = final_forecast_output + predicted_errors
                best_model_name_final = f"Corrected {best_name.upper()}"

        self.performance_results.append(result_summary)
        return final_forecast_output, best_model_name_final, best_model_result, result_summary


# -----------------------------------------------------------------
# A4.  Frequency recommendation & competition
# -----------------------------------------------------------------
@st.cache_data(show_spinner=False)
def recommend_frequency(_df, date_col):
    df = _df.copy()
    if pd.api.types.is_numeric_dtype(df[date_col]):
        df[date_col] = pd.to_datetime(df[date_col], origin='1899-12-30', unit='D')
    else:
        df[date_col] = pd.to_datetime(df[date_col], errors='coerce')
    df.dropna(subset=[date_col], inplace=True)
    if df.empty:
        raise ValueError("Date column could not be converted to a valid datetime format.")
    min_d = df[date_col].min(); max_d = df[date_col].max()
    date_range_days = (max_d - min_d).days
    if date_range_days < 1:
        return 'D', "Data spans only a single day. Daily frequency is the only option.", 100.0
    total = date_range_days + 1
    unique_days = df[date_col].dt.date.nunique()
    density = (unique_days / total) * 100
    span_reason = f"Data spans **{date_range_days} days** ({min_d.date()} → {max_d.date()})."
    density_reason = f"Density: **{density:.0f}%** ({unique_days}/{total} days)."
    if date_range_days > 365 * 2:
        freq_code, logic = 'M', "Long span → **Monthly** recommended."
    elif date_range_days > 90:
        freq_code, logic = 'W', "Mid span → **Weekly** balances seasonality + noise."
    else:
        freq_code = 'D' if density >= 75 else 'W'
        logic = "Short, dense → **Daily**." if freq_code == 'D' else "Short, sparse → aggregate to **Weekly**."
    return freq_code, f"{span_reason}\n\n{density_reason}\n\n**Recommendation:** {logic}", density


@st.cache_data(show_spinner=False)
def compare_frequencies(_df, date_col, sales_col):
    df_c = _df.copy()
    df_c[date_col] = pd.to_datetime(df_c[date_col])
    df_c = df_c.set_index(date_col).sort_index()
    all_results = {}
    params_map = {
        'D': {'min_len': 60, 'test_len': 30, 'sp': 7, 'name': 'Daily'},
        'W': {'min_len': 52, 'test_len': 8, 'sp': 52, 'name': 'Weekly'},
        'M': {'min_len': 24, 'test_len': 6, 'sp': 12, 'name': 'Monthly'},
        'Y': {'min_len': 4, 'test_len': 2, 'sp': 1, 'name': 'Yearly'},
    }
    for code, p in params_map.items():
        try:
            s = df_c[sales_col].resample(code).sum()
            if len(s) < p['min_len']:
                continue
            tr, te = s.iloc[:-p['test_len']], s.iloc[-p['test_len']:]
            mdl = SARIMAX(tr, order=(1, 1, 1), seasonal_order=(1, 1, 0, p['sp'])).fit(disp=False)
            fc = mdl.forecast(steps=len(te))
            fc.index = te.index
            mape = mean_absolute_percentage_error(te, fc) * 100
            all_results[p['name']] = {'Test WMAPE (%)': mape, 'AIC': mdl.aic}
        except Exception as e:
            all_results[p['name']] = {'Test WMAPE (%)': float('inf'), 'AIC': float('inf'), 'Error': str(e)}
    if not all_results:
        return {"error": "Not enough data to perform reliable frequency comparison."}
    return all_results


# -----------------------------------------------------------------
# A5.  Narrative / inventory analysis / attribution
# -----------------------------------------------------------------
def generate_narrative_summary(forecast_data: Dict, config: Dict) -> str:
    best_model_name = forecast_data['best_model_name']
    best_model_result = forecast_data['best_model_result']
    result_summary = forecast_data['result']
    final_forecast = forecast_data['final_forecast']
    n_periods = len(final_forecast)
    freq_map = {'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', 'Q': 'Quarterly', 'Y': 'Yearly'}
    freq_name = freq_map.get(config.get('resample_freq', 'M'), 'periods')
    x = np.arange(n_periods); y = final_forecast.values
    if n_periods >= 2:
        slope, _ = np.polyfit(x, y, 1)
    else:
        slope = 0.0
    trend_desc = "an upward trend" if slope > 0 else "a downward trend" if slope < 0 else "a stable trend"
    test_mape_str = result_summary.get('Test WMAPE (%)', 'N/A')
    if test_mape_str == 'N/A':
        train_mape_str = result_summary.get('Train WMAPE (%)', 'N/A')
        perf = f"a Train WMAPE of **{train_mape_str}%** (no test set was used)"
    else:
        perf = f"a Test WMAPE of **{test_mape_str}%** on a hold-out dataset"
    summary = (
        f"\n**Forecast Summary:**\n\nA forecast has been generated for the next **{n_periods} {freq_name} periods**. "
        f"After a competition on a hold-out test set, the **{best_model_name.replace('_', ' ').title()}** model "
        f"was selected as the most accurate predictor, achieving {perf}. The forecast indicates **{trend_desc}** over the horizon."
    )
    if result_summary.get('Error Correction Applied'):
        summary += " An XGBoost residual-correction model was layered on top of the baseline forecast."
    if best_model_result.get('forecast_ci') is not None:
        summary += " The plot includes confidence intervals for probabilistic forecasting."
    return summary


def perform_demand_gap_analysis(forecast_df: pd.DataFrame, inventory_df: pd.DataFrame, inventory_col: str) -> pd.DataFrame:
    if not isinstance(inventory_df.index, pd.DatetimeIndex):
        inventory_df = inventory_df.copy()
        inventory_df.index = pd.to_datetime(inventory_df.index)
    analysis_df = pd.merge(forecast_df, inventory_df[[inventory_col]],
                           left_index=True, right_index=True, how='left').ffill()
    analysis_df.rename(columns={'Forecasted Values': 'forecast', 'forecast_values': 'forecast'}, inplace=True)
    analysis_df['demand_gap'] = (analysis_df['forecast'] - analysis_df[inventory_col]).fillna(0)
    return analysis_df


def generate_inventory_insights_text(analysis_df: pd.DataFrame) -> Tuple[str, str]:
    stockouts = analysis_df[analysis_df['demand_gap'] > 0]
    surplus = analysis_df[analysis_df['demand_gap'] < 0]
    total_short = stockouts['demand_gap'].sum()
    avg_surp = -surplus['demand_gap'].mean() if not surplus.empty else 0
    n_stockout = len(stockouts)
    if n_stockout > 0:
        first_d = stockouts.index.min().strftime('%Y-%m-%d')
        stockout_text = (
            f"**Alert:** First potential stockout on **{first_d}**. "
            f"Total shortfall projected: **{total_short:,.0f} units**.\n"
            "- Expedite POs before this date.\n- Consider demand shaping (promos on substitutes)."
        )
    else:
        stockout_text = "**Good News:** No stockouts predicted over the horizon."
    if avg_surp > 0:
        surplus_text = (
            f"**Notice:** Average projected surplus of **{avg_surp:,.0f} units** in non-stockout periods.\n"
            "- Review reorder points and safety stock.\n- Consider promotions to accelerate sell-through."
        )
    else:
        surplus_text = ""
    return stockout_text, surplus_text


def generate_attribution_df(forecast_data: Dict[str, Any], config: Dict[str, Any]) -> pd.DataFrame:
    final_forecast_series = forecast_data['final_forecast']
    best_model_result = forecast_data['best_model_result']
    is_corrected = forecast_data['result'].get('Error Correction Applied', False)
    clean = pd.DataFrame(index=final_forecast_series.index)
    if best_model_result.get('model_name') == 'prophet' and best_model_result.get('components') is not None:
        components = best_model_result['components'].set_index('ds')
        components = components.reindex(final_forecast_series.index, fill_value=0)
        clean['Trend'] = components.get('trend', 0)
        seasonal_cols = [c for c in components.columns if 'seasonal' in c or c in ['weekly', 'yearly', 'daily']]
        clean['Seasonal'] = components[seasonal_cols].sum(axis=1) if seasonal_cols else 0
        prophet_internal = ['trend', 'yhat', 'multiplicative_terms', 'additive_terms'] + seasonal_cols
        to_exclude = [c for c in components.columns if c.endswith(('_lower', '_upper')) or c in prophet_internal]
        for c in [c for c in components.columns if c not in to_exclude]:
            clean[c] = components[c]
        if is_corrected:
            clean['Error_Correction'] = final_forecast_series - best_model_result['forecast']
    else:
        periods = {'D': 7, 'W': 4, 'M': 12, 'Q': 4, 'Y': 2}
        period = periods.get(config.get('resample_freq', 'M'), 4)
        if len(final_forecast_series) > period * 2:
            try:
                d = seasonal_decompose(final_forecast_series.fillna(0), model='additive', period=period)
                clean['Trend'] = d.trend; clean['Seasonal'] = d.seasonal; clean['Residual/Other'] = d.resid
            except Exception:
                clean['Trend'] = final_forecast_series
        else:
            clean['Trend'] = final_forecast_series
    clean.fillna(0, inplace=True)
    total_abs = clean.abs().sum(axis=1).replace(0, 1)
    for col in list(clean.columns):
        clean[f'{col}_pct'] = (clean[col].abs() / total_abs) * 100
    return clean


# -----------------------------------------------------------------
# A6.  PDF report generation
# -----------------------------------------------------------------
if FPDF is not None:
    class PDF(FPDF):
        def __init__(self, *args, title="DhishaAI Time Lens Report", **kwargs):
            super().__init__(*args, **kwargs)
            self.report_title = title

        def header(self):
            self.set_font('Arial', 'B', 15)
            self.cell(0, 10, self.report_title, 0, 1, 'C')
            self.ln(5)

        def footer(self):
            self.set_y(-15)
            self.set_font('Arial', 'I', 8)
            self.cell(0, 10, f'Page {self.page_no()}', 0, 0, 'C')

        def chapter_title(self, title):
            self.set_font('Arial', 'B', 14)
            self.cell(0, 10, title, 0, 1, 'L')
            self.ln(4)

        def chapter_body(self, body):
            self.set_font('Arial', '', 12)
            self.multi_cell(0, 5, body)
            self.ln()

        def add_plot(self, plot_bytes):
            available_width = self.w - self.l_margin - self.r_margin
            self.image(io.BytesIO(plot_bytes), w=available_width)
            self.ln(5)

        def add_table_from_df(self, df: pd.DataFrame, title: str):
            self.chapter_title(title)
            self.set_font('Arial', 'B', 10)
            self.set_fill_color(224, 235, 255); self.set_text_color(0)
            page_width = self.w - 2 * self.l_margin
            col_widths = [len(c) * 3 for c in df.columns]
            total_ratio = sum(col_widths) or 1
            col_widths = [(w / total_ratio) * page_width for w in col_widths]
            for i, header in enumerate(df.columns):
                self.cell(col_widths[i], 10, str(header), 1, 0, 'C', fill=True)
            self.ln()
            self.set_font('Arial', '', 9); self.set_text_color(0)
            fill = False
            for _, row in df.iterrows():
                self.set_fill_color(245, 245, 245)
                for i, item in enumerate(row):
                    if isinstance(item, (float, np.floating)):
                        s, align = f"{item:,.2f}", 'R'
                    else:
                        s, align = str(item), 'L'
                    self.cell(col_widths[i], 8, s, 'LR', 0, align, fill=fill)
                self.ln(); fill = not fill
            self.cell(sum(col_widths), 0, '', 'T')
            self.ln(10)
else:
    PDF = None


def generate_pdf_report(report_data: dict, config: dict) -> Optional[bytes]:
    if PDF is None:
        st.error("fpdf2 not installed (pip install fpdf2).")
        return None
    pdf = PDF(title="DhishaAI Time Lens: Demand Forecast & Inventory Report")
    for group, data in report_data.items():
        pdf.add_page()
        pdf.chapter_title(f"Analysis for Group: {group}")
        if 'perf_df' in data:
            pdf.add_table_from_df(data['perf_df'], "1. Model Competition Summary")
        if 'narrative_summary' in data:
            pdf.chapter_title("2. Narrative Summary")
            pdf.chapter_body(data['narrative_summary'])
        if data.get('forecast_plot'):
            pdf.chapter_title("3. Forecast Plot")
            pdf.add_plot(data['forecast_plot'])
        if data.get('inventory_plot'):
            if pdf.get_y() > 180: pdf.add_page()
            pdf.chapter_title("4. Demand Gap Analysis Plot")
            pdf.add_plot(data['inventory_plot'])
            pdf.chapter_title("5. Insights & Recommendations")
            pdf.chapter_body(data.get('stockout_text', ''))
            pdf.chapter_body(data.get('surplus_text', ''))
    return bytes(pdf.output())


def generate_eda_pdf_report(group_name: str, report_data: dict) -> Optional[bytes]:
    if PDF is None:
        st.error("fpdf2 not installed.")
        return None
    pdf = PDF(title="DhishaAI Time Lens: Exploratory Data Analysis Report")
    pdf.add_page()
    pdf.chapter_title(f"EDA for Group: {group_name}")
    if 'summary_metrics' in report_data:
        s_df = pd.DataFrame(list(report_data['summary_metrics'].items()), columns=['Metric', 'Value'])
        pdf.add_table_from_df(s_df, "1. Data Quality & Summary")
    plot_titles = {
        'distribution_plot': "2. Target Variable Distribution",
        'trend_plot': "3. Trend Over Time",
        'decomposition_plot': "4. Time Series Decomposition",
        'anomaly_plot': "5. Anomaly Detection",
        'acf_pacf_plot': "6. ACF & PACF Plots",
        'holiday_plot': "7. Holiday Analysis",
    }
    for key, title in plot_titles.items():
        if report_data.get(key):
            try:
                if pdf.get_y() > 180:
                    pdf.add_page()
                pdf.chapter_title(title)
                pdf.add_plot(report_data[key])
            except Exception as e:
                st.warning(f"Could not embed {title}: {e}")
    return bytes(pdf.output())


# -----------------------------------------------------------------
# A7.  Causal graph builder (graphviz)
# -----------------------------------------------------------------
def build_causal_graph(treatments: List[str], outcome: str, confounders: List[str]) -> str:
    if graphviz is None:
        return ""
    dot = graphviz.Digraph()
    dot.attr('node', shape='box', style='rounded')
    for t in treatments:
        dot.node(t, t, color='orange', style='filled, rounded')
    dot.node(outcome, outcome, color='lightblue', style='filled, rounded')
    for c in confounders:
        dot.node(c, c)
    for t in treatments:
        dot.edge(t, outcome)
        for c in confounders:
            dot.edge(c, t)
    for c in confounders:
        dot.edge(c, outcome)
    return dot.source


# -----------------------------------------------------------------
# A8.  EDA TAB (single-series mode)
# -----------------------------------------------------------------
def _figure_to_png_bytes(fig) -> Optional[bytes]:
    try:
        return fig.to_image(format='png')
    except Exception:
        return None


def render_eda_tab():
    """Single-series EDA tab — upload a CSV, pick columns/frequency, see plots."""
    st.header("Exploratory Data Analysis (Single Series)")
    st.caption("Upload one date/sales CSV for a deep-dive EDA: anomalies, decomposition, ACF/PACF, holidays.")

    with st.expander("Load data", expanded=not st.session_state.get('eda_loaded', False)):
        src = st.radio("Source", ["Upload CSV", "MySQL Database"], horizontal=True, key='eda_src')
        df_loaded = None
        if src == "Upload CSV":
            f = st.file_uploader("Sales CSV (must have date + sales columns)", type="csv", key='eda_csv')
            if f is not None:
                df_loaded = pd.read_csv(f)
        else:
            c1, c2 = st.columns(2)
            db_host = c1.text_input("Host", "localhost", key='eda_h')
            db_user = c2.text_input("User", "root", key='eda_u')
            db_pw = c1.text_input("Password", type="password", key='eda_pw')
            db_name = c2.text_input("Database", key='eda_dbn')
            query = st.text_area("SQL query", "SELECT date, sales FROM mytable;", key='eda_q')
            if st.button("Load from MySQL", key='eda_load_mysql'):
                df_loaded = load_data_from_mysql(db_host, db_user, db_pw, db_name, query)

        if df_loaded is not None:
            st.session_state['eda_df'] = df_loaded
            st.session_state['eda_loaded'] = True
            st.success(f"Loaded {len(df_loaded)} rows.")
            st.dataframe(df_loaded.head())

    if not st.session_state.get('eda_loaded'):
        st.info("Load data above to begin EDA.")
        return

    df = st.session_state['eda_df']
    c1, c2, c3, c4 = st.columns(4)
    date_col = c1.selectbox("Date column", df.columns, key='eda_date_col')
    sales_col = c2.selectbox("Sales column",
                              [c for c in df.columns if c != date_col], key='eda_sales_col')
    freq = c3.selectbox("Frequency", ['D', 'W', 'M', 'Q', 'Y'], index=2, key='eda_freq')
    country = c4.text_input("Country code (holidays)", "IN", key='eda_country')

    if st.button("Run EDA", use_container_width=True, key='eda_run'):
        try:
            with st.spinner("Building EDA..."):
                eda = TimeSeriesEDA(df, date_col=date_col, sales_col=sales_col,
                                    country_code=country, resample_freq=freq)
                st.session_state['eda_object'] = eda
                # Auto-correct flagged anomalies for simplicity
                eda.apply_anomaly_corrections(eda.potential_anomalies_df)
                st.success("EDA built.")
        except Exception as e:
            st.error(f"EDA failed: {e}")
            return

    eda = st.session_state.get('eda_object')
    if eda is None:
        return

    report_data = {}
    dist_fig, summary = eda.display_data_summary_and_distribution()
    report_data['summary_metrics'] = summary
    report_data['distribution_plot'] = _figure_to_png_bytes(dist_fig)

    st.markdown("### Trend")
    report_data['trend_plot'] = _figure_to_png_bytes(eda.plot_trend())

    st.markdown("### Decomposition")
    report_data['decomposition_plot'] = _figure_to_png_bytes(eda.plot_decomposition())

    st.markdown("### Anomaly Detection")
    if not eda.potential_anomalies_df.empty:
        with st.expander("Review identified anomalies"):
            edited = st.data_editor(eda.potential_anomalies_df, key='eda_anomaly_editor')
            if st.button("Apply edits", key='eda_apply_anom'):
                eda.apply_anomaly_corrections(edited)
                st.success("Anomaly edits applied.")
    report_data['anomaly_plot'] = _figure_to_png_bytes(eda.plot_anomaly_detection())

    st.markdown("### ACF & PACF")
    report_data['acf_pacf_plot'] = _figure_to_png_bytes(eda.plot_acf_pacf())

    st.markdown("### Holiday Analysis")
    report_data['holiday_plot'] = _figure_to_png_bytes(eda.analyze_holidays())

    st.markdown("---")
    st.markdown("##### Export this EDA")
    c1, c2 = st.columns(2)
    with c1:
        if st.button("Generate HTML report", key='eda_html', use_container_width=True):
            try:
                # Re-build same figures non-interactively
                df_plot = eda.df_eda.copy()
                df_plot['month'] = df_plot.index.month_name()
                dist_fig = make_subplots(rows=2, cols=1,
                                          subplot_titles=("Distribution", "By Month"))
                dist_fig.add_trace(go.Histogram(x=df_plot[eda.sales_col]), row=1, col=1)
                dist_fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[eda.sales_col]), row=2, col=1)
                dist_fig.update_layout(height=600, showlegend=False, template='plotly_white')
                trend_fig = px.line(eda.df_eda, x=eda.df_eda.index, y=eda.sales_col,
                                      template='plotly_white')
                figs = {'distribution': dist_fig, 'trend': trend_fig}
                summary_metrics = {
                    "Records": f"{len(eda.df):,}",
                    "Frequency": eda.resample_freq,
                    "Anomalies (potential)": f"{len(eda.potential_anomalies_df)}",
                    "Anomalies (corrected)": f"{len(eda.corrected_anomalies)}",
                }
                html = build_eda_html_report(eda, summary_metrics, figs)
                st.session_state['_eda_html_buffer'] = html.encode('utf-8')
                st.success("HTML report ready below.")
            except Exception as e:
                st.error(f"HTML report failed: {e}")
    with c2:
        if PDF is not None and st.button("Generate PDF report", key='eda_pdf', use_container_width=True):
            pdf_bytes = generate_eda_pdf_report("Single Series", report_data)
            if pdf_bytes:
                st.session_state['_eda_pdf_buffer'] = pdf_bytes
                st.success("PDF report ready below.")

    if st.session_state.get('_eda_html_buffer') is not None:
        st.download_button(
            "⬇ Download EDA HTML",
            data=st.session_state['_eda_html_buffer'],
            file_name=f"dhishaai_eda_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
            mime='text/html', use_container_width=True, key='eda_html_dl',
        )
    if st.session_state.get('_eda_pdf_buffer') is not None:
        st.download_button(
            "⬇ Download EDA PDF",
            data=st.session_state['_eda_pdf_buffer'],
            file_name='eda_report.pdf',
            mime='application/pdf', use_container_width=True, key='eda_pdf_dl',
        )


# -----------------------------------------------------------------
# A9.  Single-series forecast (multi-model competition) tab
# -----------------------------------------------------------------
def render_single_series_forecast_tab():
    """Multi-model competition for a single series (Prophet/AutoARIMA/SARIMAX/LightGBM/...)."""
    st.header("Single-Series Multi-Model Forecast")
    st.caption("Runs Prophet, AutoARIMA, SARIMAX, Holt-Winters, LightGBM, etc. in parallel and selects the best by hold-out WMAPE.")

    eda = st.session_state.get('eda_object')
    if eda is None:
        st.info("Run the EDA tab first to load and clean a single series, then come back here.")
        return

    n_periods = st.slider("Forecast horizon (periods)", 1, 60, 12, key='ss_horizon')
    available_models = ['prophet', 'auto_arima', 'sarimax', 'arima', 'holt_winters',
                        'exponential_smoothing', 'lightgbm', 'dl_moe']
    models_to_try = st.multiselect("Models to compete", available_models,
                                    default=['auto_arima', 'sarimax', 'holt_winters', 'lightgbm'],
                                    key='ss_models')
    if 'dl_moe' in available_models:
        st.caption("ð§  **dl_moe** is the Keras deep-learning Mixture-of-Experts "
                   "(trend + seasonality + transformer experts, softmax gating). "
                   + ("Requires â¥31 observations; trains a neural net so it's slow."
                      if tf is not None else
                      "â  Disabled in this environment â start the app with "
                      "`TIMELENS_ENABLE_DL_MOE=1` and a working TensorFlow to "
                      "enable it; otherwise it falls back to Holt-Winters."))
    error_threshold = st.number_input("XGBoost error correction WMAPE threshold", value=20.0, key='ss_thresh')
    use_tsfresh = st.checkbox("Use tsfresh features (slow)", value=False, key='ss_tsfresh')

    if st.button("Run multi-model competition", use_container_width=True, key='ss_run'):
        try:
            fc = TimeSeriesForecaster(eda)
            final_forecast, best_name, best_result, summary = fc.forecast(
                n_periods=n_periods,
                models_to_try=models_to_try,
                error_threshold=error_threshold,
                use_tsfresh=use_tsfresh,
            )
            st.session_state['ss_forecast'] = {
                'final_forecast': final_forecast,
                'best_model_name': best_name,
                'best_model_result': best_result,
                'result': summary,
                'forecaster': fc,
            }
            st.success(f"Winner: {best_name}")
        except Exception as e:
            st.error(f"Forecast failed: {e}")
            return

    result = st.session_state.get('ss_forecast')
    if result is None:
        return

    summary_text = generate_narrative_summary(result, {'resample_freq': eda.resample_freq})
    st.markdown(summary_text)

    final_forecast = result['final_forecast']
    best_result = result['best_model_result']

    fig = go.Figure()
    fig.add_trace(go.Scatter(x=eda.df_eda.index, y=eda.df_eda[eda.sales_col],
                              mode='lines', name='Actual'))
    fig.add_trace(go.Scatter(x=final_forecast.index, y=final_forecast,
                              mode='lines', name='Forecast', line=dict(color=DHISHAAI_ORANGE)))
    if best_result.get('forecast_ci') is not None:
        ci = best_result['forecast_ci']
        fig.add_trace(go.Scatter(x=ci.index, y=ci['upper'], mode='lines',
                                  line=dict(width=0), showlegend=False))
        fig.add_trace(go.Scatter(x=ci.index, y=ci['lower'], mode='lines',
                                  line=dict(width=0), fill='tonexty',
                                  fillcolor='rgba(239,118,2,0.15)', name='95% CI'))
    fig.update_layout(title=f"Forecast — {result['best_model_name']}", height=480)
    st.plotly_chart(fig, use_container_width=True)

    st.markdown("##### Model competition table")
    if hasattr(result['forecaster'], 'last_run_details'):
        st.dataframe(pd.DataFrame(result['forecaster'].last_run_details), use_container_width=True)

    # Inventory analysis (optional)
    inv_df = st.session_state.get('ss_inventory_df')
    inv_file = st.file_uploader("Optional: inventory CSV (date + inventory_on_hand)",
                                type='csv', key='ss_inv_upl')
    if inv_file is not None:
        inv_df = pd.read_csv(inv_file)
        inv_df = inv_df.set_index(pd.to_datetime(inv_df.iloc[:, 0]))
        st.session_state['ss_inventory_df'] = inv_df

    if inv_df is not None:
        inv_col = st.selectbox("Inventory column", inv_df.select_dtypes(include=np.number).columns,
                                key='ss_inv_col')
        fc_df = final_forecast.to_frame(name='forecast')
        ana = perform_demand_gap_analysis(fc_df, inv_df, inv_col)
        st.dataframe(ana.head(20), use_container_width=True)
        stockout_text, surplus_text = generate_inventory_insights_text(ana)
        st.markdown(stockout_text)
        if surplus_text:
            st.markdown(surplus_text)

    st.markdown("---")
    st.markdown("##### Export this forecast")
    if st.button("Generate HTML report", key='ss_html', use_container_width=True):
        try:
            html = build_forecast_html_report(result, {'resample_freq': eda.resample_freq})
            st.session_state['_ss_html_buffer'] = html.encode('utf-8')
            st.success("HTML report ready below.")
        except Exception as e:
            st.error(f"HTML report failed: {e}")
    if st.session_state.get('_ss_html_buffer') is not None:
        st.download_button(
            "⬇ Download forecast HTML",
            data=st.session_state['_ss_html_buffer'],
            file_name=f"dhishaai_forecast_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
            mime='text/html', use_container_width=True, key='ss_html_dl',
        )


# -----------------------------------------------------------------
# A10.  CAUSAL EXPLAINABILITY TAB (DoWhy)
# -----------------------------------------------------------------
def render_causal_tab():
    st.header("Causal Explainability (DoWhy)")
    st.caption("Move beyond correlation: estimate true causal effects using DoWhy.")
    if CausalModel is None or graphviz is None:
        st.error("Install `dowhy` and `graphviz` for this feature: pip install dowhy graphviz")
        return
    eda = st.session_state.get('eda_object')
    if eda is None:
        st.info("Run the EDA tab first to load and clean a series.")
        return
    try:
        features_df = eda._engineer_features()
        features_df.rename(columns={'sales': eda.sales_col}, inplace=True)
        outcome = eda.sales_col
        potential = [c for c in features_df.columns if c not in ['date', outcome]]
        if not potential:
            st.warning("No feature columns available for causal analysis.")
            return

        task = st.selectbox("Causal task", [
            "Effect Estimation (What is the impact of X on Y?)",
            "What-if Analysis (Counterfactuals)",
            "Root Cause Analysis (Find Key Drivers)",
        ])

        if "Effect Estimation" in task:
            treatments = st.multiselect("Treatment(s)", potential, key='causal_treatments')
            confounders_pool = [c for c in potential if c not in treatments]
            confounders = st.multiselect("Confounders", confounders_pool, key='causal_confounders')
            if treatments:
                st.graphviz_chart(build_causal_graph(treatments, outcome, confounders))
                if st.button("Run causal analysis", key='causal_run'):
                    estimates, refutations = [], []
                    with st.spinner("Estimating effects..."):
                        for t in treatments:
                            try:
                                m = CausalModel(data=features_df, treatment=t, outcome=outcome,
                                                common_causes=confounders)
                                est = m.identify_effect(proceed_when_unidentifiable=True)
                                e = m.estimate_effect(est, method_name="backdoor.linear_regression")
                                r = m.refute_estimate(est, e, method_name="random_common_cause")
                                estimates.append({'Treatment': t, 'Causal Estimate': float(e.value)})
                                refutations.append({'Treatment': t, 'Refutation': str(r)})
                                if len(treatments) == 1:
                                    st.session_state['causal_model'] = m
                                    st.session_state['causal_single_estimate'] = e
                            except Exception as ex:
                                estimates.append({'Treatment': t, 'Causal Estimate': np.nan})
                                refutations.append({'Treatment': t, 'Refutation': f"Error: {ex}"})
                    st.session_state['causal_estimate'] = pd.DataFrame(estimates)
                    st.session_state['causal_refutation'] = pd.DataFrame(refutations)
                    st.session_state['causal_variables'] = {'treatments': treatments, 'outcome': outcome, 'confounders': confounders}

            if 'causal_estimate' in st.session_state and st.session_state['causal_estimate'] is not None:
                st.subheader("Estimates")
                st.dataframe(st.session_state['causal_estimate'].style.format({'Causal Estimate': '{:,.4f}'}))
                st.subheader("Robustness checks")
                for _, row in st.session_state['causal_refutation'].iterrows():
                    with st.expander(f"Refutation: {row['Treatment']}"):
                        st.text(row['Refutation'])

        elif "What-if" in task:
            if not st.session_state.get('causal_model'):
                st.warning("Run a single-treatment Effect Estimation first.")
            else:
                m = st.session_state['causal_model']
                e = st.session_state['causal_single_estimate']
                treatment = st.session_state['causal_variables']['treatments'][0]
                idx = st.slider("Data point index", 0, len(features_df) - 1, 0)
                selected = features_df.iloc[[idx]]
                st.dataframe(selected)
                orig_t = float(selected[treatment].iloc[0])
                cf_val = st.number_input(f"What if '{treatment}' had been...", value=orig_t)
                if st.button("Estimate counterfactual"):
                    try:
                        import statsmodels.api as sm
                        linear_model = e.estimator.model
                        cf_point = selected.copy()
                        cf_point[treatment] = cf_val
                        confounders = st.session_state['causal_variables']['confounders']
                        predictor_cols = [treatment] + confounders
                        X_df = cf_point[predictor_cols]
                        model_feat = [n for n in linear_model.model.exog_names if n != 'const']
                        if len(predictor_cols) == len(model_feat):
                            rename_map = dict(zip(predictor_cols, model_feat))
                            X_renamed = X_df.rename(columns=rename_map)
                            X_const = sm.add_constant(X_renamed, has_constant='add')
                            X_aligned = X_const[linear_model.model.exog_names]
                            cf_out = float(linear_model.predict(X_aligned).iloc[0])
                            orig_out = float(selected[outcome].iloc[0])
                            c1, c2, c3 = st.columns(3)
                            c1.metric("Original outcome", f"{orig_out:,.2f}")
                            c2.metric("Counterfactual", f"{cf_out:,.2f}")
                            c3.metric("Estimated change", f"{cf_out - orig_out:,.2f}")
                    except Exception as ex:
                        st.error(f"Counterfactual failed: {ex}")

        else:  # Root Cause Analysis
            use_all_conf = st.checkbox("Control for all other variables in each test", value=True)
            if st.button("Find key drivers"):
                results = []
                pb = st.progress(0, text="Analyzing...")
                for i, t in enumerate(potential):
                    confs = [f for f in potential if f != t] if use_all_conf else []
                    try:
                        m = CausalModel(data=features_df, treatment=t, outcome=outcome, common_causes=confs)
                        est = m.identify_effect(proceed_when_unidentifiable=True)
                        e = m.estimate_effect(est, method_name="backdoor.linear_regression")
                        results.append({'Feature (Cause)': t, 'Estimated Causal Effect': float(e.value)})
                    except Exception:
                        results.append({'Feature (Cause)': t, 'Estimated Causal Effect': np.nan})
                    pb.progress((i + 1) / len(potential), text=f"Analyzing {t}...")
                pb.empty()
                rdf = pd.DataFrame(results).dropna()
                if not rdf.empty:
                    rdf['abs_effect'] = rdf['Estimated Causal Effect'].abs()
                    rdf = rdf.sort_values('abs_effect', ascending=False).drop(columns=['abs_effect'])
                    st.dataframe(rdf.style.format({'Estimated Causal Effect': '{:,.4f}'}))
                    fig = px.bar(rdf.head(15), x='Estimated Causal Effect', y='Feature (Cause)',
                                  orientation='h', title='Top 15 Causal Drivers')
                    fig.update_layout(yaxis={'categoryorder': 'total ascending'})
                    st.plotly_chart(fig, use_container_width=True)
    except Exception as e:
        st.error(f"Causal analysis error: {e}")


# -----------------------------------------------------------------
# A11.  WHAT-IF SCENARIOS TAB
# -----------------------------------------------------------------
def render_whatif_tab():
    st.header("What-If Scenarios")
    st.caption("Simulate the impact of feature changes on the forecast — with optional causal adjustment.")
    result = st.session_state.get('ss_forecast')
    if result is None:
        st.info("Run a single-series multi-model forecast first.")
        return
    forecaster = result['forecaster']
    if forecaster.exog_forecast is None:
        st.warning("This forecast has no exogenous features to manipulate.")
        return

    exog_features = forecaster.exog_forecast.columns.tolist()
    if 'whatif_rules' not in st.session_state:
        st.session_state['whatif_rules'] = []

    st.markdown("#### 1. Build your scenario")
    with st.form("whatif_form"):
        c1, c2, c3 = st.columns(3)
        feat = c1.selectbox("Feature to change", exog_features)
        change_type = c2.selectbox("Type of change",
                                    ["Percentage Change", "Constant Change", "Set to New Value"])
        if change_type == "Percentage Change":
            change_value = c3.number_input("Percent (%)", value=10.0, step=1.0)
        elif change_type == "Constant Change":
            change_value = c3.number_input("Value to add/subtract", value=100.0, step=10.0)
        else:
            change_value = c3.number_input("Set to", value=1.0, step=1.0)
        if st.form_submit_button("Add change"):
            st.session_state['whatif_rules'].append({
                'Feature': feat, 'Type of Change': change_type, 'Value': change_value
            })
            st.rerun()

    st.markdown("#### 2. Current scenario")
    if not st.session_state['whatif_rules']:
        st.info("No rules yet.")
    else:
        st.dataframe(pd.DataFrame(st.session_state['whatif_rules']))
        if st.button("Clear scenario"):
            st.session_state['whatif_rules'] = []
            st.rerun()

    st.markdown("#### 3. Run simulation")
    baseline = result['final_forecast']
    min_d = baseline.index.min(); max_d = baseline.index.max()
    c1, c2 = st.columns(2)
    start_d = c1.date_input("Start", value=min_d, min_value=min_d, max_value=max_d, key='wi_start')
    end_d = c2.date_input("End", value=max_d, min_value=min_d, max_value=max_d, key='wi_end')

    # Causal adjustment option (single rule + matching DoWhy estimate)
    use_causal = False
    causal_available = (
        len(st.session_state['whatif_rules']) == 1
        and isinstance(st.session_state.get('causal_estimate'), pd.DataFrame)
        and st.session_state.get('causal_single_estimate') is not None
    )
    if causal_available:
        rule = st.session_state['whatif_rules'][0]
        treatments = st.session_state.get('causal_variables', {}).get('treatments', [])
        if len(treatments) == 1 and treatments[0] == rule['Feature']:
            use_causal = st.checkbox("Apply causal estimate from DoWhy", value=True)

    if st.button("Run what-if scenario", use_container_width=True):
        if not st.session_state['whatif_rules']:
            st.warning("Add at least one change.")
            return

        if use_causal:
            rule = st.session_state['whatif_rules'][0]
            ate = float(st.session_state['causal_estimate'][
                st.session_state['causal_estimate']['Treatment'] == rule['Feature']]
                ['Causal Estimate'].iloc[0])
            orig_exog = forecaster.exog_forecast.copy()
            mask = (orig_exog.index >= pd.to_datetime(start_d)) & (orig_exog.index <= pd.to_datetime(end_d))
            if rule['Type of Change'] == "Percentage Change":
                delta_f = orig_exog.loc[mask, rule['Feature']] * (rule['Value'] / 100)
            elif rule['Type of Change'] == "Constant Change":
                delta_f = rule['Value']
            else:
                delta_f = rule['Value'] - orig_exog.loc[mask, rule['Feature']]
            sales_impact = delta_f * ate
            whatif = baseline.copy()
            whatif.loc[mask] = whatif.loc[mask] + sales_impact
        else:
            model_name = result['best_model_result']['model_name']
            if model_name not in ['prophet', 'auto_arima', 'sarimax']:
                st.warning(f"What-if re-forecast not supported for {model_name.upper()}. "
                            "Re-run with Prophet / AutoARIMA / SARIMAX, or use causal adjustment.")
                return
            scenario_exog = forecaster.exog_forecast.copy()
            mask = (scenario_exog.index >= pd.to_datetime(start_d)) & (scenario_exog.index <= pd.to_datetime(end_d))
            for rule in st.session_state['whatif_rules']:
                f, t, v = rule['Feature'], rule['Type of Change'], rule['Value']
                if t == "Percentage Change":
                    scenario_exog.loc[mask, f] *= (1 + v / 100)
                elif t == "Constant Change":
                    scenario_exog.loc[mask, f] += v
                else:
                    scenario_exog.loc[mask, f] = v
            base_model = result['best_model_result'].get('model_object')
            whatif = None
            try:
                if model_name == 'prophet' and base_model is not None:
                    fut = base_model.make_future_dataframe(periods=len(forecaster.exog_forecast),
                                                            freq=forecaster.eda.resample_freq)
                    fut = fut.merge(scenario_exog, left_on='ds', right_index=True, how='left').ffill().bfill()
                    p = base_model.predict(fut)
                    whatif = pd.Series(p['yhat'].values[-len(forecaster.exog_forecast):],
                                        index=forecaster.exog_forecast.index)
                elif model_name == 'auto_arima' and base_model is not None:
                    whatif = base_model.predict(n_periods=len(scenario_exog), X=scenario_exog)
                    whatif.index = scenario_exog.index
                elif model_name == 'sarimax' and base_model is not None:
                    whatif = base_model.forecast(steps=len(scenario_exog), exog=scenario_exog)
            except Exception as ex:
                st.error(f"Re-forecast failed: {ex}")
                return

        if whatif is not None:
            tot_o, tot_w = baseline.sum(), whatif.sum()
            delta = tot_w - tot_o
            pct = (delta / tot_o) * 100 if tot_o != 0 else 0
            c1, c2, c3 = st.columns(3)
            c1.metric("Baseline total", f"{tot_o:,.0f}")
            c2.metric("Scenario total", f"{tot_w:,.0f}", delta=f"{delta:,.0f}")
            c3.metric("Change %", f"{pct:.2f}%")
            fig = go.Figure()
            fig.add_trace(go.Scatter(x=baseline.index, y=baseline, name='Baseline',
                                      mode='lines', line=dict(dash='dot')))
            fig.add_trace(go.Scatter(x=whatif.index, y=whatif, name='Scenario',
                                      mode='lines', line=dict(color=DHISHAAI_ORANGE)))
            fig.update_layout(title="Baseline vs Scenario", height=440)
            st.plotly_chart(fig, use_container_width=True)


# =================================================================
# UNIFIED 7-TAB WORKFLOW
#   Tab 1: Data         — preview, validation, quality, about
#   Tab 2: EDA          — portfolio overview + per-SKU drill-down
#   Tab 3: Profile      — SKU intermittency classification + routing
#   Tab 4: Forecast     — portfolio routed forecast + per-SKU multi-model
#   Tab 5: Performance  — accuracy diagnostics
#   Tab 6: Scenarios    — what-if + causal adjustment
#   Tab 7: Report       — HTML / PDF export hub
# =================================================================

# -----------------------------------------------------------------
# B1.  DATA TAB — preview + validation + quality
# -----------------------------------------------------------------
def render_data_tab(cfg):
    """Step 1: load and validate the dataset. Segmentation now lives in the
    unified Step 3 (Profile & Route), combined with intermittency profiling."""
    df = st.session_state.df_raw
    date_col, sku_col, sales_col = cfg['date_col'], cfg['sku_col'], cfg['sales_col']

    # Capability detection — every dataset gets segmented; revenue/brand/truth are bonus.
    has_revenue = 'revenue' in df.columns
    has_brand = 'brand' in df.columns
    has_truth = 'segments' in df.columns                         # ground-truth label column
    is_demo_data = has_truth and has_revenue and 'latest_sku' in df.columns
    rev_col_to_use = 'revenue' if has_revenue else None

    # ---- Hero header ----
    if is_demo_data:
        hero_title = "Titan Watches · Marketplace Channel"
        hero_sub = "Multi-brand portfolio · monthly granularity · price-band aware"
    else:
        hero_title = "Demand Dataset Loaded"
        hero_sub = ("Validate the schema & data quality here, then head to "
                    "Step 3 · Profile & Route to segment and classify the portfolio.")

    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:22px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='display:flex;align-items:center;justify-content:space-between;'>
                <div>
                    <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                                opacity:0.85;font-weight:600;'>Step 1 · Data</div>
                    <div style='font-size:1.7rem;font-weight:700;margin-top:6px;'>{hero_title}</div>
                    <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>{hero_sub}</div>
                </div>
                <div style='text-align:right;font-size:0.85rem;opacity:0.85;'>
                    <div><b style='color:{DHISHAAI_ORANGE};'>LOADED</b></div>
                    <div>Validate &amp; explore</div>
                </div>
            </div>
        </div>
    """, unsafe_allow_html=True)

    # ---- KPIs ----
    try:
        if cfg['date_format']:
            dts = pd.to_datetime(df[date_col], format=cfg['date_format'], errors='coerce')
        else:
            dts = pd.to_datetime(df[date_col], errors='coerce')
        n_dt_bad = int(dts.isna().sum())
        date_min = dts.min().date(); date_max = dts.max().date()
        n_months = ((date_max.year - date_min.year) * 12 + date_max.month - date_min.month) + 1
    except Exception:
        n_dt_bad = -1; date_min = date_max = None; n_months = 0

    n_skus = df[sku_col].nunique()
    n_rev = df['revenue'].sum() if 'revenue' in df.columns else None
    n_brands = df['brand'].nunique() if 'brand' in df.columns else None

    c1, c2, c3, c4 = st.columns(4)
    with c1:
        st.markdown(f"<div class='kpi-card'><div class='kpi-label'>SKUs</div>"
                    f"<div class='kpi-value'>{n_skus:,}</div>"
                    f"<div class='kpi-sub'>across {n_brands or '—'} brands</div></div>",
                    unsafe_allow_html=True)
    with c2:
        st.markdown(f"<div class='kpi-card'><div class='kpi-label'>Observations</div>"
                    f"<div class='kpi-value'>{len(df):,}</div>"
                    f"<div class='kpi-sub'>{len(df.columns)} columns</div></div>",
                    unsafe_allow_html=True)
    with c3:
        rng = f"{date_min} → {date_max}" if date_min else "—"
        st.markdown(f"<div class='kpi-card'><div class='kpi-label'>Time span</div>"
                    f"<div class='kpi-value'>{n_months} mo</div>"
                    f"<div class='kpi-sub'>{rng}</div></div>",
                    unsafe_allow_html=True)
    with c4:
        if n_rev is not None and n_rev > 0:
            rev_str = f"₹{n_rev/1e7:.1f} Cr" if n_rev > 1e7 else f"₹{n_rev/1e5:.1f} L"
            st.markdown(f"<div class='kpi-card'><div class='kpi-label'>Total revenue</div>"
                        f"<div class='kpi-value'>{rev_str}</div>"
                        f"<div class='kpi-sub'>historical actual</div></div>",
                        unsafe_allow_html=True)
        else:
            st.markdown(f"<div class='kpi-card'><div class='kpi-label'>Total sales (units)</div>"
                        f"<div class='kpi-value'>{df[sales_col].sum():,.0f}</div>"
                        f"<div class='kpi-sub'>across all SKUs</div></div>",
                        unsafe_allow_html=True)

    st.write("")  # spacer

    # =================================================================
    # SUB-TABS — Data is now load + validate only. Segmentation moved to
    # the unified "Profile & Route" step (after EDA), where it shares one
    # per-SKU pass with intermittency profiling instead of computing twice.
    #   • Quality   — schema, quality checks, preview
    #   • Help      — workflow narrative + about
    # =================================================================
    sub_quality, sub_help = st.tabs([
        "🔎  Quality & Schema",
        "ℹ️  About this step",
    ])

    with sub_quality:
        _render_data_quality_subtab(df, cfg, sales_col, date_col, sku_col,
                                    n_dt_bad=n_dt_bad, is_demo_data=is_demo_data)

    with sub_help:
        st.info("Segmentation (Volatility × Contribution) now runs as **Phase 1 of "
                "Step 3 · Profile & Route**, combined with intermittency profiling "
                "into a single classification pass.")
        st.markdown("""
**DhishaAI Time Lens v2** is a **portfolio-scale demand forecasting engine** tuned for retail.

**The unified 7-step workflow:**
1. **Data** — load + validate portfolio _(you're here)_
2. **EDA** — explore patterns, decomposition, anomalies
3. **Profile & Route** — segment (Volatility × Contribution) + classify intermittency (Smooth / Erratic / Intermittent / Lumpy) + route to model family, in one step
4. **Forecast** — portfolio-routed forecasts + per-SKU multi-model competition
5. **Performance** — accuracy diagnostics (WMAPE / SMAPE / bias) by SKU, segment, brand
6. **Scenarios** — what-if simulations + causal adjustment (DoWhy)
7. **Report** — exec-ready HTML download for stakeholders
""")


def _render_data_segmentation_subtab(*, df, cfg, sku_col, date_col, sales_col,
                                       has_revenue, has_brand, has_truth,
                                       rev_col_to_use, n_total, date_min, date_max):
    """Segmentation phase (Volatility × Contribution) — Phase 1 of the unified
    Profile & Route step.

    State machine + side effects (df['segment'] injection, profile-cache
    invalidation, DB validate/save) are unchanged; it was relocated out of the
    Data tab so segmentation and intermittency profiling form one step after
    EDA and share a single per-SKU statistical pass.
    """
    # =================================================================
    # Routing Segments — State machine
    #   unknown   → 'Are routing segments available?' (check DB, offer Run)
    #   computing → just clicked Run, compute now and advance
    #   computed  → results visible, awaiting Validate & Save
    #   validated → written to DB, audit banner
    #   loaded_from_db → previously-saved labels reused
    # =================================================================
    st.markdown("### Routing Segments — Volatility × Contribution")

    # ---- Always-visible: methodology + threshold knobs ----
    with st.expander("How segmentation works  ·  Logic & thresholds", expanded=False):
        contrib_basis_doc = ("**revenue**" if has_revenue
                             else "**sales volume × n_periods** (no `revenue` column found)")
        st.markdown(f"""
**Each SKU gets ONE classification — demand pattern × contribution — in a single
deterministic pass (no ML, no randomness). Pattern and volatility can never
disagree because volatility is *derived from* the pattern.**

1. **History check.** SKU must have ≥ `min_periods` non-null sales observations.
   Below that, segment = `CV NULL/0` (treat as cold-start / NPI proxy).
2. **Demand pattern (Syntetos-Boylan-Croston).** From the sales series compute
   **ADI** = mean interval between non-zero demands and **CV²** = squared CV of
   the non-zero demand. Classify against the standard cutoffs (ADI 1.32, CV² 0.49):
   - **smooth** (ADI < 1.32, CV² < 0.49) · **erratic** (ADI < 1.32, CV² ≥ 0.49)
   - **intermittent** (ADI ≥ 1.32, CV² < 0.49) · **lumpy** (ADI ≥ 1.32, CV² ≥ 0.49) · **dead** (no demand)
3. **Volatility = the pattern, summarised.** **smooth ⇒ Stable**;
   **erratic / intermittent / lumpy ⇒ Volatile**; **dead ⇒ CV NULL/0**.
   (Overall `CV = σ ÷ μ` is still shown for context, but it no longer sets the
   label — that's what used to let a "Stable" SKU also read "erratic".)
4. **Contribution label (Pareto-ABC).** SKUs are ranked descending by {contrib_basis_doc};
   cumulative share is computed. Apply two cuts:
   - cum-share ≤ `top_cum_share`  ⇒ **High** contributor (e.g. top 40% of revenue)
   - cum-share ≤ `mid_cum_share`  ⇒ **Mid** contributor
   - otherwise                     ⇒ **Low** contributor

**Final segment** = (pattern → Stable/Volatile) × Contribution → 6 cells
(plus `CV NULL/0` triage bucket). Recomputable, auditable, and reproducible
from the saved run record.
""")
        # Volatility is derived from the SBC demand pattern (ADI/CV² with the
        # fixed 1.32 / 0.49 cutoffs), so there is no CV cut-off knob to tune.
        # cv_thr is kept as a constant purely so the audit record
        # (save_validated_segments) still has a value to store.
        cv_thr = 1.15
        tc1, tc2, tc3 = st.columns(3)
        hi_share = tc1.number_input(
            "Top contributors cum-share", min_value=0.10, max_value=0.70,
            value=0.40, step=0.05, key='seg_hi',
            help="SKUs covering this much cumulative revenue (top-down) become 'High contributors'.",
        )
        mid_share = tc2.number_input(
            "Mid contributors cum-share", min_value=0.50, max_value=0.99,
            value=0.85, step=0.01, key='seg_mid',
            help="SKUs covering this much cum-rev become 'Mid'; rest become 'Low'. "
                 "Must be greater than top-contributors cut-off.",
        )
        min_per = tc3.number_input(
            "Min periods (history check)", min_value=2, max_value=24, value=3, step=1,
            key='seg_min_per',
            help="SKUs with fewer observations are tagged 'CV NULL/0' (apply NPI proxy).",
        )
        if mid_share <= hi_share:
            st.warning("Mid cut-off must be greater than Top cut-off. Auto-adjusting to Top + 0.30.")
            mid_share = min(0.99, hi_share + 0.30)

        # ── Lifecycle thresholds (drive New / Churned / Short history) ──
        st.caption(
            "**Lifecycle overrides** — SKUs that match these conditions are "
            "tagged with their lifecycle status instead of a volatility×"
            "contribution segment."
        )
        lc1, lc2, lc3 = st.columns(3)
        new_prod_m = lc1.number_input(
            "New product window (months)", min_value=1, max_value=24, value=3, step=1,
            key='seg_new_prod_m',
            help="SKUs whose first sale falls within this many months of the "
                 "latest data point are tagged **New product**.",
        )
        churn_m = lc2.number_input(
            "Churn window (months)", min_value=1, max_value=24, value=3, step=1,
            key='seg_churn_m',
            help="SKUs whose last sale is older than this many months "
                 "(relative to the latest data point) are tagged **Churned "
                 "product** — likely discontinued or out-of-stock.",
        )
        short_hist_m = lc3.number_input(
            "Short history threshold (months)", min_value=2, max_value=24, value=6, step=1,
            key='seg_short_hist_m',
            help="SKUs with fewer than this many non-null months — and not "
                 "new/churned — are tagged **Short history** and routed to "
                 "the global pooled model.",
        )

    seg_params = dict(cv_threshold=cv_thr, high_cum_share=hi_share,
                      mid_cum_share=mid_share, min_periods=min_per,
                      new_product_months=new_prod_m, churn_months=churn_m,
                      short_history_months=short_hist_m)

    # ---- Check database for previously-validated labels ----
    sku_list = sorted(df[sku_col].astype(str).unique().tolist())
    try:
        existing_df = load_existing_segments(sku_list)
    except Exception as _e:
        st.warning(f"Segment DB unavailable ({_e}). Continuing without persistence.")
        existing_df = pd.DataFrame()
    n_total = len(sku_list)
    n_known = int(existing_df['sku'].nunique()) if len(existing_df) else 0
    coverage = (100 * n_known / n_total) if n_total else 0

    status = st.session_state.get('seg_flow_status', 'unknown')

    # ---- STATE: unknown — offer DB-load OR Run ----
    if status == 'unknown':
        if n_known > 0:
            latest_at = pd.to_datetime(existing_df['validated_at']).max()
            latest_run = existing_df.sort_values('validated_at', ascending=False).iloc[0]
            st.markdown(f"""
                <div style='background:#ecfdf5;border:1px solid #10b981;border-radius:10px;
                            padding:14px 18px;margin-bottom:10px;'>
                    <div style='font-weight:700;color:#065f46;font-size:1.05rem;'>
                        ✓ Routing segments found in database
                    </div>
                    <div style='color:#065f46;margin-top:6px;font-size:0.9rem;'>
                        <b>{n_known:,} / {n_total:,}</b> SKUs ({coverage:.0f}% coverage) already
                        validated. Latest run: <code>{latest_run['run_id']}</code>
                        on <b>{latest_at:%Y-%m-%d %H:%M}</b>
                        by <b>{latest_run.get('validated_by', '—')}</b>
                        · volatility = SBC pattern (smooth ⇒ Stable),
                        contribution cuts: High ≤ {latest_run.get('high_cum_share', '—')},
                        Mid ≤ {latest_run.get('mid_cum_share', '—')}.
                    </div>
                </div>
            """, unsafe_allow_html=True)
            if coverage < 100:
                st.warning(f"⚠ {n_total - n_known:,} SKUs are **new** — they have no saved label. "
                           "Loading from DB will leave them unsegmented. "
                           "Recommend **Re-run** to label everything consistently.")
            cA, cB = st.columns(2)
            if cA.button(f"📥  Load saved segments ({n_known:,} SKUs)",
                         type='primary' if coverage == 100 else 'secondary',
                         use_container_width=True, key='btn_load_db'):
                loaded = existing_df.rename(columns={'sku': sku_col})
                st.session_state.retail_seg_df = loaded
                st.session_state.seg_flow_status = 'loaded_from_db'
                st.session_state.seg_flow_run_id = loaded['run_id'].mode().iloc[0]
                st.rerun()
            if cB.button("▶️  Re-run segmentation (compute fresh)",
                         type='primary' if coverage < 100 else 'secondary',
                         use_container_width=True, key='btn_rerun_seg'):
                st.session_state.seg_flow_status = 'computing'
                st.rerun()
        else:
            st.info(
                "**No routing segments found in the database for these SKUs.** "
                "Run segmentation to compute Volatility × Contribution labels, "
                "review them, then validate to persist for future runs."
            )
            if st.button("▶️  Run Segmentation", type='primary',
                         use_container_width=True, key='btn_run_seg_initial'):
                st.session_state.seg_flow_status = 'computing'
                st.rerun()

    # ---- STATE: computing — do the work, advance ----
    if status == 'computing':
        try:
            with st.spinner("Computing CV × Pareto-ABC for each SKU…"):
                seg_df_new = compute_retail_segmentation(
                    df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
                    revenue_col=rev_col_to_use,
                    cv_threshold=cv_thr, high_cum_share=hi_share,
                    mid_cum_share=mid_share, min_periods=min_per,
                    new_product_months=new_prod_m, churn_months=churn_m,
                    short_history_months=short_hist_m,
                    date_format=cfg.get('date_format'),
                )
            st.session_state.retail_seg_df = seg_df_new
            st.session_state.seg_flow_status = 'computed'
            status = 'computed'
        except Exception as e:
            st.error(f"Segmentation failed: {e}")
            st.exception(e)
            st.session_state.seg_flow_status = 'unknown'
            return

    # ---- RENDER segment dashboard whenever we have a result ----
    if status in ('computed', 'validated', 'loaded_from_db'):
        seg_df = st.session_state.retail_seg_df

        # --- Defensive: ensure the SKU column in seg_df matches cfg['sku_col'] ---
        # seg_df can arrive from 3 paths: fresh compute (col=cfg['sku_col']),
        # DB load (col='sku', renamed on click but possibly stale in session_state),
        # or an older session_state slot. Reconcile here so everything downstream
        # can trust `seg_df[sku_col]`.
        if sku_col not in seg_df.columns:
            renamed = False
            # Try the DB's canonical 'sku' column first
            if 'sku' in seg_df.columns:
                seg_df = seg_df.rename(columns={'sku': sku_col})
                renamed = True
            else:
                # Last-resort: any non-segment string column with high uniqueness
                meta_cols = {'segment','volatility','contribution','cv','mean_sales',
                             'std_sales','total_revenue','n_periods','rev_share_pct',
                             'cum_rev_share','run_id','validated_at','cv_threshold',
                             'high_cum_share','mid_cum_share','min_periods','validated_by'}
                candidates = [c for c in seg_df.columns
                              if c not in meta_cols
                              and seg_df[c].dtype == object
                              and seg_df[c].nunique() == len(seg_df)]
                if candidates:
                    seg_df = seg_df.rename(columns={candidates[0]: sku_col})
                    renamed = True
            if not renamed:
                st.error(
                    f"Stored segments are missing a SKU column named '{sku_col}'. "
                    f"Available columns: {list(seg_df.columns)}. "
                    "Click **🔄 Re-segment** below to rebuild from the current data."
                )
                # Recovery: drop the bad cached result so 'unknown' state is shown next run
                st.session_state.seg_flow_status = 'unknown'
                if st.button("🔄  Reset segmentation state", key='btn_reset_stale'):
                    st.session_state.pop('retail_seg_df', None)
                    st.session_state.pop('seg_flow_run_id', None)
                    st.rerun()
                return
            st.session_state.retail_seg_df = seg_df   # persist the cleaned-up frame

        # Ensure cum_rev_share is present (DB-loaded rows don't carry it)
        if 'cum_rev_share' not in seg_df.columns and 'rev_share_pct' in seg_df.columns:
            seg_df = seg_df.sort_values('total_revenue', ascending=False).reset_index(drop=True)
            seg_df['cum_rev_share'] = seg_df['rev_share_pct'].cumsum() / 100.0
            st.session_state.retail_seg_df = seg_df

        # Status ribbon
        if status == 'computed':
            st.markdown(
                "<div style='background:#fef3c7;border-left:4px solid #f59e0b;"
                "padding:10px 14px;border-radius:6px;margin:10px 0;'>"
                "<b>⏳ Computed — awaiting validation.</b> "
                "Review the segments below, then click <b>Validate & Save</b> at the bottom "
                "to persist them to the database."
                "</div>", unsafe_allow_html=True)
        elif status == 'validated':
            run_id = st.session_state.get('seg_flow_run_id', '—')
            st.markdown(
                f"<div style='background:#ecfdf5;border-left:4px solid #10b981;"
                f"padding:10px 14px;border-radius:6px;margin:10px 0;'>"
                f"<b>✓ Validated & saved.</b> Run <code>{run_id}</code> — these labels are now "
                f"the canonical routing segments. Future runs on the same SKUs will auto-load them."
                f"</div>", unsafe_allow_html=True)
        elif status == 'loaded_from_db':
            run_id = st.session_state.get('seg_flow_run_id', '—')
            st.markdown(
                f"<div style='background:#eff6ff;border-left:4px solid #3b82f6;"
                f"padding:10px 14px;border-radius:6px;margin:10px 0;'>"
                f"<b>📥 Loaded from database.</b> Run <code>{run_id}</code> — "
                f"previously-validated labels reused."
                f"</div>", unsafe_allow_html=True)

        # 6-segment matrix
        seg_counts = seg_df['segment'].value_counts()
        seg_rev = seg_df.groupby('segment')['total_revenue'].sum()
        total_rev_all = seg_rev.sum()

        def _seg_card(seg_name):
            count = int(seg_counts.get(seg_name, 0))
            rev = seg_rev.get(seg_name, 0)
            rev_pct = 100*rev/total_rev_all if total_rev_all else 0
            playbook = SEGMENT_PLAYBOOK.get(seg_name, {})
            color = playbook.get('color', '#64748b')
            strategy = playbook.get('strategy', '')
            forecast = playbook.get('forecast', '')
            rev_label = "rev" if has_revenue else "vol"
            # Card now surfaces the Model recommendation in its own band
            # (with brand-color tint) so users see it at-a-glance — this
            # mirrors the cards on the Profile & Route tab.
            return (f"<div class='kpi-card' style='border-left:4px solid {color};padding:0;overflow:hidden;'>"
                    f"<div style='padding:14px 18px 8px 18px;'>"
                    f"<div class='kpi-label'>{seg_name}</div>"
                    f"<div style='display:flex;justify-content:space-between;"
                    f"align-items:baseline;margin-top:6px;'>"
                    f"<div class='kpi-value' style='color:{color};'>{count:,}</div>"
                    f"<div style='font-size:0.95rem;color:#6b7785;font-weight:600;'>"
                    f"{rev_pct:.1f}% {rev_label}</div></div>"
                    f"<div class='kpi-sub' style='margin-top:6px;line-height:1.35;'>{strategy}</div>"
                    f"</div>"
                    f"<div style='background:linear-gradient(90deg,{color}1a 0%,{color}0a 100%);"
                    f"border-top:1px solid {color}33;padding:8px 18px 10px 18px;'>"
                    f"<div style='font-size:0.62rem;font-weight:700;letter-spacing:0.08em;"
                    f"color:{color};text-transform:uppercase;'>🎯 Recommended model</div>"
                    f"<div style='font-size:0.78rem;color:#1e293b;margin-top:3px;"
                    f"line-height:1.35;font-weight:500;'>{forecast}</div>"
                    f"</div></div>")

        # Row 1 — Stable contributors
        r1c1, r1c2, r1c3 = st.columns(3)
        r1c1.markdown(_seg_card('Stable High contributors'), unsafe_allow_html=True)
        r1c2.markdown(_seg_card('Stable Mid contributors'), unsafe_allow_html=True)
        r1c3.markdown(_seg_card('Stable Low contributors'), unsafe_allow_html=True)
        # Row 2 — Volatile contributors
        r2c1, r2c2, r2c3 = st.columns(3)
        r2c1.markdown(_seg_card('Volatile High contributors'), unsafe_allow_html=True)
        r2c2.markdown(_seg_card('Volatile Mid contributors'), unsafe_allow_html=True)
        r2c3.markdown(_seg_card('Volatile Low contributors'), unsafe_allow_html=True)
        # Row 3 — Lifecycle overrides (always shown so the playbook is
        # visible even when a particular dataset has zero SKUs in that
        # bucket — helps planners know what would happen on a future
        # snapshot where lifecycle conditions DO trigger).
        st.markdown(
            "<div style='font-size:0.75rem;color:#64748b;text-transform:uppercase;"
            "letter-spacing:0.08em;margin-top:14px;margin-bottom:4px;font-weight:700;'>"
            "Lifecycle overrides (priority over volatility×contribution)"
            "</div>", unsafe_allow_html=True)
        r3c1, r3c2, r3c3 = st.columns(3)
        r3c1.markdown(_seg_card('New product'), unsafe_allow_html=True)
        r3c2.markdown(_seg_card('Churned product'), unsafe_allow_html=True)
        r3c3.markdown(_seg_card('Short history'), unsafe_allow_html=True)

        # CV NULL/0 — show only if there are any (cold-start / NPI SKUs)
        n_null = int(seg_counts.get('CV NULL/0', 0))
        if n_null > 0:
            st.markdown(_seg_card('CV NULL/0'), unsafe_allow_html=True)

        # Sanity check — every SKU must appear in exactly one card
        total_carded = int(seg_counts.sum())
        _recognised_labels = {
            'Stable High contributors', 'Stable Mid contributors',
            'Stable Low contributors', 'Volatile High contributors',
            'Volatile Mid contributors', 'Volatile Low contributors',
            'New product', 'Churned product', 'Short history',
            'CV NULL/0',
        }
        if total_carded != len(seg_df):
            unrecognised = set(seg_counts.index) - _recognised_labels
            st.warning(f"⚠ {len(seg_df) - total_carded} SKU(s) not displayed. "
                       f"Unrecognised labels: {unrecognised}")

        # ---- Per-SKU trace inspector — THE confidence-builder ----
        with st.expander("🔍 Trace a SKU — show the exact arithmetic", expanded=False):
            st.caption("Pick any SKU to see the 4-step derivation of its segment label, with real numbers.")
            sku_options = seg_df.sort_values('total_revenue', ascending=False)[sku_col].astype(str).tolist()
            picked = st.selectbox("SKU", options=sku_options, index=0, key='trace_sku')
            row = seg_df[seg_df[sku_col].astype(str) == str(picked)].iloc[0]
            trace = explain_sku_segment(row, seg_params)
            playbook = SEGMENT_PLAYBOOK.get(trace['final'], {})
            color = playbook.get('color', '#64748b')
            # Header card
            st.markdown(
                f"<div style='background:#f8fafc;border-left:4px solid {color};"
                f"padding:12px 16px;border-radius:8px;margin-bottom:12px;'>"
                f"<div style='font-size:0.8rem;color:#6b7785;text-transform:uppercase;"
                f"letter-spacing:0.06em;'>Final label</div>"
                f"<div style='font-size:1.3rem;font-weight:700;color:{color};margin-top:2px;'>"
                f"{trace['final']}</div>"
                f"<div style='font-size:0.85rem;color:#6b7785;margin-top:4px;'>"
                f"{playbook.get('strategy', '')}</div></div>",
                unsafe_allow_html=True,
            )
            # Step table
            for s in trace['steps']:
                st.markdown(
                    f"<div style='display:flex;gap:14px;padding:8px 0;border-bottom:1px solid #eef2f7;'>"
                    f"<div style='min-width:32px;height:32px;border-radius:50%;background:{color};"
                    f"color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;'>"
                    f"{s['step']}</div>"
                    f"<div style='flex:1;'>"
                    f"<div style='font-weight:600;color:#1e293b;'>{s['name']}</div>"
                    f"<div style='font-size:0.9rem;color:#475569;margin-top:2px;font-family:monospace;'>"
                    f"{s['detail']}</div>"
                    f"<div style='font-size:0.85rem;color:#0f766e;margin-top:4px;'>"
                    f"→ {s['verdict']}</div></div></div>",
                    unsafe_allow_html=True,
                )

        # ---- Ground-truth validation panel (only when source segments exist) ----
        if has_truth:
            try:
                truth = df.groupby(sku_col)['segments'].first().to_dict()
                comp = seg_df.copy()
                comp['truth'] = comp[sku_col].map(truth)
                _norm = lambda s: '' if pd.isna(s) else str(s).strip().lower()
                comp['match'] = comp['segment'].apply(_norm) == comp['truth'].apply(_norm)
                match_pct = 100 * comp['match'].mean()
                n_match = int(comp['match'].sum())
                with st.expander(f"Validation vs source `segments` column — {match_pct:.1f}% agreement"):
                    st.caption(f"{n_match:,} of {len(comp):,} SKUs match the source labels. "
                                "Remaining differences arise from manual overrides or older threshold versions.")
                    confusion = pd.crosstab(comp['segment'], comp['truth'], dropna=False)
                    st.dataframe(confusion, use_container_width=True)
            except Exception as _ve:
                st.caption(f"Validation skipped: {_ve}")

        # ---- Brand × Segment breakdown ----
        if has_brand:
            with st.expander("Brand × Segment breakdown"):
                brand_seg = (df[[sku_col, 'brand']].drop_duplicates()
                                .merge(seg_df[[sku_col, 'segment']], on=sku_col, how='left')
                                .groupby(['brand', 'segment']).size().unstack(fill_value=0))
                st.dataframe(brand_seg, use_container_width=True)

        # ---- CSV download ----
        cols_for_export = [c for c in [sku_col, 'segment', 'volatility', 'contribution',
                                        'n_periods', 'mean_sales', 'cv', 'total_revenue',
                                        'rev_share_pct'] if c in seg_df.columns]
        seg_out = seg_df[cols_for_export].copy()
        st.download_button(
            "⬇  Download segmented SKU list (CSV)",
            data=seg_out.to_csv(index=False).encode('utf-8'),
            file_name=f"DhishaAI_Segments_{pd.Timestamp.now():%Y%m%d_%H%M}.csv",
            mime='text/csv', use_container_width=True, key='seg_csv_dl',
        )

        # =================================================================
        # Pipeline injection — make computed/loaded segments the canonical
        # input for profiling + forecasting (NOT the raw `segments` column,
        # which may be absent or stale on a fresh dataset).
        # =================================================================
        sku_to_seg = dict(zip(seg_df[sku_col].astype(str),
                              seg_df['segment'].astype(str)))
        # Inject (or refresh) a `segment` column on df_raw.
        # Idempotent — re-running with different thresholds re-maps cleanly.
        # IMPORTANT: build a fresh DataFrame (df_raw.copy()) so id() changes
        # — multiple downstream caches (profile-df cache, eda cache, etc.)
        # use id(df_raw) for invalidation; in-place mutation would silently
        # leave them stale and the new 'segment' column would never reach
        # the profile / forecast layers.
        df_seg = df.copy()
        df_seg['segment'] = df_seg[sku_col].astype(str).map(sku_to_seg)
        n_unmapped = int(df_seg['segment'].isna().sum())
        df_seg['segment'] = df_seg['segment'].fillna('CV NULL/0')   # safety fallback
        st.session_state.df_raw = df_seg
        df = df_seg  # keep the local ref consistent for the rest of this render

        # Force cfg → segment_col so profiler + panel-feature builder pick it up
        cfg['segment_col'] = 'segment'

        # Explicitly invalidate downstream caches that hold pre-segmentation
        # snapshots — the new 'segment' column must reach profile + forecast.
        # NOTE: do NOT pop 'df_processed' here — render_forecast_tab and
        # render_submission_tab read it via attribute access and would
        # AttributeError if it disappears while `profiled` is still True.
        # It's safely refreshed inside the conditional invalidation block
        # below (only when profile gets reset).
        for _k in ('_profile_df_cache', '_profile_df_cache_key',
                   '_eda_cache', '_eda_cache_key'):
            st.session_state.pop(_k, None)

        # If the user re-segments after profiling, invalidate stale downstream caches.
        # Two trigger conditions:
        #   (a) profiling already ran AND the signature drifted from the one
        #       stored at profile time — classic re-segmentation case.
        #   (b) profiling ran BEFORE any segmentation (so signature was never
        #       captured) — old profiles still carry 'unknown' for every SKU
        #       and need to be recomputed with the new labels.
        current_seg_signature = (st.session_state.get('seg_flow_run_id')
                                 or hash(tuple(sorted(sku_to_seg.items()))))
        last_seg_signature = st.session_state.get('_seg_signature_at_profile')
        _prev_profiles = st.session_state.get('profiles')
        _profiles_have_unknown = (
            _prev_profiles is not None
            and 'segment' in _prev_profiles.columns
            and _prev_profiles['segment'].astype(str).str.lower().eq('unknown').any()
        )
        signature_drifted = (
            last_seg_signature is not None
            and last_seg_signature != current_seg_signature
        )
        if st.session_state.get('profiled') and (
            signature_drifted or _profiles_have_unknown or last_seg_signature is None
        ):
            st.session_state.profiled = False
            st.session_state.forecasts_run = False
            st.session_state.pop('profiles', None)
            st.session_state.pop('_seg_signature_at_profile', None)
            # Safe to drop df_processed now — both 'profiled' and
            # 'forecasts_run' are False so no consumer will read it before
            # the user clicks Run Intermittency Profiling again.
            st.session_state.pop('df_processed', None)
            st.info("Segments changed (or were missing) at last Profile/Forecast run — "
                    "those steps will re-execute with the new labels. "
                    "Go to **Profile & Route** and click **Run intermittency profiling** again.")
        elif st.session_state.get('profiled') and 'df_processed' in st.session_state:
            # Profile is still valid (segments unchanged) — but df_raw is now
            # a fresh object containing the 'segment' column. Refresh
            # df_processed so downstream consumers (forecast tab, submission
            # tab) see the column alignment they expect.
            try:
                _old_dp = st.session_state.df_processed
                if 'segment' not in _old_dp.columns:
                    _new_dp = _old_dp.copy()
                    _new_dp['segment'] = _new_dp[sku_col].astype(str).map(sku_to_seg)
                    _new_dp['segment'] = _new_dp['segment'].fillna('CV NULL/0')
                    st.session_state.df_processed = _new_dp
            except Exception:
                # If anything goes wrong, prefer dropping the stale frame
                # so the user is forced to re-profile (clean state) instead
                # of forecasting on a mismatched panel.
                st.session_state.profiled = False
                st.session_state.forecasts_run = False
                st.session_state.pop('df_processed', None)
                st.session_state.pop('profiles', None)

        # Confirmation banner — visible proof to the demo audience
        n_unique = len(set(sku_to_seg.values()))
        warn_html = (f" <span style='color:#b45309;'>· {n_unmapped:,} row(s) "
                     f"had no SKU match (defaulted to CV NULL/0)</span>"
                     if n_unmapped else "")
        st.markdown(
            f"<div style='background:#f0fdfa;border-left:4px solid #14b8a6;"
            f"padding:10px 14px;border-radius:6px;margin-top:10px;font-size:0.9rem;'>"
            f"<b>✓ Routing segments wired into the forecasting pipeline.</b> "
            f"{len(sku_to_seg):,} SKUs labelled across {n_unique} segment classes — "
            f"these are now driving the SKU profiler, LightGBM categorical features, "
            f"and per-SKU model routing.{warn_html}"
            f"</div>", unsafe_allow_html=True,
        )

    # ---- STATE: computed — Validate & Save panel ----
    if status == 'computed':
        st.markdown("---")
        st.markdown("#### ✅  Validate & Save to Database")
        st.caption("Confirming saves these labels with a run-record (thresholds, dataset "
                   "fingerprint, validator, timestamp). Future sessions on these SKUs "
                   "will auto-load them — no re-computation needed.")
        v1, v2 = st.columns([2, 1])
        with v1:
            validator = st.text_input("Validator name (for audit log)",
                                      value=os.environ.get('USER', 'demo_user'),
                                      key='seg_validator_name')
            default_notes = (f"Run on {n_total:,} SKUs"
                             + (f" · {date_min} → {date_max}" if date_min else ""))
            notes = st.text_input("Notes (optional)", value=default_notes,
                                  key='seg_validation_notes')
        with v2:
            st.write(""); st.write("")
            if st.button("Validate & Save", type='primary',
                         use_container_width=True, key='btn_validate'):
                fp = dataset_fingerprint(df, sku_col, date_col, sales_col)
                try:
                    run_id = save_validated_segments(
                        st.session_state.retail_seg_df, sku_col, seg_params,
                        fp, validator, notes,
                    )
                    st.session_state.seg_flow_status = 'validated'
                    st.session_state.seg_flow_run_id = run_id
                    st.rerun()
                except Exception as e:
                    st.error(f"Save failed: {e}")
            if st.button("Discard — re-tune thresholds",
                         use_container_width=True, key='btn_discard'):
                st.session_state.seg_flow_status = 'unknown'
                st.rerun()

    # ---- STATE: validated / loaded_from_db — offer a fresh start ----
    if status in ('validated', 'loaded_from_db'):
        cR1, cR2, cR3 = st.columns([1, 1, 2])
        with cR1:
            if st.button("🔄  Re-segment", use_container_width=True, key='btn_resegment'):
                st.session_state.seg_flow_status = 'unknown'
                st.rerun()
        # Audit trail
        with cR2:
            runs_df = list_segmentation_runs(limit=10)
        with st.expander(f"Audit trail — {len(runs_df)} most recent run(s)"):
            if len(runs_df):
                st.dataframe(runs_df, use_container_width=True, hide_index=True)
            else:
                st.caption("No saved runs yet.")


def _render_data_quality_subtab(df, cfg, sales_col, date_col, sku_col, *,
                                  n_dt_bad: int, is_demo_data: bool):
    """Quality / Schema / Preview sub-tab of the Data page.

    Body extracted from the original linear render_data_tab. Three
    independent expanders, all collapsible — keeps the panel light.
    """
    expanded_q = not is_demo_data
    with st.expander("Data Quality Checks", expanded=expanded_q):
        checks = []
        sales_na = df[sales_col].isna().sum()
        sales_negative = (df[sales_col] < 0).sum() if pd.api.types.is_numeric_dtype(df[sales_col]) else 0
        sales_zero = (df[sales_col] == 0).sum() if pd.api.types.is_numeric_dtype(df[sales_col]) else 0
        dupes = df.duplicated(subset=[date_col, sku_col]).sum()
        checks.append({"Check": "Sales column is numeric",
                       "Status": "✅ Pass" if pd.api.types.is_numeric_dtype(df[sales_col]) else "❌ FAIL",
                       "Details": f"dtype = {df[sales_col].dtype}"})
        checks.append({"Check": "Date column parseable",
                       "Status": "✅ Pass" if n_dt_bad == 0 else ("❌ FAIL" if n_dt_bad < 0 else "⚠ Partial"),
                       "Details": f"{n_dt_bad} unparseable values" if n_dt_bad >= 0 else "Parse error"})
        checks.append({"Check": "No (SKU, date) duplicates",
                       "Status": "✅ Pass" if dupes == 0 else "⚠ Warning",
                       "Details": f"{dupes} duplicate (SKU, date) rows"})
        checks.append({"Check": "No missing sales values",
                       "Status": "✅ Pass" if sales_na == 0 else "⚠ Warning",
                       "Details": f"{sales_na} NaN sales values"})
        checks.append({"Check": "Sales values non-negative",
                       "Status": "✅ Pass" if sales_negative == 0 else "⚠ Warning",
                       "Details": f"{sales_negative} negative values, {sales_zero} zero values"})
        st.dataframe(pd.DataFrame(checks), use_container_width=True, hide_index=True)

    with st.expander("Data preview (first 12 rows)", expanded=False):
        st.dataframe(df.head(12), use_container_width=True, height=300)

    with st.expander("Schema details"):
        schema_df = pd.DataFrame({
            'column': df.columns,
            'dtype': [str(t) for t in df.dtypes],
            'non_null': df.notna().sum().values,
            'unique': [df[c].nunique() for c in df.columns],
            'sample': [str(df[c].dropna().iloc[0])[:60] if df[c].notna().any() else '-' for c in df.columns],
        })
        st.dataframe(schema_df, use_container_width=True, hide_index=True)


# -----------------------------------------------------------------
# B2.  EDA — portfolio overview + per-SKU drill-down (uses df_raw)
# -----------------------------------------------------------------
def render_unified_eda_tab(cfg):
    """Single EDA tab that pulls from the sidebar-loaded data and lets the user
    pick either the whole portfolio or a specific SKU to drill into."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 2 · EDA</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                Exploratory Time-Series Analysis
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Trend, seasonality, decomposition, anomalies, autocorrelation — portfolio or per-SKU
            </div>
        </div>
    """, unsafe_allow_html=True)

    date_col, sku_col, sales_col = cfg['date_col'], cfg['sku_col'], cfg['sales_col']

    # Parse dates ONCE per df_raw — see render_profiling_tab for the same
    # pattern. EDA gets visited repeatedly during exploration, so this trims
    # a meaningful chunk off every tab-switch.
    df_raw = st.session_state.df_raw
    # Include columns tuple — keeps the cache in sync when the Data-tab
    # Retail Segmentation flow injects a 'segment' column (id(df_raw) may
    # remain stable if the seg flow mutates in place).
    _hist_start = cfg.get('history_start_date')
    _eda_key = (id(df_raw), tuple(df_raw.columns), date_col, sales_col,
                cfg.get('date_format'), _hist_start)
    if st.session_state.get('_eda_df_cache_key') != _eda_key:
        df = df_raw.copy()
        if cfg['date_format']:
            df[date_col] = pd.to_datetime(df[date_col], format=cfg['date_format'], errors='coerce')
        else:
            # Auto-detect couldn't pin a format — dayfirst=True so '01/02/22'
            # parses as Feb-1 (DD/MM/YY) rather than pandas' US default
            # Jan-2 (MM/DD/YY), which would dump every observation into Jan.
            df[date_col] = pd.to_datetime(df[date_col], dayfirst=True, errors='coerce')
        df = df.dropna(subset=[date_col, sales_col])
        # Honour the planner's history-start cutoff so EDA matches what
        # the models will see during training.
        if _hist_start is not None:
            df = df[df[date_col] >= pd.Timestamp(_hist_start)].copy()
        st.session_state['_eda_df_cache'] = df
        st.session_state['_eda_df_cache_key'] = _eda_key
    else:
        df = st.session_state['_eda_df_cache']

    # ---- Scope selector ----
    scope = st.radio(
        "Analysis scope",
        ["Portfolio aggregate", "Single SKU (drill-down)"],
        horizontal=True, key='eda_scope',
        help="Portfolio = sum across all SKUs. Single SKU = deep-dive on one product.",
    )

    if scope == "Single SKU (drill-down)":
        sku_volumes = df.groupby(sku_col)[sales_col].sum().sort_values(ascending=False)
        top_n = min(len(sku_volumes), 200)
        sku_choices = sku_volumes.head(top_n).index.tolist()
        sel_sku = st.selectbox(
            f"Pick a SKU (top {top_n} by volume)",
            sku_choices,
            help="Top-volume SKUs are listed first; type to filter.",
        )
        series_df = df[df[sku_col] == sel_sku][[date_col, sales_col]].copy()
        scope_label = f"SKU = {sel_sku}"
    else:
        series_df = df.groupby(date_col, as_index=False)[sales_col].sum()
        scope_label = f"Portfolio aggregate ({df[sku_col].nunique():,} SKUs)"

    if len(series_df) < 4:
        st.warning(f"Not enough rows ({len(series_df)}) for meaningful EDA.")
        return

    # ---- Map cfg['freq'] (MS/W/D/...) to TimeSeriesEDA freq ('M'/'W'/'D'/'Q'/'Y') ----
    freq_map = {'MS': 'M', 'M': 'M', 'W': 'W', 'D': 'D', 'QS': 'Q', 'Q': 'Q', 'YS': 'Y', 'Y': 'Y'}
    eda_freq = freq_map.get(cfg.get('freq', 'MS'), 'M')

    st.info(f"Running EDA on **{scope_label}** at **{eda_freq}** frequency.")
    if st.button("Run EDA", use_container_width=True, key='unified_eda_run'):
        try:
            with st.spinner("Building EDA..."):
                eda = TimeSeriesEDA(
                    series_df, date_col=date_col, sales_col=sales_col,
                    country_code='IN', resample_freq=eda_freq,
                )
                eda.apply_anomaly_corrections(eda.potential_anomalies_df)
                st.session_state['eda_object'] = eda
                st.session_state['eda_scope_label'] = scope_label
                st.success(f"EDA built for {scope_label}.")
        except Exception as e:
            st.error(f"EDA failed: {e}")
            return

    eda = st.session_state.get('eda_object')
    if eda is None:
        return

    st.markdown(f"**Showing EDA for:** {st.session_state.get('eda_scope_label', scope_label)}")

    # ---- Plots ----
    dist_fig, summary = eda.display_data_summary_and_distribution()
    report_data = {'summary_metrics': summary, 'distribution_plot': _figure_to_png_bytes(dist_fig)}

    st.markdown("### Trend")
    report_data['trend_plot'] = _figure_to_png_bytes(eda.plot_trend())

    st.markdown("### Seasonal Decomposition")
    report_data['decomposition_plot'] = _figure_to_png_bytes(eda.plot_decomposition())

    st.markdown("### Anomaly Detection")
    if not eda.potential_anomalies_df.empty:
        with st.expander("Review identified anomalies"):
            edited = st.data_editor(eda.potential_anomalies_df,
                                      key='unified_eda_anomaly_editor')
            if st.button("Apply edits", key='unified_eda_apply'):
                eda.apply_anomaly_corrections(edited)
                st.success("Anomaly edits applied.")
    report_data['anomaly_plot'] = _figure_to_png_bytes(eda.plot_anomaly_detection())

    st.markdown("### ACF & PACF")
    report_data['acf_pacf_plot'] = _figure_to_png_bytes(eda.plot_acf_pacf())

    st.markdown("### Holiday Analysis")
    report_data['holiday_plot'] = _figure_to_png_bytes(eda.analyze_holidays())

    # Stash for the report tab
    st.session_state['eda_report_data'] = report_data


# -----------------------------------------------------------------
# B3.  FORECAST — portfolio routed + drill-down multi-model in one tab
# -----------------------------------------------------------------
def render_unified_forecast_tab(cfg):
    """One Forecast tab combining (a) portfolio-routed forecast and
    (b) per-SKU multi-model drill-down."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 4 · Forecast</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                Generate Demand Predictions
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Portfolio routing for all SKUs · or multi-model competition for one
            </div>
        </div>
    """, unsafe_allow_html=True)

    if not st.session_state.get('profiled'):
        st.warning("Run **Profile & Route** first — this engine routes SKUs by intermittency "
                    "pattern, so it needs the profile classifications before forecasting.")
        return

    mode = st.radio(
        "Forecast mode",
        ["A. Portfolio routed forecast", "B. Single-SKU multi-model competition"],
        horizontal=True, key='fc_mode',
    )

    if mode == "A. Portfolio routed forecast":
        # Existing routed-forecast UI
        render_forecast_tab(cfg)
    else:
        # Drill-down: ensure an EDA object exists for a single SKU
        eda = st.session_state.get('eda_object')
        if eda is None or 'Single SKU' not in st.session_state.get('eda_scope_label', ''):
            st.info("Run **EDA → Single SKU (drill-down)** first to pick the SKU you want "
                    "to deep-dive on. The multi-model competition will run on that series.")
            return
        render_single_series_forecast_tab()


# -----------------------------------------------------------------
# B4.  SCENARIOS — what-if + causal adjustment in one tab
# -----------------------------------------------------------------
def render_unified_scenarios_tab(cfg):
    """One Scenarios tab folding both Causal Explainability and What-If."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 6 · Scenarios</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                What-If &amp; Causal Sensitivity
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Simulate price / promo / festival impact — with causal effect estimation via DoWhy
            </div>
        </div>
    """, unsafe_allow_html=True)

    if st.session_state.get('eda_object') is None:
        st.info("Run **EDA → Single SKU** first — scenarios need exogenous features from one series.")
        return

    sub = st.radio(
        "Scenario type",
        ["Causal Effect Estimation (DoWhy)", "What-If Feature Simulation"],
        horizontal=True, key='scenario_sub',
        help="Causal: estimate the true effect of one feature on sales. "
             "What-If: simulate the impact of feature changes on the forecast.",
    )

    if sub == "Causal Effect Estimation (DoWhy)":
        render_causal_tab()
    else:
        render_whatif_tab()


# -----------------------------------------------------------------
# A12.  HTML REPORT GENERATION
# -----------------------------------------------------------------
def _fig_to_html(fig, full_html: bool = False) -> str:
    """Serialize a Plotly figure to inline HTML (CDN-linked plotly.js)."""
    try:
        return fig.to_html(full_html=full_html, include_plotlyjs='cdn',
                            config={'displaylogo': False, 'responsive': True})
    except Exception:
        return ""


def _df_to_html_table(df: pd.DataFrame, max_rows: int = 200) -> str:
    """Render a DataFrame as a styled HTML table (clipped for size)."""
    if df is None or df.empty:
        return "<p><em>No data available.</em></p>"
    truncated = len(df) > max_rows
    view = df.head(max_rows) if truncated else df
    html = view.to_html(index=True, classes='dhishaai-table', border=0,
                        float_format=lambda x: f"{x:,.2f}")
    if truncated:
        html += f"<p class='note'>Showing first {max_rows:,} of {len(df):,} rows.</p>"
    return html


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {{
    --blue: #073e5c;
    --blue-2: #0a527a;
    --orange: #ef7602;
    --grey: #f6f8fa;
    --light-blue: #e8f0f7;
    --border: #e5e9ee;
    --text: #1f2937;
    --muted: #6b7785;
  }}
  body {{
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
    line-height: 1.6;
    margin: 0;
    padding: 0 36px 64px 36px;
    background: linear-gradient(180deg,#fbfcfd 0%, #f5f7fa 100%);
    font-size: 15px;
  }}
  /* === Hero header === */
  header.hero {{
    background: linear-gradient(135deg, var(--blue) 0%, var(--blue-2) 100%);
    color: #fff;
    border-radius: 12px;
    padding: 28px 32px;
    margin: 24px 0 32px 0;
    box-shadow: 0 6px 24px rgba(7,62,92,0.12);
    display: flex; justify-content: space-between; align-items: flex-end;
  }}
  header.hero .brand {{
    font-size: 1.8rem; font-weight: 800; letter-spacing: -0.02em;
  }}
  header.hero .brand .accent {{ color: var(--orange); }}
  header.hero .title {{
    font-size: 1.35rem; font-weight: 700; margin-top: 6px;
    color: #fff; opacity: 0.95;
  }}
  header.hero .subtitle {{
    font-size: 0.92rem; opacity: 0.85; margin-top: 4px;
  }}
  header.hero .meta {{ text-align: right; font-size: 0.85rem; opacity: 0.85; }}
  header.hero .meta b {{ color: var(--orange); }}

  /* === Headings === */
  h1, h2, h3, h4 {{ color: var(--blue); font-weight: 700; letter-spacing: -0.01em; }}
  h2 {{
    border-left: 5px solid var(--orange);
    padding-left: 14px;
    margin-top: 44px;
    font-size: 1.45rem;
  }}
  h3 {{ margin-top: 24px; font-size: 1.1rem; }}
  h4 {{ margin-top: 16px; font-size: 1rem; }}
  p.lead {{ font-size: 1.05rem; color: #334155; }}

  /* === KPI row === */
  .kpi-row {{ display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 14px; margin: 18px 0 24px 0; }}
  .kpi {{
    background: #fff;
    border-left: 4px solid var(--blue);
    border-radius: 10px;
    padding: 16px 20px;
    box-shadow: 0 1px 3px rgba(7,62,92,0.05);
  }}
  .kpi .label {{ color: var(--muted); font-size: 0.78rem; text-transform: uppercase;
                  letter-spacing: 0.04em; font-weight: 600; }}
  .kpi .value {{ font-size: 1.7rem; font-weight: 700; color: var(--blue);
                  line-height: 1.15; margin-top: 4px; }}

  /* === Tables === */
  table.dhishaai-table {{
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    font-size: 0.9rem;
    background: #fff;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(7,62,92,0.05);
  }}
  table.dhishaai-table th {{
    background: var(--blue);
    color: #fff;
    text-align: left;
    padding: 10px 14px;
    font-weight: 600;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }}
  table.dhishaai-table td {{ padding: 8px 14px; border-bottom: 1px solid var(--border); }}
  table.dhishaai-table tr:nth-child(even) td {{ background: #fafbfc; }}
  table.dhishaai-table tr:hover td {{ background: var(--light-blue); }}

  /* === 6-Segment grid === */
  .seg-grid {{ display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; margin: 20px 0; }}
  @media (max-width: 900px) {{ .seg-grid {{ grid-template-columns: 1fr; }} }}
  .seg-card {{
    background: #fff;
    border-radius: 12px;
    padding: 18px 20px;
    box-shadow: 0 2px 8px rgba(7,62,92,0.06);
    min-height: 240px;
  }}
  .seg-card-head {{ display: flex; justify-content: space-between; align-items: center; }}
  .seg-name {{ font-size: 0.92rem; font-weight: 700; color: var(--blue); }}
  .seg-priority {{ color: #fff; padding: 3px 11px; border-radius: 12px;
                    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; }}
  .seg-stats {{ display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }}
  .seg-count {{ font-size: 2.1rem; font-weight: 800; line-height: 1; }}
  .seg-rev {{ font-size: 1rem; color: var(--muted); font-weight: 600; }}
  .seg-rev span {{ font-size: 0.78rem; font-weight: 500; margin-left: 2px; }}
  .seg-strategy {{ font-size: 0.85rem; margin-top: 12px; color: #334155;
                    line-height: 1.45; }}
  .seg-meta {{ font-size: 0.78rem; color: var(--muted); margin-top: 10px;
                line-height: 1.55; border-top: 1px solid var(--border); padding-top: 8px; }}
  .seg-meta b {{ color: var(--blue); }}

  /* === Pills === */
  .pill-stable, .pill-volatile, .pill-null {{
    display: inline-block; padding: 2px 9px; border-radius: 10px;
    font-size: 0.78rem; font-weight: 600;
  }}
  .pill-stable {{ background: #d1fae5; color: #065f46; }}
  .pill-volatile {{ background: #fee2e2; color: #991b1b; }}
  .pill-null {{ background: #f1f5f9; color: #475569; }}

  /* === Method box === */
  .method-box {{
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 22px;
    margin: 14px 0;
  }}

  /* === Chart grid === */
  .chart-grid {{ display: grid; grid-template-columns: repeat(2,1fr); gap: 16px; }}
  @media (max-width: 900px) {{ .chart-grid {{ grid-template-columns: 1fr; }} }}
  .chart-cell {{ background: #fff; border-radius: 10px; padding: 14px;
                  box-shadow: 0 1px 3px rgba(7,62,92,0.05); }}

  /* === Recommendations === */
  ol.recos {{ padding-left: 22px; }}
  ol.recos li {{ margin-bottom: 12px; font-size: 0.96rem; }}
  ol.recos b {{ color: var(--blue); }}

  /* === Misc === */
  .note {{ color: var(--muted); font-size: 0.84rem; font-style: italic; }}
  .summary-box {{
    background: #fff8f0;
    border-left: 4px solid var(--orange);
    border-radius: 8px;
    padding: 16px 20px;
    margin: 16px 0;
  }}

  /* === TOC === */
  .toc-box {{
    background: #fff;
    border: 1px solid var(--border);
    padding: 18px 24px;
    border-radius: 10px;
    margin-bottom: 28px;
    box-shadow: 0 1px 3px rgba(7,62,92,0.05);
  }}
  .toc-box strong {{ color: var(--blue); font-size: 0.85rem;
                     text-transform: uppercase; letter-spacing: 0.06em; }}
  ul.toc {{ list-style: none; padding: 0; margin: 10px 0 0 0;
            display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 4px 12px; }}
  ul.toc li a {{ color: var(--blue); text-decoration: none; font-size: 0.9rem;
                  font-weight: 500; padding: 4px 0; display: inline-block; }}
  ul.toc li a:hover {{ color: var(--orange); }}

  footer {{ border-top: 1px solid var(--border); padding-top: 18px; margin-top: 48px;
            color: var(--muted); font-size: 0.85rem; text-align: center; }}
  footer b {{ color: var(--blue); }}
</style>
</head>
<body>
<header class="hero">
  <div>
    <div class="brand">Dhisha<span class="accent">AI</span> Time Lens</div>
    <div class="title">{title}</div>
    <div class="subtitle">{subtitle}</div>
  </div>
  <div class="meta">
    <div><b>Build</b> v2.6 · Retail Edition</div>
    <div>Generated {now}</div>
  </div>
</header>
<div class="toc-box">
  <strong>Contents</strong>
  {toc}
</div>
{body}
<footer>
  <div>Dhisha<b style="color:var(--orange);">AI</b> Time Lens · Automated Retail Demand Intelligence</div>
  <div style="margin-top:4px;">Generated {now}</div>
</footer>
</body>
</html>"""


def _section(anchor: str, heading: str, html_body: str) -> Tuple[str, str]:
    """Return ((toc_link_html, section_html))."""
    return (
        f'<li><a href="#{anchor}">{heading}</a></li>',
        f'<section id="{anchor}"><h2>{heading}</h2>{html_body}</section>',
    )


def _kpi(label: str, value: str) -> str:
    return f'<div class="kpi"><div class="label">{label}</div><div class="value">{value}</div></div>'


def build_eda_html_report(eda: 'TimeSeriesEDA', summary_metrics: Dict[str, str],
                           figs: Dict[str, Any]) -> str:
    """Build a self-contained EDA HTML report."""
    toc_items = []
    body_parts = []

    # KPIs
    kpis = "".join(_kpi(k, str(v)) for k, v in summary_metrics.items())
    toc, html = _section("summary", "1. Data Summary",
                         f'<div class="kpi-row">{kpis}</div>')
    toc_items.append(toc); body_parts.append(html)

    section_specs = [
        ("distribution", "2. Target Distribution", "distribution"),
        ("trend", "3. Trend Over Time", "trend"),
        ("decomposition", "4. Seasonal Decomposition", "decomposition"),
        ("anomaly", "5. Anomaly Detection", "anomaly"),
        ("acf_pacf", "6. ACF / PACF", "acf_pacf"),
        ("holidays", "7. Holiday Analysis", "holidays"),
    ]
    for anchor, heading, key in section_specs:
        fig = figs.get(key)
        if fig is None:
            continue
        toc, html = _section(anchor, heading, _fig_to_html(fig))
        toc_items.append(toc); body_parts.append(html)

    # Anomaly stats table
    if not eda.potential_anomalies_df.empty:
        toc, html = _section("anomaly_table", "8. Identified Anomalies",
                             _df_to_html_table(eda.potential_anomalies_df))
        toc_items.append(toc); body_parts.append(html)

    return _HTML_TEMPLATE.format(
        title="Exploratory Data Analysis",
        subtitle=f"Time-series profiling at {eda.resample_freq} frequency",
        now=pd.Timestamp.now().strftime('%Y-%m-%d %H:%M'),
        toc=f"<ul class='toc'>{''.join(toc_items)}</ul>",
        body="".join(body_parts),
    )


def build_forecast_html_report(forecast_payload: Dict[str, Any], cfg: Dict[str, Any]) -> str:
    """Build a self-contained forecast HTML report (multi-model single-series)."""
    final_forecast = forecast_payload['final_forecast']
    best_result = forecast_payload['best_model_result']
    result = forecast_payload['result']
    forecaster = forecast_payload['forecaster']
    eda = forecaster.eda

    toc_items, body_parts = [], []

    # Narrative summary
    narrative = generate_narrative_summary(forecast_payload, {'resample_freq': eda.resample_freq})
    narrative_html = f'<div class="summary-box">{narrative.replace(chr(10), "<br/>")}</div>'
    toc, html = _section("summary", "1. Forecast Summary", narrative_html)
    toc_items.append(toc); body_parts.append(html)

    # KPIs
    kpi_html = "".join([
        _kpi("Best Model", result.get('Model', '-')),
        _kpi("Train WMAPE", f"{result.get('Train WMAPE (%)', '-')}%"),
        _kpi("Test WMAPE", f"{result.get('Test WMAPE (%)', '-')}%"),
        _kpi("Forecast Horizon", f"{len(final_forecast)} periods"),
        _kpi("Error Correction", "Yes" if result.get('Error Correction Applied') else "No"),
    ])
    toc, html = _section("kpis", "2. Key Metrics", f'<div class="kpi-row">{kpi_html}</div>')
    toc_items.append(toc); body_parts.append(html)

    # Forecast plot
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=eda.df_eda.index, y=eda.df_eda[eda.sales_col],
                              mode='lines', name='Actual', line=dict(color=DHISHAAI_BLUE)))
    fig.add_trace(go.Scatter(x=final_forecast.index, y=final_forecast,
                              mode='lines', name='Forecast', line=dict(color=DHISHAAI_ORANGE)))
    if best_result.get('forecast_ci') is not None:
        ci = best_result['forecast_ci']
        fig.add_trace(go.Scatter(x=ci.index, y=ci['upper'], mode='lines',
                                  line=dict(width=0), showlegend=False))
        fig.add_trace(go.Scatter(x=ci.index, y=ci['lower'], mode='lines',
                                  line=dict(width=0), fill='tonexty',
                                  fillcolor='rgba(239,118,2,0.15)', name='95% CI'))
    fig.update_layout(title="Actual vs Forecast", height=480, template='plotly_white')
    toc, html = _section("forecast_plot", "3. Forecast Plot", _fig_to_html(fig))
    toc_items.append(toc); body_parts.append(html)

    # Forecast table
    fc_df = final_forecast.to_frame(name='forecast')
    if best_result.get('forecast_ci') is not None:
        fc_df = fc_df.join(best_result['forecast_ci'])
    toc, html = _section("forecast_table", "4. Forecast Values",
                         _df_to_html_table(fc_df, max_rows=200))
    toc_items.append(toc); body_parts.append(html)

    # Model competition
    if hasattr(forecaster, 'last_run_details') and forecaster.last_run_details:
        comp = pd.DataFrame(forecaster.last_run_details)
        toc, html = _section("competition", "5. Model Competition",
                             _df_to_html_table(comp))
        toc_items.append(toc); body_parts.append(html)

    return _HTML_TEMPLATE.format(
        title="Single-Series Forecast Report",
        subtitle=f"Multi-model competition · winner: {forecast_payload.get('best_model_name', '—')}",
        now=pd.Timestamp.now().strftime('%Y-%m-%d %H:%M'),
        toc=f"<ul class='toc'>{''.join(toc_items)}</ul>",
        body="".join(body_parts),
    )


def build_retail_segmentation_html_report(
    seg_df: pd.DataFrame,
    df_raw: pd.DataFrame,
    cfg: Dict[str, Any],
    profiles: Optional[pd.DataFrame] = None,
) -> str:
    """Build a retail-flavored executive HTML report for the segmentation work.

    Centre-piece for the demo: hero KPI strip → 6-segment matrix with playbook →
    brand × segment breakdown → forecasting strategy recommendations.
    """
    toc_items, body_parts = [], []

    sku_col = cfg.get('sku_col', 'latest_sku')
    sales_col = cfg.get('sales_col', 'sales')
    date_col = cfg.get('date_col', 'month_')

    n_skus = int(seg_df[sku_col].nunique())
    n_obs = len(df_raw)
    total_rev = float(seg_df['total_revenue'].sum())

    try:
        dts = pd.to_datetime(df_raw[date_col], errors='coerce')
        date_min, date_max = dts.min().date(), dts.max().date()
        n_months = (date_max.year - date_min.year) * 12 + (date_max.month - date_min.month) + 1
        date_range_str = f"{date_min} → {date_max}"
    except Exception:
        date_range_str = "—"; n_months = 0

    n_brands = df_raw['brand'].nunique() if 'brand' in df_raw.columns else None

    # ===== 1. Executive Summary =====
    rev_str = f"₹{total_rev/1e7:.2f} Cr" if total_rev > 1e7 else f"₹{total_rev/1e5:.2f} L"
    kpi_html = "".join([
        _kpi("SKUs in portfolio", f"{n_skus:,}"),
        _kpi("Brands", f"{n_brands:,}" if n_brands else "—"),
        _kpi("Time span", f"{n_months} months"),
        _kpi("Historical revenue", rev_str),
    ])

    exec_narrative = f"""
    <p class="lead">This report classifies <b>{n_skus:,} SKUs</b> across
    <b>{n_brands or '—'} retail brands</b> over <b>{n_months} months</b> of
    transactional history ({date_range_str}). Each SKU is placed into a
    <b>Volatility × Contribution</b> segment that drives forecasting strategy,
    safety-stock policy and replenishment cadence.</p>

    <p>The six-segment matrix below is the operating-model backbone:
    <b>stable, high-contributing</b> SKUs deserve premium forecasting investment;
    <b>volatile, low-contributing</b> SKUs are best forecast at aggregate level or
    moved to make-to-order. Per-segment playbooks are detailed below.</p>
    """
    toc, html = _section("summary", "1. Executive Summary",
                         f'<div class="kpi-row">{kpi_html}</div>{exec_narrative}')
    toc_items.append(toc); body_parts.append(html)

    # ===== 2. Segmentation methodology =====
    methodology = f"""
    <div class="method-box">
    <h4>How segments are derived</h4>
    <table class="dhishaai-table">
      <thead><tr><th>Axis</th><th>Metric</th><th>Cut-off</th><th>Interpretation</th></tr></thead>
      <tbody>
        <tr><td><b>Volatility</b></td><td>SBC demand pattern (ADI &amp; CV² of non-zero demand)</td>
            <td>smooth ⇒ <span class="pill-stable">Stable</span><br>erratic / intermittent / lumpy ⇒ <span class="pill-volatile">Volatile</span></td>
            <td>Derived from the demand pattern — so a SKU's segment and pattern can never disagree</td></tr>
        <tr><td><b>Contribution</b></td><td>Pareto ABC on cumulative revenue share</td>
            <td>Top 40% rev = High · 40–85% = Mid · &gt;85% = Low</td>
            <td>Strategic importance to top-line</td></tr>
        <tr><td><b>Edge case</b></td><td>n_periods &lt; 3 or μ = 0</td>
            <td><span class="pill-null">CV NULL/0</span></td>
            <td>Insufficient history — apply NPI proxy</td></tr>
      </tbody>
    </table>
    <p class="note">Thresholds are tunable; the DhishaAI engine recalibrates them
    automatically when re-fit on new monthly snapshots.</p>
    </div>
    """
    toc, html = _section("methodology", "2. Segmentation Methodology", methodology)
    toc_items.append(toc); body_parts.append(html)

    # ===== 3. The 6-segment matrix with playbook =====
    seg_counts = seg_df['segment'].value_counts()
    seg_rev = seg_df.groupby('segment')['total_revenue'].sum()
    total_rev_all = seg_rev.sum()

    cards = []
    order = [
        'Stable High contributors', 'Stable Mid contributors', 'Stable Low contributors',
        'Volatile High contributors', 'Volatile Mid contributors', 'Volatile Low contributors',
        'New product', 'Churned product', 'Short history',
    ]
    for seg_name in order:
        n = int(seg_counts.get(seg_name, 0))
        r = float(seg_rev.get(seg_name, 0))
        r_pct = 100*r/total_rev_all if total_rev_all else 0
        pb = SEGMENT_PLAYBOOK.get(seg_name, {})
        color = pb.get('color', '#64748b')
        priority = pb.get('priority', '')
        strategy = pb.get('strategy', '')
        fc_model = pb.get('forecast', '')
        safety = pb.get('safety_stock', '')
        cards.append(f"""
        <div class="seg-card" style="border-top:5px solid {color};">
          <div class="seg-card-head">
            <div class="seg-name">{seg_name}</div>
            <div class="seg-priority" style="background:{color};">{priority}</div>
          </div>
          <div class="seg-stats">
            <div class="seg-count" style="color:{color};">{n:,}</div>
            <div class="seg-rev">{r_pct:.1f}%<span> rev share</span></div>
          </div>
          <div class="seg-strategy"><b>Strategy.</b> {strategy}</div>
          <div class="seg-meta">
            <div><b>Forecast model:</b> {fc_model}</div>
            <div><b>Safety stock:</b> {safety}</div>
          </div>
        </div>
        """)
    matrix_html = '<div class="seg-grid">' + ''.join(cards) + '</div>'
    toc, html = _section("matrix", "3. The Segment Operating Matrix", matrix_html)
    toc_items.append(toc); body_parts.append(html)

    # ===== 4. Visual distribution =====
    try:
        cnt_df = seg_df['segment'].value_counts().reset_index()
        cnt_df.columns = ['segment', 'count']
        cnt_fig = px.bar(
            cnt_df, x='segment', y='count', color='segment',
            color_discrete_sequence=['#10b981','#3b82f6','#94a3b8','#dc2626','#f59e0b','#fb7185',
                                     '#8b5cf6','#475569','#f97316','#64748b'],
            text='count',
        )
        cnt_fig.update_layout(showlegend=False, template='plotly_white',
                              title='SKU count by segment', height=420,
                              xaxis_title='', yaxis_title='SKUs')
        cnt_fig.update_xaxes(tickangle=-25)

        rev_df = seg_rev.reset_index()
        rev_df.columns = ['segment', 'revenue']
        rev_pie = px.pie(
            rev_df, names='segment', values='revenue', hole=0.45,
            color_discrete_sequence=['#10b981','#3b82f6','#94a3b8','#dc2626','#f59e0b','#fb7185',
                                     '#8b5cf6','#475569','#f97316','#64748b'],
        )
        rev_pie.update_layout(template='plotly_white', title='Revenue share by segment', height=420)

        # Only the first chart needs to embed plotly.js; the second can be just the div
        viz_html = f"""
        <div class="chart-grid">
            <div class="chart-cell">{_fig_to_html(cnt_fig)}</div>
            <div class="chart-cell">{_fig_to_html(rev_pie)}</div>
        </div>
        """
        toc, html = _section("viz", "4. Portfolio Distribution", viz_html)
        toc_items.append(toc); body_parts.append(html)
    except Exception as _e:
        # Don't silently swallow during dev — emit a clean note instead
        toc, html = _section("viz", "4. Portfolio Distribution",
                             f"<p class='note'>Charts unavailable: {_e}</p>")
        toc_items.append(toc); body_parts.append(html)

    # ===== 5. Brand × Segment crosstab =====
    if 'brand' in df_raw.columns:
        try:
            brand_seg = (df_raw[[sku_col, 'brand']].drop_duplicates()
                            .merge(seg_df[[sku_col, 'segment']], on=sku_col, how='left')
                            .groupby(['brand','segment']).size().unstack(fill_value=0))
            brand_seg['Total'] = brand_seg.sum(axis=1)
            brand_seg = brand_seg.sort_values('Total', ascending=False)
            toc, html = _section("brand", "5. Brand × Segment Breakdown",
                                 _df_to_html_table(brand_seg))
            toc_items.append(toc); body_parts.append(html)
        except Exception:
            pass

    # ===== 6. Top 25 hero SKUs =====
    try:
        hero = (seg_df[seg_df['segment'].str.contains('High contributors', na=False)]
                  .sort_values('total_revenue', ascending=False).head(25).copy())
        keep = [sku_col, 'segment', 'n_periods', 'mean_sales', 'cv', 'total_revenue', 'rev_share_pct']
        keep = [c for c in keep if c in hero.columns]
        hero = hero[keep]
        if 'cv' in hero.columns:
            hero['cv'] = hero['cv'].round(3)
        if 'mean_sales' in hero.columns:
            hero['mean_sales'] = hero['mean_sales'].round(2)
        if 'total_revenue' in hero.columns:
            hero['total_revenue'] = hero['total_revenue'].apply(lambda x: f"₹{x:,.0f}")
        if 'rev_share_pct' in hero.columns:
            hero['rev_share_pct'] = hero['rev_share_pct'].round(3)
        toc, html = _section("hero", "6. Top-25 Hero SKUs (High Contributors)",
                             _df_to_html_table(hero, max_rows=25))
        toc_items.append(toc); body_parts.append(html)
    except Exception:
        pass

    # ===== 7. Recommendations =====
    recos = """
    <ol class="recos">
      <li><b>Invest forecast accuracy on Stable High contributors first.</b> These few SKUs typically drive 30–50% of revenue. Even a 2–3 percentage-point WMAPE improvement here yields more value than perfecting tail SKUs.</li>
      <li><b>Service-level differentiation.</b> Apply 98% SL to Volatile High, 95% to Stable/Volatile Mid, 90% to Stable Low. Avoid blanket 95% — it over-stocks the tail and under-stocks the heroes.</li>
      <li><b>Volatile SKUs need exogenous features.</b> Festivals, weekends, scheme-days and price changes explain most of the volatility. Plain ARIMA isn't enough — use LightGBM with calendar features.</li>
      <li><b>Tail rationalisation candidates.</b> Volatile Low Contributors (intermittent + insignificant) are candidates for SKU rationalisation or move-to-MTO. Review with category team quarterly.</li>
      <li><b>Refresh segments quarterly.</b> A Stable Mid today may become Volatile High after a product launch or a competitor exit. Re-run the segmentation on each quarter-close.</li>
    </ol>
    """
    toc, html = _section("recos", "7. Recommendations", recos)
    toc_items.append(toc); body_parts.append(html)

    # ===== Compose =====
    toc_html = "<ul class='toc'>" + "".join(toc_items) + "</ul>"
    return _HTML_TEMPLATE.format(
        title="Retail Portfolio Segmentation",
        subtitle=f"Volatility × Contribution matrix · {n_skus:,} SKUs · "
                 f"{n_brands or '—'} brands · {date_range_str}",
        now=pd.Timestamp.now().strftime('%Y-%m-%d %H:%M'),
        toc=toc_html,
        body="".join(body_parts),
    )


def build_routed_forecast_html_report(results: List['ForecastResult'],
                                       profiles: Dict[str, 'SKUProfile'],
                                       cfg: Dict[str, Any]) -> str:
    """Build an HTML report for the SKU-routed multi-SKU forecast."""
    toc_items, body_parts = [], []

    # Aggregate KPIs
    n_skus = len(results)
    n_with_mape = sum(1 for r in results if r.backtest_mape is not None)
    strategies = pd.Series([r.strategy_used for r in results]).value_counts()
    median_mape = float(np.nanmedian([r.backtest_mape for r in results if r.backtest_mape is not None])) \
        if n_with_mape else float('nan')

    kpi_html = "".join([
        _kpi("Total SKUs", f"{n_skus:,}"),
        _kpi("SKUs evaluated", f"{n_with_mape:,}"),
        _kpi("Median 1-mo WMAPE", f"{median_mape:.1f}%" if pd.notna(median_mape) else "—"),
        _kpi("Forecast horizon", f"{cfg.get('horizon', '?')} periods"),
    ])
    toc, html = _section("summary", "1. Routed Forecast Summary",
                         f'<div class="kpi-row">{kpi_html}</div>')
    toc_items.append(toc); body_parts.append(html)

    # Strategy split
    strat_df = strategies.to_frame(name='SKU count')
    strat_df['Share %'] = (strat_df['SKU count'] / n_skus * 100).round(1)
    toc, html = _section("strategy", "2. Strategy Routing",
                         _df_to_html_table(strat_df))
    toc_items.append(toc); body_parts.append(html)

    # Per-SKU forecast table
    rows = []
    for r in results:
        prof = profiles.get(r.sku)
        rows.append({
            'SKU': r.sku,
            'Brand': getattr(prof, 'brand', '-') if prof else '-',
            'Segment': getattr(prof, 'segment', '-') if prof else '-',
            'Strategy': r.strategy_used,
            '1-mo WMAPE %': round(r.backtest_mape, 2) if r.backtest_mape is not None else None,
            'Total forecast': round(float(r.forecast.sum()), 2) if r.forecast is not None else None,
        })
    sku_df = pd.DataFrame(rows)
    toc, html = _section("skus", "3. Per-SKU Forecasts (top 200)",
                         _df_to_html_table(sku_df, max_rows=200))
    toc_items.append(toc); body_parts.append(html)

    return _HTML_TEMPLATE.format(
        title="Routed Portfolio Forecast",
        subtitle=f"{n_skus:,} SKUs · {cfg.get('horizon', '?')}-period horizon · "
                 f"median WMAPE {median_mape:.1f}%" if pd.notna(median_mape) else
                 f"{n_skus:,} SKUs · {cfg.get('horizon', '?')}-period horizon",
        now=pd.Timestamp.now().strftime('%Y-%m-%d %H:%M'),
        toc=f"<ul class='toc'>{''.join(toc_items)}</ul>",
        body="".join(body_parts),
    )


# -----------------------------------------------------------------
# A13.  REPORT TAB — central HTML download hub
# -----------------------------------------------------------------
def render_report_tab(cfg):
    """Standalone tab that produces downloadable HTML reports for the work done."""
    st.markdown(f"""
        <div style='background:linear-gradient(135deg,{DHISHAAI_BLUE} 0%,#0a527a 100%);
                    color:#fff;padding:20px 26px;border-radius:12px;margin-bottom:18px;
                    box-shadow:0 4px 16px rgba(7,62,92,0.12);'>
            <div style='font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;
                        opacity:0.85;font-weight:600;'>Step 7 · Report</div>
            <div style='font-size:1.55rem;font-weight:700;margin-top:4px;'>
                Executive HTML Reports
            </div>
            <div style='font-size:0.9rem;opacity:0.85;margin-top:4px;'>
                Self-contained, brandable, emailable — interactive Plotly charts embedded
            </div>
        </div>
    """, unsafe_allow_html=True)
    st.caption(
        "Download a self-contained HTML you can email or paste into a shared drive. "
        "Charts stay interactive (zoom, hover, export PNG)."
    )

    # ---- Retail Segmentation Report (the demo's hero deliverable) ----
    seg_df = st.session_state.get('retail_seg_df')
    df_raw = st.session_state.get('df_raw')
    if seg_df is not None and df_raw is not None:
        st.markdown("### Retail Segmentation Report")
        st.caption("**Executive deliverable** — the 6-segment matrix with playbook, brand breakdown, "
                    "and operational recommendations. Send this to category managers.")
        if st.button("Generate Segmentation HTML report", key='rep_seg',
                      use_container_width=True):
            with st.spinner("Building executive HTML…"):
                try:
                    html_str = build_retail_segmentation_html_report(seg_df, df_raw, cfg)
                    st.session_state['_seg_html'] = html_str
                    st.success(f"Generated · {len(html_str)/1024:.0f} KB")
                except Exception as e:
                    st.error(f"Failed: {e}")
        if st.session_state.get('_seg_html'):
            st.download_button(
                "Download Segmentation report (HTML)",
                data=st.session_state['_seg_html'],
                file_name=f"DhishaAI_Retail_Segmentation_{pd.Timestamp.now():%Y%m%d_%H%M}.html",
                mime='text/html',
                use_container_width=True, key='seg_dl',
            )
        st.markdown("---")

    # ---- EDA report ----
    st.markdown("### EDA Report")
    eda = st.session_state.get('eda_object')
    if eda is None:
        st.info("Run the EDA tab first to generate this report.")
    else:
        if st.button("Generate EDA HTML report", key='rep_eda'):
            try:
                with st.spinner("Building EDA HTML..."):
                    # Re-build the figures non-interactively for embedding
                    df_plot = eda.df_eda.copy()
                    df_plot['month'] = df_plot.index.month_name()
                    dist_fig = make_subplots(rows=2, cols=1,
                                              subplot_titles=("Distribution", "By Month"))
                    dist_fig.add_trace(go.Histogram(x=df_plot[eda.sales_col]), row=1, col=1)
                    dist_fig.add_trace(go.Box(x=df_plot['month'], y=df_plot[eda.sales_col]), row=2, col=1)
                    dist_fig.update_layout(height=600, showlegend=False, template='plotly_white')

                    trend_fig = px.line(eda.df_eda, x=eda.df_eda.index, y=eda.sales_col,
                                          title='Sales over time', template='plotly_white')

                    decomp_fig = None
                    try:
                        period = {'D': 7, 'W': 4, 'M': 12, 'Q': 4, 'Y': 2}.get(eda.resample_freq, 4)
                        if len(eda.df_eda) > period * 2:
                            d = seasonal_decompose(eda.df_eda[eda.sales_col], model='additive', period=period)
                            decomp_fig = make_subplots(rows=4, cols=1, shared_xaxes=True,
                                                        subplot_titles=("Observed", "Trend", "Seasonal", "Residuals"))
                            decomp_fig.add_trace(go.Scatter(x=d.observed.index, y=d.observed, mode='lines'), row=1, col=1)
                            decomp_fig.add_trace(go.Scatter(x=d.trend.index, y=d.trend, mode='lines'), row=2, col=1)
                            decomp_fig.add_trace(go.Scatter(x=d.seasonal.index, y=d.seasonal, mode='lines'), row=3, col=1)
                            decomp_fig.add_trace(go.Scatter(x=d.resid.index, y=d.resid, mode='markers'), row=4, col=1)
                            decomp_fig.update_layout(height=700, showlegend=False, template='plotly_white')
                    except Exception:
                        pass

                    anom_fig = go.Figure()
                    anom_fig.add_trace(go.Scatter(x=eda.df_eda.index, y=eda.df_eda[eda.sales_col],
                                                    mode='lines', name='Cleaned'))
                    if eda.corrected_anomalies:
                        dts = list(eda.corrected_anomalies.keys())
                        vals = [v['original'] for v in eda.corrected_anomalies.values()]
                        anom_fig.add_trace(go.Scatter(x=dts, y=vals, mode='markers',
                                                       name='Corrected',
                                                       marker=dict(color='red', symbol='x', size=10)))
                    anom_fig.update_layout(title="Anomaly Detection", template='plotly_white')

                    acf_fig = None
                    try:
                        series = eda.df_eda[eda.sales_col]
                        lags = min(20, max(2, len(series) - 1))
                        a_vals, _ = acf(series, nlags=lags, alpha=0.05)
                        p_vals, _ = pacf(series, nlags=lags, alpha=0.05)
                        acf_fig = make_subplots(rows=1, cols=2, subplot_titles=("ACF", "PACF"))
                        acf_fig.add_trace(go.Bar(x=np.arange(lags + 1), y=a_vals, name='ACF'), row=1, col=1)
                        acf_fig.add_trace(go.Bar(x=np.arange(lags + 1), y=p_vals, name='PACF'), row=1, col=2)
                        acf_fig.update_layout(height=400, showlegend=False, template='plotly_white')
                    except Exception:
                        pass

                    figs = {
                        'distribution': dist_fig,
                        'trend': trend_fig,
                        'decomposition': decomp_fig,
                        'anomaly': anom_fig,
                        'acf_pacf': acf_fig,
                    }
                    summary_metrics = {
                        "Records": f"{len(eda.df):,}",
                        "Min date": str(pd.to_datetime(eda.df[eda.date_col]).min().date()),
                        "Max date": str(pd.to_datetime(eda.df[eda.date_col]).max().date()),
                        "Frequency": eda.resample_freq,
                        "Anomalies (potential)": f"{len(eda.potential_anomalies_df)}",
                        "Anomalies (corrected)": f"{len(eda.corrected_anomalies)}",
                    }
                    html = build_eda_html_report(eda, summary_metrics, figs)
                st.success("EDA report ready.")
                st.download_button(
                    "⬇ Download EDA report (HTML)",
                    data=html.encode('utf-8'),
                    file_name=f"dhishaai_eda_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
                    mime='text/html', use_container_width=True,
                )
            except Exception as e:
                st.error(f"EDA HTML report failed: {e}")

    st.markdown("---")
    # ---- Single-series forecast report ----
    st.markdown("### 2. Multi-Model Forecast Report")
    ss = st.session_state.get('ss_forecast')
    if ss is None:
        st.info("Run the Multi-Model Forecast tab to generate this report.")
    else:
        if st.button("Generate forecast HTML report", key='rep_fc'):
            try:
                html = build_forecast_html_report(ss, cfg)
                st.success("Forecast report ready.")
                st.download_button(
                    "⬇ Download forecast report (HTML)",
                    data=html.encode('utf-8'),
                    file_name=f"dhishaai_forecast_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
                    mime='text/html', use_container_width=True,
                )
            except Exception as e:
                st.error(f"Forecast HTML report failed: {e}")

    st.markdown("---")
    # ---- Routed multi-SKU report ----
    st.markdown("### 3. SKU-Routed Forecast Report")
    results = st.session_state.get('forecast_results')
    profiles = st.session_state.get('profiles')
    if results is None or profiles is None:
        st.info("Run the Profile & Route and Forecast (Routed) tabs to generate this report.")
    else:
        if st.button("Generate routed forecast HTML report", key='rep_routed'):
            try:
                profiles_map = {p.sku: p for p in profiles} if isinstance(profiles, list) else profiles
                html = build_routed_forecast_html_report(results, profiles_map, cfg)
                st.success("Routed forecast report ready.")
                st.download_button(
                    "⬇ Download routed forecast report (HTML)",
                    data=html.encode('utf-8'),
                    file_name=f"dhishaai_routed_forecast_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.html",
                    mime='text/html', use_container_width=True,
                )
            except Exception as e:
                st.error(f"Routed report failed: {e}")


# -----------------------------------------------------------------
# A14.  WIRE NEW TABS INTO MAIN
# -----------------------------------------------------------------
# Save the original SKU-routing main so we can extend it with extra tabs.
_main_sku_routing = main


def main():  # noqa: F811 — extended main supersedes the earlier one
    st.set_page_config(page_title="DhishaAI Time Lens v2", layout="wide")
    apply_theme()

    if 'profiled' not in st.session_state:
        st.session_state.profiled = False
        st.session_state.forecasts_run = False

    cfg = render_sidebar()
    if cfg is None:
        return

    # Standard professional time-series forecasting workflow:
    # Data → EDA → Profile/Route → Forecast → Performance → Scenarios → Report
    # Each step is a single consolidated entry point. No duplicates.
    tabs = st.tabs([
        "1. Data",
        "2. EDA",
        "3. Profile & Route",
        "4. Forecast",
        "5. Forecast Submission",
        "6. Performance",
        "7. Scenarios",
        "8. Report",
    ])

    with tabs[0]:
        # Data preview, schema, quality checks, About (folded in)
        render_data_tab(cfg)
    with tabs[1]:
        # Unified EDA: portfolio aggregate OR single-SKU drill-down
        render_unified_eda_tab(cfg)
    with tabs[2]:
        # SKU intermittency classification + routing strategy
        render_profiling_tab(cfg)
    with tabs[3]:
        # Unified Forecast: A) portfolio routed  OR  B) per-SKU multi-model competition
        render_unified_forecast_tab(cfg)
    with tabs[4]:
        # Planner's final-review screen: edit forecast values with MoM/YoY
        # decision support, reason codes, and a submission audit trail.
        render_submission_tab(cfg)
    with tabs[5]:
        # Backtest accuracy diagnostics
        render_performance_tab(cfg)
    with tabs[6]:
        # Unified Scenarios: causal effect estimation (DoWhy) + what-if feature simulation
        render_unified_scenarios_tab(cfg)
    with tabs[7]:
        # Central HTML / PDF download hub
        render_report_tab(cfg)


if __name__ == '__main__':
    main()
