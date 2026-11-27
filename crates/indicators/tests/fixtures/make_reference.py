#!/usr/bin/env python3
"""Adds the expected indicator columns to reference.csv.

The first six columns (time, open, high, low, close, volume) are the bars,
written once from `sample_bars(300)`; this script keeps them and recomputes
every other column. It uses only the standard library and implements each
indicator from its textbook definition, independently of the Rust code:

* SMA: mean of the last n values.
* EMA: alpha = 2 / (n + 1), seeded with the SMA of the first n values.
* Bollinger: SMA(n) and population standard deviation (divide by n).
* RSI: Wilder; the average gain and the average loss are RMAs (alpha = 1 / n,
  seeded with the mean of the first n changes; the first change is at bar 1).
  RSI = 100 - 100 / (1 + avg_gain / avg_loss); 100 when the average loss is 0
  and the gain is not, 50 when both are 0.
* MACD: EMA(12) - EMA(26); signal = EMA(9) of the MACD line, starting where
  MACD is first defined; histogram = MACD - signal.

Run from this directory: python3 make_reference.py
"""

import csv
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "reference.csv")
NAN = math.nan


def sma(xs, n):
    """Mean of the last n values; None-free input starting at index 0."""
    out = [NAN] * len(xs)
    for i in range(n - 1, len(xs)):
        out[i] = sum(xs[i - n + 1 : i + 1]) / n
    return out


def smoothed(xs, n, alpha):
    """Recursive average over xs, whose first finite value may be late."""
    out = [NAN] * len(xs)
    first = next((i for i, x in enumerate(xs) if not math.isnan(x)), None)
    if first is None or first + n > len(xs):
        return out
    seed_at = first + n - 1
    prev = sum(xs[first : seed_at + 1]) / n
    out[seed_at] = prev
    for i in range(seed_at + 1, len(xs)):
        prev = prev + alpha * (xs[i] - prev)
        out[i] = prev
    return out


def ema(xs, n):
    return smoothed(xs, n, 2.0 / (n + 1))


def rma(xs, n):
    return smoothed(xs, n, 1.0 / n)


def stdev(xs, n):
    out = [NAN] * len(xs)
    for i in range(n - 1, len(xs)):
        w = xs[i - n + 1 : i + 1]
        m = sum(w) / n
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / n)
    return out


def rsi(xs, n):
    gains = [NAN] + [max(xs[i] - xs[i - 1], 0.0) for i in range(1, len(xs))]
    losses = [NAN] + [max(xs[i - 1] - xs[i], 0.0) for i in range(1, len(xs))]
    ag, al = rma(gains, n), rma(losses, n)
    out = []
    for g, l in zip(ag, al):
        if math.isnan(g) or math.isnan(l):
            out.append(NAN)
        elif l == 0.0:
            out.append(50.0 if g == 0.0 else 100.0)
        else:
            out.append(100.0 - 100.0 / (1.0 + g / l))
    return out


def main():
    with open(PATH, newline="") as f:
        rows = list(csv.reader(f))
    bars = [r[:6] for r in rows[1:]]
    close = [float(r[4]) for r in bars]

    basis = sma(close, 20)
    dev = stdev(close, 20)
    macd = [a - b for a, b in zip(ema(close, 12), ema(close, 26))]
    signal = ema(macd, 9)

    columns = {
        "sma20": sma(close, 20),
        "ema20": ema(close, 20),
        "bb_basis": basis,
        "bb_upper": [m + 2.0 * d for m, d in zip(basis, dev)],
        "bb_lower": [m - 2.0 * d for m, d in zip(basis, dev)],
        "rsi14": rsi(close, 14),
        "macd": macd,
        "macd_signal": signal,
        "macd_hist": [m - s for m, s in zip(macd, signal)],
    }

    def cell(x):
        return "" if math.isnan(x) else repr(x)

    with open(PATH, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(rows[0][:6] + list(columns))
        for i, b in enumerate(bars):
            w.writerow(b + [cell(c[i]) for c in columns.values()])


if __name__ == "__main__":
    main()
