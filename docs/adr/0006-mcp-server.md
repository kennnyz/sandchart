# ADR 0006: MCP server

Date: 2026-11-28. Status: accepted.

## Context

Release 0.5 lets an AI agent (Claude Code, Claude Desktop, Cursor and other Model Context Protocol clients) read the same charts the trader sees and work with them: candles, indicators, drawings, position outcomes, replay results and alerts. All of that already lives in Rust behind the engine (ADR 0001) and in one SQLite file in the user's data folder. The project's priorities are reliability first, then speed and low resource use, then minimalism. Nothing may leave the machine except requests to the market-data hosts the README lists, and the app holds no exchange keys.

## Decision

1. **A separate stdio binary, `sandchart-mcp`** (crate `crates/mcp`), built on the same `sandchart-engine` and opening the same data folder and SQLite file as the app (the same `directories::ProjectDirs` path; `--data-dir` overrides it). It works whether or not the app is running, needs no port, no token and no network listener, and is set up like any stdio MCP server (`claude mcp add sandchart -- sandchart-mcp`). Stdout carries only JSON-RPC; logs go to stderr.
2. **Two processes, one database.** The store opens SQLite in WAL mode with a busy timeout of 5 s, and every write transaction starts `IMMEDIATE`, so the app and the server wait for each other's writes instead of failing, and a read-then-write transaction cannot lose to a commit made in between. Migrations re-read the schema version inside their own write transaction, so two processes opening an old file at once migrate it once. The server opens the engine as a secondary process: it loads indicators from the app's folders but never deletes module files or prunes the compiled-module cache, which belong to the app. It does not run the alert service.
3. **SDK:** the official Rust MCP SDK `rmcp` (Apache-2.0, checked by cargo deny), with the server, macros and stdio transport features only, no HTTP. Tool input schemas are generated with `schemars` from the same serde types the engine uses (`sandchart-core` derives `JsonSchema` behind its `schema` feature), so the schema an agent sees cannot drift from what the server parses.
4. **Tools.** Inputs are validated with clear messages; a rule broken is a tool error the agent can read and correct, not a protocol error. Prices go out as decimal strings and as integer ticks with the price scale, so agents never parse floats for money; inputs take ticks at a stated `priceScale`, as the app's IPC does, and are rescaled like the app's.
   - `search_instruments(query, limit ≤ 50)`. The first call of a process refreshes the instrument list from the provider; if that fails, the cached list answers with a warning.
   - `get_candles(source, symbol, timeframe, limit ≤ 5000, before?)`: cache-first, fetching missing pages from the provider like the chart does, newest last.
   - `list_indicators()`; `compute_indicator(id, params, source, symbol, timeframe, last_n ≤ 5000)`: the same sandboxed runtime and the same bars as the chart (every cached bar up to 100 000, after the same refresh as `get_candles`), returning the last `last_n` values with their bar times. Unknown parameters and values outside a parameter's range are errors, not silently replaced by defaults.
   - `list_drawings(source, symbol)`, `save_drawing(drawing)`, `delete_drawing(id)`: the engine's own validation and caps. A running app shows the change the next time it loads that pair.
   - `position_outcome(source, symbol, timeframe, position)`: `sandchart_core::position` over the cached candles, as for a position drawing.
   - `run_replay(path)`: reads a `.replay` file the user names and returns its trades and statistics from `sandchart_core::replay`, re-simulated from the file's commands. Only regular files up to the app's 32 MiB cap are read; anything else is refused before reading.
   - `list_alerts()`, `set_alert(alert)`, `delete_alert(id)`. Alerts fire only while the app runs; the tool descriptions say so. A running app notices changes made by another process (SQLite `data_version`, checked every few seconds) and arms or disarms them.
   No tool places orders; there are no exchange keys anywhere.
5. **Outgoing hosts** stay the README list: the server only talks to the same providers, through the same `Binance` client. The README "Privacy and network" section says so.
6. **Distribution:** the release workflow builds `sandchart-mcp` per OS next to `sandchart-indicator` (one archive each, in `SHA256SUMS` and the provenance attestation). `cargo install --path crates/mcp` works from a checkout. Docs: `docs/mcp.md`.

## Alternatives considered

- **An HTTP server inside the app.** Works only while the app runs, opens a local port that any local program can reach, and needs a token.
- **Read-only access.** Simpler, but an agent could then not draw levels, mark positions or set alerts, which is most of the point.
- **Hand-written JSON schemas.** No new dependency in core, but a second description of every drawing kind that would drift from serde.
- **Decimal strings as input prices.** Easier for an agent, but a second input format next to the app's ticks; the outputs give both, so an agent copies ticks it has seen.

## Consequences

- Two processes may write the database at once; a writer can wait up to 5 s for the other before it fails with a "database is locked" error.
- An alert set by an agent while the app is closed fires only after the app starts; while the app runs it is armed within a few seconds.
- Drawings an agent saves appear in an open chart only when that pair is loaded again.
- The server compiles the built-in indicators at its first start unless the app has already cached them.
