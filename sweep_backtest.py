"""Locked walk-forward parameter sweep for the standalone IDX backtest.

Selection uses only data through 2023. Data from 2024-2025 is held out and
never used to choose a candidate.
"""
from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from backtest_yfinance import Trade, active_for_snapshot, add_features, download_snapshots, get_prices, simulate_trade, snapshot_periods


@dataclass(frozen=True)
class Candidate:
    compression_max: float
    volume_min: float
    atr_pct_min: float
    gap_max_pct: float | None

    @property
    def name(self) -> str:
        gap = "none" if self.gap_max_pct is None else f"{self.gap_max_pct:g}"
        return f"c{self.compression_max:g}_v{self.volume_min:g}_atr{self.atr_pct_min:g}_gap{gap}"


BASELINE = Candidate(1.5, 1.5, 5.0, None)


def candidates() -> list[Candidate]:
    return [Candidate(*values) for values in itertools.product((1.0, 1.5, 2.0), (1.5, 2.0), (3.0, 5.0, 7.0), (None, 2.0, 4.0))]


def signal_mask(features: pd.DataFrame, candidate: Candidate) -> pd.Series:
    return (
        features["bullish_above_mas"]
        & (features["compression_pct"] <= candidate.compression_max)
        & (features["volume_ratio"] >= candidate.volume_min)
        & (features["atr_pct_signal"] >= candidate.atr_pct_min)
    )


def gap_allowed(features: pd.DataFrame, signal_index: int, maximum_gap_pct: float | None) -> bool:
    if maximum_gap_pct is None or signal_index + 1 >= len(features):
        return True
    return (float(features.iloc[signal_index + 1].Open) / float(features.iloc[signal_index].Close) - 1) * 100 <= maximum_gap_pct


def run_basis(tickers: list[str], membership: dict[str, set[str]], basis: str, args: argparse.Namespace, grid: list[Candidate], start_index: int = 0, trades: list[Trade] | None = None, checkpoint=None) -> tuple[list[Trade], list[dict[str, object]]]:
    trades = trades or []
    quality: list[dict[str, object]] = []
    history_start = (pd.Timestamp(args.start) - pd.Timedelta(days=90)).date().isoformat()
    history_end = (pd.Timestamp(args.end) + pd.Timedelta(days=31)).date().isoformat()
    for number, ticker in enumerate(tickers[start_index:], start_index + 1):
        try:
            prices = get_prices(ticker, basis, history_start, history_end, Path(args.cache_dir))
        except Exception as exc:  # noqa: BLE001
            quality.append({"basis": basis, "ticker": ticker, "reason": "price_error", "detail": str(exc)})
            continue
        if len(prices) < 40:
            quality.append({"basis": basis, "ticker": ticker, "reason": "insufficient_price_history", "detail": len(prices)})
            continue
        features = add_features(prices)
        for candidate in grid:
            next_available_signal = 0
            for signal_index in np.flatnonzero(signal_mask(features, candidate).to_numpy()):
                timestamp = features.index[signal_index]
                if signal_index < next_available_signal or timestamp < pd.Timestamp(args.start) or timestamp > pd.Timestamp(args.end):
                    continue
                if not active_for_snapshot(ticker, timestamp, membership, "monthly") or not gap_allowed(features, signal_index, candidate.gap_max_pct):
                    continue
                trade = simulate_trade(features, signal_index, basis, candidate.name, ticker)
                if trade:
                    trades.append(trade)
                    next_available_signal = features.index.get_loc(pd.Timestamp(trade.exit_date))
        if number % 50 == 0:
            if checkpoint:
                checkpoint(number, trades)
            print(f"{basis}: {number}/{len(tickers)} tickers", flush=True)
    if checkpoint:
        checkpoint(len(tickers), trades)
    return trades, quality


def yearly_metrics(trades: pd.DataFrame) -> pd.DataFrame:
    rows = []
    frame = trades.copy()
    frame["year"] = pd.to_datetime(frame.signal_date).dt.year
    for (basis, candidate, year), group in frame.groupby(["basis", "strategy", "year"]):
        returns = group.net_return_pct
        losses = -returns[returns < 0].sum()
        rows.append({"basis": basis, "candidate": candidate, "year": year, "trades": len(group), "profit_factor": returns[returns > 0].sum() / losses if losses else np.inf, "expectancy_r": group.r_multiple.mean(), "mean_return_pct": returns.mean()})
    return pd.DataFrame(rows)


def select_candidate(yearly: pd.DataFrame, end_year: int) -> str | None:
    training = yearly[yearly.year <= end_year]
    ranked = []
    for candidate, group in training.groupby("candidate"):
        by_basis = group.groupby("basis").agg(trades=("trades", "sum"), pf=("profit_factor", "mean"), expectancy=("expectancy_r", "mean"))
        if len(by_basis) != 2 or (by_basis.trades < 50).any():
            continue
        ranked.append((min(by_basis.expectancy), min(by_basis.pf), min(by_basis.trades), candidate))
    return max(ranked)[-1] if ranked else None


def aggregate_period(trades: pd.DataFrame, candidate: str, years: tuple[int, ...]) -> pd.DataFrame:
    frame = trades[(trades.strategy == candidate) & (pd.to_datetime(trades.signal_date).dt.year.isin(years))]
    rows = []
    for basis, group in frame.groupby("basis"):
        returns = group.net_return_pct
        losses = -returns[returns < 0].sum()
        rows.append({"basis": basis, "candidate": candidate, "trades": len(group), "profit_factor": returns[returns > 0].sum() / losses if losses else np.inf, "expectancy_r": group.r_multiple.mean(), "mean_return_pct": returns.mean()})
    return pd.DataFrame(rows)


def monthly_block_bootstrap_r_difference(trades: pd.DataFrame, candidate: str, seed: int, samples: int = 5_000) -> tuple[float, float]:
    frame = trades[trades.strategy.isin([BASELINE.name, candidate])].copy()
    frame["block"] = pd.to_datetime(frame.signal_date).dt.to_period("M")
    sums = frame.groupby(["block", "strategy"]).r_multiple.sum().unstack(fill_value=0).reindex(columns=[BASELINE.name, candidate], fill_value=0)
    counts = frame.groupby(["block", "strategy"]).r_multiple.count().unstack(fill_value=0).reindex(columns=[BASELINE.name, candidate], fill_value=0)
    if sums.empty or not counts[BASELINE.name].sum() or not counts[candidate].sum():
        return np.nan, np.nan
    rng = np.random.default_rng(seed)
    differences = np.empty(samples)
    for index in range(samples):
        chosen = rng.integers(0, len(sums), len(sums))
        sampled_sums, sampled_counts = sums.iloc[chosen].sum(), counts.iloc[chosen].sum()
        differences[index] = sampled_sums[candidate] / sampled_counts[candidate] - sampled_sums[BASELINE.name] / sampled_counts[BASELINE.name]
    return tuple(np.percentile(differences, [2.5, 97.5]))


def main() -> int:
    parser = argparse.ArgumentParser(description="Locked 54-candidate walk-forward sweep; no holdout selection.")
    parser.add_argument("--idx-snapshot-url-template", required=True)
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--cache-dir", default="backtest_cache")
    parser.add_argument("--output-dir", default="backtest_output")
    parser.add_argument("--run-dir", help="Persistent directory for checkpoint/resume; defaults to backtest_output/sweep_active")
    parser.add_argument("--max-tickers", type=int)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    periods = snapshot_periods(pd.Timestamp(args.start), pd.Timestamp(args.end), "monthly")
    membership, manifest = download_snapshots(args.idx_snapshot_url_template, periods, None, "excel")
    tickers = sorted(set().union(*membership.values()))
    if args.max_tickers:
        tickers = tickers[:args.max_tickers]
    grid = candidates()
    print(f"locked candidate grid: {len(grid)}, tickers: {len(tickers)}", flush=True)
    output = Path(args.run_dir) if args.run_dir else Path(args.output_dir) / "sweep_active"
    output.mkdir(parents=True, exist_ok=True)
    progress_path = output / "progress.json"
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else {}
    trades, quality = [], []
    for basis in ("adjusted", "raw"):
        checkpoint_path = output / f"{basis}_trades.csv"
        existing = [Trade(**row) for row in pd.read_csv(checkpoint_path).to_dict("records")] if checkpoint_path.exists() else []
        def checkpoint(completed, saved_trades, basis=basis, checkpoint_path=checkpoint_path):
            pd.DataFrame([trade.__dict__ for trade in saved_trades]).to_csv(checkpoint_path, index=False)
            progress[basis] = completed
            progress_path.write_text(json.dumps(progress), encoding="utf-8")
        basis_trades, basis_quality = run_basis(tickers, membership, basis, args, grid, int(progress.get(basis, 0)), existing, checkpoint)
        trades.extend(basis_trades)
        quality.extend(basis_quality)
    trade_frame = pd.DataFrame([trade.__dict__ for trade in trades])
    if trade_frame.empty:
        raise RuntimeError("No trades generated")
    yearly = yearly_metrics(trade_frame)
    selected = select_candidate(yearly, 2023)
    walk_forward = []
    for train_end, test_year in ((2021, 2022), (2022, 2023), (2023, 2024), (2024, 2025)):
        candidate = select_candidate(yearly, train_end)
        if candidate:
            evaluation = yearly[(yearly.candidate == candidate) & (yearly.year == test_year)].copy()
            evaluation.insert(0, "train_end", train_end)
            walk_forward.append(evaluation)
    holdout = aggregate_period(trade_frame, selected, (2024, 2025)) if selected else pd.DataFrame()
    if selected:
        for basis in ("adjusted", "raw"):
            lower, upper = monthly_block_bootstrap_r_difference(trade_frame[(trade_frame.basis == basis) & (pd.to_datetime(trade_frame.signal_date).dt.year >= 2024)], selected, args.seed)
            holdout.loc[holdout.basis == basis, "bootstrap_r_diff_low"] = lower
            holdout.loc[holdout.basis == basis, "bootstrap_r_diff_high"] = upper

    trade_frame.to_csv(output / "trades.csv", index=False)
    yearly.to_csv(output / "yearly_metrics.csv", index=False)
    (pd.concat(walk_forward, ignore_index=True) if walk_forward else pd.DataFrame()).to_csv(output / "walk_forward.csv", index=False)
    holdout.to_csv(output / "holdout_selected.csv", index=False)
    pd.DataFrame(quality).to_csv(output / "data_quality.csv", index=False)
    (output / "report.md").write_text("\n".join([
        "# Locked parameter sweep", "", f"Candidates: {len(grid)}", f"Selected from 2021-2023 only: `{selected}`", "",
        "The grid varies compression (1/1.5/2%), volume (1.5/2x), ATR (3/5/7%), and next-day maximum gap (none/2/4%).", "",
        "## Holdout 2024-2025", "```csv", holdout.to_csv(index=False).strip(), "```", "",
        "## Manifest", "```json", json.dumps(manifest, indent=2), "```",
    ]), encoding="utf-8")
    print(f"completed: {output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())