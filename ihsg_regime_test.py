"""Compare the selected parameter candidate with and without the fixed IHSG regime."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from backtest_yfinance import Trade, active_for_snapshot, add_features, download_snapshots, get_prices, simulate_trade, snapshot_periods
from sweep_backtest import Candidate, gap_allowed

BASE = Candidate(1.5, 2.0, 7.0, 2.0)
BASE_NAME = "base_c1.5_v2_atr7_gap2"
REGIME_NAME = "base_c1.5_v2_atr7_gap2_ihsg_regime"


def signals(features: pd.DataFrame, regime: bool) -> pd.Series:
    result = (
        features["bullish_above_mas"]
        & (features["compression_pct"] <= BASE.compression_max)
        & (features["volume_ratio"] >= BASE.volume_min)
        & (features["atr_pct_signal"] >= BASE.atr_pct_min)
    )
    return result & features["ihsg_regime"] if regime else result


def run_basis(tickers, membership, basis, args):
    history_start = (pd.Timestamp(args.start) - pd.Timedelta(days=90)).date().isoformat()
    history_end = (pd.Timestamp(args.end) + pd.Timedelta(days=31)).date().isoformat()
    benchmark = get_prices("^JKSE", basis, history_start, history_end, Path(args.cache_dir))
    trades, quality = [], []
    for number, ticker in enumerate(tickers, 1):
        try:
            prices = get_prices(ticker, basis, history_start, history_end, Path(args.cache_dir))
        except Exception as exc:
            quality.append({"basis": basis, "ticker": ticker, "reason": "price_error", "detail": str(exc)})
            continue
        if len(prices) < 40:
            quality.append({"basis": basis, "ticker": ticker, "reason": "insufficient_price_history", "detail": len(prices)})
            continue
        features = add_features(prices, benchmark)
        for name, needs_regime in ((BASE_NAME, False), (REGIME_NAME, True)):
            next_available = 0
            for index in np.flatnonzero(signals(features, needs_regime).to_numpy()):
                timestamp = features.index[index]
                if index < next_available or timestamp < pd.Timestamp(args.start) or timestamp > pd.Timestamp(args.end):
                    continue
                if not active_for_snapshot(ticker, timestamp, membership, "monthly") or not gap_allowed(features, index, BASE.gap_max_pct):
                    continue
                trade = simulate_trade(features, index, basis, name, ticker)
                if trade:
                    trades.append(trade)
                    next_available = features.index.get_loc(pd.Timestamp(trade.exit_date))
        if number % 100 == 0:
            print(f"{basis}: {number}/{len(tickers)}", flush=True)
    return trades, quality


def summary(trades: pd.DataFrame) -> pd.DataFrame:
    frame = trades.copy()
    frame["period"] = np.where(pd.to_datetime(frame.signal_date).dt.year <= 2023, "in_sample_2021_2023", "holdout_2024_2025")
    rows = []
    for (basis, period, strategy), group in frame.groupby(["basis", "period", "strategy"]):
        returns = group.net_return_pct
        losses = -returns[returns < 0].sum()
        rows.append({"basis": basis, "period": period, "strategy": strategy, "trades": len(group), "win_rate_pct": (returns > 0).mean() * 100, "profit_factor": returns[returns > 0].sum() / losses if losses else np.inf, "expectancy_r": group.r_multiple.mean(), "mean_return_pct": returns.mean()})
    return pd.DataFrame(rows)


def block_bootstrap_r_difference(trades: pd.DataFrame, seed=42, samples=5000):
    frame = trades[trades.strategy.isin([BASE_NAME, REGIME_NAME])].copy()
    frame["block"] = pd.to_datetime(frame.signal_date).dt.to_period("M")
    sums = frame.groupby(["block", "strategy"]).r_multiple.sum().unstack(fill_value=0).reindex(columns=[BASE_NAME, REGIME_NAME], fill_value=0)
    counts = frame.groupby(["block", "strategy"]).r_multiple.count().unstack(fill_value=0).reindex(columns=[BASE_NAME, REGIME_NAME], fill_value=0)
    rng = np.random.default_rng(seed)
    values = np.empty(samples)
    for index in range(samples):
        chosen = rng.integers(0, len(sums), len(sums))
        s, c = sums.iloc[chosen].sum(), counts.iloc[chosen].sum()
        values[index] = s[REGIME_NAME] / c[REGIME_NAME] - s[BASE_NAME] / c[BASE_NAME]
    return tuple(np.percentile(values, [2.5, 97.5]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--idx-snapshot-url-template", required=True)
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--cache-dir", default="backtest_cache")
    parser.add_argument("--output-dir", default="backtest_output")
    args = parser.parse_args()
    periods = snapshot_periods(pd.Timestamp(args.start), pd.Timestamp(args.end), "monthly")
    membership, manifest = download_snapshots(args.idx_snapshot_url_template, periods, None, "excel")
    tickers = sorted(set().union(*membership.values()))
    all_trades, quality = [], []
    for basis in ("adjusted", "raw"):
        trades, issues = run_basis(tickers, membership, basis, args)
        all_trades.extend(trades)
        quality.extend(issues)
    trade_frame = pd.DataFrame([trade.__dict__ for trade in all_trades])
    report_summary = summary(trade_frame)
    bootstrap_rows = []
    for basis in ("adjusted", "raw"):
        holdout = trade_frame[(trade_frame.basis == basis) & (pd.to_datetime(trade_frame.signal_date).dt.year >= 2024)]
        low, high = block_bootstrap_r_difference(holdout)
        bootstrap_rows.append({"basis": basis, "regime_minus_base_expectancy_r_95_low": low, "regime_minus_base_expectancy_r_95_high": high})
    output = Path(args.output_dir) / pd.Timestamp.now(tz="UTC").strftime("ihsg_combo_%Y%m%dT%H%M%SZ")
    output.mkdir(parents=True)
    trade_frame.to_csv(output / "trades.csv", index=False)
    report_summary.to_csv(output / "summary.csv", index=False)
    pd.DataFrame(bootstrap_rows).to_csv(output / "bootstrap.csv", index=False)
    pd.DataFrame(quality).to_csv(output / "data_quality.csv", index=False)
    (output / "report.md").write_text("\n".join(["# IHSG regime combo", "", "Candidate: compression <=1.5%, volume >=2x, ATR >=7%, gap entry <=2%.", "", "## Summary", "```csv", report_summary.to_csv(index=False).strip(), "```", "", "## Holdout block-bootstrap R difference", "```csv", pd.DataFrame(bootstrap_rows).to_csv(index=False).strip(), "```", "", "## Manifest", "```json", json.dumps(manifest, indent=2), "```"]), encoding="utf-8")
    print(f"completed: {output}")


if __name__ == "__main__":
    main()