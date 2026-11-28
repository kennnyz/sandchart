# MCP server

`sandchart-mcp` lets an AI agent work with your Sandchart charts through the [Model Context Protocol](https://modelcontextprotocol.io): read candles, run indicators, read and draw lines and positions, check how a position played out, read the results of a `.replay` file, and set alerts. It is a small program next to the app that your agent (Claude Code, Claude Desktop, Cursor or any other MCP client) starts and talks to over stdin and stdout. It opens the same local database as the app, so whatever the agent draws appears on your chart, and the other way round.

No tool places an order. There are no exchange keys anywhere, and nothing about you or your charts leaves the machine.

- [Install](#install)
- [Set up your agent](#set-up-your-agent)
- [Numbers, prices and times](#numbers-prices-and-times)
- [Tools](#tools)
- [Limits](#limits)
- [Working next to the app](#working-next-to-the-app)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)

## Install

Download the archive for your system from the [Releases](../../../releases) page, `sandchart-mcp-<target>.tar.gz` (`.zip` on Windows), check it against `SHA256SUMS`, unpack it and put `sandchart-mcp` on your `PATH`:

| System | Archive |
| --- | --- |
| macOS, Apple silicon | `sandchart-mcp-aarch64-apple-darwin.tar.gz` |
| macOS, Intel | `sandchart-mcp-x86_64-apple-darwin.tar.gz` |
| Windows | `sandchart-mcp-x86_64-pc-windows-msvc.zip` |
| Linux | `sandchart-mcp-x86_64-unknown-linux-gnu.tar.gz` |

On macOS the binary is not signed; remove the quarantine flag once with `xattr -d com.apple.quarantine sandchart-mcp`.

Or build it from a clone (Rust stable and the `wasm32-wasip2` target, see `AGENTS.md`):

```sh
cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release --locked
cargo install --locked --path crates/mcp
```

`sandchart-mcp --version` prints the version. Use the same version as your app: an older server refuses a database a newer app has upgraded, and a newer server never upgrades the database of an older app (that app could then no longer open it); it asks you to update the app first. On a machine where the app has never run, the server sets up a new database itself.

## Set up your agent

The server needs no arguments. It finds the app's data folder by itself (the same one the app uses); `--data-dir <folder>` points it at another one.

**Claude Code:**

```sh
claude mcp add sandchart -- sandchart-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project) take the same block:

```json
{
  "mcpServers": {
    "sandchart": {
      "command": "sandchart-mcp"
    }
  }
}
```

If the client does not find the program, give the full path as `command`, for example `/usr/local/bin/sandchart-mcp` or `C:\\Tools\\sandchart-mcp.exe`.

Then ask in plain words, for example: "Show me the 4h RSI of ETHUSDT for the last ten bars", "Draw a horizontal line at the last swing low of BTCUSDT on the daily chart and alert me when the price crosses it", or "Read ~/Desktop/BTCUSDT-1h.replay and tell me my win rate".

## Numbers, prices and times

- **Prices are integers counted in ticks**, as everywhere in Sandchart. A pair's `priceScale` is the number of decimal places of one tick: on BTCUSDT (`priceScale` 2) the price 61443.01 is `6144301`. Inputs take ticks plus the `priceScale` they are written at; a drawing or alert at another scale is converted to the pair's, as the app does. Outputs give the ticks and, next to them, the same price as a decimal string (`price` and `priceDecimal`), so an agent never has to do float arithmetic on money.
- **Volumes** use the pair's `qtyScale` the same way.
- **Times** are Unix milliseconds, UTC. A candle's `time` is its open time.
- **Timeframes** are `1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`.
- **`source`** defaults to `binance`, the only exchange in this version. Symbols are matched without regard to case (`btcusdt` finds `BTCUSDT`).
- Field names are camelCase. An unknown field, such as a misspelt `lastN`, is an error, never ignored.
- A tool that cannot do what was asked returns an error result whose text says why (`limit must be 1 to 5000, not 5001`, `a long position needs stop < entry < take`), so the agent can fix the call.

## Tools

Every tool returns one JSON object, as structured content and as the same JSON in text.

### search_instruments

Finds pairs by symbol. The first call after the server starts refreshes the pair list from the exchange; if that fails, the cached list answers with a `warning`.

| Input | |
| --- | --- |
| `query` | Part of a symbol, e.g. `"BTC"`. |
| `limit` | 1 to 50, default 20. |

```json
{ "query": "btcusdt", "limit": 2 }
```

```json
{ "instruments": [
  { "source": "binance", "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "priceScale": 2, "qtyScale": 5 },
  { "source": "binance", "symbol": "WBTCUSDT", "base": "WBTC", "quote": "USDT", "priceScale": 2, "qtyScale": 5 }
] }
```

### get_candles

Candles, oldest first, from the local cache; candles that are missing are fetched from the exchange and cached, like the chart does when you scroll. The last candle may still be forming.

| Input | |
| --- | --- |
| `source`, `symbol`, `timeframe` | The pair and timeframe. |
| `limit` | 1 to 5000, default 500. |
| `before` | Only candles that open before this time (ms); default up to now. |

```json
{ "symbol": "BTCUSDT", "timeframe": "1h", "limit": 2 }
```

```json
{
  "instrument": { "source": "binance", "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "priceScale": 2, "qtyScale": 5 },
  "timeframe": "1h",
  "candles": [
    { "time": 1795762800000, "open": "61500.10", "high": "61800.00", "low": "61450.00", "close": "61777.35",
      "volume": "512.34000", "ticks": [6150010, 6180000, 6145000, 6177735, 51234000] },
    { "time": 1795766400000, "open": "61791.77", "high": "61900.00", "low": "61700.00", "close": "61850.00",
      "volume": "98.10000", "ticks": [6179177, 6190000, 6170000, 6185000, 9810000] }
  ],
  "atHistoryStart": false,
  "warning": null
}
```

`ticks` is `[open, high, low, close, volume]` in ticks. `atHistoryStart` is true when nothing older exists. `warning` is set when the exchange could not be reached and the cache answered.

### list_indicators

The built-in indicators and the ones installed in the app, with their parameters (kind, range, default) and output series. No input.

```json
{ "indicators": [
  { "id": "builtin.sma", "name": "SMA", "version": "0.2.0", "description": "Simple moving average",
    "builtin": true, "repaints": false,
    "params": [
      { "id": "period", "label": "Period", "kind": { "int": { "min": 1, "max": 1000 } }, "default": { "int": 20 } },
      { "id": "source", "label": "Source", "kind": { "choice": ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"] },
        "default": { "choice": "close" } }
    ],
    "series": [ { "id": "sma", "label": "SMA", "kind": "line", "pane": "price", "color": 0 } ] }
], "failed": [], "error": null }
```

### compute_indicator

Runs one indicator in the app's sandbox (the same runtime, limits and bars as the chart: every cached bar of the pair and timeframe, at most 100 000, after the same refresh as `get_candles`) and returns its last `lastN` values with the open times of their bars. A value is `null` where the indicator has none yet (before its first full window). Your chart's indicators are not changed.

| Input | |
| --- | --- |
| `id` | From `list_indicators`, e.g. `"builtin.rsi"`. |
| `params` | Values by parameter id, e.g. `{ "period": 50 }`; missing ones take their default. A parameter the indicator does not have, a value of the wrong type or outside the range is an error. |
| `source`, `symbol`, `timeframe` | The pair and timeframe. |
| `lastN` | 1 to 5000, default 200. |

```json
{ "id": "builtin.rsi", "symbol": "BTCUSDT", "timeframe": "1d", "lastN": 2 }
```

```json
{ "indicator": "builtin.rsi", "params": { "period": 14, "source": "close" },
  "source": "binance", "symbol": "BTCUSDT", "timeframe": "1d",
  "times": [1795737600000, 1795824000000],
  "series": [ { "id": "rsi", "values": [26.59, 26.87] } ],
  "log": null, "warning": null }
```

A marker series comes as `{ "id": "...", "markers": [ { "time": ..., "shape": "up", "text": null } ] }`. Indicator values are plain numbers: indicators compute in floating point (see [ADR 0002](adr/0002-indicator-runtime.md)).

### list_drawings

The drawings of a pair in paint order. Input: `source`, `symbol`.

```json
{ "instrument": { "symbol": "BTCUSDT", "priceScale": 2, "...": "..." },
  "drawings": [
    { "id": "mcp-1a2b-...", "source": "binance", "symbol": "BTCUSDT", "priceScale": 2,
      "body": { "kind": "hline", "p": 6000000 }, "style": { "color": 0, "width": 1, "dash": false },
      "locked": false, "z": 0, "updatedAt": 1795766400123 }
  ] }
```

### save_drawing

Saves a drawing with the same rules as the app ([Drawing tools](drawings.md)): a new one, or the one with the same `id` replaced. Returns the drawing as stored.

| Input | |
| --- | --- |
| `id` | Optional, 1 to 64 characters from `A-Z a-z 0-9 _ -`. Leave it out for a new drawing; the server makes one. |
| `source`, `symbol` | The pair. |
| `priceScale` | The scale of the prices in `body`. |
| `body` | The shape, by `kind` (below). |
| `style` | Optional `{ "color": 0-7, "width": 1-4, "dash": false }`, default slot 0, width 1, solid. |
| `locked`, `z` | Optional, default `false` and `0`. |

| `kind` | Fields |
| --- | --- |
| `hline` | `p` |
| `trend` | `a`, `b` (points `{ "t": ms, "p": ticks }`), `extendLeft`, `extendRight` |
| `rect` | `a`, `b`, `extendRight` |
| `fib` | `a`, `b`, `levels` (1 to 16 numbers in −5..5, e.g. `[0, 0.382, 0.5, 0.618, 1]`) |
| `position` | `side` (`long` or `short`), `entry` (a point), `stop`, `take`, `endT` |
| `brush` | `points` (2 to 500 points) |
| `note` | `t`, `text` (1 to 2000 bytes) |

```json
{ "symbol": "BTCUSDT", "priceScale": 2,
  "body": { "kind": "trend", "a": { "t": 1795680000000, "p": 6050000 }, "b": { "t": 1795766400000, "p": 6185000 },
            "extendLeft": false, "extendRight": true } }
```

An open chart shows the new drawing the next time it loads that pair (switch pairs or timeframes, or restart). Replacing a drawing that alerts follow with one that is not an `hline` or a `trend`, or that is on another pair, deletes those alerts in the same write.

### delete_drawing

Deletes a drawing by `id`, and the alerts that follow it. An unknown id is not an error.

```json
{ "id": "mcp-1a2b-..." }
```

```json
{ "deleted": "mcp-1a2b-..." }
```

### position_outcome

How a long or short position played out over the cached candles of a timeframe, by the same rule as position drawings: the first bar after the entry bar that reaches the stop or the take decides, and a bar that reaches both counts as a stop and is marked `ambiguous`. Candles back to the entry are fetched first (at most 5000).

| Input | |
| --- | --- |
| `source`, `symbol`, `timeframe` | The pair and timeframe. |
| `position` | `side`, `entry` `{ "t", "p" }`, `stop`, `take` (ticks), `endT` (ms, after the entry). |

```json
{ "symbol": "BTCUSDT", "timeframe": "1h",
  "position": { "side": "long", "entry": { "t": 1795752000000, "p": 6177735 }, "stop": 6150000, "take": 6233205,
                "endT": 1795838400000 } }
```

```json
{ "status": "take", "exitTime": 1795773600000, "ambiguous": false, "r": 2.0, "warning": null }
```

`status` is `open`, `take` or `stop`; `r` is reward over risk on a take, −1 on a stop, 0 while open.

### run_replay

Reads a `.replay` file and returns its trades and statistics in R. The results are simulated again from the file's own candles and commands, exactly as the app does when you open it (see [Replay](replay.md)); nothing in the file is taken on trust.

Only an absolute path to a regular file ending in `.replay`, at most 32 MiB, is read. Give it the files you mean it to read.

```json
{ "path": "/Users/me/Desktop/BTCUSDT-1h.replay" }
```

```json
{ "instrument": { "symbol": "BTCUSDT", "priceScale": 2, "...": "..." }, "timeframe": "1h",
  "candles": 620, "start": 500, "startTime": 1793966400000, "current": 619, "currentTime": 1794394800000,
  "trades": [
    { "side": "long", "entryBar": 503, "entryTime": 1793977200000, "entryPrice": 6012000, "entryPriceDecimal": "60120.00",
      "initialStop": 5992000, "initialStopDecimal": "59920.00", "stop": 5992000, "stopDecimal": "59920.00",
      "take": 6052000, "takeDecimal": "60520.00", "exitBar": 511, "exitTime": 1794006000000,
      "exitPrice": 6052000, "exitPriceDecimal": "60520.00", "reason": "take", "ambiguous": false, "r": 2.0 }
  ],
  "stats": { "count": 1, "wins": 1, "losses": 0, "winRate": 1.0, "totalR": 2.0, "averageR": 2.0,
             "profitFactor": null, "maxDrawdownR": 0.0, "longestLosingStreak": 0 } }
```

### list_alerts

Every alert, oldest first, active or fired. No input.

```json
{ "alerts": [
  { "id": "mcp-...", "source": "binance", "symbol": "BTCUSDT", "priceScale": 2,
    "kind": { "kind": "price", "price": 6000000, "priceDecimal": "60000.00" }, "direction": "below",
    "active": true, "createdAt": 1795766400123, "triggeredAt": null, "triggeredPrice": null }
], "note": "Alerts fire only while the Sandchart app is running." }
```

A fired alert has `active: false`, `triggeredAt` and `triggeredPrice` (with `triggeredPriceDecimal`).

### set_alert

Arms an alert ([Alerts](alerts.md)): a price alert, or an alert on an `hline` or `trend` drawing of the same pair. It fires once, when the price crosses the level in its direction (`above`, `below` or `cross`); wicks and gaps count. **Alerts fire only while the Sandchart app is running**: the app picks a new one up within a few seconds and shows an OS notification when it fires.

| Input | |
| --- | --- |
| `id` | Optional; an existing id replaces that alert. |
| `source`, `symbol`, `priceScale` | The pair and the scale of `kind.price`. |
| `kind` | `{ "kind": "price", "price": ticks }` or `{ "kind": "drawing", "drawingId": "..." }`. |
| `direction` | `above`, `below` or `cross`. |

```json
{ "symbol": "BTCUSDT", "priceScale": 2, "kind": { "kind": "price", "price": 6000000 }, "direction": "below" }
```

Returns the alert as stored, with the same `note`.

### delete_alert

Deletes an alert by `id`. An unknown id is not an error.

## Limits

| What | Limit |
| --- | --- |
| Search results | 50 |
| Candles per `get_candles` | 5000 |
| Values per `compute_indicator` | 5000 (computed over up to 100 000 bars) |
| Drawings per pair | 2000 |
| Active alerts | 100, on at most 30 pairs; 500 kept in all |
| Replay file | 32 MiB, 200 000 candles, 10 000 commands |
| Indicator run | The app's sandbox limits: memory, work and time (see [Writing indicators](indicators.md#limits-and-errors)) |

The instrument list is downloaded once per server start; after a failure, at most once a minute.

## Working next to the app

The server and the app may run at the same time. Both use the same SQLite file in WAL mode: reads never wait, and a write waits up to 5 seconds for the other program's write instead of failing. The server never deletes indicator files or compiled modules; that is the app's job.

- Drawings the agent saves appear on your chart the next time the app loads that pair.
- Alerts the agent sets or deletes are armed or disarmed by a running app within a few seconds, and show in its alerts panel. While the app is closed they are stored and start when the app starts.
- The server works while the app is closed too: candles, indicators, drawings and replays need only the database (and the exchange for candles that are not cached yet).

## Privacy

The server adds no host. It talks only to the market-data hosts in [Privacy and network](../README.md#privacy-and-network) (`data-api.binance.vision` for the instrument list and candles), through the same client as the app, and only when a tool needs data that is not cached. It opens no port and listens on no network; it only reads stdin and writes stdout. It reads files only through `run_replay`, and only the `.replay` file you name. Your agent sees what the tools return; what the agent does with it is up to the agent and its provider.

## Troubleshooting

- **"database schema version 5 is newer than supported version 4"**: the app is newer than the server. Install the server of the same version.
- **"database schema version 3 is older than this program's version 4; update the Sandchart app first"**: the server is newer than the app. Update the app and start it once; it upgrades its database, and the server then opens it.
- **"database is locked"**: the other program held a write for more than 5 seconds. Try again.
- **The first indicator call is slow**: the server compiles the built-in indicators once, unless the app has already done it on this machine.
- The server writes its own messages to stderr; MCP clients usually show them in their log of the server.
