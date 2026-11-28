# Replay

Replay walks through history bar by bar, as if it were live: you see a bar, decide, and only then see the next one. You can take paper trades along the way and get their results in R. A session saves to a `.replay` file that anyone can open and get exactly the same trades and numbers, offline. This page covers how to start, the controls, how trades are filled and measured, the file, and the limits.

- [Start a replay](#start-a-replay)
- [Controls](#controls)
- [Shortcuts](#shortcuts)
- [Trades](#trades)
- [Fills and R](#fills-and-r)
- [Results](#results)
- [The .replay file](#the-replay-file)
- [Sharing](#sharing)
- [Limits](#limits)

## Start a replay

1. Open the pair and timeframe you want to practise on.
2. Click **Replay** in the top bar. A strip under the chart says what to do next.
3. Pick the first bar:
   - **click a bar** on the chart: a line marks the bar under the mouse and dims everything after it; or
   - **pick a date**: the replay starts at the first bar of that day (UTC). The date can be anywhere in the history the chart has loaded; scroll left first to load older bars.

   Esc or **Cancel** puts it away without starting.

The chart then shows the bars up to the one you picked, with up to 500 bars of context before it, and nothing after it. A dashed line labelled **Replay** marks where the revealed bars end. Live updates for the pair stop while the replay is open.

Only bars already in the local cache can be replayed. A pair you just opened has its newest 1000 bars cached; older ones are cached as you scroll back to them.

No bar after the current one ever reaches the screen. The price scale, the crosshair, the indicators and the outcomes of your position drawings all see only the revealed bars: an SMA ends at the current bar, and a position drawn earlier shows as open until a revealed bar decides it. A drawing whose first point is after the current bar is hidden (neither drawn nor clickable) until a step reveals that bar; a horizontal line, which has no time, always shows.

## Controls

The controls bar is under the chart:

| Control | What it does |
| --- | --- |
| Step | Reveals the next bar. |
| Play / Pause | Reveals bars one after another at the chosen speed. |
| 1× 2× 5× 10× | Speed of Play, in bars per second. |
| Buy | Opens a long at the close of the current bar. |
| Sell | Opens a short at the close of the current bar. |
| Close trade | Closes the open trade at the close of the current bar. |
| Save | Saves the session as a `.replay` file. |
| Open | Opens a `.replay` file. |
| Exit replay | Ends the replay and goes back to the live chart. |

Play stops by itself at the last cached bar ("End of data"), when an action fails, and when the window is hidden or minimised. There is no step back: to try again, start a new replay at the same bar.

Opening another pair or timeframe ends the replay too.

## Shortcuts

| Keys | What |
| --- | --- |
| → | Step; held down, it steps as fast as the bars come |
| Space | Play or pause |
| Shift+B | Buy |
| Shift+S | Sell |
| Shift+C | Close the trade |
| Esc | Cancel picking a start |

The replay keys never use Alt, so they do not clash with the drawing tools (Alt plus a letter). They do nothing while you type in a text field. Space on a control you reached with Tab presses that control instead.

## Trades

One trade can be open at a time; Buy and Sell are off while it is.

A new trade has its **stop 1.5 % away** from the entry and its **take at 2 R** (twice as far, on the other side). It is drawn like a position drawing: a grey zone for the risk, a grey zone for the reward, the stop and take as percentages and the reward to risk, and the trade's R so far on the right.

Drag the round handle on the stop or the take to move it. The change is sent when you release the mouse and applies from the next bar. A level cannot be dragged across the current close: a long's stop stays below it and its take above it, a short's the other way round.

Closed trades stay on the chart as an entry dot and an exit dot joined by a dashed line, with the trade's R at the exit.

## Fills and R

- **Opening** fills at the close of the current bar.
- **Stop and take** are checked from the next bar on. A long is stopped when a bar's low reaches the stop and takes profit when a bar's high reaches the take; a short is the mirror image. The trade fills at the stop or take price, or at the bar's open when the bar opens beyond it (a gap): a long whose stop is at 90 and whose next bar opens at 85 fills at 85.
- **A bar that touches both the stop and the take counts as a stop**, marked "?" on the chart: one bar alone cannot say which came first. This is the same rule as for position drawings; replay on a lower timeframe to see the order.
- **Close trade** fills at the close of the current bar.
- An edit of the stop or take applies from the next bar.
- There are no fees and no slippage.

**R** is the result measured in units of the first risk: (exit − entry) / (entry − stop at entry). It is measured against the stop the trade was **opened** with, so moving the stop later does not change what 1 R is. A take at 2 R is +2.0R; a stop at the first stop is −1.0R (more when a gap opens through it); a stop moved to the entry closes at 0.0R.

## Results

The panel on the right shows, over the closed trades:

| | |
| --- | --- |
| Trades | Closed trades. |
| Win rate | Trades with R above 0, over all trades. |
| Total R | The sum of R. |
| Average R | Total R over the number of trades. |
| Profit factor | The sum of winning R over the sum of losing R; "—" while there is no losing trade. |
| Max drawdown | The deepest fall of the running total R below its highest point. |
| Losing streak | The longest run of losing trades in a row. |
| Open trade | The open trade's R marked to the current close. It does not count in the numbers above. |

All results are worked out by the app's engine, from the bars and the commands you gave. Numbers are coloured only by their sign.

## The .replay file

**Save** asks where to put the file. It is plain JSON, one candle and one command per line, so two files compare well in a diff. It holds:

- the format version (1);
- the pair (source, symbol, base and quote asset, price and quantity decimals) and the timeframe;
- the candles: the context before the start and every revealed bar, as whole numbers in the pair's tick and lot size, and **no bar after the current one**;
- the index of the first replayed bar and of the current bar;
- every command you gave, in order: open (side, bar, stop, take), edit (bar and the new stop or take) and close (bar);
- a SHA-256 hash of the candles. It covers the candles only, not the pair, the timeframe, the indices or the commands.

It holds no results. **Open** reads the file, checks its version, its limits and the hash of its candles, and plays the commands again to get the trades and statistics. A file that fails a check is refused with the reason, and the replay you had open stays as it was. An opened file switches the chart to its pair and timeframe, and since it has no bar after its current one, it cannot be stepped further.

## Sharing

Send the `.replay` file. Whoever opens it gets the same chart, the same trades and the same numbers, on any computer, without a network connection and without the pair being cached: the file carries its own candles. The hash catches a file whose candles were damaged or changed; an edited command or pair is not caught, since the hash covers the candles only. It is a check, not a signature, so it proves nothing about who made the file.

## Limits

- A replay steps the chart's own timeframe; there is no aggregation from smaller bars.
- A file holds at most 200 000 candles and 10 000 commands, and is at most 32 MiB.
- No step back, no fees, no slippage, one open trade at a time.
- A replay starts only at a cached bar, and plays up to the newest bar that was cached when it started.
