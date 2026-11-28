# Sandchart

**An open-source desktop chart terminal written in Rust.** Fast candlestick charts for Binance spot markets, a local cache that opens charts instantly, and no account, subscription, API keys or telemetry.

[![CI](https://github.com/kennnyz/sandchart/actions/workflows/ci.yml/badge.svg)](https://github.com/kennnyz/sandchart/actions/workflows/ci.yml)
![Licence: MIT OR Apache-2.0](https://img.shields.io/badge/licence-MIT%20OR%20Apache--2.0-blue)
![Platforms: macOS, Windows, Linux](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Status: 0.2, early](https://img.shields.io/badge/status-0.2%20early-orange)

![Sandchart showing a live BTCUSDT 1h chart from Binance](docs/screenshot.png)

<sub>Live Binance data, 27 November 2026. The interface is set to Russian; English is one click away.</sub>

## Why Sandchart

- **Your machine, your data.** Candles are cached in a local SQLite file. Charts open from cache instantly and keep working offline. There is nothing to sign in to and no telemetry.
- **Nothing to steal.** The app never asks for exchange keys and only talks to Binance's public market-data hosts and, for updates, to GitHub (see [Privacy and network](#privacy-and-network)).
- **Exact numbers.** Prices and volumes are integers counted in the pair's tick and lot size, from the exchange to the screen. No floating-point money anywhere in the core.
- **Our own renderer.** The chart is a small Canvas 2D engine written for this project, not a wrapped charting library. A frame takes well under a millisecond to draw.
- **Built to be extended.** Indicators are WebAssembly modules that run in a sandbox: they cannot read your files or reach the network. Drawing tools, a replay anyone can reproduce from a shared file, alerts and a local MCP server for AI agents build on the same core. See the [roadmap](#roadmap).

## Features

- Candlestick chart with volume: pan and zoom with mouse or trackpad (including pinch), crosshair with an OHLC legend, auto scale and logarithmic scale. The price axis grows to fit long prices such as `120 587.50` or `0.00001234`.
- Timeframes from 1 minute to 1 month, each fetched natively from Binance and cached.
- Live updates of the forming candle over WebSocket. After a dropped connection or a sleeping laptop, the missed candles are fetched again, so the chart has no gaps.
- Polite to the exchange: retries back off (1, 2, 4… up to 30 s) and honour Binance's `Retry-After`.
- Search over all Binance spot pairs (Cmd/Ctrl+K) and a watchlist with last price and 24 h change: add with the `+` button, drag to reorder, hide the panel to give the chart more room.
- Indicators: SMA, EMA, Bollinger bands, RSI and MACD are built in, and you can add your own as WebAssembly modules. They run in a sandbox with no files, no network and no clock, under memory and work limits. Lines, histograms, markers and bands draw over the candles or in panes of their own, and a repaint check warns about indicators that change their past. Write one in Rust with the `sandchart-indicator` command, or let your coding agent do it: see [Writing indicators](docs/indicators.md).
- Drawing tools: trend lines, horizontal levels, rectangles, Fibonacci retracements, long and short positions with their outcome, a brush, notes on bars and a ruler. Drawings are stored per pair in the local SQLite file, show on every timeframe, snap to bar prices with the magnet and undo with Cmd/Ctrl+Z. See [Drawing tools](docs/drawings.md).
- Replay: step or play through history bar by bar with no future bar on screen, take paper trades with a draggable stop and take, and see the results in R (win rate, total and average R, profit factor, drawdown). Save the session to a `.replay` file that carries its own candles, so anyone opens it offline and gets the same trades and numbers. See [Replay](docs/replay.md).
- Alerts: a price alert at the crosshair price (Alt+A) or an alert on a horizontal or trend line, crossing above, below or either way. Wicks and gaps count, each alert fires once with an OS notification and a message in the app, and a panel under the watchlist lists, re-arms and deletes them. They run while the app is open, on your machine only. See [Alerts](docs/alerts.md).
- An MCP server for AI agents: `sandchart-mcp` gives Claude Code, Claude Desktop, Cursor and other MCP clients your candles, indicators, drawings, position outcomes, replay results and alerts, from the same local database as the app. Prices come as ticks and decimal strings; no tool can trade. See [MCP server](docs/mcp.md).
- Monochrome candles (color appears only in numbers and indicator series), dark and light themes, English and Russian interface.
- Builds for macOS (Apple silicon and Intel), Windows and Linux.

## Architecture

Sandchart is one desktop binary. A Rust core owns the data; a thin TypeScript UI draws it.

```mermaid
flowchart LR
    subgraph app["Sandchart app"]
        direction TB
        ui["UI in a WebView<br/>React + TypeScript<br/>own Canvas chart renderer"]
        subgraph core["Rust core"]
            direction LR
            engine["engine<br/>cache-then-fetch, live updates,<br/>gap backfill, connection state"]
            data["data<br/>Binance REST + WebSocket"]
            store[("store<br/>SQLite cache")]
            corecrate["core<br/>exact decimal ticks,<br/>timeframes, candles"]
            host["indicators<br/>wasmtime sandbox: no files,<br/>network or clock"]
        end
        ui -- "commands" --> engine
        engine -- "events + live channel" --> ui
        engine --> data
        engine --> store
        engine -- "all cached candles" --> host
        data --> corecrate
        store --> corecrate
    end
    binance["Binance public market data<br/>data-api.binance.vision (REST)<br/>data-stream.binance.vision (WebSocket)"]
    data <--> binance

    mcp["sandchart-mcp<br/>stdio MCP server for AI agents"]
    mcp -- "same engine, same SQLite file" --> store
```

| Crate or folder | What it does |
| --- | --- |
| [`crates/core`](crates/core) | Shared types: instruments, candles, timeframes, and decimal strings parsed into integer ticks without floats. |
| [`crates/store`](crates/store) | The SQLite cache: instruments, candles per pair and timeframe, the start of each pair's history, and the watchlist. Migrations go up and down. |
| [`crates/data`](crates/data) | Data providers behind one `Provider` trait. Binance today: pair list, history pages, 24 h changes, and a live WebSocket stream that reconnects with backoff and an idle timeout. |
| [`crates/engine`](crates/engine) | The brain: serves charts from cache first, fetches only what is missing, keeps live subscriptions, backfills gaps after reconnects, and tracks the connection state. |
| [`crates/indicators`](crates/indicators) | The indicator host: runs WebAssembly indicators in a sandbox (no files, network, env or real clock) under memory and work limits, and checks what they declare and return. The five built-in indicators are compiled in. |
| [`crates/indicator-cli`](crates/indicator-cli) | The `sandchart-indicator` command for authors: `new`, `build` and `test`, using the same host as the app. |
| [`indicators`](indicators) | The indicator SDK (`sandchart-indicator`, with the contract `sdk/wit/indicator.wit`), the built-in indicators, and test modules for the host. A separate Cargo workspace that builds for WebAssembly. |
| [`app/src-tauri`](app/src-tauri) | The desktop shell: exposes the engine to the UI as typed commands and a live-event channel, with a strict content security policy and no file-system or shell access. |
| [`app/ui`](app/ui) | The interface: Canvas chart, search, watchlist, status bar and states. It runs in a normal browser against a built-in mock too, which is how the end-to-end tests work. |

### How candles get to the screen

```mermaid
sequenceDiagram
    participant UI
    participant Engine
    participant Cache as SQLite cache
    participant Binance

    UI->>Engine: open BTCUSDT, 1h
    Engine->>Cache: cached candles?
    Cache-->>Engine: what is stored
    alt cache is stale or empty
        Engine->>Binance: newest page (up to 1000 candles)
        Binance-->>Engine: candles
        Engine->>Cache: save
    end
    Engine-->>UI: page of candles
    UI->>Engine: subscribe to live updates
    loop every 1-2 s
        Binance-->>Engine: forming candle (WebSocket)
        Engine-->>UI: update the last candle
    end
    Note over Engine,Binance: closed candles are saved.<br/>After a dropped connection only the missed candles are fetched.
    UI->>Engine: scrolled to the left edge
    Engine->>Binance: one older page
    Engine->>Cache: save
    Engine-->>UI: older candles
```

Nothing is reloaded wholesale: a chart you have opened before comes straight from the cache, and the exchange only sees requests for candles the cache does not have.

## Roadmap

| Version | Focus |
| --- | --- |
| 0.1 | Live Binance charts, local cache, own renderer, search, watchlist, themes, unsigned builds |
| **0.2** (this release) | Indicators as sandboxed WebAssembly modules, with an SDK and a command to build and test them; one-button self-update |
| 0.3 | Drawing tools: trend lines, levels, zones, Fibonacci, long and short positions, a ruler, a brush and notes on bars |
| 0.4 | Replay: step through history candle by candle, paper trades with stop and take-profit, statistics in R, a shareable `.replay` file that gives anyone the same result |
| 0.5 | An MCP server so AI agents can read charts, build indicators and run replays; price alerts |
| 1.0 | Builds signed with OS code-signing certificates |

The order can change; the design decisions are recorded in [ADR 0001](docs/adr/0001-wasm-indicators-and-tauri.md).

## Install

Download the file for your system from the [Releases](../../releases) page:

| System | File |
| --- | --- |
| macOS, Apple silicon | `Sandchart_<version>_aarch64.dmg` |
| macOS, Intel | `Sandchart_<version>_x64.dmg` |
| Windows | `Sandchart_<version>_x64-setup.exe` |
| Linux | `.AppImage` or `.deb` |

The builds are not signed with an OS code-signing certificate yet, so the operating system will warn you the first time. Updates are signed with the project's own key (see [Updates](#updates)).

Version 0.2 migrates the local database (watchlist, cache, indicator settings). The data is kept, but 0.1 refuses to open the migrated database. Back up the file first if you may want to go back.

Version 0.1 cannot update itself. Install 0.2 by hand once; later versions update from inside the app.

### macOS

1. Open the `.dmg` and drag Sandchart to Applications. Run it from there, not from the disk image or Downloads (see [Updates](#updates)).
2. Try to open it once. macOS says it cannot verify the app.
3. Open System Settings, Privacy & Security, scroll to the message about Sandchart and click Open Anyway.

If you prefer a terminal, `xattr -dr com.apple.quarantine /Applications/Sandchart.app` removes the quarantine flag.

### Windows

Coming from 0.1? Uninstall it first (Settings → Apps → Sandchart), then run the setup. Your data is kept.

Run `Sandchart_<version>_x64-setup.exe`. It installs for your user only and does not ask for administrator rights. If SmartScreen shows "Windows protected your PC", click More info, then Run anyway.

### Linux

For the AppImage: `chmod +x Sandchart_*.AppImage`, then run it. For the `.deb`: `sudo apt install ./Sandchart_*.deb`.

## Updates

Sandchart can update itself. Ten seconds after it starts, and then once a day by the wall clock while it stays open, it asks GitHub for a small file (`latest.json`) that names the newest release. If there is a newer version, a banner appears in the status bar. Press **Update and restart**: the app downloads the update, checks its signature against the project's public key built into the app, installs it and restarts. An update with a bad signature is refused. **Later** hides the banner until the next start.

To check by hand, or to turn the automatic check off, click the version in the status bar: **Check for updates** and **Check automatically**. With the automatic check off, Sandchart makes no update request until you press **Check for updates**.

- **macOS:** run Sandchart from `/Applications`. A copy started from the disk image or straight from Downloads is run by macOS from a read-only path (App Translocation) and cannot replace itself. The banner then asks you to move the app to Applications first.
- **Windows:** the installer runs in passive mode (a progress window, no questions) and needs no administrator rights.
- **Linux:** the AppImage updates in the app. A `.deb` install does not: the banner shows the release page address, so install the new `.deb` yourself.
- A failed check at start is silent and tried again later. A failed manual check or download shows the error and a Retry button.

## Write your own indicators

Indicators are WebAssembly modules. The [guide](docs/indicators.md) shows how to write one in Rust, or how to hand the job to your coding agent. You need the `sandchart-indicator` command: download the archive for your system (`sandchart-indicator-<target>.tar.gz`, or `.zip` on Windows) from the [Releases](../../releases) page and put the binary on your `PATH`, or build it from a clone:

```sh
rustup target add wasm32-wasip2
git clone https://github.com/kennnyz/sandchart && cd sandchart
cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release
cargo install --path crates/indicator-cli
```

## Verify your download

Every release has a `SHA256SUMS` file and a build provenance attestation made by GitHub Actions.

Check the checksum (run in the folder with the downloads):

```sh
sha256sum --check --ignore-missing SHA256SUMS      # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS  # macOS
```

On Windows, compare `Get-FileHash .\Sandchart_<version>_x64-setup.exe` with the matching line in `SHA256SUMS`.

Check that the file was built by this repository's workflow, with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify Sandchart_<version>_aarch64.dmg --repo kennnyz/sandchart
```

## Build from source

You need Rust (stable, installed with [rustup](https://rustup.rs/)) with the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`), Node.js 22 and pnpm 10. On Linux also install the Tauri system packages:

```sh
sudo apt-get install -y build-essential libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release   # the built-in indicators, embedded in the app
pnpm --dir app/ui install --frozen-lockfile
pnpm --dir app/ui tauri build    # macOS and Linux shell; bundles land in target/release/bundle/
```

On Windows the `tauri` script in `app/ui/package.json` does not work in `cmd`; run the CLI from the `app` folder instead: `cd app` and `node ui/node_modules/@tauri-apps/cli/tauri.js build`.

The UI also runs in a normal browser against a built-in mock, without Rust: `pnpm --dir app/ui dev`.

Tests:

```sh
cargo test --workspace
pnpm --dir app/ui test
pnpm --dir app/ui exec playwright install chromium && pnpm --dir app/ui exec playwright test
```

Contributors and coding agents: see [AGENTS.md](AGENTS.md).

## Privacy and network

Sandchart holds no exchange API keys, has no accounts and sends no telemetry. The only outgoing connections are to these hosts:

- `data-api.binance.vision` (REST: instruments, candles, 24 h change)
- `data-stream.binance.vision` (WebSocket: live candles)
- `github.com` (the static update file `latest.json`, and the download link for an update, which redirects to the next host)
- `release-assets.githubusercontent.com` (the update file itself)

The update requests are plain downloads of public files. Nothing about you or your charts is sent. To stop the automatic check, click the version in the status bar and turn off **Check automatically**.

Alerts add no host: their live prices come from `data-stream.binance.vision` like the chart's, and their notifications are shown by your operating system, with no push service in between.

The MCP server (`sandchart-mcp`) adds no host either: it fetches candles from `data-api.binance.vision` like the app (the newest page on each call, older ones only when they are not cached) and refreshes the instrument list from there once per process. It opens no port and reads no file outside Sandchart's own folders except a `.replay` file you name. What your agent does with the answers is between you and the agent.

Your watchlist, drawings, alerts and cached candles stay in a local SQLite file in your user data folder.

## Third-party notices

Bundled fonts, under the SIL Open Font License 1.1 (licence texts in `app/ui/src/assets/fonts`):

- IBM Plex Sans
- IBM Plex Mono
- Space Grotesk

Rust dependencies under the MPL-2.0 (file-level copyleft, used unmodified, allowed as exceptions in `deny.toml`): `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext`. All of them come in through Tauri.

The WebAssembly runtime (wasmtime, cranelift and the WASI crates) is Apache-2.0 WITH LLVM-exception, which `deny.toml` allows for every crate.

Every other dependency must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib or Unicode-3.0; `cargo deny check` enforces this in CI. Interface icons are from [Lucide](https://lucide.dev) (ISC); the chart-tool icons in `app/ui/src/icons.tsx` are the project's own.

## Licence

Dual-licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT licence](LICENSE-MIT), at your option.
