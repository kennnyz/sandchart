# Sandchart

Sandchart is an open-source desktop chart app: fast candlestick charts for Binance spot markets, with no account, no subscription and no telemetry. It is a small, hackable alternative to the big charting websites for people who just want to look at a chart.

![Sandchart showing a BTCUSDT 1h chart with the watchlist](docs/screenshot.png)

The screenshot uses sample data from the built-in mock, not real market prices.

## Features in 0.1

- Candlestick chart with volume, drawn by our own Canvas renderer: pan and zoom with mouse or trackpad, crosshair with an OHLC legend, auto scale and logarithmic scale.
- Timeframes 1m to 1W, each one fetched natively from Binance and cached locally. Building higher timeframes from 1-minute candles arrives with replay in 0.3.
- Live updates of the last candle over WebSocket, with a connection indicator and automatic reconnects.
- Search over all Binance spot pairs (Cmd/Ctrl+K) and a drag-to-reorder watchlist with last price and 24 h change.
- Candles are monochrome; colour appears only in numbers. Dark and light themes.
- English and Russian interface.
- Candles are stored in a local SQLite file, so charts open instantly and work from cache when offline.
- Builds for macOS (Apple silicon and Intel), Windows and Linux.

Not in 0.1: indicators, drawing tools, alerts, replay, AI-agent tools. They are planned; see [ADR 0001](docs/adr/0001-wasm-indicators-and-tauri.md).

## Install

Download the file for your system from the [Releases](../../releases) page:

| System | File |
| --- | --- |
| macOS, Apple silicon | `Sandchart_<version>_aarch64.dmg` |
| macOS, Intel | `Sandchart_<version>_x64.dmg` |
| Windows | `Sandchart_<version>_x64_en-US.msi` |
| Linux | `.AppImage` or `.deb` |

The builds are not signed yet, so the operating system will warn you the first time.

### macOS

1. Open the `.dmg` and drag Sandchart to Applications.
2. Try to open it once. macOS says it cannot verify the app.
3. Open System Settings, Privacy & Security, scroll to the message about Sandchart and click Open Anyway.

If you prefer a terminal, `xattr -dr com.apple.quarantine /Applications/Sandchart.app` removes the quarantine flag.

### Windows

Run the `.msi`. If SmartScreen shows "Windows protected your PC", click More info, then Run anyway.

### Linux

For the AppImage: `chmod +x Sandchart_*.AppImage`, then run it. For the `.deb`: `sudo apt install ./Sandchart_*.deb`.

## Verify your download

Every release has a `SHA256SUMS` file and a build provenance attestation made by GitHub Actions.

Check the checksum (run in the folder with the downloads):

```sh
sha256sum --check --ignore-missing SHA256SUMS      # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS  # macOS
```

On Windows, compare `Get-FileHash .\Sandchart_<version>_x64_en-US.msi` with the matching line in `SHA256SUMS`.

Check that the file was built by this repository's workflow, with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify Sandchart_<version>_aarch64.dmg --repo <owner>/sandchart
```

## Build from source

You need Rust (stable, installed with [rustup](https://rustup.rs/)), Node.js 22 and pnpm 10. On Linux also install the Tauri system packages:

```sh
sudo apt-get install -y build-essential libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
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

Sandchart holds no exchange API keys, has no accounts and sends no telemetry. The only outgoing connections are to the public Binance market-data hosts:

- `data-api.binance.vision` (REST: instruments, candles, 24 h change)
- `data-stream.binance.vision` (WebSocket: live candles)

Your watchlist and cached candles stay in a local SQLite file in your user data folder.

## Third-party notices

Bundled fonts, under the SIL Open Font License 1.1 (licence texts in `app/ui/src/assets/fonts`):

- IBM Plex Sans
- IBM Plex Mono
- Space Grotesk

Rust dependencies under the MPL-2.0 (file-level copyleft, used unmodified, allowed as exceptions in `deny.toml`): `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext`. All of them come in through Tauri.

`target-lexicon` is Apache-2.0 WITH LLVM-exception.

Every other dependency must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib or Unicode-3.0; `cargo deny check` enforces this in CI. Icons are from [Lucide](https://lucide.dev) (ISC).

## Licence

Dual-licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT licence](LICENSE-MIT), at your option.
