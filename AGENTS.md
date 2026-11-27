# AGENTS.md

Guide for coding agents and contributors. Read it before changing anything.

## What this is

Sandchart is a desktop chart app: a Rust core (candles, providers, SQLite cache) behind a Tauri 2 shell, with a React + TypeScript UI that draws the chart on its own Canvas. All data and logic live in Rust; the UI only draws. Outside Tauri the UI talks to a browser mock (`app/ui/src/backend/mock.ts`), which the Playwright tests use.

## Repo map

| Path | What |
| --- | --- |
| `crates/core` | Types shared by everything: `Candle`, `Instrument`, `Timeframe`, tick/price scaling. No I/O. |
| `crates/store` | SQLite storage (rusqlite), versioned migrations in `crates/store/migrations`. |
| `crates/data` | The `Provider` trait and its implementations (`binance/`). Fixtures and wiremock tests in `crates/data/tests`. |
| `crates/engine` | `Engine`: caching, paging, live updates, connection state. Holds providers as `Arc<dyn Provider>`. |
| `crates/indicators` | The indicator host: loads indicator WebAssembly modules (wasmtime), runs them in a sandbox under memory and fuel limits, checks `meta` and output, runs the repaint check. Embeds the built-in modules with `include_bytes!`. |
| `crates/indicator-cli` | The `sandchart-indicator` author tool (`new`, `build`, `test`) and its project template in `template/`. |
| `indicators/` | A separate Cargo workspace (own `Cargo.lock`) built for `wasm32-wasip2`: `sdk` (the published `sandchart-indicator` crate and the contract `sdk/wit/indicator.wit`), `builtin/*` (SMA, EMA, Bollinger, RSI, MACD), `testguests/*` (modules that misbehave on purpose, for host tests). |
| `app/src-tauri` | Tauri shell: commands and events over the engine. `tauri.conf.json` is here. |
| `app/ui` | React UI, own Canvas chart (`src/chart`), i18n (`src/i18n`), unit tests (vitest) and e2e (`e2e/`, Playwright). |
| `deny.toml` | cargo-deny licence and ban policy. |
| `docs/adr` | Architecture decision records. |

## Commands

Run from the repo root. These are what CI runs.

```sh
# Rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
cargo deny check            # needs cargo-deny; CI runs it on Linux

# UI (install once: pnpm --dir app/ui install --frozen-lockfile)
pnpm --dir app/ui build                 # tsc --noEmit + vite build; also creates app/ui/dist
pnpm --dir app/ui exec tsc --noEmit
pnpm --dir app/ui test                  # vitest
pnpm --dir app/ui exec playwright install chromium
pnpm --dir app/ui exec playwright test  # e2e against the mock, serves on port 4173

# Indicators (own workspace; CI also runs these)
cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release
cargo fmt --check --manifest-path indicators/Cargo.toml
cargo clippy --manifest-path indicators/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path indicators/Cargo.toml
cargo test -p sandchart-indicator-cli -- --ignored   # new, build, test from the template; needs the network
cargo test --release -p sandchart-indicators --test builtins -- --ignored perf_   # timing budgets

# Desktop bundle (macOS/Linux shell). The bundle ends up in target/release/bundle/
pnpm --dir app/ui tauri build
```

`app/ui/dist` must exist before `cargo clippy` or `cargo test` build the Tauri crate, because `tauri::generate_context!` reads it. Run `pnpm --dir app/ui build` first on a fresh checkout.

The indicator wasm files must exist before any root `cargo build`, `clippy` or `test` too, because `crates/indicators` embeds the built-ins with `include_bytes!`. Build them first with the first command of the indicators block above (CI does, before clippy). `rustup target add wasm32-wasip2` once.

The Tauri CLI must run with `app/` as the current directory; the `tauri` script in `app/ui/package.json` does that with `cd ..` (POSIX only). Release CI and Windows use `node ui/node_modules/@tauri-apps/cli/tauri.js` from `app/`.

## Add a data provider

1. Create `crates/data/src/<name>/mod.rs` and implement `Provider` (see `crates/data/src/lib.rs`): `source()` returns the id used in `InstrumentId::source`; implement `instruments`, `history` and `live`; implement `day_changes` if the source has quotes. Re-export the type from `crates/data/src/lib.rs`.
2. Convert prices and volumes to integer ticks with `parse_scaled` and the instrument's `price_scale` / `qty_scale`. Never go through `f64`. Reject values outside `±(2^53 - 1)` with an error.
3. Register it: add the provider to the `Vec<Arc<dyn Provider>>` passed to `Engine::open` in `app/src-tauri/src/main.rs`.
4. Add the display name as `source.<id>` to `app/ui/src/i18n/en.json` and `ru.json`.
5. Tests, the same way as `crates/data/tests/binance_rest.rs` and `binance_ws.rs`: recorded fixtures in `crates/data/tests/fixtures/`, a wiremock server for REST, a local WebSocket server for live data. No test may touch the real network.
6. List every new outgoing host in the "Privacy and network" section of `README.md`.

## Add a built-in indicator

The user-facing guide for writing indicators is `docs/indicators.md`; read it first. A built-in is the same kind of module, compiled into the app.

1. Copy `indicators/builtin/bollinger` to `indicators/builtin/<name>`. In its `Cargo.toml` set `name = "builtin-<name>"`. The workspace picks up `builtin/*` on its own. Set the module id to `builtin.<name>` (the `builtin.` prefix is reserved for the app) and keep `version` equal to the one the other built-ins use; `builtin_ids_and_versions` in `crates/indicators/tests/builtins.rs` asserts it.
2. Use `sandchart_indicator::ta` for the maths. The module must not repaint and must give `NaN` before its first full window.
3. Register it in `crates/indicators/src/builtins.rs`: add `builtin!("builtin.<name>", "builtin_<name>.wasm")` to `BUILTINS` and raise the array length. The file name is the package name with `-` turned into `_`.
4. Add reference values: extend `crates/indicators/tests/fixtures/make_reference.py` with an independent implementation from the textbook definition (standard library only), run it to update `reference.csv`, and add a `<name>_matches_reference` test to `crates/indicators/tests/builtins.rs`. Do not generate the expected numbers with the Rust code under test.
5. Add the same indicator to `MOCK_BUILTINS` in `app/ui/src/backend/mock.ts`, so the browser mock and the Playwright tests list and draw it.
6. Run the indicators block under "Commands", then the root Rust checks. The five built-ins together must stay inside the timing budgets (50 ms on 100 000 bars); the `perf_` tests check it.
7. If the module needs a new `ta` helper, add it to `indicators/sdk/src/ta.rs` with unit tests. That crate is published to users, so keep the helpers small and stable. Do not change a type in `indicator.wit` without a new contract version (see ADR 0002).

## Rules

- Commit messages: one short English line saying what was done. No prefix such as `feat:`, no emojis, no trailers.
- Prices and quantities are integers (`i64` ticks) in Rust, storage and IPC. Floats are only for pixel drawing in the UI and inside indicators (ADR 0002). Every tick value sent to the UI must fit in `±(2^53 - 1)`.
- Every new crate inherits `publish.workspace = true` (and the other `.workspace = true` package fields). `cargo deny` accepts path dependencies without versions (`allow-wildcard-paths`) only for unpublished crates.
- UI strings go through `t(key)`. Add every key to both `en.json` and `ru.json`; the i18n test checks parity.
- Allowed dependency licences: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0. A new exception in `deny.toml` needs a reason in a comment.
- Candles stay monochrome; colour only in numbers and in indicator series (8-slot palette). Icons come from Lucide only.
- No exchange API keys, no accounts, no telemetry. The only outgoing hosts are the ones in `README.md`.
- GitHub Actions are pinned to a full commit SHA with the version in a comment.
- Do not copy code, icons or texts from other chart products.
