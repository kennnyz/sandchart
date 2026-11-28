# Replay

Replay walks through history bar by bar, as if it were live: you see a bar, decide, and only then see the next one. You can take paper trades along the way and get their results in R. A session saves to a `.replay` file that anyone can open and get exactly the same trades and numbers, offline. This page covers how to start, the controls, how trades are filled and measured, the file, and the limits.

- [Start a replay](#start-a-replay)
- [Controls](#controls)
- [Update interval and timeframes](#update-interval-and-timeframes)
- [Catching up](#catching-up)
- [Shortcuts](#shortcuts)
- [Trades](#trades)
- [Fills and R](#fills-and-r)
- [Results](#results)
- [The .replay file](#the-replay-file)
- [Sharing](#sharing)
- [Limits](#limits)

## Start a replay

1. Open the pair and timeframe you want to practise on.
2. Click **Replay** in the top bar. A bar under the chart says what to do next.
3. Pick the first bar:
   - **click a bar** on the chart: a line marks the bar under the mouse and dims everything after it. The start is picked when the button comes up; a press that moves 4 px or more pans the chart instead, and the wheel zooms, so you can look for the bar first; or
   - **type a start time**: a UTC date as `YYYY-MM-DD`, with a time `HH:MM` after it if you like (`2026-11-20 13:00`), then Enter or **Start**. The replay starts at the first bar at or after that time; a date alone means midnight UTC, so the first bar of that day. It reads the same in every language and on every system. The time can be anywhere in the history the chart has loaded (it says which span when it is outside); scroll left first to load older bars.

   Esc or the **X** at the right end puts it away without starting.

The chart then shows the bars up to the one you picked, with up to 500 bars of context before it, and nothing after it. A dashed line labelled **Replay** marks where the revealed bars end. Live updates for the pair stop while the replay is open, until it catches up with them (see [Catching up](#catching-up)).

The replay starts at a bar already in the local cache. A pair you just opened has its newest 1000 bars cached; older ones are cached as you scroll back to them. A bar that is still forming cannot be picked: a replay only ever shows closed bars.

No bar after the current one ever reaches the screen. The price scale, the crosshair, the indicators and the outcomes of your position drawings all see only the revealed bars: an SMA ends at the current bar, and a position drawn earlier shows as open until a revealed bar decides it. A drawing whose first point is at or after the end of the current step is hidden (neither drawn nor clickable) until a step reveals that time; on a higher timeframe this holds inside the forming bar too, so a point two hours into a 4h bar stays hidden until the replay has stepped past it. A horizontal line, which has no time, always shows. The watchlist shows a dash and **Replay** instead of the pair's live price and 24 h change until the replay catches up.

## Controls

The replay bar sits centred under the chart, with the results under it:

| Control | What it does |
| --- | --- |
| Select bar ▾ | Start again from another bar: **Pick a bar on the chart** or **Pick a date** (the start time field). With trades not saved yet it asks first, since a new start drops them (see below). The live chart comes back to pick on. |
| Play / Pause | Reveals one step after another at the chosen speed. |
| Step | Reveals the next step. |
| 1x 2x 3x 5x 10x | Speed of Play, in steps per second. |
| Update interval ▾ | The step: how much each Step reveals (see below). |
| Jump to real time | Steps to the newest closed bar at once; the replay then has caught up (see below). |
| Date and time | Where the replay stands: the close of the last revealed bar of the update interval, in UTC. |
| Buy | Opens a long at the close of the current step. |
| Sell | Opens a short at the close of the current step. |
| Close trade | Closes the open trade at the close of the current step. |
| Save | Saves the session as a `.replay` file. |
| Open | Opens a `.replay` file. |
| X | Ends the replay and goes back to the live chart; with trades not saved yet it asks first. |

The round **+** at the left edge of the crosshair's price label opens a menu there too: **Buy** (Shift+B) and **Sell** (Shift+S), the same as the buttons, at the close of the current step, not at the price you point at, and **Draw horizontal line at <price>**. It has no alert item, since a replay's prices are from the past. Buy and Sell are off while a trade is open and once the replay has caught up ("Real time reached").

A control that is off says why in its tooltip: Buy and Sell while a trade is open ("One trade at a time"), Close trade without one. The status at the right end of the bar ("End of data", "Real time reached", newer bars that failed to load, with the reason in the tooltip) has room of its own, so the bar never shifts when it appears.

Play stops by itself at the newest bar ("End of data"), when an action fails, and when the window is hidden or minimised. There is no step back: to try again, pick the same bar with **Select bar**.

Opening another pair ends the replay. Another timeframe does not (see below).

Select bar, X and opening another pair drop the replay's trades. When it has trades that are not in a file saved (or opened) as the replay stands now, a question opens over the bar first: **Cancel** keeps the replay (and the pair: the other one does not open), **Discard** goes on without saving, and **Save first** saves the file, then goes on; closing the save panel without saving keeps the replay. Esc answers Cancel.

## Update interval and timeframes

A replay steps one timeframe, its **update interval**: each step reveals one candle of it. It starts as the chart's timeframe. The dropdown offers the timeframes the chart can be built from: the chart's own and the lower ones whose bars line up with it (a 4h chart offers 1m, 3m, 5m, 15m, 30m, 1h, 2h and 4h; 5m is not offered while the replay steps 3m candles, since their bars do not line up). A higher one than the current interval is offered only where the replay stands on its boundary; otherwise it is greyed out with the time to step to first. The app's engine may still refuse one, for instance 1m over a span longer than 138 days; its message shows above the chart and the interval stays as it was.

Changing the interval keeps the trades and the point the replay has reached. The commands are played again on the new candles, so a result can change: a 1h candle that touched both the stop and the take counts as a stop, while its 15m candles may show which came first.

Switch the chart's timeframe at any time:

- **A higher timeframe** (4h while stepping 1h) shows bars built from the revealed candles. The last one is still forming and grows with each step, as a live bar does.
- **A lower timeframe** (15m while stepping 1h) changes the update interval to it first, then shows it.
- Trades and results stay either way. A timeframe the replay cannot build (3d, or 1w from 3d) is refused with a message and the chart stays where it was.

### Catching up

Steps do not stop at the bars that were cached when the replay began: when the last of them is revealed, the app loads the bars that have closed since (from the cache, else from the exchange). If they cannot be loaded (no connection, for instance), a notice says so in the replay bar; the replay stays where it is and the next step tries again. When no newer closed bar exists, the replay has **caught up with real time**, and the backtest ends there:

- the point it reached is kept as the catch-up time and does not move again; trades and results count the bars up to it only;
- a trade still open then is **not finished at real time**: it stays in the trades list with its R at that moment, and like an open trade it does not count in the results;
- Play, Step, Jump to real time, Buy, Sell and Close trade are off ("Real time reached"); Select bar, Save, Open and X still work;
- the chart shows live data again, for display only: new bars appear, but they move no trade; drawings after the catch-up time show again, and so does the pair's quote in the watchlist;
- **Save** writes the session up to the catch-up time, without live bars, so the file gives the same results anywhere. Opening it shows the same finished backtest.

Changing the timeframe or the update interval keeps a caught-up replay finished. An opened file never loads newer bars: it ends at its last bar.

## Shortcuts

| Keys | What |
| --- | --- |
| → | Step; held down, it steps as fast as the bars come |
| Space | Play or pause |
| Shift+B | Buy |
| Shift+S | Sell |
| Shift+C | Close the trade |
| Esc | Cancel picking a start, close a dropdown, or answer Cancel to the question before trades are dropped |

The replay keys never use Alt, so they do not clash with the drawing tools (Alt plus a letter). They do nothing while you type in a text field. Space on a control you reached with Tab presses that control instead.

## Trades

One trade can be open at a time; Buy and Sell are off while it is.

A new trade has its **stop 1.5 % away** from the entry and its **take at 2 R** (twice as far, on the other side). It is drawn like a position drawing: a grey zone for the risk, a grey zone for the reward, the stop and take as percentages of the entry, and the trade's R so far on the right. Next to the percentages the take and the stop show what a fill there would be in R, measured against the stop at entry like the results (see [Fills and R](#fills-and-r)): a stop widened from 1 % to 1.6 % below the entry shows −1.6R, and the take's R does not change when the stop moves.

Drag the round handle on the stop or the take to move it. The change is sent when you release the mouse and applies from the next bar. A level cannot be dragged across the current close: a long's stop stays below it and its take above it, a short's the other way round.

Closed trades stay on the chart as an entry dot and an exit dot joined by a dashed line, with the trade's R at the exit. A trade not finished at real time keeps its zone and R, without handles.

## Fills and R

- **Opening** fills at the close of the current bar.
- **Stop and take** are checked from the next bar on. A long is stopped when a bar's low reaches the stop and takes profit when a bar's high reaches the take; a short is the mirror image. The trade fills at the stop or take price, or at the bar's open when the bar opens beyond it (a gap): a long whose stop is at 90 and whose next bar opens at 85 fills at 85.
- **A bar that touches both the stop and the take counts as a stop**, marked "?" on the chart: one bar alone cannot say which came first. This is the same rule as for position drawings; replay on a lower timeframe to see the order.
- **Close trade** fills at the close of the current bar.
- An edit of the stop or take applies from the next bar.
- There are no fees and no slippage.

**R** (the R column of the results says so in its tooltip) is the result measured in units of the first risk: (exit − entry) / (entry − stop at entry). It is measured against the stop the trade was **opened** with, so moving the stop later does not change what 1 R is. A take at 2 R is +2.0R; a stop at the first stop is −1.0R (more when a gap opens through it); a stop moved to the entry closes at 0.0R.

## Results

The panel under the replay bar shows a row of numbers over the closed trades and, below it, every trade, newest first: its side, when it was entered and at what price, the stop at entry (1 R is the distance to it), when and at what price it was exited, how it ended (take, stop, closed, still open, not finished at real time) and its R. The times are when the fills happened, the close time of the bar each one filled on (a stop or take inside a bar shows that bar's close), in UTC to the minute; they read the same on every timeframe and update interval, though an exit can move when a finer interval shows the stop or take was hit earlier. The columns keep their widths, and the list scrolls. The panel stays folded to its row until the first trade; after that the arrow on **Results** folds and unfolds it, and the app remembers that. The numbers:

| | |
| --- | --- |
| Trades | Closed trades. |
| Win rate | Trades with R above 0, over all trades. |
| Total R | The sum of R. |
| Average R | Total R over the number of trades. |
| Profit factor | The sum of winning R over the sum of losing R; "—" while there is no losing trade. |
| Max drawdown | The deepest fall of the running total R below its highest point. |
| Losing streak | The longest run of losing trades in a row. |
| Open trade | The open trade's R marked to the current close. It does not count in the numbers above, nor does a trade not finished at real time. |

All results are worked out by the app's engine, from the bars and the commands you gave. Numbers are coloured only by their sign.

## The .replay file

**Save** asks where to put the file. It is plain JSON, one candle and one command per line, so two files compare well in a diff. It holds:

- the format version (2);
- the pair (source, symbol, base and quote asset, price and quantity decimals) and the base timeframe, the one the replay steps;
- the candles: the context before the start and every revealed bar, as whole numbers in the pair's tick and lot size. The app saves **no bar after the current one**;
- the start and the cut as times: the close time of the first replayed bar and of the current one;
- for a replay that caught up with real time, the catch-up time (`caughtUpAt`), which is the cut; such a file has no bar after it;
- every command you gave, in order, each with the time it was given (the close time of the then current bar): open (side, stop, take), edit (the new stop or take) and close;
- a SHA-256 hash of the candles. It covers the candles only, not the pair, the timeframe, the times or the commands.

Files saved by earlier versions (format 1, which counted bars by index) still open and give the same trades; saving one again writes format 2.

It holds no results. **Open** reads the file, checks its version, its limits, that every candle opens on its timeframe's grid (an hourly candle on the hour) and closes before 2^53 − 1 ms, and the hash of its candles, and plays the commands again to get the trades and statistics. A file that fails a check is refused, and the replay you had open stays as it was. A strip above the chart says what is wrong in plain words (not a Sandchart replay file, made by a newer Sandchart, or damaged or edited), with the exact reason in its tooltip; × closes it. An opened file switches the chart to its pair and timeframe, and since it has no bar after its current one, it cannot be stepped further.

## Sharing

Send the `.replay` file. Whoever opens it gets the same chart, the same trades and the same numbers, on any computer, without a network connection and without the pair being cached: the file carries its own candles. The hash catches a file whose candles were damaged or changed; an edited command or pair is not caught, since the hash covers the candles only. It is a check, not a signature, so it proves nothing about who made the file.

## Limits

- 3d is stepped only on its own: it is never built from lower bars, and no lower interval is offered on a 3d chart.
- A file holds at most 200 000 candles and 10 000 commands, and is at most 32 MiB.
- No step back, no fees, no slippage, one open trade at a time.
- A replay starts only at a cached, closed bar. It plays up to the newest closed bar, loading the ones that closed after it began, and the backtest ends there (see [Catching up](#catching-up)).
