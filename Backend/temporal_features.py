"""
Temporal Feature Engineering Module
Frequency-aware exogenous variables for demand forecasting.

Author: DhishaAI Forecast Engineering
Date: 2026-05-23

This module provides:
- Frequency detection and validation
- Holiday & festival aggregation
- Temporal phase indicators
- Business day calculations
- India-specific festival calendar
"""

import pandas as pd
import numpy as np
from typing import Tuple, List, Dict, Optional
from datetime import datetime
import warnings

# ================================================================
# PART 1: HOLIDAY & FESTIVAL DATA STRUCTURES
# ================================================================

INDIA_FESTIVAL_CALENDAR = {
    # (month, approximate_day): (festival_name, is_major, typical_impact_days)
    (1, 26): ('republic_day', False, 3),
    (1, 1): ('new_year', False, 7),
    (2, 14): ('valentines_day', False, 2),
    (3, 8): ('holi', True, 20),        # ← Major festival
    (3, 25): ('ugadi', False, 3),
    (4, 14): ('baisakhi', False, 5),
    (5, 1): ('may_day', False, 1),
    (6, 21): ('summer_solstice', False, 2),
    (7, 17): ('muharram', False, 5),
    (8, 15): ('independence_day', False, 5),
    (8, 15): ('janmashtami', False, 5),
    (9, 16): ('milad_un_nabi', False, 3),
    (9, 21): ('navratri_start', True, 14),  # ← Major festival
    (9, 30): ('dussehra', True, 5),
    (10, 2): ('gandhi_jayanthi', False, 3),
    (10, 24): ('diwali', True, 30),    # ← MAJOR FESTIVAL (highest impact)
    (10, 29): ('govardhan_puja', False, 3),
    (10, 30): ('bhai_dooj', False, 3),
    (11, 1): ('diwali_buyback', True, 7),  # Post-Diwali consumer refresh
    (11, 11): ('diwali_extended', False, 5),  # Extended festival period
    (12, 25): ('christmas', False, 20),
    (12, 31): ('new_year_eve', False, 7),
}

RELIGIOUS_FESTIVAL_CALENDAR = {
    # Movable festivals (lunar calendar) — use approximate dates
    'eid_ul_fitr': {
        'typical_months': [4, 5],  # Varies by year (lunar)
        'is_major': True,
        'typical_impact_days': 7,
        'description': 'Islamic festival marking end of Ramadan'
    },
    'eid_ul_adha': {
        'typical_months': [7, 8],
        'is_major': True,
        'typical_impact_days': 7,
        'description': 'Islamic festival of sacrifice'
    },
    'muharram_islamic_new_year': {
        'typical_months': [7, 8],
        'is_major': False,
        'typical_impact_days': 3,
    },
}

REGIONAL_FESTIVALS = {
    'south': [
        'pongal', 'makar_sankranti', 'ugadi', 'onam'
    ],
    'north': [
        'baisakhi', 'diwali', 'holi', 'dussehra'
    ],
    'east': [
        'durga_puja', 'onam', 'pongal'
    ],
    'west': [
        'navratri', 'diwali', 'holi', 'pongal'
    ],
}

# Substring keywords that mark a holiday as "special"/major (high demand impact).
# Matched case-insensitively against the holiday *name* returned by the
# `holidays` library, so it survives the lunar-calendar date drift that makes
# fixed (month, day) lookups unreliable. Anything that does NOT match is
# classified as an "other"/minor public holiday.
MAJOR_HOLIDAY_KEYWORDS = (
    'diwali', 'deepavali', 'holi', 'navratri', 'navaratri', 'dussehra',
    'dasara', 'vijaya dashami', 'durga puja', 'ganesh', 'janmashtami',
    'eid', 'id-ul', 'bakrid', 'christmas', 'independence day', 'republic day',
    'gandhi', 'pongal', 'onam', 'raksha bandhan', 'rakhi', 'ram navami',
    'shivaratri', 'shivratri', 'guru nanak', 'gurpurab', 'gurpurb',
    'ugadi', 'gudi padwa', 'new year',
)


def classify_holiday(name: str) -> str:
    """Classify a holiday name as 'special' (major festival) or 'other'.

    Generic by design — works for any country's `holidays` output; for
    non-Indian calendars most entries simply fall through to 'other',
    which is the correct conservative default.
    """
    n = str(name or '').lower()
    return 'special' if any(k in n for k in MAJOR_HOLIDAY_KEYWORDS) else 'other'

# ================================================================
# PART 2: HELPER FUNCTIONS
# ================================================================

def detect_frequency(dates: pd.Series) -> Tuple[str, str, float]:
    """
    Detect the frequency of a date series.
    
    Returns:
        (pandas_freq, human_label, median_gap_days)
    
    Examples:
        ('D', 'Daily', 1.0)
        ('W', 'Weekly', 7.0)
        ('MS', 'Monthly', 30.4)
    """
    dt_idx = pd.to_datetime(dates, errors='coerce').dropna().unique()
    dt_idx = pd.DatetimeIndex(dt_idx).sort_values()
    
    if len(dt_idx) < 2:
        return '?', 'Unknown', 0.0
    
    gaps = np.diff(dt_idx.values).astype('timedelta64[D]').astype(float)
    median_gap = float(np.median(gaps))
    
    # Frequency detection with tolerance
    if median_gap < 1.5:
        return 'D', 'Daily', median_gap
    elif 6 <= median_gap <= 8.5:
        return 'W', 'Weekly', median_gap
    elif 13 <= median_gap <= 16:
        return 'W', 'Bi-weekly', median_gap
    elif 27 <= median_gap <= 32:
        return 'MS', 'Monthly', median_gap
    elif 85 <= median_gap <= 95:
        return 'QS', 'Quarterly', median_gap
    elif 350 <= median_gap <= 380:
        return 'YS', 'Yearly', median_gap
    else:
        return '?', f'Irregular (~{median_gap:.0f}d)', median_gap


def get_holidays_in_range(
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    country: str = 'IN'
) -> Dict[str, bool]:
    """
    Fetch holidays in a date range using the holidays library.
    
    Returns dict: {date → holiday_name}
    """
    try:
        import holidays as _hol_lib
        years = list(range(start_date.year, end_date.year + 1))
        hol = _hol_lib.country_holidays(country, years=years)
        
        # Filter to range
        holidays_in_range = {
            k: v for k, v in hol.items()
            if start_date.date() <= k <= end_date.date()
        }
        return holidays_in_range
    except ImportError:
        warnings.warn("holidays library not installed. Holiday features will be skipped.")
        return {}


def get_major_festival_in_month(month: int) -> Optional[str]:
    """Return major festival name if month contains one."""
    major_festivals = {
        3: 'holi',
        9: 'navratri',
        10: 'diwali',
    }
    return major_festivals.get(month)


def month_phase(day_of_month: int) -> str:
    """Classify which phase of the month."""
    if day_of_month <= 10:
        return 'early'
    elif day_of_month <= 20:
        return 'mid'
    else:
        return 'late'


def quarter_phase(month: int) -> str:
    """Classify which phase of the quarter."""
    month_in_quarter = (month - 1) % 3 + 1
    if month_in_quarter == 1:
        return 'start'
    elif month_in_quarter == 2:
        return 'mid'
    else:
        return 'end'


def get_seasonality_multiplier(month: int) -> float:
    """
    Get seasonal multiplier for month.
    
    This is a *generic* template based on Indian retail patterns.
    In production, derive this from historical avg demand by month.
    
    Formula: multiplier = avg_sales_in_month / avg_sales_all_months
    """
    # Template based on typical Indian retail calendar
    seasonal_mult_template = {
        1: 0.90,   # Post-holiday slump
        2: 0.88,   # Cold season, pre-Holi
        3: 1.05,   # Holi boost
        4: 0.92,   # Summer starts
        5: 0.85,   # Peak summer slump (too hot for retail)
        6: 0.88,   # Monsoon begins
        7: 0.90,   # Monsoon in full swing
        8: 0.95,   # Monsoon waning
        9: 1.10,   # Pre-Navratri, monsoon ends
        10: 1.25,  # Navratri + Diwali prep (PEAK FESTIVAL SEASON)
        11: 1.30,  # Diwali period (HIGHEST SEASON)
        12: 1.20,  # Year-end, post-Diwali buyback, holidays
    }
    return float(seasonal_mult_template.get(month, 1.0))


def count_holidays_in_month(
    year: int,
    month: int,
    holidays_dict: Dict = None
) -> int:
    """Count number of holidays in a given month."""
    if holidays_dict is None:
        holidays_dict = get_holidays_in_range(
            pd.Timestamp(year, month, 1),
            pd.Timestamp(year, month, 1) + pd.DateOffset(months=1) - pd.Timedelta(days=1),
            country='IN'
        )
    
    # Count holidays in this month
    month_start = pd.Timestamp(year, month, 1).date()
    month_end = (pd.Timestamp(year, month, 1) + pd.DateOffset(months=1) - pd.Timedelta(days=1)).date()
    
    count = 0
    for date_obj in holidays_dict.keys():
        # Convert to date if it's a Timestamp
        if isinstance(date_obj, pd.Timestamp):
            date_obj = date_obj.date()
        elif isinstance(date_obj, datetime):
            date_obj = date_obj.date()
        
        if month_start <= date_obj <= month_end:
            count += 1
    return count


def count_holidays_by_class_in_month(
    year: int,
    month: int,
    holidays_dict: Dict = None
) -> Tuple[int, int]:
    """Count (special_festivals, other_holidays) in a given month.

    `special` = major festivals (Diwali/Holi/Eid/...); `other` = the long
    tail of minor public holidays. The split lets tree/linear models learn
    the very different demand response to a Diwali month vs a month that
    merely contains a minor public holiday.
    """
    if holidays_dict is None:
        holidays_dict = get_holidays_in_range(
            pd.Timestamp(year, month, 1),
            pd.Timestamp(year, month, 1) + pd.DateOffset(months=1) - pd.Timedelta(days=1),
            country='IN'
        )
    month_start = pd.Timestamp(year, month, 1).date()
    month_end = (pd.Timestamp(year, month, 1) + pd.DateOffset(months=1) - pd.Timedelta(days=1)).date()

    special = other = 0
    for date_obj, name in holidays_dict.items():
        if isinstance(date_obj, (pd.Timestamp, datetime)):
            date_obj = date_obj.date()
        if month_start <= date_obj <= month_end:
            if classify_holiday(name) == 'special':
                special += 1
            else:
                other += 1
    return special, other


def get_business_days_in_month(year: int, month: int) -> int:
    """
    Calculate business days (Mon-Fri) in a month.
    
    Note: This is simplified (no holiday adjustment). For production,
    subtract specific holidays.
    """
    month_start = pd.Timestamp(year, month, 1)
    month_end = month_start + pd.DateOffset(months=1) - pd.Timedelta(days=1)
    
    dates = pd.date_range(month_start, month_end, freq='D')
    business_days = (dates.dayofweek < 5).sum()  # Mon-Fri = 0-4
    return int(business_days)


def get_weekends_in_month(year: int, month: int) -> int:
    """Count Saturdays and Sundays in a month."""
    return get_days_in_month(year, month) - get_business_days_in_month(year, month)


def get_days_in_month(year: int, month: int) -> int:
    """Get number of calendar days in a month."""
    month_start = pd.Timestamp(year, month, 1)
    month_end = month_start + pd.DateOffset(months=1) - pd.Timedelta(days=1)
    return month_end.day


# ================================================================
# PART 3: MAIN FEATURE BUILDERS
# ================================================================

def build_temporal_features_daily(
    df: pd.DataFrame,
    date_col: str,
    holidays_dict: Optional[Dict] = None
) -> pd.DataFrame:
    """Build daily-level temporal features."""
    df = df.copy()
    dt = pd.to_datetime(df[date_col], errors='coerce')

    # Day-of-week features
    df['day_of_week'] = dt.dt.dayofweek
    df['is_weekend'] = dt.dt.dayofweek.isin([5, 6]).astype(np.uint8)
    df['is_friday'] = (dt.dt.dayofweek == 4).astype(np.uint8)
    df['is_monday'] = (dt.dt.dayofweek == 0).astype(np.uint8)

    # Day-of-month features
    df['day_of_month'] = dt.dt.day.astype(np.uint8)
    df['is_start_of_month'] = (dt.dt.day <= 3).astype(np.uint8)
    df['is_end_of_month'] = (dt.dt.day >= 28).astype(np.uint8)
    df['is_mid_of_month'] = ((dt.dt.day >= 10) & (dt.dt.day <= 20)).astype(np.uint8)

    # ── Holiday flags — special (major festival) vs other (minor public) ──
    # Computed deterministically from the supplied calendar so the SAME flag
    # is produced on history and on the forecast horizon (no train/serve skew).
    if holidays_dict:
        special_dates = {
            (d.date() if isinstance(d, (pd.Timestamp, datetime)) else d)
            for d, name in holidays_dict.items() if classify_holiday(name) == 'special'
        }
        other_dates = {
            (d.date() if isinstance(d, (pd.Timestamp, datetime)) else d)
            for d, name in holidays_dict.items() if classify_holiday(name) != 'special'
        }
        day_dates = dt.dt.date
        df['is_special_holiday'] = day_dates.isin(special_dates).astype(np.uint8)
        df['is_other_holiday'] = day_dates.isin(other_dates).astype(np.uint8)
    else:
        df['is_special_holiday'] = np.uint8(0)
        df['is_other_holiday'] = np.uint8(0)
    df['is_holiday'] = ((df['is_special_holiday'] + df['is_other_holiday']) > 0).astype(np.uint8)

    # Fourier encoding
    dow = df['day_of_week']
    df['sin_dow'] = np.sin(2 * np.pi * dow / 7.0)
    df['cos_dow'] = np.cos(2 * np.pi * dow / 7.0)

    return df


def build_temporal_features_weekly(
    df: pd.DataFrame,
    date_col: str,
    holidays_dict: Optional[Dict] = None
) -> pd.DataFrame:
    """Build weekly-level temporal features."""
    df = df.copy()
    dt = pd.to_datetime(df[date_col], errors='coerce')
    
    # Week-of-year features
    df['week_of_year'] = dt.dt.isocalendar().week.fillna(0).astype(np.uint8)
    df['is_year_start_week'] = (dt.dt.isocalendar().week <= 2).astype(np.uint8)
    df['is_year_end_week'] = (dt.dt.isocalendar().week >= 51).astype(np.uint8)
    
    # Fourier encoding
    week = df['week_of_year']
    df['sin_week'] = np.sin(2 * np.pi * week / 52.0)
    df['cos_week'] = np.cos(2 * np.pi * week / 52.0)
    
    # Holiday features
    if holidays_dict is not None:
        # Count holidays in week
        def count_hols_in_week(ts):
            week_start = ts - pd.Timedelta(days=ts.dayofweek)
            week_end = week_start + pd.Timedelta(days=6)
            count = 0
            for hol_date in holidays_dict.keys():
                if isinstance(hol_date, datetime):
                    hol_ts = pd.Timestamp(hol_date)
                    if week_start <= hol_ts <= week_end:
                        count += 1
            return count
        
        df['holidays_in_week'] = dt.apply(count_hols_in_week).astype(np.uint8)
    else:
        df['holidays_in_week'] = 0
    
    return df


def build_temporal_features_monthly(
    df: pd.DataFrame,
    date_col: str,
    holidays_dict: Optional[Dict] = None
) -> pd.DataFrame:
    """Build monthly-level temporal features (MOST IMPORTANT).

    PERF: every feature here is a function of (year, month) alone. Naïve
    per-row `.apply()` ran ≤100 K Python calls on the production panel and
    iterated the holidays-dict on every one of them — for MP-Till that
    block dominated the panel build (tens of seconds). This build computes
    each feature ONCE per unique (year, month) into a small lookup table
    (≈36 rows for 3 years of monthly data) and merges it back, turning
    O(N) into O(unique-months). Vectorises the pandas built-ins
    (`dt.days_in_month`) and dict-`.map()` for cheap integer→value lookups.
    """
    df = df.copy()
    dt = pd.to_datetime(df[date_col], errors='coerce')

    # ── Calendar basics (vectorised pandas accessors) ──
    df['month'] = dt.dt.month.fillna(0).astype(np.uint8)
    df['quarter'] = dt.dt.quarter.fillna(0).astype(np.uint8)
    df['year'] = dt.dt.year.fillna(0).astype(np.uint16)

    # ── Days in month — pandas built-in, fully vectorised ──
    df['days_in_month'] = dt.dt.days_in_month.fillna(0).astype(np.uint8)

    # ── Per-(year, month) features: build a small lookup table ONCE ──
    # Every column below is a pure function of (year, month); doing it via
    # unique pairs collapses the work from ~N rows to ~36 unique months.
    valid = dt.notna()
    if valid.any():
        ym_unique = (
            pd.DataFrame({'year': dt.dt.year, 'month': dt.dt.month})
            .loc[valid].drop_duplicates(ignore_index=True)
        )
        ym_unique['year'] = ym_unique['year'].astype(int)
        ym_unique['month'] = ym_unique['month'].astype(int)
        ym_unique['business_days_in_month'] = [
            get_business_days_in_month(y, m)
            for y, m in zip(ym_unique['year'], ym_unique['month'])
        ]
        ym_unique['num_holidays_in_month'] = [
            count_holidays_in_month(y, m, holidays_dict)
            for y, m in zip(ym_unique['year'], ym_unique['month'])
        ]
        _splits = [
            count_holidays_by_class_in_month(y, m, holidays_dict)
            for y, m in zip(ym_unique['year'], ym_unique['month'])
        ]
        ym_unique['num_special_festivals'] = [s[0] for s in _splits]
        ym_unique['num_other_holidays'] = [s[1] for s in _splits]
        # Merge back on (year, month) — the result is aligned to df's order.
        # Use plain int year/month keys for the merge.
        _keys = pd.DataFrame({
            'year': df['year'].astype(int),
            'month': df['month'].astype(int),
        })
        _merged = _keys.merge(ym_unique, on=['year', 'month'], how='left',
                              sort=False)
        df['business_days_in_month'] = _merged['business_days_in_month'].fillna(0).astype(np.uint8).values
        df['num_holidays_in_month'] = _merged['num_holidays_in_month'].fillna(0).astype(np.uint8).values
        df['num_special_festivals'] = _merged['num_special_festivals'].fillna(0).astype(np.uint8).values
        df['num_other_holidays'] = _merged['num_other_holidays'].fillna(0).astype(np.uint8).values
    else:
        df['business_days_in_month'] = np.uint8(0)
        df['num_holidays_in_month'] = np.uint8(0)
        df['num_special_festivals'] = np.uint8(0)
        df['num_other_holidays'] = np.uint8(0)

    df['weekends_in_month'] = (
        df['days_in_month'].astype(np.int16) - df['business_days_in_month'].astype(np.int16)
    ).clip(lower=0).astype(np.uint8)
    df['has_any_holiday'] = (df['num_holidays_in_month'] > 0).astype(np.uint8)
    df['has_special_festival'] = (df['num_special_festivals'] > 0).astype(np.uint8)

    # ── Temporal phase — vectorised via numpy.select instead of per-row .apply ──
    _day = dt.dt.day.fillna(0).astype(int).values
    df['month_phase'] = pd.Categorical(
        np.where(_day <= 10, 'early',
                 np.where(_day <= 20, 'mid', 'late')),
        categories=['early', 'mid', 'late'],
    )
    _qpos = ((df['month'].astype(int) - 1) % 3 + 1).values
    df['quarter_phase'] = pd.Categorical(
        np.where(_qpos == 1, 'start',
                 np.where(_qpos == 2, 'mid', 'end')),
        categories=['start', 'mid', 'end'],
    )

    # ── Seasonality multiplier — dict.map (vectorised) ──
    _seas_map = {m: get_seasonality_multiplier(m) for m in range(1, 13)}
    df['seasonality_multiplier'] = (
        df['month'].map(_seas_map).fillna(1.0).astype(np.float32)
    )

    # ── Peak / off season — vectorised .isin (already fast) ──
    df['is_peak_season'] = df['month'].isin([10, 11, 12]).astype(np.uint8)
    df['is_off_season'] = df['month'].isin([5, 6]).astype(np.uint8)

    # ── Major festival — dict.map ──
    _major_map = {m: get_major_festival_in_month(m) for m in range(1, 13)}
    df['major_festival'] = df['month'].map(_major_map).fillna('none').astype('category')
    
    # ── NEW: Month-of-year encodings (categorical for tree models) ──
    df['month_name'] = pd.to_datetime(df['month'].astype(str), format='%m').dt.strftime('%b')
    df['month_name'] = df['month_name'].astype('category')
    
    # ── Fourier encoding (existing pattern) ──
    df['sin_month'] = np.sin(2 * np.pi * df['month'] / 12.0)
    df['cos_month'] = np.cos(2 * np.pi * df['month'] / 12.0)
    df['sin_quarter'] = np.sin(2 * np.pi * df['quarter'] / 4.0)
    df['cos_quarter'] = np.cos(2 * np.pi * df['quarter'] / 4.0)
    
    return df


def build_temporal_features_quarterly(
    df: pd.DataFrame,
    date_col: str,
    holidays_dict: Optional[Dict] = None
) -> pd.DataFrame:
    """Build quarterly-level temporal features."""
    df = df.copy()
    dt = pd.to_datetime(df[date_col], errors='coerce')
    
    df['quarter'] = dt.dt.quarter.astype(np.uint8)
    df['year'] = dt.dt.year.astype(np.uint16)
    
    # Days in quarter (90 or 92)
    def days_in_quarter(ts):
        if pd.isna(ts):
            return np.nan
        q = ts.quarter
        months = [3, 3, 3]  # Each quarter is 3 months
        total = sum(get_days_in_month(ts.year, (q-1)*3 + m + 1) for m in range(3))
        return total
    
    df['days_in_quarter'] = dt.apply(days_in_quarter).astype(np.uint16)
    
    # Festive quarter indicator
    # India: Q3 (Jul-Sep) has Navratri/Ganesh Chaturthi, Q4 (Oct-Dec) has Diwali + year-end
    df['is_festive_quarter'] = df['quarter'].isin([3, 4]).astype(np.uint8)
    
    # Fourier
    df['sin_quarter'] = np.sin(2 * np.pi * df['quarter'] / 4.0)
    df['cos_quarter'] = np.cos(2 * np.pi * df['quarter'] / 4.0)
    
    return df


def build_temporal_features_yearly(
    df: pd.DataFrame,
    date_col: str
) -> pd.DataFrame:
    """Build yearly-level temporal features."""
    df = df.copy()
    dt = pd.to_datetime(df[date_col], errors='coerce')
    
    df['year'] = dt.dt.year.astype(np.uint16)
    
    # Leap year
    df['is_leap_year'] = dt.dt.is_leap_year.astype(np.uint8)
    
    # Days in year
    df['days_in_year'] = (365 + df['is_leap_year']).astype(np.uint16)
    
    return df


# ================================================================
# PART 4: MAIN ENTRY POINT
# ================================================================

def build_temporal_features(
    df: pd.DataFrame,
    date_col: str,
    freq: str = 'MS',
    holiday_country: str = 'IN'
) -> pd.DataFrame:
    """
    Build frequency-aware temporal features.
    
    Args:
        df: DataFrame with date column
        date_col: name of date column
        freq: pandas frequency code ('D', 'W', 'MS', 'QS', 'YS')
              If 'auto', will be detected from data
        holiday_country: country code for holidays ('IN', 'US', etc.)
    
    Returns:
        DataFrame with added temporal feature columns
    
    Example:
        >>> df = pd.DataFrame({
        ...     'date': pd.date_range('2023-01', '2023-12', freq='MS'),
        ...     'sku': 'SKU001',
        ...     'sales': np.random.randint(100, 1000, 12)
        ... })
        >>> df = build_temporal_features(df, 'date', freq='MS', holiday_country='IN')
        >>> print(df.columns)  # days_in_month, num_holidays_in_month, seasonality_multiplier, ...
    """
    
    # Detect frequency if auto
    if freq.upper() == 'AUTO':
        freq, freq_label, gap = detect_frequency(df[date_col])
        print(f"Detected frequency: {freq_label} (median gap: {gap:.1f} days)")
    
    # Pre-fetch holidays for the date range
    dates = pd.to_datetime(df[date_col], errors='coerce').dropna()
    holidays_dict = None
    if len(dates) > 0:
        try:
            holidays_dict = get_holidays_in_range(
                dates.min(),
                dates.max(),
                country=holiday_country
            )
        except Exception as e:
            warnings.warn(f"Could not load holidays: {e}")
    
    # Route to frequency-specific builder
    freq_upper = freq.upper().strip()
    
    if freq_upper.startswith('D'):
        return build_temporal_features_daily(df, date_col, holidays_dict)

    elif freq_upper.startswith('W'):
        return build_temporal_features_weekly(df, date_col, holidays_dict)
    
    elif freq_upper.startswith('MS') or freq_upper.startswith('M'):
        return build_temporal_features_monthly(df, date_col, holidays_dict)
    
    elif freq_upper.startswith('QS') or freq_upper.startswith('Q'):
        return build_temporal_features_quarterly(df, date_col, holidays_dict)
    
    elif freq_upper.startswith('YS') or freq_upper.startswith('Y'):
        return build_temporal_features_yearly(df, date_col)
    
    else:
        warnings.warn(f"Unknown frequency: {freq}. Skipping temporal features.")
        return df


# Module-level memo for the (typically tiny) future-horizon temporal frame.
# Keyed on (tuple-of-date-ns, freq, country); a forecast run with 3000 SKUs
# previously rebuilt the SAME 6-row frame 6000 times across SARIMAX + LightGBM
# paths. Bounded by FORECAST run shape (a handful of unique horizons per
# session), so the cache stays small.
_TF_FOR_INDEX_CACHE: Dict[Tuple, pd.DataFrame] = {}


def build_temporal_features_for_index(
    index,
    freq: str = 'MS',
    holiday_country: str = 'IN',
) -> pd.DataFrame:
    """Build deterministic temporal features for a bare DatetimeIndex.

    This is the future-horizon twin of `build_temporal_features`: every
    column it returns is a pure function of the date (Tier-0) or of a known
    holiday/festival calendar (Tier-1), so it can be evaluated on a forecast
    horizon WITHOUT any target leakage. Critically it routes through the same
    frequency-specific builders, guaranteeing the future feature values match
    how the model saw them in training (no train/serve skew).

    Returns a DataFrame indexed by `index` containing only the temporal
    feature columns (the synthetic date column is dropped). The result is
    memoised by (index, freq, country) so a per-SKU loop that all forecasts
    the same horizon pays the compute cost ONCE.
    """
    idx = pd.DatetimeIndex(pd.to_datetime(index))
    if len(idx) == 0:
        return pd.DataFrame(index=idx)
    cache_key = (tuple(int(v) for v in idx.asi8), str(freq), str(holiday_country))
    cached = _TF_FOR_INDEX_CACHE.get(cache_key)
    if cached is not None:
        return cached.copy()
    tmp = pd.DataFrame({'__tf_date__': idx})
    out = build_temporal_features(tmp, date_col='__tf_date__', freq=freq,
                                  holiday_country=holiday_country)
    out = out.drop(columns=['__tf_date__'], errors='ignore')
    out.index = idx
    # Cap the cache so a misuse (e.g. unique-per-call indices) can't grow
    # unbounded. ~128 distinct horizons is plenty for any real session.
    if len(_TF_FOR_INDEX_CACHE) >= 128:
        _TF_FOR_INDEX_CACHE.clear()
    _TF_FOR_INDEX_CACHE[cache_key] = out
    return out.copy()


# Columns produced by this module that are pure functions of the date or of a
# known holiday calendar — i.e. safe to RECOMPUTE on a forecast horizon rather
# than copy from history. Consumed by the app's future-exog projector to decide
# which exogenous columns get recomputed (Tier 0/1) vs carried forward.
CALENDAR_DETERMINISTIC_COLUMNS = frozenset({
    # day-level
    'day_of_week', 'is_weekend', 'is_friday', 'is_monday', 'day_of_month',
    'is_start_of_month', 'is_end_of_month', 'is_mid_of_month',
    'sin_dow', 'cos_dow',
    'is_special_holiday', 'is_other_holiday', 'is_holiday',
    # week-level
    'week_of_year', 'is_year_start_week', 'is_year_end_week',
    'sin_week', 'cos_week', 'holidays_in_week',
    # month-level
    'month', 'quarter', 'year', 'days_in_month', 'business_days_in_month',
    'weekends_in_month', 'seasonality_multiplier', 'is_peak_season',
    'is_off_season', 'num_holidays_in_month', 'has_any_holiday',
    'num_special_festivals', 'num_other_holidays', 'has_special_festival',
    'sin_month', 'cos_month', 'sin_quarter', 'cos_quarter',
    # phase / categorical
    'month_phase', 'quarter_phase', 'major_festival', 'month_name',
    # quarter / year level
    'days_in_quarter', 'is_festive_quarter', 'is_leap_year', 'days_in_year',
})


# ================================================================
# PART 5: UTILITY FUNCTIONS
# ================================================================

def get_temporal_features_by_segment() -> Dict[str, List[str]]:
    """
    Return recommended temporal features for each segment.
    
    This can be used to select which features to include in models.
    """
    return {
        'Stable High contributors': [
            'days_in_month', 'business_days_in_month', 'num_holidays_in_month',
            'month_phase', 'seasonality_multiplier', 'is_peak_season'
        ],
        'Stable Mid contributors': [
            'days_in_month', 'business_days_in_month', 'num_holidays_in_month',
            'month_phase', 'seasonality_multiplier'
        ],
        'Stable Low contributors': [
            'days_in_month', 'business_days_in_month',
            'seasonality_multiplier'  # Minimal features for pooled model
        ],
        'Volatile High contributors': [
            'days_in_month', 'business_days_in_month', 'num_holidays_in_month',
            'major_festival', 'month_phase', 'seasonality_multiplier', 'is_peak_season'
        ],
        'Volatile Mid contributors': [
            'days_in_month', 'business_days_in_month', 'num_holidays_in_month',
            'major_festival', 'month_phase', 'seasonality_multiplier'
        ],
        'Volatile Low contributors': [
            'num_holidays_in_month', 'days_in_month', 'seasonality_multiplier'
        ],
        'CV NULL/0': [
            'days_in_month', 'seasonality_multiplier'
        ],
    }


def validate_temporal_features(df: pd.DataFrame) -> Dict[str, bool]:
    """
    Validate that temporal features are present and in valid ranges.
    
    Returns dict of {feature_name: is_valid}
    """
    checks = {}
    
    if 'days_in_month' in df.columns:
        checks['days_in_month'] = (
            (df['days_in_month'].between(28, 31)).all() and
            df['days_in_month'].dtype in (np.uint8, int)
        )
    
    if 'business_days_in_month' in df.columns:
        checks['business_days_in_month'] = (
            (df['business_days_in_month'].between(18, 23)).all() and
            df['business_days_in_month'].dtype in (np.uint8, int)
        )
    
    if 'num_holidays_in_month' in df.columns:
        checks['num_holidays_in_month'] = (
            (df['num_holidays_in_month'].between(0, 10)).all() and
            df['num_holidays_in_month'].dtype in (np.uint8, int)
        )
    
    if 'seasonality_multiplier' in df.columns:
        checks['seasonality_multiplier'] = (
            (df['seasonality_multiplier'].between(0.5, 1.5)).all() and
            df['seasonality_multiplier'].dtype == np.float32
        )
    
    if 'month_phase' in df.columns:
        checks['month_phase'] = (
            df['month_phase'].isin(['early', 'mid', 'late']).all()
        )
    
    return checks


if __name__ == '__main__':
    # Quick test
    dates = pd.date_range('2023-01-01', '2023-12-31', freq='MS')
    test_df = pd.DataFrame({
        'date': dates,
        'sku': 'TEST_SKU',
        'sales': np.random.randint(100, 1000, len(dates))
    })
    
    result = build_temporal_features(test_df, 'date', freq='MS', holiday_country='IN')
    
    print("✓ Temporal features built successfully")
    print("\nNew columns added:")
    new_cols = set(result.columns) - set(test_df.columns)
    for col in sorted(new_cols):
        print(f"  - {col}")
    
    print("\nFeature validation:")
    validation = validate_temporal_features(result)
    for feat, is_valid in validation.items():
        status = "✓" if is_valid else "✗"
        print(f"  {status} {feat}")
    
    print("\nSample data:")
    print(result[['date', 'days_in_month', 'num_holidays_in_month', 
                  'seasonality_multiplier', 'month_phase']].head(10))
