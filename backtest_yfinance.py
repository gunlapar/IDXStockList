#!/usr/bin/env python3
"""A/B backtest for the IDX compression-and-volume screener.

The runner intentionally does not read or write the Google Sheet used by the app.
It needs IDX membership snapshots because Yahoo Finance has price history,
not an auditable historical IDX universe.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Iterable
from urllib.request import urlopen

import numpy as np
import pandas as pd
import yfinance as yf


BUY_FEE = 0.0015
SELL_FEE = 0.0025
STRATEGIES = {
    "compression_1_5_atr_5_bullish": "compression_1_5_atr_5_bullish",
    "compression_1_5_atr_5_ihsg_regime_bullish": "compression_1_5_atr_5_ihsg_regime_bullish",
}


@dataclass
class Trade:
    basis: str
    strategy: str
    ticker: str
    signal_date: str
    entry_date: str
    exit_date: str
    exit_reason: str
    entry_price: float
    exit_price: float
    atr: float
    atr_pct_signal: float
    ihsg_close: float
    ihsg_ma50: float
    ihsg_regime: bool
    net_return_pct: float
    r_multiple: float
    holding_days: int
    ma_state: str


def normalize_ticker(value: object) -> str | None:
    if pd.isna(value):
        return None
    ticker = str(value).strip().upper().replace(".JK", "")
    if not ticker or not ticker.replace("-", "").isalnum() or len(ticker) > 8:
        return None
    return f"{ticker}.JK"


def find_ticker_column(frame: pd.DataFrame, explicit: str | None) -> str:
    if explicit:
        if explicit not in frame.columns:
            raise ValueError(f"Kolom ticker '{explicit}' tidak ada di snapshot.")
        return explicit
    aliases = {"ticker", "symbol", "code", "stockcode", "kode", "kodeemiten", "kodesaham"}
    for column in frame.columns:
        normalized = "".join(ch for ch in str(column).lower() if ch.isalnum())
        if normalized in aliases:
            return column
    raise ValueError("Kolom ticker tidak ditemukan. Gunakan --ticker-column.")


def read_snapshot(payload: bytes, snapshot_format: str) -> pd.DataFrame:
    if snapshot_format == "auto":
        snapshot_format = "excel" if payload.startswith((b"PK", bytes.fromhex("D0CF11E0A1B11AE1"))) else "csv"
    if snapshot_format != "excel":
        return pd.read_csv(io.BytesIO(payload))
    preview = pd.read_excel(io.BytesIO(payload), header=None, nrows=12)
    aliases = {"ticker", "symbol", "code", "stockcode", "kode", "kodeemiten", "kodesaham"}
    for row_index, row in preview.iterrows():
        labels = {"".join(char for char in str(value).lower() if char.isalnum()) for value in row.dropna()}
        if labels & aliases:
            return pd.read_excel(io.BytesIO(payload), header=row_index)
    return pd.read_excel(io.BytesIO(payload))


def snapshot_periods(start: pd.Timestamp, end: pd.Timestamp, frequency: str) -> pd.PeriodIndex:
    return pd.period_range(start=start, end=end, freq="M" if frequency == "monthly" else "Y")


def download_snapshots(url_template: str, periods: Iterable[pd.Period], ticker_column: str | None, snapshot_format: str) -> tuple[dict[str, set[str]], list[dict]]:
    membership: dict[str, set[str]] = {}
    manifest: list[dict] = []
    for period in periods:
        key = str(period)
        url = url_template.format(year=period.year, month=period.month, month_name=period.strftime("%b"), period=key)
        try:
            with urlopen(url, timeout=30) as response:
                payload = response.read()
        except Exception as exc:  # noqa: BLE001 - show the concrete upstream failure
            raise RuntimeError(f"Snapshot IDX {key} gagal diunduh dari {url}: {exc}") from exc
        try:
            frame = read_snapshot(payload, snapshot_format)
            column = find_ticker_column(frame, ticker_column)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Snapshot IDX {key} tidak valid ({url}): {exc}") from exc
        tickers = {ticker for value in frame[column] if (ticker := normalize_ticker(value))}
        if not tickers:
            raise RuntimeError(f"Snapshot IDX {key} tidak berisi ticker valid: {url}")
        membership[key] = tickers
        manifest.append({"period": key, "url": url, "sha256": hashlib.sha256(payload).hexdigest(), "tickers": len(tickers)})
    return membership, manifest


def cache_path(cache_dir: Path, ticker: str, basis: str, start: str, end: str) -> Path:
    return cache_dir / basis / f"{ticker.replace('.JK', '')}_{start}_{end}.csv"
def get_prices(ticker: str, basis: str, start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    path = cache_path(cache_dir, ticker, basis, start, end)
    if path.exists():
        frame = pd.read_csv(path, parse_dates=["Date"], index_col="Date")
    else:
        frame = yf.Ticker(ticker).history(start=start, end=end, interval="1d", auto_adjust=basis == "adjusted", actions=False)
        if frame.empty:
            return frame
        frame.index = pd.to_datetime(frame.index).tz_localize(None).normalize()
        frame = frame[["Open", "High", "Low", "Close", "Volume"]].dropna()
        path.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(path, index_label="Date")
    frame.index = pd.to_datetime(frame.index).tz_localize(None).normalize()
    return frame[["Open", "High", "Low", "Close", "Volume"]].sort_index().dropna()


def add_features(frame: pd.DataFrame, benchmark: pd.DataFrame | None = None) -> pd.DataFrame:
    result = frame.copy()
    close, high, low, volume = (result[column] for column in ("Close", "High", "Low", "Volume"))
    for period in (5, 10, 20):
        result[f"ma{period}"] = close.rolling(period).mean()
    result["avg_volume20"] = volume.shift(1).rolling(20).mean()
    result["volume_ratio"] = volume / result["avg_volume20"]
    result["compression_pct"] = (result[["ma5", "ma10", "ma20"]].max(axis=1) - result[["ma5", "ma10", "ma20"]].min(axis=1)) / close * 100
    result["range20_pct"] = (high.rolling(20).max() - low.rolling(20).min()) / close * 100
    result["bb_width"] = (4 * close.rolling(20).std(ddof=0)) / result["ma20"]
    result["flat20"] = close.rolling(20).max() == close.rolling(20).min()
    previous_close = close.shift(1)
    true_range = pd.concat([high - low, (high - previous_close).abs(), (low - previous_close).abs()], axis=1).max(axis=1)
    result["atr14"] = true_range.rolling(14).mean()
    result["core_3_filters"] = (
        ~result["flat20"]
        & (result["avg_volume20"] > 0)
        & (result["avg_volume20"] * close >= 200_000_000)
        & (result["range20_pct"] <= 30)
        & (result["compression_pct"] <= 5)
        & (result["volume_ratio"] >= 1.5)
        & result["atr14"].notna()
    )
    bullish_above_mas = result["core_3_filters"] & (close > result[["ma5", "ma10", "ma20"]].max(axis=1))
    ma_alignment = (result["ma5"] > result["ma10"]) & (result["ma10"] > result["ma20"])
    result["bullish_above_mas"] = bullish_above_mas
    result["compression_5_bullish"] = bullish_above_mas
    result["compression_2_bullish"] = bullish_above_mas & (result["compression_pct"] <= 2)
    result["compression_1_5_bullish"] = bullish_above_mas & (result["compression_pct"] <= 1.5)
    result["atr_pct_signal"] = result["atr14"] / close * 100
    result["compression_1_5_atr_5_bullish"] = result["compression_1_5_bullish"] & (result["atr_pct_signal"] >= 5)
    if benchmark is None:
        result[["ihsg_close", "ihsg_ma50"]] = np.nan
        result["ihsg_regime"] = False
    else:
        ihsg_close = benchmark["Close"].sort_index()
        ihsg_ma50 = ihsg_close.rolling(50).mean()
        regime = pd.DataFrame({
            "ihsg_close": ihsg_close,
            "ihsg_ma50": ihsg_ma50,
            "ihsg_regime": (ihsg_close > ihsg_ma50) & (ihsg_ma50 > ihsg_ma50.shift(5)),
        }).reindex(result.index).ffill()
        result[["ihsg_close", "ihsg_ma50", "ihsg_regime"]] = regime
        result["ihsg_regime"] = result["ihsg_regime"].fillna(False).astype(bool)
    result["compression_1_5_atr_5_ihsg_regime_bullish"] = result["compression_1_5_atr_5_bullish"] & result["ihsg_regime"]
    result["ma_state"] = np.where(ma_alignment, "B_confirmed_aligned", "C_unaligned")
    result["potential_bullish"] = bullish_above_mas & ~ma_alignment
    result["confirmed_bullish"] = bullish_above_mas & ma_alignment
    return result


def simulate_trade(frame: pd.DataFrame, signal_index: int, basis: str, strategy: str, ticker: str, max_holding_days: int = 20) -> Trade | None:
    entry_index = signal_index + 1
    last_index = entry_index + max_holding_days - 1
    if last_index >= len(frame):
        return None
    signal = frame.iloc[signal_index]
    entry = frame.iloc[entry_index]
    entry_price, atr = float(entry.Open), float(signal.atr14)
    target, stop = entry_price + 2 * atr, entry_price - 1.5 * atr
    exit_price = float(frame.iloc[last_index].Close)
    exit_index, reason = last_index, "TIMEOUT"
    for offset in range(max_holding_days):
        candle_index = entry_index + offset
        candle = frame.iloc[candle_index]
        if candle.Open >= target:
            exit_price, exit_index, reason = float(candle.Open), candle_index, "TP1_GAP"
            break
        if candle.Open <= stop:
            exit_price, exit_index, reason = float(candle.Open), candle_index, "SL_GAP"
            break
        hit_target, hit_stop = candle.High >= target, candle.Low <= stop
        if hit_target and hit_stop:  # Daily OHLC cannot order intraday touches: use the conservative stop.
            exit_price, exit_index, reason = stop, candle_index, "SL_SAME_DAY"
            break
        if hit_stop:
            exit_price, exit_index, reason = stop, candle_index, "SL"
            break
        if hit_target:
            exit_price, exit_index, reason = target, candle_index, "TP1"
            break
    net_return = (exit_price * (1 - SELL_FEE) - entry_price * (1 + BUY_FEE)) / (entry_price * (1 + BUY_FEE))
    risk_fraction = (1.5 * atr) / entry_price
    return Trade(
        basis=basis, strategy=strategy, ticker=ticker, signal_date=frame.index[signal_index].date().isoformat(),
        entry_date=frame.index[entry_index].date().isoformat(), exit_date=frame.index[exit_index].date().isoformat(),
        exit_reason=reason, entry_price=entry_price, exit_price=exit_price, atr=atr,
        atr_pct_signal=float(signal.get("atr_pct_signal", atr / float(signal.Close) * 100)),
        ihsg_close=float(signal.get("ihsg_close", np.nan)), ihsg_ma50=float(signal.get("ihsg_ma50", np.nan)),
        ihsg_regime=bool(signal.get("ihsg_regime", False)),
        net_return_pct=net_return * 100, r_multiple=net_return / risk_fraction if risk_fraction else np.nan,
        holding_days=exit_index - entry_index + 1, ma_state=str(signal.get("ma_state", "unknown")),
    )


def active_for_snapshot(ticker: str, timestamp: pd.Timestamp, membership: dict[str, set[str]], frequency: str) -> bool:
    period = timestamp.to_period("M" if frequency == "monthly" else "Y")
    return ticker in membership.get(str(period), set())


def active_for_year(ticker: str, timestamp: pd.Timestamp, membership: dict[int, set[str]]) -> bool:
    return ticker in membership.get(timestamp.year, set())


def run_basis(tickers: Iterable[str], membership: dict[str, set[str]], basis: str, args: argparse.Namespace, quality: list[dict], benchmark: pd.DataFrame | None = None) -> list[Trade]:
    trades: list[Trade] = []
    history_start = (pd.Timestamp(args.start) - pd.Timedelta(days=90)).date().isoformat()
    for ticker in tickers:
        try:
            prices = get_prices(ticker, basis, history_start, (pd.Timestamp(args.end) + pd.Timedelta(days=31)).date().isoformat(), Path(args.cache_dir))
        except Exception as exc:  # noqa: BLE001
            quality.append({"basis": basis, "ticker": ticker, "reason": "yahoo_error", "detail": str(exc)})
            continue
        if len(prices) < 40:
            quality.append({"basis": basis, "ticker": ticker, "reason": "insufficient_price_history", "detail": len(prices)})
            continue
        features = add_features(prices, benchmark)
        for strategy, signal_column in STRATEGIES.items():
            next_available_signal = 0
            for signal_index, (timestamp, row) in enumerate(features.iterrows()):
                if signal_index < next_available_signal or timestamp < pd.Timestamp(args.start) or timestamp > pd.Timestamp(args.end):
                    continue
                if not active_for_snapshot(ticker, timestamp, membership, args.snapshot_frequency) or not bool(row[signal_column]):
                    continue
                trade = simulate_trade(features, signal_index, basis, strategy, ticker)
                if trade:
                    trades.append(trade)
                    # A signal on the exit day may open again next day; earlier signals are blocked.
                    next_available_signal = features.index.get_loc(pd.Timestamp(trade.exit_date))
                else:
                    quality.append({"basis": basis, "ticker": ticker, "reason": "insufficient_forward_bars", "detail": timestamp.date().isoformat()})
    return trades


def monthly_block_bootstrap_difference(trades: pd.DataFrame, seed: int, samples: int = 2_000) -> tuple[float, float]:
    if trades.empty:
        return np.nan, np.nan
    baseline = "compression_1_5_atr_5_bullish"
    experiment = "compression_1_5_atr_5_ihsg_regime_bullish"
    frame = trades.assign(block=pd.to_datetime(trades.signal_date).dt.to_period("M"))
    sums = frame.groupby(["block", "strategy"]).net_return_pct.sum().unstack(fill_value=0).reindex(columns=[baseline, experiment], fill_value=0)
    counts = frame.groupby(["block", "strategy"]).net_return_pct.count().unstack(fill_value=0).reindex(columns=[baseline, experiment], fill_value=0)
    if not counts[baseline].sum() or not counts[experiment].sum():
        return np.nan, np.nan
    rng = np.random.default_rng(seed)
    differences = np.empty(samples)
    block_count = len(sums)
    for index in range(samples):
        chosen = rng.integers(0, block_count, block_count)
        sampled_sums, sampled_counts = sums.iloc[chosen].sum(), counts.iloc[chosen].sum()
        differences[index] = sampled_sums[experiment] / sampled_counts[experiment] - sampled_sums[baseline] / sampled_counts[baseline]
    return tuple(np.percentile(differences, [2.5, 97.5]))


def profit_factor(returns: pd.Series) -> float:
    gross_profit = returns[returns > 0].sum()
    gross_loss = -returns[returns < 0].sum()
    return gross_profit / gross_loss if gross_loss else np.inf


def profit_factor_without_top_winners(returns: pd.Series, count: int) -> float:
    return profit_factor(returns.drop(returns.nlargest(count).index))


def build_summary(trades: pd.DataFrame, seed: int) -> pd.DataFrame:
    rows: list[dict] = []
    entry_dates = pd.to_datetime(trades.entry_date)
    periods = {"full": trades.index == trades.index}
    if entry_dates.min().year <= 2023 and entry_dates.max().year >= 2024:
        periods |= {"in_sample_2021_2023": entry_dates <= pd.Timestamp("2023-12-31"), "holdout_2024_2025": entry_dates >= pd.Timestamp("2024-01-01")}
    for basis in sorted(trades.basis.unique()):
        for period, mask in periods.items():
            subset = trades[(trades.basis == basis) & mask]
            atr_low, atr_high = monthly_block_bootstrap_difference(subset, seed)
            for strategy, group in subset.groupby("strategy"):
                returns = group.net_return_pct
                rows.append({
                    "basis": basis, "period": period, "strategy": strategy, "trades": len(group),
                    "win_rate_pct": (returns > 0).mean() * 100, "mean_return_pct": returns.mean(), "median_return_pct": returns.median(),
                    "profit_factor": profit_factor(returns), "expectancy_r": group.r_multiple.mean(),
                    "average_holding_days": group.holding_days.mean(),
                    "profit_factor_excluding_best_1": profit_factor_without_top_winners(returns, 1),
                    "profit_factor_excluding_best_5": profit_factor_without_top_winners(returns, 5),
                    "ihsg_regime_minus_atr_5_bootstrap_95_low_pct": atr_low,
                    "ihsg_regime_minus_atr_5_bootstrap_95_high_pct": atr_high,
                })
    return pd.DataFrame(rows)


def build_monthly_summary(trades: pd.DataFrame) -> pd.DataFrame:
    monthly = trades.copy()
    monthly["month"] = pd.to_datetime(monthly.entry_date).dt.to_period("M").astype(str)
    rows = []
    for (basis, strategy, month), group in monthly.groupby(["basis", "strategy", "month"]):
        returns = group.net_return_pct
        rows.append({
            "basis": basis, "strategy": strategy, "month": month, "trades": len(group),
            "win_rate_pct": (returns > 0).mean() * 100, "mean_return_pct": returns.mean(),
            "profit_factor": profit_factor(returns), "expectancy_r": group.r_multiple.mean(),
        })
    return pd.DataFrame(rows)


def write_report(output_dir: Path, summary: pd.DataFrame, monthly: pd.DataFrame, manifest: list[dict], quality: pd.DataFrame, args: argparse.Namespace) -> None:
    decision_period = "holdout_2024_2025" if "holdout_2024_2025" in summary.period.values else "full"
    experiment = summary[(summary.period == decision_period) & (summary.strategy == "compression_1_5_atr_5_ihsg_regime_bullish")]
    passed = len(experiment) == 2 and all(
        (row.profit_factor >= 1.3)
        and (row.expectancy_r > 0)
        and (row.trades >= 100)
        and (row.profit_factor_excluding_best_5 > 1)
        and (row.ihsg_regime_minus_atr_5_bootstrap_95_low_pct >= 0)
        for row in experiment.itertuples()
    )
    lines = [
        "# IDX ATR + IHSG Regime Backtest", "", "## Configuration", "",
        f"- Test period: {args.start} to {args.end}",
        f"- Fees: buy {BUY_FEE:.2%}, sell {SELL_FEE:.2%}",
        "- Exit: full TP1 (+2 ATR), SL (-1.5 ATR), or 20 trading days.",
        "- Baseline: compression <=1.5%, ATR14 / signal close >=5%, volume ratio >=1.5x, range20 <=30%, close above MA5/10/20, liquidity, and ATR data checks.",
        "- Experiment: baseline plus signal-day IHSG close > MA50 and MA50 > its value five trading days earlier.",
        "- Entry remains next-day open; one active position per ticker per strategy.",
        "- Bollinger squeeze and MA alignment are not gates.",
        "- Bootstrap: 2,000 resamples of calendar-month blocks; all trades in a selected month stay together.",
        f"- This {args.start[:4]}-{args.end[:4]} run is exploratory; no production BUY rule is changed.", "",
        "## Decision", "", "PASS" if passed else "FAIL", "",
        f"Decision period: {decision_period}.", "",
        "Pass requires both adjusted and raw PF >=1.3, positive expectancy R, at least 100 trades, bootstrap lower bound >=0, and PF >1 after removing the five best winners.", "",
        "## Summary", "", "```csv", summary.to_csv(index=False).strip(), "```", "",
        "## Monthly breakdown", "", "```csv", monthly.to_csv(index=False).strip(), "```", "",
        "## IDX snapshot manifest", "", "```json", json.dumps(manifest, indent=2), "```", "",
        f"Excluded/data-quality rows: {len(quality)}",
    ]
    (output_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="A/B test the IDX compression screener with Yahoo Finance data.")
    parser.add_argument("--idx-snapshot-url-template", required=True, help="Snapshot URL template using {year}, {month}, {month_name}, or {period}; supports CSV and Excel")
    parser.add_argument("--snapshot-frequency", choices=("yearly", "monthly"), default="monthly", help="Use monthly IDX snapshots for historical membership (default: monthly)")
    parser.add_argument("--snapshot-format", choices=("auto", "csv", "excel"), default="auto", help="auto detects .xlsx bytes; set excel for IDX download URLs without a file extension")
    parser.add_argument("--ticker-column", help="Ticker column name when snapshot auto-detection is unsuitable")
    parser.add_argument("--start", default="2020-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--cache-dir", default="backtest_cache")
    parser.add_argument("--output-dir", default="backtest_output")
    parser.add_argument("--max-tickers", type=int, help="Limit universe; useful for a Yahoo smoke test")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    start, end = pd.Timestamp(args.start), pd.Timestamp(args.end)
    if start.year > end.year:
        raise ValueError("--start harus sebelum --end")
    periods = snapshot_periods(start, end, args.snapshot_frequency)
    membership, manifest = download_snapshots(args.idx_snapshot_url_template, periods, args.ticker_column, args.snapshot_format)
    tickers = sorted(set().union(*membership.values()))
    if args.max_tickers:
        tickers = tickers[:args.max_tickers]
    quality: list[dict] = []
    trades: list[Trade] = []
    history_start = (start - pd.Timedelta(days=90)).date().isoformat()
    history_end = (end + pd.Timedelta(days=31)).date().isoformat()
    for basis in ("adjusted", "raw"):
        benchmark = get_prices("^JKSE", basis, history_start, history_end, Path(args.cache_dir))
        if len(benchmark) < 55:
            raise RuntimeError(f"Data IHSG tidak cukup untuk MA50 ({basis}): {len(benchmark)} bar")
        trades.extend(run_basis(tickers, membership, basis, args, quality, benchmark))
    if not trades:
        raise RuntimeError("Tidak ada trade yang dapat diuji. Periksa snapshot IDX, periode, atau kualitas Yahoo data.")
    run_id = pd.Timestamp.utcnow().strftime("%Y%m%dT%H%M%SZ")
    output_dir = Path(args.output_dir) / run_id
    output_dir.mkdir(parents=True, exist_ok=False)
    trade_frame = pd.DataFrame(asdict(trade) for trade in trades)
    summary = build_summary(trade_frame, args.seed)
    monthly_summary = build_monthly_summary(trade_frame)
    quality_frame = pd.DataFrame(quality, columns=["basis", "ticker", "reason", "detail"])
    trade_frame.to_csv(output_dir / "trades.csv", index=False)
    summary.to_csv(output_dir / "summary.csv", index=False)
    monthly_summary.to_csv(output_dir / "monthly_summary.csv", index=False)
    quality_frame.to_csv(output_dir / "data_quality.csv", index=False)
    write_report(output_dir, summary, monthly_summary, manifest, quality_frame, args)
    print(f"Selesai: {output_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
