# ADR 0005: Replay

Date: 2026-11-28. Status: accepted.

## Context

Release 0.4 lets a trader step through history bar by bar, take paper trades and share the session so anyone gets the same result. Drawings (0.3) already have the position model and a deterministic Rust outcome function (ADR 0004). The project's priorities are reliability first, then speed and low resource use, then minimalism.

## Decision

1. **Replay steps the chart's own timeframe.** No aggregation from 1-minute candles in 0.4. ADR 0001 said aggregation would come with replay; it is not needed to step one timeframe, so it is deferred. A bar touching both stop and take counts as stop and is marked ambiguous, as for drawings.
2. **Fills.** A market trade fills at the close of the current (last revealed) bar. Stop and take are checked from the next bar on with `position::resolve`. A manual close fills at the close of the current bar. No fees or slippage in 0.4; results are in R, where fees would only shift every trade the same way. One open trade at a time (minimal, matches R statistics).
3. **Results in Rust.** `sandchart_core::replay` simulates a session: candles + trade commands → trades with exit time, exit price and R; and statistics: count, wins, losses, win rate, total R, average R, expectancy, profit factor, max drawdown in R, longest losing streak. The UI never computes results itself; it calls the engine after each step that can change them (new bar, trade opened, closed or edited).
4. **The `.replay` file is self-contained.** JSON, version 1: instrument (source, symbol, price scale), timeframe, the candles used (context before the start and every revealed bar, as integer ticks), the start index, the current index, and the trade commands (open: side, bar index, stop, take; edit: stop and take at a bar; close at a bar). Its `sha256` covers the canonical candle bytes. Opening a file verifies the hash and re-simulates from the commands, so the results come from the file, never from a stored result. Files are capped at 200 000 candles, 10 000 commands and 32 MiB. Anyone with the file gets the same trades and statistics on any machine, offline.
5. **Future bars are never sent to the UI.** The engine holds the session's candles; the UI receives only bars up to the current index. A replay cannot peek ahead by accident: drawings, indicators and autoscale see only revealed bars. Indicators recompute on revealed bars only.
6. **Saving uses the Tauri dialog plugin** (native save panel, written from Rust); opening uses the existing file input pattern (bytes to Rust). Live updates for the instrument pause while a replay is open.
7. **Controls:** pick a start bar (click on the chart or a date), Step (→), Play/Pause (Space) at 1, 2, 5 or 10 bars per second, Buy/Sell (default stop 1.5 % away, take at 2R, both draggable before and after entry like a position drawing), Close, Exit replay. No step back in 0.4: to retry, restart from the same start. The file keeps every command, so a step back would have to rewrite history.

## Alternatives considered

- **Simulation in TypeScript.** Fast, but a second implementation that breaks determinism.
- **Only a candle hash in the file.** Smaller, but the file then needs the same exchange and cache to replay, and Binance may delist pairs.
- **Step back.** More UI and an ambiguous history.

## Consequences

- A replay file can be large (up to 32 MiB) because it carries its candles; in exchange it opens offline and on any machine.
- Candles of different timeframes can still differ slightly, as in 0.1, until aggregation lands.
- Results are in R only; fees and slippage are left for a later release.
