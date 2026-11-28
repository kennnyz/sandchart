# AGENTS.md

Guide for coding agents and contributors. Read it before changing anything.

## What this is

Sandchart is a desktop chart app: a Rust core (candles, providers, SQLite cache) behind a Tauri 2 shell, with a React + TypeScript UI that draws the chart on its own Canvas. All data and logic live in Rust; the UI only draws. Outside Tauri the UI talks to a browser mock (`app/ui/src/backend/mock.ts`), which the Playwright tests use.

## Repo map

| Path | What |
| --- | --- |
| `crates/core` | Types shared by everything: `Candle`, `Instrument`, `Timeframe`, tick/price scaling. No I/O. `drawing.rs` holds the `Drawing` model and its validation, `position.rs` the outcome of a position (`resolve`), used by the engine and by replay. `replay.rs` simulates a replay session (`simulate`, `stats`) and reads and writes the `.replay` file (`ReplayFile`, `candle_hash`, limits). |
| `crates/store` | SQLite storage (rusqlite), versioned migrations in `crates/store/migrations`. |
| `crates/data` | The `Provider` trait and its implementations (`binance/`). Fixtures and wiremock tests in `crates/data/tests`. |
| `crates/engine` | `Engine`: caching, paging, live updates, connection state. Holds providers as `Arc<dyn Provider>`. `replay.rs` holds the one replay session (`replay_start`, `replay_step`, `replay_command`, `replay_state`, `replay_export`, `replay_file_name`, `replay_open`, `replay_exit`); while it is open, live events of its instrument are held back and indicators and position outcomes of its instrument and timeframe compute over its revealed bars only (`replay_bars`, a snapshot taken out of the lock). |
| `crates/indicators` | The indicator host: loads indicator WebAssembly modules (wasmtime), runs them in a sandbox under memory and fuel limits, checks `meta` and output, runs the repaint check. Embeds the built-in modules with `include_bytes!`. |
| `crates/indicator-cli` | The `sandchart-indicator` author tool (`new`, `build`, `test`) and its project template in `template/`. |
| `indicators/` | A separate Cargo workspace (own `Cargo.lock`) built for `wasm32-wasip2`: `sdk` (the published `sandchart-indicator` crate and the contract `sdk/wit/indicator.wit`), `builtin/*` (SMA, EMA, Bollinger, RSI, MACD), `testguests/*` (modules that misbehave on purpose, for host tests). |
| `app/src-tauri` | Tauri shell: commands and events over the engine. `tauri.conf.json` is here. |
| `app/ui` | React UI, own Canvas chart (`src/chart`), i18n (`src/i18n`), unit tests (vitest) and e2e (`e2e/`, Playwright). |
| `app/ui/src/chart/drawings` | Drawings on the chart: `registry.ts` (the `ToolDef` contract and `TOOLS`), one module per tool in `tools/`, `state.ts` (selection, placement, undo), `layer.ts` (painting on the base and overlay canvases, pointer input), `geometry.ts`, `magnet.ts`, `ruler.ts`, `keys.ts`. `src/state/drawings.ts` stores changes through the backend. User guide: `docs/drawings.md`. See ADR 0004. |
| `app/ui/src/state/replay.ts`, `app/ui/src/chart/replay.ts` | Replay in the UI: the controller (start, step, play timer, trade commands, save, open, keys) and the chart layer (trades painted with the position tool, draggable stop and take, the cut, the start picker). `ReplayBar.tsx` and `ReplayStats.tsx` in `src/components`; `backend/mockReplay.ts` is the TEST-ONLY copy of the simulation for the browser mock. User guide: `docs/replay.md`. See ADR 0005. |
| `crates/core/tests/fixtures/replay.json` | Hand-written replay cases (simulate, stats, files with their sha256) read by both `crates/core/tests/replay.rs` and `app/ui/src/backend/mockReplay.test.ts`, so the Rust simulation and the mock's copy cannot drift. Add a case there for every rule change, computed by hand, never with the code under test. |
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
cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release --locked
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

## Release

A release is a `vX.Y.Z` tag. The workflow `.github/workflows/release.yml` builds the four bundles, signs the updater files, writes `latest.json` and `SHA256SUMS`, and creates a **draft** release. See [ADR 0003](docs/adr/0003-self-update.md) for why.

- **Secrets.** `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are repository secrets set in the environment of the tauri-action step of the build job. That step runs `tauri build`, which would also run `beforeBuildCommand` (npm, Vite) with the secrets in its environment, so the release config clears `beforeBuildCommand`; the UI is built in an earlier step without them. The public key is in `plugins.updater.pubkey` in `app/src-tauri/tauri.conf.json`. The private key and its password live in the owner's password manager; never put them in the repo, a log or a chat.
- **`app/src-tauri/tauri.release.conf.json`** holds `bundle.createUpdaterArtifacts: true` and an empty `build.beforeBuildCommand`, and is passed with `--config` by the release workflow only. A local `tauri build` does not need the key.
- **`scripts/check-version.sh [expected]`** checks that the version is the same in the workspace `Cargo.toml`, `app/src-tauri/tauri.conf.json` and `app/ui/package.json`, and with an argument that it equals it. CI runs it without an argument, the release workflow with the tag minus `v`. Bump all three together.
- **`scripts/updater_manifest.py`** writes `latest.json` from the release files. It exits 1 and writes nothing unless all four platforms (`darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`) have exactly one file and a non-empty `.sig`. Tests: `python3 -m unittest discover -s scripts -p 'test_*.py'` (CI runs them).

Checklist:

1. Bump the version in the three files (`scripts/check-version.sh` must pass), on a branch, and merge the pull request.
2. Tag the merge commit `vX.Y.Z` and push the tag.
3. Wait for the workflow to finish. It leaves a draft release.
4. Open the draft and check that `latest.json` lists the four platforms, each with a `url` and a `signature`.
5. Publish it as the latest release, not as a pre-release. Installed apps see the update only after this step: `releases/latest` ignores drafts and pre-releases.

If the workflow fails, delete the tag and any draft release, fix the problem, and push the same tag again. Nothing was published. Optional check before tagging that the key and its password work: `echo test > /tmp/x && node app/ui/node_modules/@tauri-apps/cli/tauri.js signer sign -f <key file> -p <password> /tmp/x` (run it from `app/`, with the key kept outside the repo).

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

## Add a drawing tool

Read ADR 0004 and `docs/drawings.md` first. The chart core has no per-tool code: a tool is data in Rust plus one module in the UI.

1. Add a `DrawingBody` variant in `crates/core/src/drawing.rs` (serde `kind` in snake_case) and its rules in `validate`. Add a case per rule, with the whole message, to `crates/core/tests/fixtures/drawings_invalid.json`, and a valid one to `drawings_valid.json`. Prices are `i64` ticks inside `±(2^53 - 1)`; points are `Anchor { t, p }`, never bar indices.
2. Mirror the type in `app/ui/src/backend/types.ts` (`DrawingBody`) and the same rules in `mockValidateDrawing` in `app/ui/src/backend/mock.ts`, so the browser mock rejects what Rust rejects. `crates/core/tests/drawing.rs` and `mock.test.ts` both run the fixtures, so the two cannot drift.
3. Write `app/ui/src/chart/drawings/tools/<name>.ts` implementing `ToolDef` (placement, `create`, `timeSpan`, `layout`, `paint`, `hitTest`, `handles`, `moveBy`, `moveHandle`). Cache a `Path2D` in the geometry; put any text on a `pill` (`label.ts`). Icons come from Lucide.
4. Add it to `TOOLS` in `registry.ts`. Pick a free Alt shortcut (`code`, not R or M, which are the ruler and the magnet); `tools.test.ts` checks the shortcuts do not clash. If it has options, add them to `BodyOptions` in `app/ui/src/components/DrawingStyle.tsx`.
5. Add `tools.<name>` (and any other strings) to `en.json` and `ru.json`.
6. Tests: geometry and editing in `app/ui/src/chart/drawings/tools.test.ts`, an end-to-end placement and reload in `app/ui/e2e/drawings.spec.ts`, and a line for the tool in `docs/drawings.md`.

## Rules

- Commit messages: one short English line saying what was done. No prefix such as `feat:`, no emojis, no trailers.
- Prices and quantities are integers (`i64` ticks) in Rust, storage and IPC. Floats are only for pixel drawing in the UI and inside indicators (ADR 0002). Every tick value sent to the UI must fit in `±(2^53 - 1)`.
- Every new crate inherits `publish.workspace = true` (and the other `.workspace = true` package fields). `cargo deny` accepts path dependencies without versions (`allow-wildcard-paths`) only for unpublished crates.
- UI strings go through `t(key)`. Add every key to both `en.json` and `ru.json`; the i18n test checks parity.
- Allowed dependency licences: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0. A new exception in `deny.toml` needs a reason in a comment.
- Candles stay monochrome; colour only in numbers and in indicator series (8-slot palette). Icons come from Lucide only.
- No exchange API keys, no accounts, no telemetry. The only outgoing hosts are the ones in `README.md`. The update check is the only non-market request; its hosts are in the same list.
- GitHub Actions are pinned to a full commit SHA with the version in a comment.
- Do not copy code, icons or texts from other chart products.
