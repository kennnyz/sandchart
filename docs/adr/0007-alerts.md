# ADR 0007: Alerts

Date: 2026-11-28. Status: accepted.

## Context

Release 0.5 lets a trader be told when the price reaches a level: a price, a horizontal line or a trend line drawn on the chart. The app already streams live candles for the open chart (with a cap of 32 streams), stores drawings in SQLite (ADR 0004) and pauses live updates of a replayed pair (ADR 0005). The project's priorities are reliability first, then speed and low resource use, then minimalism. Nothing may leave the machine: no accounts, no push service, no email.

## Decision

1. **Kinds.** A price alert watches a fixed price; a line alert watches an `hline` or a `trend` drawing. A trend line's level at time t is linear interpolation in price ticks between its anchors, rounded half away from zero, and continues past an anchor only on the side its `extendLeft` / `extendRight` flag extends. Outside the line (or on a line whose anchors share a time) there is no level, and the alert cannot fire. No rectangle or Fibonacci alerts in 0.5.
2. **Directions and the firing rule.** `above`, `below` or `cross` (either). Between two consecutive updates of the same stream, `above` fires when the previous price was below the level and the price since then reached it: the close, a new high of the same bar, or the high of a new bar (so a bar that opens on the other side of the level, a gap, fires as well). `below` is the mirror image. The rule is a pure function, `sandchart_core::alert::fires`, with hand-written cases in `crates/core/tests/fixtures/alerts.json` that the browser mock's copy runs too. The fired price is the close when it is past the level, else the level itself (only a wick reached it).
3. **Fire once.** A fired alert turns inactive and keeps when and at what price it fired; re-arming is a deliberate action in the UI. An alert that fired while the window was not looked at stays highlighted until it is seen.
4. **Where they run: in the engine, on live candles, only while the app runs.** Every pair with an active alert gets a live stream. When the chart already streams that pair (any timeframe), its stream is shared; otherwise the engine opens its own 1-minute stream and closes it again when the chart takes over or the last active alert of the pair goes. Every stream counts toward the one cap of 32, now kept in the engine. At most 30 pairs may have active alerts, so the chart always finds a stream; at most 100 alerts are active at once. Arming past either limit is refused with an error that says which. When the feeding stream changes, the next comparison uses closes only, so the high of a longer bar from before cannot fire an alert. While a replay holds a pair back its alerts are not evaluated; after the replay the first update is compared with the last price before it.
5. **Storage.** Migration `0004_alerts`: id, source, symbol, price scale, kind, price ticks or drawing id, direction, active, created_at, triggered_at, triggered_price. Like drawings, prices are stored with the price scale they were made at and rescaled when the instrument's scale changes. Deleting a drawing deletes its alerts in the same transaction. A firing is written with `active = 1` as its condition, so a deleted or already fired alert never fires twice.
6. **Notification.** An OS notification sent from Rust through `tauri-plugin-notification`, plus an `alert-fired` event that the UI shows as a toast and in the alerts panel. The plugin's JavaScript API is not exposed: the window's capability stays as it was. Permission is asked when the first alert is created, not at startup. No sound in 0.5. Nothing leaves the machine.
7. **UI.** An "Alert" section in the style popover of an hline or trend line (direction, create or remove), Alt+A for a price alert at the crosshair price (direction `cross`), and a compact alerts panel under the watchlist: pair, level, direction, state, delete and re-arm.

## Alternatives considered

- **Evaluate in the UI.** The UI only sees the open chart's pair, and the result would depend on the window being drawn; Rust already owns the data.
- **One provider stream per alert.** Simpler bookkeeping, but 100 alerts would need 100 connections; one stream per pair is enough.
- **Closes only.** Simpler, but a wick through the level between two updates (Binance sends one every second or two) would be missed.
- **A background service that runs while the app is closed.** Needs an OS service per platform and a second process writing the database; out of scope for 0.5, and the docs say alerts run only while the app runs.
- **Ask for notification permission at startup.** Most users never set an alert; the prompt would be noise.

## Consequences

- A trader with alerts on many pairs keeps up to 30 extra WebSocket streams open while the app runs.
- A spike that starts and ends between two updates of a longer bar is still missed; the next update shows only its high or low if that bar's extreme changed.
- A trend line's level is evaluated at the time an update arrives; a wick earlier in the same interval is compared with the level at that later time, which differs only by the line's slope over a second or two.
- The schema goes to version 4. 0.4 refuses the newer file, as with every migration.
