# Alerts

An alert tells you when the price reaches a level: a price you pick, or a horizontal or trend line you drew. When it fires, Sandchart shows a notification of your operating system and a message at the top of the window, and marks the alert in the alerts panel. This page covers the kinds of alerts, how to set them, exactly when they fire, and the limits.

- [Kinds](#kinds)
- [Set an alert](#set-an-alert)
- [On the chart](#on-the-chart)
- [The alerts panel](#the-alerts-panel)
- [When an alert fires](#when-an-alert-fires)
- [Trend lines](#trend-lines)
- [Only while the app runs](#only-while-the-app-runs)
- [Limits](#limits)
- [Privacy](#privacy)

## Kinds

| Kind | Watches |
| --- | --- |
| Price alert | A fixed price of a pair. |
| Line alert | A horizontal line or a trend line on the chart. Move the line and the alert follows it. Delete the line and its alert is deleted too. |

Each alert has a direction:

| Direction | Fires when the price |
| --- | --- |
| Cross | moves through the level either way |
| Above | comes from below the level up to it or past it |
| Below | comes from above the level down to it or past it |

Rectangles, Fibonacci levels and the other drawings have no alerts.

## Set an alert

- **Price alert:** point at a price on the chart and press **Alt+A** (⌥A on a Mac). The alert is set at the price under the crosshair, direction Cross, on the pair the chart shows. Not during a [replay](replay.md): its prices are from the past.
- **Line alert:** double-click a horizontal or trend line (or select it and press Enter) to open its style. In the **Alert** row pick the direction and press **Set**. While it is set, the same row changes its direction (which arms it again) or **Remove**s it.

The first alert you create may make your operating system ask whether Sandchart may show notifications. Allow it to get notifications outside the window; the message in the window and the panel work either way.

## On the chart

Every active price alert of the pair on the chart shows as a thin dashed line at its price, with a bell tag and the price on the price axis. Click the line to pick the alert in the alerts panel. A fired alert has no line; a line alert is its own line. During a replay the levels are hidden.

## The alerts panel

The panel under the watchlist lists every alert, newest first: the pair, the direction, the level (or **Line**) and the state, **Active** or when and at what price it fired. A click on an alert opens its pair on the chart.

- An alert that fired is highlighted until you look at it: click it, or close its message.
- The arrow button arms a fired alert again. It then waits for the next time the price reaches the level.
- × deletes an alert.

The panel hides together with the watchlist.

## When an alert fires

Sandchart receives the price of every pair with an active alert about once a second. Between two updates it checks whether the price reached the level:

- the latest price is at or past the level, or
- the bar's high (or low) went past the level since the previous update: a short spike through the level fires even if the price is back on the other side when the update arrives, or
- a new bar opened on the other side of the level, for example after a gap or after the connection was down for a while.

The previous price must have been on the other side: an Above alert set while the price is already above the level waits until the price goes below it and comes back. The first update after an alert is set only records where the price is.

An alert fires once and then turns inactive. The message says the price when it fired: the latest price if it is past the level, or the level itself if only a wick reached it. Arm it again from the panel to wait for the next time.

While a pair is open in a [replay](replay.md), its alerts are not checked. When the replay ends, the first new price is compared with the last one before the replay, so a level crossed in the meantime fires then.

## Trend lines

A trend line's level at a moment is read off the line between its two points, in the pair's price steps. Past its points the line has a level only on the sides it is extended to (**Extend left**, **Extend right** in its style). A trend line that is not extended to the right stops having a level after its right point, so its alert can no longer fire there. The level is taken at the moment the update arrives; a spike earlier in the same second or two is compared with that level.

## Only while the app runs

Alerts are checked inside the app. **While Sandchart is closed nothing is checked and nothing fires.** When the app starts again, its alerts start again from the current price; a level crossed while it was closed does not fire. A computer that sleeps checks nothing until it wakes up; then the first new price is compared with the last one before, so a level crossed meanwhile fires then. Keep the app open (it can be in the background) to be alerted.

Alerts an AI agent sets or deletes through the [MCP server](mcp.md) follow the same rule: a running app arms or disarms them within a few seconds; while it is closed they wait for it.

## Limits

- At most **100 alerts active** at once and **500 alerts kept** in all. Delete fired alerts you no longer need.
- At most **30 pairs** with active alerts. Each such pair needs a live connection to the exchange; the pair on the chart shares the chart's connection.
- At most 32 live connections in all, the chart's included. An alert on a new pair is refused when all of them are in use.
- No sound in this version.

An alert that is refused shows the reason in a strip above the chart until you close it (×) or the next change of an alert succeeds.

## Privacy

Alerts stay in the local SQLite file with your drawings. The notification is shown by your own operating system; nothing is sent to a server, there is no account, and the live prices come from the same Binance host as the chart's (see [Privacy and network](../README.md#privacy-and-network)).
