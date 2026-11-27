# ADR 0002: Indicator runtime

Date: 2026-11-28. Status: accepted.

## Context

ADR 0001 chose WebAssembly modules run by wasmtime for indicators. Release 0.2 builds that host (`crates/indicators`) and the contract it speaks (`indicators/sdk/wit/indicator.wit`). The host runs code written by strangers inside a desktop app that holds no secrets but does hold the user's files and network. Results must be the same on every machine, so that a chart, a screenshot or later a replay can be checked by someone else. Indicator authors are not WebAssembly experts: when a module is rejected, the message must say what to change.

The rest of the app keeps prices and quantities as `i64` ticks (core, store, IPC), and candles are drawn monochrome.

## Decision

1. **`f64` in price units inside indicators.** The host converts ticks to `tick / 10^price_scale` (volume `tick / 10^qty_scale`) before a call. Moving averages, deviations and oscillators are float maths; asking authors to do fixed-point arithmetic would make every indicator harder and slower to write. Ticks stay integers everywhere else. NaN means "no value at this bar"; the host turns `±inf` into NaN so the UI draws a gap.
2. **Colour from a palette slot, not from the module.** A series declares `color: u8` in `0..=7`; each theme maps the slots to colours. Modules cannot pick colours that clash with a theme or with the monochrome candles.
3. **A pure function over all cached history.** `compute(params, candles)` gets every cached candle of the instrument and timeframe (capped at the newest 100 000) and returns whole series, one value per bar. There is no state between calls: each call gets a fresh instance and store. A module may repaint (`test.repaints` returns the maximum of all closes on every bar); the host does not try to prevent it. Incremental (per-bar) APIs can come later without breaking this one.
4. **Fuel is the limit; the epoch is only a backstop.** Fuel counts executed instructions, so a module that fits the limit on one machine fits it on every machine. Per call: fuel `DEFAULT_FUEL`; 256 MiB of linear memory in total across all memories of the store; at most 32 instances, 4 memories, 16 tables of up to 100 000 elements and 10 000 WASI handles; and an epoch deadline of 100 ticks of 100 ms (10 s). Fuel and the epoch only act while wasm code runs; neither can stop a host call that blocks. So no host call may block: the monotonic clock is replaced by one whose subscriptions are ready at once (a `sleep` or a poll timeout returns immediately, since time does not pass in the sandbox), stdin is closed, and there are no files or sockets to wait on. The engine canonicalizes NaN and turns off relaxed SIMD and threads, so the same input gives the same bits and the same `fuel_used`.
5. **WASI 0.2 with stubs, nothing real.** Rust's `std` for `wasm32-wasip2` imports WASI, so the host links WASI 0.2 but gives it nothing: no args, env or preopened directories; TCP, UDP and name lookup off; wall and monotonic clocks fixed at 0; both random generators seeded with `0x5A4D_C4A7`. stdout and stderr go to one in-memory log that keeps the first 16 KiB and silently drops the rest, so logging never traps; it comes back as `Output::log`. Any import other than WASI 0.2 and the contract's own `types` interface is rejected as `ForbiddenImport`.
6. **A named, versioned interface export.** The world is `plugin { export indicator; }`, so a module exports `sandchart:indicator/indicator@0.1.0` rather than bare functions. The host checks the export at load time and rejects anything else as `WrongContract` with the version it found. A module built for `@0.2.0` is rejected. A module built for a newer patch, `@0.1.1`, loads on this `0.1.0` host: wasmtime matches the export name by semver compatibility (same `0.1` minor) and then type-checks it structurally, so a patch release of the contract may only clarify, never change a type.
7. **Compiled modules are cached on disk.** A compiled module is stored as `<sha256 of the module>-<engine hash>.cwasm` in the app's cache directory, written through a temp file and a rename, and pruned at startup to the modules that still exist and the current wasmtime build. Meta is checked on every load, cached or not.

## Alternatives considered

- **Integer ticks inside indicators.** Exact, but every indicator would need fixed-point maths and the scale of each instrument; mistakes would be overflows instead of rounding.
- **Colours chosen by the module (RGB).** Flexible, but modules would break themes and the monochrome candle rule.
- **Incremental compute (state kept between bars).** Faster on a live tick, but harder to write correctly, and a stateful module can drift from the same module run from scratch. The budget for a full recompute is 50 ms for the five built-ins on 100 000 bars.
- **Wall-clock time limits only.** Simple, but a module would pass on a fast machine and fail on a slow one. Fuel is deterministic; the epoch stays as a backstop.
- **No WASI at all (a bare `wasm32-unknown-unknown` core module).** Smallest attack surface, but authors lose `std` printing and formatting, and each language would need its own workaround. Stubbed WASI gives the same safety with a normal toolchain.
- **Bare exported functions instead of a named interface.** Less to type in WIT, but no version in the export name, so the host could not tell a module of another contract version from a broken one.

## Consequences

- Indicator values are rounded `f64`. They are for drawing and reading, not for accounting; anything exact stays in ticks.
- Clocks are 0 and random is seeded, so a module cannot read the time or produce different results per run. An author who needs time uses the candle `time` field.
- An endless loop costs at most one fuel budget per call; the app keeps running and the user sees "ran out of fuel".
- Patch versions of the contract must keep every type of `0.1.0`. A change of any type is a new minor version (`0.2.0`), which this host rejects until it learns it.
- The cache trusts files in the app's own cache directory (`Component::deserialize_file` runs their machine code). A tampered cache file is treated like a tampered app binary.
- `Apache-2.0 WITH LLVM-exception` (wasmtime, cranelift and the WASI crates) is on the global licence allow list in `deny.toml`.
