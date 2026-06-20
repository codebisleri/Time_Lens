"""Ad-hoc back-test: Volatile High accuracy — OLD vs NEW levers.
OLD = plain Prophet (no holidays) + winner-takes-all (blend off)
NEW = event-aware Prophet + weighted ensemble (Levers 1+3+5)
Compares leak-free headline backtest MAPE/SMAPE per SKU.
"""
import warnings; warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
import app_v2_6 as app

H = 3
SALES, DATE, SKU = 'sales', 'date', 'sku'

# ---- plain (pre-change) Prophet for the OLD baseline ----
def plain_prophet(history, h, freq):
    try:
        from prophet import Prophet
        d = pd.DataFrame({'ds': history.index, 'y': history.values})
        m = Prophet(yearly_seasonality=True, weekly_seasonality=False, daily_seasonality=False)
        m.fit(d)
        fut = m.make_future_dataframe(periods=h, freq=freq, include_history=False)
        out = m.predict(fut)['yhat'].clip(lower=0).values
        return pd.Series(out, index=app._future_index(history, h, freq))
    except Exception:
        return app.forecast_holt_winters(history, h, freq)

EVENT_PROPHET = app.forecast_prophet  # the new event-aware one


def make_profile(seg='Volatile High contributors'):
    return {'segment': seg, 'recommended_strategy': 'prophet',
            'intermittency': 'erratic', 'is_cold_start': False,
            'is_short_history': False}


def run_one(panel, profile):
    res = app.forecast_one_sku('S', panel, profile, H, 'MS', SKU, DATE, SALES,
                               global_pkg=None, run_backtest=True)
    return res.backtest_mape, res.backtest_smape, res.strategy_used


def set_config(mode):
    if mode == 'OLD':
        app.ADDITIONAL_FORECASTERS['prophet'] = plain_prophet
        app.forecast_prophet = plain_prophet
        app.ENABLE_WEIGHTED_BLEND = False
    else:  # NEW
        app.ADDITIONAL_FORECASTERS['prophet'] = EVENT_PROPHET
        app.forecast_prophet = EVENT_PROPHET
        app.ENABLE_WEIGHTED_BLEND = True


# ---- gather Volatile High SKUs: 3 real + synthetic event-spiky ----
panels = []  # (name, panel)

df = pd.read_csv('Data_for_forecast/retail_demo_data.csv')
cols = {c.lower(): c for c in df.columns}
rc = cols.get('revenue')
seg = app.compute_retail_segmentation(df, cols['sku'], cols['sales'], cols['date'], revenue_col=rc)
vh = seg[seg['segment'] == 'Volatile High contributors']['sku'].tolist()
for s in vh:
    sub = df[df[cols['sku']] == s].copy()
    sub = sub.rename(columns={cols['sku']: SKU, cols['sales']: SALES, cols['date']: DATE})
    sub[DATE] = pd.to_datetime(sub[DATE])
    sub = sub.groupby(DATE, as_index=False)[SALES].sum().sort_values(DATE)
    sub[SKU] = 'S'
    if len(sub) >= 18:
        panels.append((f"real:{s}", sub[[DATE, SKU, SALES]]))

# synthetic: 36-mo monthly, high CV, annual festival spikes (months Oct/Nov) + promo noise
rng = np.random.RandomState(7)
idx = pd.date_range('2022-01-01', periods=36, freq='MS')
for k in range(6):
    base = rng.randint(120, 360)
    season = 0.25 * base * np.sin(2 * np.pi * (np.arange(36) % 12) / 12.0)
    series = base + season + rng.normal(0, 0.18 * base, 36)
    for t in range(36):
        if idx[t].month in (10, 11):          # festival spike
            series[t] += rng.uniform(1.6, 2.6) * base
        if rng.rand() < 0.15:                  # random promo bursts
            series[t] += rng.uniform(0.8, 1.5) * base
    series = np.clip(series, 0, None).round()
    p = pd.DataFrame({DATE: idx, SKU: 'S', SALES: series})
    panels.append((f"synth:{k}", p))

print(f"Back-testing {len(panels)} Volatile-High SKUs (H={H}), leak-free holdout MAPE\n")
print(f"{'SKU':14} {'OLD_MAPE':>9} {'NEW_MAPE':>9} {'Δ%':>7}   {'NEW strategy'}")
print("-" * 80)

rows = []
for name, panel in panels:
    try:
        set_config('OLD'); old_m, old_s, _ = run_one(panel, make_profile())
        set_config('NEW'); new_m, new_s, strat = run_one(panel, make_profile())
        if old_m is None or new_m is None:
            print(f"{name:14} {'n/a':>9} {'n/a':>9}      -   {strat}")
            continue
        delta = (new_m - old_m) / old_m * 100 if old_m else 0.0
        rows.append((old_m, new_m))
        tag = strat if len(strat) < 42 else strat[:39] + '...'
        print(f"{name:14} {old_m:9.1f} {new_m:9.1f} {delta:+7.1f}   {tag}")
    except Exception as e:
        print(f"{name:14} ERROR {type(e).__name__}: {str(e)[:50]}")

if rows:
    old = np.array([r[0] for r in rows]); new = np.array([r[1] for r in rows])
    print("-" * 80)
    print(f"{'MEAN':14} {old.mean():9.1f} {new.mean():9.1f} {(new.mean()-old.mean())/old.mean()*100:+7.1f}")
    print(f"{'MEDIAN':14} {np.median(old):9.1f} {np.median(new):9.1f} "
          f"{(np.median(new)-np.median(old))/np.median(old)*100:+7.1f}")
    wins = int((new < old).sum())
    print(f"\nNEW beat OLD on {wins}/{len(rows)} SKUs")
print("\n__BACKTEST_DONE__")
