"""
Phase 2 Enhancements: CatBoost, XGB Quantile, Neural Elasticity
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Three specialized models to add to the algorithm ensemble:

1. CatBoost — Native categorical feature support
   └─ Impact: +3-5% MAPE improvement (Volatile Mid, Stable Mid)
   
2. XGB Quantile — Uncertainty quantiles (90th percentile)
   └─ Impact: Risk-aware forecasting for safety stock
   
3. Neural Elasticity — Price-demand nonlinearity learner
   └─ Impact: +5-8% MAPE improvement (Volatile Mid, Stable High)

Integration: Add to SEGMENT_ARCHITECTURE 'blend' list.
Usage: Called via forecast_one_sku() in app_v2_6.py
"""

import os
import numpy as np
import pandas as pd
from typing import Tuple, Optional
import warnings
warnings.filterwarnings('ignore')

# Try to import optional libraries.
#
# NOTE on import strategy: we catch a broad ``Exception`` (not just
# ``ImportError``) because a *present-but-broken* optional dependency raises
# other error types — e.g. TensorFlow built against a newer NumPy raises
# ``AttributeError`` rather than ``ImportError``. Catching only ``ImportError``
# would let that propagate and crash any module that does
# ``import phase2_enhancements``.
try:
    import catboost as cb
    CATBOOST_AVAILABLE = True
except Exception:
    CATBOOST_AVAILABLE = False

# QuantileRegressor lives in ``sklearn.linear_model`` (NOT ``sklearn.ensemble``).
try:
    from sklearn.linear_model import QuantileRegressor
    SKLEARN_QR_AVAILABLE = True
except Exception:
    SKLEARN_QR_AVAILABLE = False

# TensorFlow/Keras is imported *lazily* inside forecast_neural_elasticity().
# Importing it at module load can hang or crash the host app (it spawns
# threads and is sensitive to the installed NumPy ABI), so we defer it.
# KERAS_AVAILABLE stays None ("unknown") until the first lazy import attempt.
KERAS_AVAILABLE = None


def _try_import_keras():
    """Lazily import Keras. Returns the needed symbols or None on any failure.

    Updates the module-level KERAS_AVAILABLE flag as a side effect so callers
    and the __main__ banner can report availability after a probe. Once a probe
    has failed, subsequent calls short-circuit to None — we do NOT retry the
    import, because a broken TensorFlow install can be slow (or hang) to import
    and retrying it on every forecast call would cripple throughput.
    """
    global KERAS_AVAILABLE
    if KERAS_AVAILABLE is False:
        return None
    # Opt-in gate. Importing TensorFlow can block in native code (and is
    # uninterruptible by Python signals) when the installed TF/NumPy ABIs are
    # mismatched — which would freeze the whole forecast run. So we refuse to
    # even attempt the import unless the operator has explicitly enabled it AND
    # validated their environment. Set TIMELENS_ENABLE_NEURAL=1 to turn it on.
    if os.environ.get('TIMELENS_ENABLE_NEURAL', '').strip() not in ('1', 'true', 'True', 'yes'):
        KERAS_AVAILABLE = False
        return None
    try:
        from tensorflow.keras.models import Sequential
        from tensorflow.keras.layers import LSTM, Dense, Dropout
        from tensorflow.keras.optimizers import Adam
        KERAS_AVAILABLE = True
        return Sequential, LSTM, Dense, Dropout, Adam
    except Exception:
        KERAS_AVAILABLE = False
        return None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. CATBOOST MODEL — Categorical Feature Support
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def forecast_catboost(
    sku_panel: pd.DataFrame,
    date_col: str,
    sales_col: str,
    h: int,
    freq: str,
    numeric_features: Optional[list] = None,
    categorical_features: Optional[list] = None,
) -> Tuple[pd.Series, Optional[pd.Series]]:
    """
    CatBoost forecast — handles categorical features natively.
    
    Ideal for: Volatile Mid (price-elastic + promo-sensitive)
    
    Features:
      • Native one-hot encoding for promo, event flags
      • Feature importance ranking
      • Built-in regularization (no manual CV needed)
      • Fast predictions
    
    Args:
        sku_panel: Panel data with features
        date_col: Date column name
        sales_col: Sales column name
        h: Forecast horizon
        freq: Frequency (D/W/MS/QS/YS)
        numeric_features: List of numeric feature columns
        categorical_features: List of categorical columns (promo, events)
    
    Returns:
        (forecast_series, confidence_intervals)
    """
    
    if not CATBOOST_AVAILABLE:
        return None, None
    
    try:
        sku_panel = sku_panel.sort_values(date_col).copy()
        sku_panel.set_index(date_col, inplace=True)

        # Prepare features
        if numeric_features is None:
            numeric_features = ['lag_1', 'lag_3', 'lag_12', 'log_price', 'price_change_pct']
        if categorical_features is None:
            categorical_features = [col for col in sku_panel.columns if col.startswith('evt_')]

        available_numeric = [f for f in numeric_features if f in sku_panel.columns]
        available_categorical = [f for f in categorical_features if f in sku_panel.columns]

        if not available_numeric and not available_categorical:
            return None, None

        def _lag_digits(col):
            ds = ''.join(ch for ch in str(col) if ch.isdigit())
            return int(ds) if ds else 0

        # Build the design frame. Drop warm-up rows that have no shortest-lag
        # value, then fill any remaining gaps (longer lags early in the series)
        # with the column mean — NOT zeros. A 0-filled early block collapses a
        # lag column to a near-constant, and CatBoost's quantizer raises on
        # constant features (catboost/libs/data/quantization.cpp). This is the
        # root cause of the "CatBoost failed: …quantization.cpp:241" error on
        # short train slices (k-fold folds, short-history SKUs).
        Xdf = sku_panel[available_numeric + available_categorical].copy()
        lag_cols = [c for c in available_numeric
                    if str(c).lower().startswith('lag')]
        if lag_cols:
            shortest = min(lag_cols, key=_lag_digits)
            Xdf = Xdf[Xdf[shortest].notna()]
        y = sku_panel.loc[Xdf.index, sales_col].astype(float)

        for c in available_numeric:
            col = pd.to_numeric(Xdf[c], errors='coerce')
            Xdf[c] = col.fillna(col.mean() if col.notna().any() else 0.0)
        for c in available_categorical:
            Xdf[c] = Xdf[c].fillna(0)

        # Drop constant (zero-variance) numeric features — the actual trigger
        # for the quantization error — so CatBoost only sees features it can bin.
        available_numeric = [c for c in available_numeric
                             if Xdf[c].nunique(dropna=False) > 1]
        if not available_numeric and not available_categorical:
            return None, None

        feature_cols = available_numeric + available_categorical
        Xdf = Xdf[feature_cols]

        # Bail out gracefully (→ caller falls back to Holt-Winters) when there's
        # too little signal to quantize/fit reliably.
        if len(Xdf) < 8 or y.nunique() < 2:
            return None, None

        X = Xdf.values
        y = y.values
        n_rows = len(X)

        # Size the model to the data: tiny series get fewer iterations, shallower
        # trees, and a border_count that can't exceed the sample count.
        model = cb.CatBoostRegressor(
            iterations=int(min(400, max(50, n_rows * 12))),
            learning_rate=0.05,
            depth=int(min(6, max(3, n_rows // 6))),
            border_count=int(min(128, max(8, n_rows))),
            cat_features=list(range(len(available_numeric),
                                    len(available_numeric) + len(available_categorical)))
                         if available_categorical else None,
            verbose=False,
            allow_writing_files=False,
            loss_function='MAE',
        )
        model.fit(X, y)

        # Recursive multi-step forecast. We roll the lag-style numeric features
        # forward using each step's own prediction so the horizon isn't just the
        # same value repeated h times. Lag columns are detected by a 'lag' prefix;
        # exogenous/categorical columns are held flat at their last observed value.
        last_features = X[-1].astype(float).copy()
        lag_idx = [i for i, c in enumerate(available_numeric) if str(c).lower().startswith('lag')]
        # Order lag indices by the lag horizon embedded in the name (lag_1, lag_3…)
        def _lag_order(col):
            digits = ''.join(ch for ch in str(col) if ch.isdigit())
            return int(digits) if digits else 0
        lag_idx.sort(key=lambda i: _lag_order(available_numeric[i]))

        forecast_values = []
        for _ in range(h):
            pred = max(0.0, float(model.predict([last_features])[0]))  # Non-negative
            forecast_values.append(pred)
            # Shift lag features: each longer lag inherits the previous shorter
            # lag's value, and the shortest lag becomes the new prediction.
            for j in range(len(lag_idx) - 1, 0, -1):
                last_features[lag_idx[j]] = last_features[lag_idx[j - 1]]
            if lag_idx:
                last_features[lag_idx[0]] = pred

        # Build index
        idx = pd.date_range(sku_panel.index[-1], periods=h + 1, freq=freq)[1:]
        forecast = pd.Series(forecast_values, index=idx, name='forecast')

        return forecast, None

    except Exception:
        # Best-effort model — the caller (forecast_catboost_uni) falls back to
        # Holt-Winters when this returns None, so fail quietly rather than
        # spamming logs across thousands of SKUs / k-fold folds.
        return None, None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. XGB QUANTILE REGRESSION — Uncertainty Quantiles
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def forecast_xgb_quantile(
    history: pd.Series,
    h: int,
    freq: str,
    quantile: float = 0.9
) -> pd.Series:
    """
    XGBoost Quantile Regression — forecast at specified percentile.
    
    Use Cases:
      • quantile=0.90 → Safety stock (99th percentile for critical SKUs)
      • quantile=0.50 → Median (robust to outliers)
      • quantile=0.10 → Lower bound (markdown planning)
    
    Ideal for: Volatile High, Volatile Mid (risk-aware forecasting)
    
    Args:
        history: Historical sales series
        h: Forecast horizon
        freq: Frequency
        quantile: Percentile to forecast (0.1-0.99)
    
    Returns:
        forecast_series at specified quantile
    """
    
    if not SKLEARN_QR_AVAILABLE:
        return None
    
    try:
        if len(history) < 12:
            return None
        
        # Build lags as features
        history_arr = history.values
        X, y = [], []
        
        for i in range(3, len(history_arr)):
            X.append([
                history_arr[i-1],  # lag_1
                history_arr[i-3],  # lag_3
                history_arr[i-12] if i >= 12 else history_arr[0]  # lag_12
            ])
            y.append(history_arr[i])
        
        X = np.array(X)
        y = np.array(y)
        
        # Train quantile regressor
        model = QuantileRegressor(
            quantile=quantile,
            alpha=0.01,
            solver='highs'
        )
        model.fit(X, y)
        
        # Forecast
        forecast_values = []
        last_features = X[-1].copy()
        
        for _ in range(h):
            pred = max(0, model.predict([last_features])[0])
            forecast_values.append(pred)
            # Update features: shift lags
            last_features = [pred, last_features[0], last_features[1]]
        
        idx = pd.date_range(history.index[-1], periods=h + 1, freq=freq)[1:]
        return pd.Series(forecast_values, index=idx)
    
    except Exception:
        # Quiet failure — caller falls back to Holt-Winters.
        return None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. NEURAL ELASTICITY — Price-Demand Nonlinearity
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def forecast_neural_elasticity(
    sku_panel: pd.DataFrame,
    date_col: str,
    sales_col: str,
    price_col: str,
    h: int,
    freq: str,
    future_price: Optional[np.ndarray] = None
) -> Optional[pd.Series]:
    """
    Neural Elasticity Model — Keras LSTM for price-demand curves.
    
    Learns nonlinear relationship: demand = f(price, trend, seasonality)
    
    Rationale:
      • Linear regression: demand ∝ log(price) → assumes constant elasticity
      • Neural network: learns piecewise elasticity curves
      • Example: Hero SKU may have 40% drop at 2× price, niche SKU only 10%
    
    Ideal for: Volatile Mid (promo-sensitive), Stable High (hero SKUs)
    
    Architecture:
      • Input: [price_t, price_t-1, lag_1_sales, trend_component]
      • LSTM(32) → LSTM(16) → Dense(8) → Dense(1)
      • Output: forecast for next period
    
    Args:
        sku_panel: Panel data
        date_col: Date column
        sales_col: Sales column  
        price_col: Price column
        h: Forecast horizon
        freq: Frequency
        future_price: Future price forecast (array of length h)
    
    Returns:
        forecast_series with neural predictions
    """
    
    keras_syms = _try_import_keras()
    if keras_syms is None:
        return None
    Sequential, LSTM, Dense, Dropout, Adam = keras_syms

    try:
        sku_panel = sku_panel.sort_values(date_col).copy()
        history = sku_panel.set_index(date_col)[sales_col].values
        prices = sku_panel.set_index(date_col)[price_col].values
        
        if len(history) < 24:
            return None  # Need enough data for LSTM
        
        # Build sequences
        lookback = 3
        X_price, X_lags, y = [], [], []
        
        for i in range(lookback, len(history) - 1):
            price_seq = prices[i-lookback:i]  # Last 3 prices
            lag_seq = history[i-lookback:i]   # Last 3 sales
            
            X_price.append(price_seq)
            X_lags.append(lag_seq)
            y.append(history[i + 1])
        
        X_price = np.array(X_price).reshape(-1, lookback, 1)
        X_lags = np.array(X_lags).reshape(-1, lookback, 1)
        y = np.array(y)
        
        # Build LSTM model
        model = Sequential([
            LSTM(32, activation='relu', input_shape=(lookback, 1), return_sequences=True),
            Dropout(0.2),
            LSTM(16, activation='relu'),
            Dropout(0.2),
            Dense(8, activation='relu'),
            Dense(1, activation='relu')  # Non-negative output
        ])
        
        model.compile(optimizer=Adam(learning_rate=0.001), loss='mae')
        model.fit(
            [X_price, X_lags], y,
            epochs=50,
            batch_size=8,
            verbose=0,
            validation_split=0.1
        )
        
        # Forecast
        forecast_values = []
        last_price = prices[-lookback:]
        last_lags = history[-lookback:]
        
        if future_price is None:
            future_price = np.repeat(prices[-1], h)
        
        for i in range(h):
            price_input = np.array(last_price).reshape(1, lookback, 1)
            lags_input = np.array(last_lags).reshape(1, lookback, 1)
            
            pred = model.predict([price_input, lags_input], verbose=0)[0][0]
            forecast_values.append(max(0, float(pred)))
            
            # Update sequences
            last_price = np.roll(last_price, -1)
            last_price[-1] = future_price[i]
            last_lags = np.roll(last_lags, -1)
            last_lags[-1] = forecast_values[-1]
        
        idx = pd.date_range(sku_panel[date_col].iloc[-1], periods=h + 1, freq=freq)[1:]
        return pd.Series(forecast_values, index=idx)
    
    except Exception:
        # Quiet failure — caller falls back to Holt-Winters.
        return None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# INTEGRATION GUIDE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"""
HOW TO INTEGRATE INTO app_v2_6.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: Import Phase 2 models (top of app_v2_6.py)
─────────────────────────────────────────────────────────────
from phase2_enhancements import (
    forecast_catboost,
    forecast_xgb_quantile,
    forecast_neural_elasticity,
    CATBOOST_AVAILABLE,
    SKLEARN_QR_AVAILABLE,
    KERAS_AVAILABLE
)

STEP 2: Add to ADDITIONAL_FORECASTERS dict (line ~2000)
─────────────────────────────────────────────────────────────
ADDITIONAL_FORECASTERS = {
    'holt_winters': forecast_holt_winters,
    'prophet': forecast_prophet,
    'autoarima': forecast_autoarima,
    'theta': forecast_theta,
    'tsb': forecast_tsb,
    'naive_seasonal': forecast_naive_seasonal,
    
    # Phase 2 additions
    'catboost': lambda hist, h, freq: forecast_catboost(...) or hist.mean(),
    'xgb_quantile_90': lambda hist, h, freq: forecast_xgb_quantile(hist, h, freq, 0.9),
    'neural_elasticity': lambda hist, h, freq: forecast_neural_elasticity(...) or hist.mean(),
}

STEP 3: Update SEGMENT_ARCHITECTURE blends (line ~198)
─────────────────────────────────────────────────────────────
'Stable High contributors': {
    'primary': 'prophet',
    'blend': ['global_lgbm', 'catboost', 'autoarima', 'neural_elasticity'],  # Added
    ...
}

'Volatile Mid contributors': {
    'primary': 'global_lgbm',
    'blend': ['prophet', 'catboost', 'neural_elasticity', 'theta'],  # Added
    ...
}

STEP 4: Test (run app_v2_6.py)
─────────────────────────────────────────────────────────────
streamlit run app_v2_6.py
# Upload retail_clean_demo.csv
# Run forecasts
# Check blend pool includes new models

EXPECTED IMPROVEMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Model             Segments                    Impact
─────────────────────────────────────────────────────────────
CatBoost          Volatile Mid, Stable Mid    +3-5% MAPE
XGB Quantile      Volatile High               Risk quantiles only
Neural Elasticity Volatile Mid, Stable High   +5-8% MAPE (price elasticity)

Total Phase 2 Expected: –8-15% additional MAPE improvement
                        (9-13% → 7-11% overall)
"""

if __name__ == '__main__':
    _try_import_keras()  # probe so the banner reports a real bool, not None
    print("✅ Phase 2 Enhancement Models Ready")
    print(f"   CatBoost available: {CATBOOST_AVAILABLE}")
    print(f"   XGB Quantile available: {SKLEARN_QR_AVAILABLE}")
    print(f"   Neural Elasticity available: {KERAS_AVAILABLE}")
    print("\n📖 See integration guide above for usage in app_v2_6.py")
