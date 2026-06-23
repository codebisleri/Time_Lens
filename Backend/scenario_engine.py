"""Scenario engine — Causal Effect Estimation (DoWhy) extracted for parity.

This module is the REUSABLE service layer for the Scenario workflow's causal
sub-tab (Phase Y.A). The functions below are lifted VERBATIM from the source of
truth ``app_v2_6-Scenario.py`` (``render_causal_tab`` + its helpers, lines
~15015–16015) with the Streamlit (``st.*``) glue removed, so the calculations,
formulas, estimator catalog, refuter battery, elasticity, robustness verdicts
and interpretation text are byte-for-byte identical to the Streamlit app.

Nothing here touches the forecasting engine, WMAPE, champion selection, business
rules, or any other workflow — it only interprets data via DoWhy.

If ``dowhy`` / ``graphviz`` are unavailable, ``DOWHY_AVAILABLE`` is False and the
API surfaces the same "install dowhy graphviz" guidance the Streamlit tab shows.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:  # match the source's optional-import guard (lines 122–125)
    from dowhy import CausalModel
except Exception:  # pragma: no cover - environment dependent
    CausalModel = None  # type: ignore

try:
    import graphviz  # noqa: F401
except Exception:  # pragma: no cover
    graphviz = None  # type: ignore

DOWHY_AVAILABLE = CausalModel is not None and graphviz is not None

# Business-friendly task labels (source lines 15574–15576).
T_IMPACT = "📈 How much does a lever move demand?"
T_WHATIF = "🔮 Try a specific change (what-if)"
T_DRIVERS = "🏆 Which levers matter most?"

# source line 15320
_PRICE_LIKE_TREATMENTS = ('price', 'discount', 'promo_intensity', 'unit_price',
                          'avg_selling_price', 'list_price')


# ── build_causal_graph (source 15015–15049) ──────────────────────────────────
def build_causal_graph(treatments: List[str], outcome: str, confounders: List[str],
                       instruments: Optional[List[str]] = None,
                       effect_modifiers: Optional[List[str]] = None) -> str:
    """DOT for the assumed causal DAG, matching what CausalModel is given."""
    if graphviz is None:
        return ""
    instruments = instruments or []
    effect_modifiers = effect_modifiers or []
    dot = graphviz.Digraph()
    dot.attr('node', shape='box', style='rounded')
    for t in treatments:
        dot.node(t, t, color='orange', style='filled, rounded')
    dot.node(outcome, outcome, color='lightblue', style='filled, rounded')
    for c in confounders:
        dot.node(c, c)
    for z in instruments:
        dot.node(z, z, color='palegreen', style='filled, rounded')
    for em in effect_modifiers:
        dot.node(em, em, color='khaki', style='filled, rounded')
    for t in treatments:
        dot.edge(t, outcome)
        for c in confounders:
            dot.edge(c, t)
        for z in instruments:
            dot.edge(z, t)
    for c in confounders:
        dot.edge(c, outcome)
    for em in effect_modifiers:
        dot.edge(em, outcome)
    return dot.source


# ── _causal_interpretation (source 15324–15352) ──────────────────────────────
def causal_interpretation(treatment, outcome, theta, features_df):
    """Plain-language sentence + elasticity (arc elasticity at data means)."""
    direction = "increase" if theta >= 0 else "decrease"
    base = (f"Raising **{treatment}** by 1 unit causes demand "
            f"({outcome}) to {direction} by {abs(theta):,.3f} units "
            f"on average, holding the chosen confounders fixed.")
    elas = np.nan
    try:
        mean_t = float(features_df[treatment].mean())
        mean_y = float(features_df[outcome].mean())
        is_continuous = features_df[treatment].nunique() > 2
        if is_continuous and abs(mean_t) > 1e-9 and abs(mean_y) > 1e-9:
            elas = theta * mean_t / mean_y * 100.0
            if any(k in str(treatment).lower() for k in _PRICE_LIKE_TREATMENTS):
                base += (f" That is a price elasticity of about "
                         f"{elas:,.2f}% demand per +1% — demand is "
                         f"{'elastic' if abs(elas) > 1 else 'inelastic'}.")
    except Exception:
        pass
    return base, elas


# ── _causal_estimator_catalog (source 15381–15398) ───────────────────────────
def causal_estimator_catalog(features_df, treatment: str) -> List[Tuple[str, str, bool]]:
    """Return [(method_name, human_label, applicable)] for this treatment."""
    try:
        is_binary = features_df[treatment].nunique() <= 2
    except Exception:
        is_binary = False
    return [
        ("backdoor.linear_regression", "Linear regression (continuous & binary)", True),
        ("backdoor.generalized_linear_model", "Generalized linear model (GLM)", True),
        ("backdoor.propensity_score_matching", "Propensity score matching (binary)", is_binary),
        ("backdoor.propensity_score_stratification", "Propensity score stratification (binary)", is_binary),
        ("backdoor.propensity_score_weighting", "Propensity score weighting / IPW (binary)", is_binary),
        ("backdoor.distance_matching", "Distance matching (binary)", is_binary),
    ]


# ── _estimate_one_method (source 15401–15427) ────────────────────────────────
def _estimate_one_method(m, est, method_name: str):
    """Run a single DoWhy estimator, returning (estimate_obj, error_str)."""
    params: Dict[str, Any] = {}
    if method_name == "backdoor.distance_matching":
        params = {"distance_metric": "minkowski", "p": 2}
    if method_name == "backdoor.generalized_linear_model":
        try:
            import statsmodels.api as sm
            params = {"glm_family": sm.families.Gaussian()}
        except Exception:
            return None, "statsmodels unavailable for GLM"
    try:
        if params:
            e = m.estimate_effect(est, method_name=method_name, method_params=params)
        else:
            e = m.estimate_effect(est, method_name=method_name)
        return e, None
    except Exception as ex:
        return None, f"{type(ex).__name__}: {ex}"


# ── _extract_pvalue (source 15430–15440) ─────────────────────────────────────
def _extract_pvalue(sig) -> float:
    try:
        v = sig.get('p_value') if isinstance(sig, dict) else sig
        arr = np.ravel(np.asarray(v, dtype=float))
        return float(np.nanmax(arr)) if arr.size else np.nan
    except Exception:
        return np.nan


# ── refuter battery (source 15443–15508) ─────────────────────────────────────
_REFUTER_BATTERY = [
    ("random_common_cause", "Add random common cause", {}, "stable"),
    ("placebo_treatment_refuter", "Placebo treatment", {"placebo_type": "permute"}, "to_zero"),
    ("data_subset_refuter", "Random subset (80%)", {"subset_fraction": 0.8}, "stable"),
    ("add_unobserved_common_cause", "Unobserved confounder",
     {"confounders_effect_on_treatment": "linear",
      "confounders_effect_on_outcome": "linear",
      "effect_strength_on_treatment": 0.01,
      "effect_strength_on_outcome": 0.01}, "stable"),
]

REFUTER_CHOICES = [(mn, label) for mn, label, _, _ in _REFUTER_BATTERY]


def _refuter_verdict(theta: float, new_effect: float, expectation: str) -> str:
    if not np.isfinite(new_effect) or abs(theta) < 1e-12:
        return "—"
    if expectation == "to_zero":
        ratio = abs(new_effect) / max(abs(theta), 1e-9)
        if ratio < 0.20:
            return "✓ Robust"
        if ratio < 0.50:
            return "~ Moderate"
        return "▲ Caution"
    pct = abs(new_effect - theta) / max(abs(theta), 1e-9)
    if pct < 0.20:
        return "✓ Robust"
    if pct < 0.50:
        return "~ Moderate"
    return "▲ Caution"


def _run_refutation_battery(m, est, e, theta: float,
                            refuters: List[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for method_name, label, params, expectation in _REFUTER_BATTERY:
        if method_name not in refuters:
            continue
        try:
            r = (m.refute_estimate(est, e, method_name=method_name, **params)
                 if params else m.refute_estimate(est, e, method_name=method_name))
            new_effect = float(getattr(r, 'new_effect', np.nan))
            p_value = _extract_pvalue(getattr(r, 'refutation_result', None))
            rows.append({
                'Refuter': label,
                'Refuted effect': new_effect,
                'Verdict': _refuter_verdict(theta, new_effect, expectation),
                'p-value': p_value,
                '_detail': str(r),
            })
        except Exception as ex:
            rows.append({
                'Refuter': label, 'Refuted effect': np.nan,
                'Verdict': '— (could not run)', 'p-value': None,
                '_detail': f"{type(ex).__name__}: {ex}",
            })
    return rows


# ── _sku_causal_effect (source 15511–15549) ──────────────────────────────────
def sku_causal_effect(panel, sku, sku_col, date_col, sales_col, lever, lever_pool):
    """Linear causal effect of `lever` on demand for one SKU's history."""
    try:
        g = panel[panel[sku_col] == sku].copy()
        g[date_col] = pd.to_datetime(g[date_col], errors='coerce')
        g = g.dropna(subset=[date_col]).sort_values(date_col)
        if len(g) < 8:
            return None, None, None, len(g), "not enough history (need ≥ 8 periods)"
        dd = pd.DataFrame({'date': g[date_col].values})
        dd[sales_col] = pd.to_numeric(g[sales_col], errors='coerce').values
        dd[lever] = pd.to_numeric(g[lever], errors='coerce').values
        commons = []
        for c in lever_pool:
            if c != lever and c in g.columns:
                dd[c] = pd.to_numeric(g[c], errors='coerce').values
                commons.append(c)
        dd['month'] = pd.to_datetime(dd['date']).dt.month
        commons.append('month')
        dd = dd.drop(columns=['date']).fillna(0)
        if dd[lever].nunique() < 2:
            return None, None, None, len(g), f"'{lever}' never changes in this SKU's history"
        m = CausalModel(data=dd, treatment=lever, outcome=sales_col, common_causes=commons)
        est = m.identify_effect(proceed_when_unidentifiable=True)
        e = m.estimate_effect(est, method_name="backdoor.linear_regression")
        theta = float(e.value)
        recent = dd.tail(min(12, len(dd)))
        return (theta, float(recent[sales_col].mean()),
                float(recent[lever].mean()), len(g), None)
    except Exception as ex:
        return None, None, None, 0, f"{type(ex).__name__}: {ex}"


# ── _reliability_callout (source 15552–15570) ────────────────────────────────
def reliability_callout(verdict: str) -> Tuple[str, str, str]:
    v = str(verdict or '')
    if 'Robust' in v:
        return ('success', "✅ Reliable",
                "This result held up under every cross-check — you can plan around it.")
    if 'Moderate' in v:
        return ('info', "🟡 Fairly reliable",
                "This mostly held up under cross-checks — a solid guide for decisions.")
    if 'Caution' in v:
        return ('warning', "🔴 Directional only",
                "This is sensitive to assumptions — treat it as a rough direction and "
                "gather more data before betting big on it.")
    return ('info', "ℹ️ Estimated",
            "Reliability cross-checks weren't run for this result.")


def _clean(v: Any) -> Any:
    """JSON-safe float (NaN/inf → None)."""
    try:
        f = float(v)
        return f if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ── Orchestrator: T_IMPACT (source render_causal_tab 15729–15818) ────────────
def estimate_causal_effects(
    features_df: pd.DataFrame, outcome: str, treatments: List[str],
    confounders: List[str], instruments: Optional[List[str]] = None,
    effect_modifiers: Optional[List[str]] = None,
    methods: Optional[List[str]] = None, refuters: Optional[List[str]] = None,
    compute_ci: bool = True,
) -> Dict[str, Any]:
    """Replicates the IMPACT branch: estimate every treatment across methods, run
    the refuter battery, derive elasticity/robustness/interpretation. Returns a
    JSON-safe dict mirroring the Streamlit session_state outputs."""
    if CausalModel is None:
        raise RuntimeError("dowhy is not installed")
    instruments = instruments or []
    effect_modifiers = effect_modifiers or []
    methods = methods or ["backdoor.linear_regression"]
    refuters = refuters if refuters is not None else [mn for mn, _, _, _ in _REFUTER_BATTERY]

    _probe = treatments[0] if treatments else (
        [c for c in features_df.columns if c != outcome] or [outcome])[0]
    method_labels = {mn: lbl for mn, lbl, _ in causal_estimator_catalog(features_df, _probe)}
    method_labels["iv.instrumental_variable"] = "Instrumental variable (IV / 2SLS)"

    estimates: List[Dict[str, Any]] = []
    refutations: List[Dict[str, Any]] = []
    method_rows: List[Dict[str, Any]] = []
    estimand_texts: Dict[str, str] = {}

    for t in treatments:
        try:
            model_kwargs: Dict[str, Any] = dict(
                data=features_df, treatment=t, outcome=outcome, common_causes=confounders)
            if instruments:
                model_kwargs['instruments'] = instruments
            if effect_modifiers:
                model_kwargs['effect_modifiers'] = effect_modifiers
            m = CausalModel(**model_kwargs)
            est = m.identify_effect(proceed_when_unidentifiable=True)
            estimand_texts[t] = str(est)

            headline_e, headline_theta = None, np.nan
            for mi, method_name in enumerate(methods):
                e, err = _estimate_one_method(m, est, method_name)
                if e is None:
                    method_rows.append({
                        'Treatment': t, 'Method': method_labels.get(method_name, method_name),
                        'Causal Effect': None, 'CI low': None, 'CI high': None,
                        'p-value': None, 'Note': err})
                    continue
                theta = float(e.value)
                ci_lo = ci_hi = pval = np.nan
                if compute_ci:
                    try:
                        arr = np.asarray(e.get_confidence_intervals(), dtype=float).ravel()
                        if arr.size >= 2:
                            ci_lo, ci_hi = float(np.min(arr)), float(np.max(arr))
                    except Exception:
                        pass
                    try:
                        pval = _extract_pvalue(e.test_stat_significance())
                    except Exception:
                        pass
                method_rows.append({
                    'Treatment': t, 'Method': method_labels.get(method_name, method_name),
                    'Causal Effect': _clean(theta), 'CI low': _clean(ci_lo),
                    'CI high': _clean(ci_hi), 'p-value': _clean(pval), 'Note': ''})
                if mi == 0:
                    headline_e, headline_theta = e, theta

            if headline_e is None:
                raise RuntimeError("no estimator succeeded")

            interp, elas = causal_interpretation(t, outcome, headline_theta, features_df)
            rb = _run_refutation_battery(m, est, headline_e, headline_theta, refuters)
            _verds = [row['Verdict'] for row in rb]
            overall = ('▲ Caution' if any('Caution' in v for v in _verds)
                       else '~ Moderate' if any('Moderate' in v for v in _verds)
                       else '✓ Robust' if any('Robust' in v for v in _verds)
                       else '—')
            level, head, expl = reliability_callout(overall)
            estimates.append({
                'Treatment': t,
                'Causal Estimate': _clean(headline_theta),
                'Treatment (lever)': t,
                'Causal Effect (per +1 unit)': _clean(headline_theta),
                'Elasticity (% per +1%)': _clean(elas),
                'Robustness': overall,
                'Interpretation': interp,
                'reliabilityLevel': level, 'reliabilityHead': head, 'reliabilityExpl': expl,
            })
            for row in rb:
                refutations.append({
                    'Treatment': t, 'Refuter': row['Refuter'],
                    'Refuted effect': _clean(row['Refuted effect']),
                    'Verdict': row['Verdict'], 'p-value': _clean(row['p-value'])})
        except Exception as ex:
            estimates.append({
                'Treatment': t, 'Causal Estimate': None, 'Treatment (lever)': t,
                'Causal Effect (per +1 unit)': None, 'Elasticity (% per +1%)': None,
                'Robustness': '—', 'Interpretation': f"Could not estimate: {ex}",
                'reliabilityLevel': 'info', 'reliabilityHead': 'ℹ️ Estimated',
                'reliabilityExpl': "Could not estimate this lever."})

    dot = build_causal_graph(treatments, outcome, confounders, instruments, effect_modifiers)
    return {
        "estimates": estimates,
        "methodComparison": method_rows,
        "refutation": refutations,
        "estimands": estimand_texts,
        "dotGraph": dot,
        "variables": {
            "treatments": treatments, "outcome": outcome, "confounders": confounders,
            "instruments": instruments, "effect_modifiers": effect_modifiers},
    }


# ── Orchestrator: T_DRIVERS (source 15984–16000) ─────────────────────────────
def rank_drivers(features_df: pd.DataFrame, outcome: str, potential: List[str],
                 use_all_conf: bool = True) -> List[Dict[str, Any]]:
    """Rank every lever by |causal effect| on demand (linear backdoor)."""
    if CausalModel is None:
        raise RuntimeError("dowhy is not installed")
    results: List[Dict[str, Any]] = []
    for t in potential:
        confs = [f for f in potential if f != t] if use_all_conf else []
        try:
            m = CausalModel(data=features_df, treatment=t, outcome=outcome, common_causes=confs)
            est = m.identify_effect(proceed_when_unidentifiable=True)
            e = m.estimate_effect(est, method_name="backdoor.linear_regression")
            results.append({'Lever': t, 'Impact on demand': float(e.value)})
        except Exception:
            results.append({'Lever': t, 'Impact on demand': np.nan})
    rdf = pd.DataFrame(results).dropna()
    if rdf.empty:
        return []
    rdf['abs_effect'] = rdf['Impact on demand'].abs()
    rdf = rdf.sort_values('abs_effect', ascending=False).drop(columns=['abs_effect'])
    return [{'Lever': r['Lever'], 'Impact on demand': _clean(r['Impact on demand'])}
            for _, r in rdf.iterrows()]
