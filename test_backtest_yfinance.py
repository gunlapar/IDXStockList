import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

from backtest_yfinance import BUY_FEE, SELL_FEE, active_for_snapshot, active_for_year, add_features, run_basis, simulate_trade, snapshot_periods


def candles(rows):
    return pd.DataFrame(rows, index=pd.date_range("2024-01-01", periods=len(rows), freq="B"))


class BacktestTests(unittest.TestCase):
    def test_features_create_all_compression_variants(self):
        closes = [100] * 30 + [104]
        volumes = [2_000_000] * 30 + [4_000_000]
        frame = candles([{"Open": value, "High": value + 1, "Low": value - 1, "Close": value, "Volume": volume} for value, volume in zip(closes, volumes)])
        last = add_features(frame).iloc[-1]
        self.assertTrue(last.compression_5_bullish)
        self.assertTrue(last.compression_2_bullish)
        self.assertTrue(last.compression_1_5_bullish)
        self.assertEqual(last.ma_state, "B_confirmed_aligned")

    def test_compression_variants_are_nested(self):
        def frame(closes):
            volumes = [3_000_000] * 30 + [6_000_000]
            return candles([{"Open": value, "High": value + 1, "Low": value - 1, "Close": value, "Volume": volume} for value, volume in zip(closes, volumes)])

        strong_only = add_features(frame([100] * 21 + [101.2] * 5 + [102.4] * 4 + [103.6])).iloc[-1]
        baseline_only = add_features(frame([100] * 21 + [102] * 5 + [104] * 4 + [106])).iloc[-1]
        self.assertTrue(strong_only.compression_5_bullish)
        self.assertTrue(strong_only.compression_2_bullish)
        self.assertFalse(strong_only.compression_1_5_bullish)
        self.assertTrue(baseline_only.compression_5_bullish)
        self.assertFalse(baseline_only.compression_2_bullish)

    def test_short_history_cannot_create_a_signal(self):
        frame = candles([{"Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 2_000_000}] * 19)
        self.assertFalse(add_features(frame).iloc[-1].core_3_filters)
    def test_same_day_tp_and_sl_uses_conservative_stop(self):
        frame = candles([
            {"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1},
            {"Open": 100, "High": 103, "Low": 98, "Close": 100, "Volume": 1},
        ] + [{"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1}] * 19)
        frame["atr14"] = 1.0
        trade = simulate_trade(frame, 0, "adjusted", "A_volume_compression", "TEST.JK")
        self.assertEqual(trade.exit_reason, "SL_SAME_DAY")
        self.assertEqual(trade.exit_price, 98.5)

    def test_gap_and_fees_use_open_price(self):
        frame = candles([
            {"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1},
            {"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1},
            {"Open": 97, "High": 100, "Low": 96, "Close": 98, "Volume": 1},
        ] + [{"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1}] * 18)
        frame["atr14"] = 1.0
        trade = simulate_trade(frame, 0, "raw", "A_volume_compression", "TEST.JK")
        expected = (97 * (1 - SELL_FEE) - 100 * (1 + BUY_FEE)) / (100 * (1 + BUY_FEE)) * 100
        self.assertEqual(trade.exit_reason, "SL_GAP")
        self.assertAlmostEqual(trade.net_return_pct, expected)

    def test_one_position_per_ticker_until_exit(self):
        prices = candles([{"Open": 100, "High": 100, "Low": 100, "Close": 100, "Volume": 1}] * 45)
        features = prices.copy()
        features["compression_5_bullish"] = True
        features["compression_2_bullish"] = False
        features["compression_1_5_bullish"] = False
        features["ma_state"] = "C_unaligned"
        features["atr14"] = 1.0
        args = SimpleNamespace(start="2024-01-01", end="2024-03-31", cache_dir="unused", snapshot_frequency="yearly")
        with patch("backtest_yfinance.get_prices", return_value=prices), patch("backtest_yfinance.add_features", return_value=features):
            trades = run_basis(["TEST.JK"], {"2024": {"TEST.JK"}}, "adjusted", args, [])
        self.assertEqual(len(trades), 2)
        self.assertEqual([trade.entry_date for trade in trades], ["2024-01-02", "2024-01-30"])
    def test_timeout_and_historical_membership(self):
        frame = candles([{"Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 1}] * 21)
        frame["atr14"] = 2.0
        trade = simulate_trade(frame, 0, "adjusted", "A_volume_compression", "TEST.JK")
        self.assertEqual(trade.exit_reason, "TIMEOUT")
        self.assertEqual(trade.holding_days, 20)
        self.assertTrue(active_for_year("TEST.JK", pd.Timestamp("2024-01-01"), {2024: {"TEST.JK"}}))
        self.assertFalse(active_for_year("TEST.JK", pd.Timestamp("2023-01-01"), {2024: {"TEST.JK"}}))


    def test_monthly_snapshot_controls_membership(self):
        periods = snapshot_periods(pd.Timestamp("2024-01-15"), pd.Timestamp("2024-02-02"), "monthly")
        self.assertEqual([str(period) for period in periods], ["2024-01", "2024-02"])
        membership = {"2024-01": {"TEST.JK"}, "2024-02": set()}
        self.assertTrue(active_for_snapshot("TEST.JK", pd.Timestamp("2024-01-31"), membership, "monthly"))
        self.assertFalse(active_for_snapshot("TEST.JK", pd.Timestamp("2024-02-01"), membership, "monthly"))

if __name__ == "__main__":
    unittest.main()