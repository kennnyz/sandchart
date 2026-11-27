# ADR 0001: Tauri shell, own Canvas renderer, WASM indicators

Date: 2026-11-27. Status: accepted.

## Context

Sandchart is meant to be an open-source desktop chart app that is easy to read, easy to extend and safe to run other people's code in. Three early choices shape everything else: the application shell, the chart renderer, and how indicators are executed. A fourth, how timeframes are produced, affects the first release.

The constraints: no exchange keys and no accounts, so there is nothing to steal; the same results for everyone, so replay can be shared and checked; a small team (one author plus coding agents); Windows, macOS and Linux from the start.

## Decision

1. **Shell: Tauri 2 with a web UI.** The Rust core runs in the same process; the UI is TypeScript and React in the system WebView.
2. **Renderer: our own, on Canvas 2D, with no charting library.** Drawings and replay need direct control of the coordinate system. WebGL can come later for very large data sets.
3. **Indicators: WebAssembly modules run by wasmtime, planned for 0.2.** A module gets candles up to the cursor and returns lines, histograms and signals. It has no file, network or clock access, and has limits on memory, fuel and time. The built-in indicators use the same interface.
4. **Timeframes in 0.1: native, per timeframe.** Each timeframe is fetched from Binance and cached separately. Building higher timeframes from 1-minute candles (aggregation in the core) arrives in 0.3 together with replay, where it is required.
5. **Releases: unsigned for now.** 0.1 ships `.dmg`, `.msi`, `.AppImage` and `.deb` built in GitHub Actions, with `SHA256SUMS` and build provenance attestations. Signing and notarization come with 1.0.

## Alternatives considered

- **Pure Rust GUI (egui, iced, gpui).** One language, but menus, dialogs, text fields and drawing handles of the quality we want would take much longer, and an egui app looks like a developer tool.
- **Local server plus a browser tab.** The simplest to build, but it does not feel like an application and opens a port on localhost.
- **A charting library for the renderer.** Ready-made, but drawing tools would have to be bolted on from outside, and some libraries require attribution to a commercial product. Our own renderer is more work and is the core of the project.
- **Indicators as scripts (a Pine-like language or embedded JS/Lua).** Easier to write, but running untrusted code safely is much harder, and a new language needs its own documentation and tooling. WASM gives a real sandbox and lets authors use Rust or any language that compiles to it.
- **Aggregating timeframes in the core from the start.** A daily chart built from 1-minute history would mean downloading millions of candles before the first view, so 0.1 fetches natively.
- **Paid signing certificates now.** Money and setup for a project with no users yet. We accept the OS warnings and document them in the README.

## Consequences

- Two languages (Rust and TypeScript) and three different WebViews (WebKit, WebView2, WebKitGTK) must be tested; CI builds and tests on all three systems.
- We own the whole chart: axes, scaling, panning, crosshair, panes. It costs time and gives us full freedom.
- Indicators wait for 0.2 and the WASM host. Until then the chart shows candles and volume only.
- Switching timeframes is fast and cheap in 0.1, but the cache holds each timeframe separately, and candles of different timeframes may differ slightly until aggregation lands in 0.3.
- Users see OS warnings on first launch until releases are signed; the README explains how to open the app and how to verify downloads.
