# ADR 0004: Drawing tools

Date: 2026-11-28. Status: accepted.

## Context

Release 0.3 adds drawings on the chart: trend lines, horizontal levels, rectangles, Fibonacci retracements, long and short positions, a ruler, a brush and notes on bars. The same position tool and its outcome are reused by replay in 0.4, and the MCP server in 0.5 lets agents read and write drawings. The project's priorities are reliability first, then speed and low resource use, then minimalism. New tools must be addable without changing the chart core.

Before this release every pointer move redrew the whole frame (grid, candles, indicators) only to move the crosshair.

## Decision

1. **Drawings are data in Rust.** `sandchart_core::drawing` defines `Drawing` with a serde-tagged `DrawingBody` and validates every drawing (point counts, text length, tick range, style ranges). The store keeps them in table `drawings` (migration 0003), one row per drawing with the body as JSON. The engine and Tauri expose list, save and delete. The browser mock keeps them in memory.
2. **Anchors are time and price, never a bar index.** A point is `{ t: unix ms, p: price ticks }`. Bar indices shift whenever older candles are prepended; times do not. A drawing belongs to an instrument and shows on every timeframe. Time maps to x by binary search over the loaded bars with a fractional position inside a bar; outside the loaded bars it extrapolates by the timeframe step.
3. **The tick scale is stored with the drawing.** Each row records the instrument's `price_scale` at save time. When the instrument's scale later differs, the loader rescales the ticks.
4. **Two canvas layers.** The base layer draws grid, candles, indicators and drawings and is redrawn only when data, view, theme or drawings change. A transparent overlay on top draws the crosshair, its axis labels, hover and selection handles, the shape being placed or dragged, and the ruler. A pointer move redraws only the overlay.
5. **A tool registry.** Each tool is one module implementing one interface (how it is placed, how it paints, hit-testing, handles). The chart core has no per-tool branches. A new tool is one module, one `DrawingBody` variant and its validation.
6. **Position outcome is a pure Rust function.** `sandchart_core::position::resolve` takes side, entry, stop, take, an end time and candles in ticks and returns the outcome (open, take, stop) with the bar it happened on. A bar that touches both stop and take counts as stop and is flagged ambiguous. Bars are scanned from the bar after the entry bar. Replay in 0.4 uses the same function. The UI asks the engine for outcomes after a position is placed or moved, not on every drag frame.
7. **Saving happens on pointer up**, never per drag frame. Undo and redo are an in-memory history in the UI for the session.
8. **Colours are the eight indicator palette slots.** Position zones are grey; only the numbers (R, percentages) are coloured, in line with "colour only in numbers".

## Alternatives considered

- **localStorage in the UI.** Faster to build, but breaks the rule that data lives in Rust and blocks replay files and the MCP server.
- **Bar index anchors.** Simpler maths, wrong after every history page.
- **One canvas.** Less code; every mouse move keeps redrawing everything.
- **Outcome in TypeScript.** Instant during drags, but a second implementation that would drift from replay.
- **A switch over drawing kinds in the renderer.** Quicker for two tools; every later tool touches the core.

## Consequences

- A drawing made on 1h shows on 15m and 1d. A per-timeframe filter can be added later as one field.
- The crosshair code moved to the overlay layer; tests that read canvas pixels must look at both canvases.
- The schema goes to version 3. 0.2 refuses the newer file, as with every migration.
