"""
generate_retail_demo_data.py
============================
Generates a credible synthetic retail dataset for testing the DhishaAI Demand
Forecasting app.

The dataset is engineered so that every cell of the 6-segment matrix is
populated AND every SKU has enough history for the forecasting engine to
report Train / Test MAPE + Historical prediction:

    stable High  | Stable Mid  | stable Low
    Volatile Hi  | Volatile Md | Volatile Lo
    + CV NULL/0 (cold-start / NPI SKUs — now 6–8 months of history,
                 enough for 1 rolling-origin train window + 1 test holdout)

Design rules (so the app's MAPE/SMAPE/historical-forecast coverage is 100%):
    1. Every SKU has at least 4 non-zero months → standard MAPE is defined
       on the test holdout AND on at least one training rolling-origin point.
    2. Cold-start SKUs have 6–8 months of history (not 1–2), giving them
       enough data for a single rolling backtest window.
    3. Intermittent SKUs cap zero-rate at 50% (was 55%) so test month is
       rarely zero — SMAPE fallback still covers the rest.

Vertical:   multi-category Indian lifestyle retailer
Categories: Footwear, Apparel, Bags, Accessories
Brands:     3 fictional brands per category
SKUs:       ~120
Months:     36 (Jan-2022 → Dec-2024)

Output columns (long format, one row per SKU per month):
    date, sku, product_name, category, brand, sales, revenue, unit_price

Run:
    python generate_retail_demo_data.py
Produces:
    retail_demo_data.csv
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime


# --------------------------------------------------------------------------
# Catalogue: categories × brands × product templates
# --------------------------------------------------------------------------
CATEGORIES = {
    "Footwear": {
        "brands": ["Strider", "Pacepoint", "Trailmark"],
        "products": ["Running Shoe", "Casual Sneaker", "Loafer", "Boot",
                     "Sandal", "Slip-On", "Trekking Shoe", "Formal Oxford"],
        "price_range": (799, 4499),
    },
    "Apparel": {
        "brands": ["Urbano", "Threadline", "Indigo Co."],
        "products": ["Slim-Fit Jeans", "Polo T-Shirt", "Hoodie", "Chinos",
                     "Linen Shirt", "Cargo Pant", "Crew-Neck Tee",
                     "Casual Shirt"],
        "price_range": (399, 2999),
    },
    "Bags": {
        "brands": ["Nomad&Co", "Carryall", "Voyage"],
        "products": ["Laptop Backpack", "Sling Bag", "Duffel", "Tote",
                     "Crossbody", "Trolley 55cm", "Wallet", "Pouch"],
        "price_range": (499, 3499),
    },
    "Accessories": {
        "brands": ["Tonic", "Loop", "Atlas"],
        "products": ["Sunglasses", "Belt", "Cap", "Socks (3-pack)",
                     "Wristband", "Wallet", "Scarf", "Tie"],
        "price_range": (149, 1499),
    },
}

# --------------------------------------------------------------------------
# Demand archetypes — engineered to fill the segment matrix
# Each archetype defines (base_mean, cv_target, seasonality, trend, intermittency)
# --------------------------------------------------------------------------
ARCHETYPES = {
    # name                    base   cv    season   trend     intermittent  weight
    "hero_stable":         dict(base=350, cv=0.30, season=0.10, trend=+0.02, intermit=0.00),
    "steady_mid":          dict(base=120, cv=0.40, season=0.15, trend=+0.01, intermit=0.00),
    "tail_steady":         dict(base= 25, cv=0.45, season=0.10, trend=+0.00, intermit=0.00),
    "promo_volatile_hi":   dict(base=520, cv=1.40, season=0.20, trend=+0.01, intermit=0.00),
    "seasonal_volatile":   dict(base=110, cv=1.10, season=0.55, trend=+0.00, intermit=0.00),
    "erratic_tail":        dict(base= 18, cv=1.80, season=0.10, trend=+0.00, intermit=0.30),
    # Cap zero-rate at 0.50 (was 0.55) so the LAST month — the test holdout —
    # is rarely zero, which means standard MAPE is defined on most
    # intermittent SKUs and SMAPE covers the rest.
    "intermittent":        dict(base= 14, cv=2.20, season=0.05, trend=+0.00, intermit=0.50),
    "cold_start":          dict(base=  0, cv=0.00, season=0.00, trend=+0.00, intermit=0.00),  # special
}

# Target SKU mix per archetype — ensures every segment populated
ARCHETYPE_TARGETS = {
    "hero_stable":        10,  # → stable High
    "steady_mid":         28,  # → Stable Mid
    "tail_steady":        25,  # → stable Low
    "promo_volatile_hi":  12,  # → Volatile High
    "seasonal_volatile":  20,  # → Volatile Mid
    "erratic_tail":       15,  # → Volatile Low
    "intermittent":        6,  # → Volatile Low / intermittent
    "cold_start":          4,  # → CV NULL/0
}


# --------------------------------------------------------------------------
# Time series synthesis
# --------------------------------------------------------------------------
def synthesize_series(spec: dict, dates: pd.DatetimeIndex, seed: int) -> np.ndarray:
    """Generate a monthly sales vector for one SKU according to its archetype."""
    rng = np.random.default_rng(seed)
    n = len(dates)
    if spec["base"] == 0:
        # Cold-start / NPI: real sales only in the LAST 6–8 months. Wider
        # window than before (1–2 months) so the forecasting engine can
        # produce a Train MAPE (≥ 1 rolling-origin window) + Test MAPE
        # (1-month holdout) + Historical prediction line on the chart.
        # Earlier months remain zero — segmenter still classifies as
        # cold-start because the FULL history has very short non-zero tail.
        sales = np.zeros(n)
        active_periods = int(rng.integers(6, 9))   # 6, 7, or 8 months
        warm_base = float(rng.integers(20, 80))
        # Light trend across the warm-up so two consecutive months aren't
        # identical — gives backtests something to actually score against.
        ramp = np.linspace(0.75, 1.25, active_periods)
        sales[-active_periods:] = rng.normal(
            warm_base, warm_base * 0.4, size=active_periods) * ramp
        return np.clip(sales, 0, None).round()

    base = spec["base"]
    cv = spec["cv"]
    season_amp = spec["season"]
    trend = spec["trend"]
    intermit = spec["intermit"]

    # Trend (compound monthly)
    t = np.arange(n)
    trend_mult = (1 + trend) ** t

    # Seasonality — sinusoid peaking around month 11 (festive) + month 5 (summer)
    month_of_year = np.array([d.month for d in dates])
    seasonal = 1 + season_amp * (
        0.6 * np.sin(2 * np.pi * (month_of_year - 11) / 12) +
        0.4 * np.sin(2 * np.pi * (month_of_year - 5) / 12)
    )

    # Noise — multiplicative, calibrated to target CV
    # σ_noise ≈ cv (multiplicative lognormal)
    noise_sigma = np.sqrt(np.log(1 + cv ** 2))
    noise_mu = -0.5 * noise_sigma ** 2     # so E[noise]=1
    noise = rng.lognormal(mean=noise_mu, sigma=noise_sigma, size=n)

    sales = base * trend_mult * seasonal * noise

    # Intermittency — randomly zero out periods. Protect the LAST month
    # (the test-holdout target): if the random zero-mask happens to land
    # on it, flip it back on. Otherwise standard MAPE is undefined for the
    # test backtest of these SKUs — SMAPE still works, but keeping the
    # last month non-zero means most intermittent SKUs surface a real
    # MAPE in the table, not just an SMAPE fallback.
    if intermit > 0:
        mask = rng.random(n) < intermit
        mask[-1] = False   # never zero the final month
        sales[mask] = 0

    # Occasional big spike (promo) for promo_volatile_hi
    if cv >= 1.3 and intermit < 0.2:
        n_promos = rng.integers(2, 5)
        promo_idx = rng.choice(n, size=n_promos, replace=False)
        sales[promo_idx] *= rng.uniform(2.0, 4.0, size=n_promos)

    return np.clip(sales, 0, None).round()


# --------------------------------------------------------------------------
# SKU catalogue builder
# --------------------------------------------------------------------------
def build_sku_catalogue(seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    # Spread SKUs across categories proportionally to ARCHETYPE_TARGETS
    rows = []
    sku_counter = 1000

    archetypes_flat = []
    for arch, n in ARCHETYPE_TARGETS.items():
        archetypes_flat.extend([arch] * n)
    rng.shuffle(archetypes_flat)

    cat_keys = list(CATEGORIES.keys())
    for arch in archetypes_flat:
        cat = rng.choice(cat_keys)
        cat_info = CATEGORIES[cat]
        brand = rng.choice(cat_info["brands"])
        product = rng.choice(cat_info["products"])
        p_lo, p_hi = cat_info["price_range"]
        # Hero SKUs tend toward premium pricing; tail toward cheaper
        if arch in ("hero_stable", "promo_volatile_hi"):
            price = rng.uniform(0.55 * p_hi, p_hi)
        elif arch in ("tail_steady", "erratic_tail", "intermittent"):
            price = rng.uniform(p_lo, 0.55 * p_lo + 0.45 * p_hi)
        else:
            price = rng.uniform(p_lo, p_hi)
        price = round(price / 10) * 10        # round to nearest ₹10
        sku_code = f"{cat[:3].upper()}{sku_counter:04d}"
        rows.append({
            "sku": sku_code,
            "product_name": f"{brand} {product}",
            "category": cat,
            "brand": brand,
            "unit_price": price,
            "archetype": arch,
        })
        sku_counter += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Long-format panel builder
# --------------------------------------------------------------------------
def build_panel(catalogue: pd.DataFrame,
                start: str = "2022-01-01",
                end: str = "2024-12-31") -> pd.DataFrame:
    dates = pd.date_range(start=start, end=end, freq="MS")
    rows = []
    seed_base = 1
    for _, sku in catalogue.iterrows():
        spec = ARCHETYPES[sku["archetype"]]
        sales = synthesize_series(spec, dates, seed=seed_base)
        seed_base += 1
        for d, s in zip(dates, sales):
            rows.append({
                "date": d.strftime("%Y-%m-%d"),
                "sku": sku["sku"],
                "product_name": sku["product_name"],
                "category": sku["category"],
                "brand": sku["brand"],
                "unit_price": sku["unit_price"],
                "sales": int(s),
                "revenue": float(s * sku["unit_price"]),
            })
    df = pd.DataFrame(rows)

    # Drop the leading zero-rows for cold-start SKUs so they REALLY look like NPI
    cold_skus = catalogue.loc[catalogue["archetype"] == "cold_start", "sku"].tolist()
    if cold_skus:
        # For cold SKUs, keep only rows with sales > 0
        cold_mask = df["sku"].isin(cold_skus)
        keep_mask = (~cold_mask) | (df["sales"] > 0)
        df = df[keep_mask].reset_index(drop=True)

    return df


# --------------------------------------------------------------------------
# Quick QA print
# --------------------------------------------------------------------------
def qa_report(catalogue: pd.DataFrame, panel: pd.DataFrame) -> None:
    print("=" * 70)
    print(f"Catalogue: {len(catalogue):,} SKUs")
    print(catalogue.groupby(["category", "brand"]).size().unstack(fill_value=0))
    print()
    print(f"Panel: {len(panel):,} rows  |  "
          f"{panel['sku'].nunique()} SKUs  |  "
          f"{panel['date'].nunique()} dates  |  "
          f"{panel['date'].min()} → {panel['date'].max()}")
    print(f"Total sales (units):    {panel['sales'].sum():>12,}")
    print(f"Total revenue (₹):      {panel['revenue'].sum():>12,.0f}")
    print()
    # Quick CV histogram
    agg = panel.groupby("sku")["sales"].agg(["mean", "std", "count"])
    agg["cv"] = agg["std"] / agg["mean"]
    print("CV distribution:")
    print(agg["cv"].describe())
    print()
    print("Archetype → expected segment cell:")
    arch_map = catalogue.set_index("sku")["archetype"].to_dict()
    agg["archetype"] = agg.index.map(arch_map)
    print(agg.groupby("archetype")[["mean", "cv", "count"]].mean().round(2))


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    catalogue = build_sku_catalogue(seed=42)
    panel = build_panel(catalogue)

    out_path = Path(__file__).parent / "retail_demo_data.csv"
    # Drop the helper unit_price column? Keep it — useful for the demo.
    export = panel[["date", "sku", "product_name", "category", "brand",
                    "unit_price", "sales", "revenue"]]
    export.to_csv(out_path, index=False)
    print(f"\n✓ Wrote {len(export):,} rows to {out_path}")

    qa_report(catalogue, panel)


if __name__ == "__main__":
    main()
