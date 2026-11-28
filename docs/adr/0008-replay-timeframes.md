# ADR 0008: Replay across timeframes

Date: 2026-11-28. Status: accepted. Supersedes decision 1 of [ADR 0005](0005-replay.md) and its bar-index command model.

## Context

Replay in 0.4 steps the chart's own timeframe and its trade commands point at bar indices of that timeframe (ADR 0005). Switching the chart from 1h to 15m during a replay therefore has to end it: the 15m bars have other indices, and the forming 1h bar cannot be shown from 1h bars alone. Traders expect what other chart tools do: replay at a chosen step (an "update interval" such as 1m, 15m or 1h), look at any timeframe while doing it, see the forming 4h bar grow as they step, and keep their trades when they switch. The priorities stay reliability first, then speed and low resource use, then minimalism.

## Decision

1. **A replay has a base timeframe, the step resolution.** Stepping reveals base candles. The point the replay has reached, the **cut**, is a time: the close time of the last revealed base candle. A candle's close time is its open time plus the timeframe's length, or the start of the next calendar month for 1M. The base candles revealed at a cut are those that close at or before it.
2. **Chart candles are aggregated in core.** For a chart timeframe T at or above the base, `aggregate` builds T's candles from the revealed base candles: the open of the first, the highest high, the lowest low, the close of the last, the summed volume. Buckets match Binance: fixed-length buckets aligned to the Unix epoch for minutes, hours and days; weeks start on Monday 00:00 UTC; months are calendar months in UTC. 3d is never built from a lower timeframe: no recorded Binance 3d candles confirm where its buckets start, and a guess would show wrong bars (a 3d replay steps native 3d candles). The last bucket may be partial, which is the forming bar. A bucket without base candles (a gap) gives no candle. T is accepted only when every T boundary is a base boundary: 1h from 15m, 1w from 1d and 1M from 1d are fine, 1M from 1w, 1w from 3d and 3d from 1d are refused. T equal to the base returns the base candles unchanged. A chart below the base re-bases the session to that timeframe; that is the engine's job and comes in the next step.
3. **Commands carry a time, not a bar index:** the cut at the moment they were given. An open fills at the close of the base candle ending at that cut; stop and take are checked on the base candles after it; an edit applies from the next base candle; a manual close fills at the close of the base candle ending at its cut. The ambiguity rule (a candle touching both levels is a stop) and the gap rule (a candle opening beyond a level fills at its open) are unchanged and apply to base candles. A trade's entry and exit times are the open times of the base candles it filled on, so a chart of any timeframe puts them in the bucket that contains them. Results therefore do not depend on the chart's timeframe: they are a function of the base candles and the commands only.
4. **The `.replay` file goes to version 2:** the instrument, the base timeframe (`base`), the base candles (context, the revealed ones and optionally later ones), the start (the cut when the replay began), the current cut (`cut`), and the commands with their times. Version 1 files still open: each bar index becomes that bar's close time, with the version 1 timeframe as the base, and they give the same trades. Saving always writes version 2. The limits and the `sha256` rule (it covers the candles only) are unchanged.
5. **Determinism and limits are unchanged.** Results are computed in Rust only (the browser mock keeps a TEST-ONLY copy checked against the same fixture); a session holds at most 200 000 base candles; future candles are never sent to the UI.

## Alternatives considered

- **Keep stepping the chart's timeframe and translate indices on a switch.** No new maths, but the forming higher-timeframe bar cannot be shown, a lower timeframe cannot be shown at all, and every switch rewrites the commands.
- **Always step 1-minute candles.** One resolution for everything, but a year of 1m is 525 600 candles, over the cap and slow to fetch, for traders who step 4h bars.
- **Use the exchange's native higher-timeframe candles next to the base ones.** No aggregation, but they show the whole bar, future included, until the cut reaches its close.
- **Commands as base-candle indices.** Smaller numbers, but indices move when context is prepended and differ between bases; a time means the same on every timeframe.

## Consequences

- A higher-timeframe chart in a replay is built from base candles, so it can differ slightly from the exchange's own candles of that timeframe (as noted in ADR 0005); outside replay the chart keeps the native ones.
- Version 1 files open in this release; older releases refuse version 2 files, as with every format bump.
- The engine session, its IPC and the UI move to the base timeframe and the cut in the next step. Until then the engine uses the chart's timeframe as the base.
