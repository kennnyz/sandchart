# Drawing tools

Sandchart can draw on the chart: trend lines, horizontal levels, rectangles, Fibonacci retracements, long and short positions, a brush, notes on bars and a ruler. This page covers every tool, how to place and edit it, the shortcuts, and where drawings are kept.

- [The tools](#the-tools)
- [Placing and editing](#placing-and-editing)
- [Selecting several](#selecting-several)
- [Context menu](#context-menu)
- [Style, lock and delete](#style-lock-and-delete)
- [Shift, ⌘, magnet and ruler](#shift--magnet-and-ruler)
- [Hide and show](#hide-and-show)
- [Shortcuts](#shortcuts)
- [Where drawings are kept](#where-drawings-are-kept)
- [Position outcomes](#position-outcomes)

## The tools

The tools rail is on the left of the chart. Click a tool, or press its shortcut (Alt, ⌥ on macOS, plus a letter), then click on the chart. A tool is put down after one drawing, except the brush.

| Tool | Shortcut | How to place it |
| --- | --- | --- |
| Trend line | Alt+T | Click the two ends, or press on the first end, drag and release on the second. In the style popover it can extend to the left, to the right, or both. |
| Horizontal line | Alt+H | One click. It runs across the whole chart and its price is tagged on the price axis. |
| Rectangle | Alt+B | Click two opposite corners, or drag from one to the other. It can extend to the right edge. |
| Fibonacci retracement | Alt+F | Click where the move starts, then where it ends. Level 0 is at the end of the move, level 1 at its start. The levels are 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272 and 1.618, each labelled with its price; turn any of them off in the style popover. |
| Long position | Alt+L | One click at the entry. The stop starts 1.5 % below the entry, the take at 3 R above it, and the position runs for 20 bars. Drag the stop, take and end handles to change them. |
| Short position | Alt+S | The same, mirrored: the stop above the entry, the take below. |
| Brush | Alt+P | Press and draw. The stroke is simplified to at most 500 points when you release. The brush stays picked for the next stroke until Esc or another tool. |
| Note | Alt+N | Click a bar. A marker appears above the bar's high and an editor opens; write the text (up to 2000 bytes) and save with ⌘Enter (Ctrl+Enter). Hover the marker to read the first line. An empty text deletes the note. |
| Ruler | Alt+R | Not stored. See [Shift, magnet and ruler](#shift-magnet-and-ruler). |

A position's zones are grey; only its numbers are coloured: the take and stop distance in percent, the reward to risk (RR), and the outcome in R once there is one.

## Placing and editing

- **Select** a drawing by clicking it. Its handles show. A click on empty space deselects it.
- **Move** it by dragging its body. **Reshape** it by dragging a handle.
- **Handles**: a trend line has one on each end and one in the middle, which moves the whole line. A rectangle has one on each corner and one in the middle of each edge; an edge handle moves only that side. A Fibonacci retracement has its two ends, a position its stop, take, entry and end. A brush stroke shows a marker on each end while it is selected, but has no handles: it only moves. A horizontal line has one in the middle.
- **Delete** the selection with Delete or Backspace.
- **Esc** drops a half-placed drawing and the tool, closes a popover, and deselects.
- **Undo** with ⌘Z (Ctrl+Z), **redo** with ⇧⌘Z (Ctrl+Shift+Z). Every change counts: placing, moving, reshaping, deleting, and each change in the style popover. The history lasts for the session, up to 200 steps, and starts over when you open another pair.

Every change is saved when you release the mouse, not while you drag.

## Selecting several

- **⌘-drag** (Ctrl-drag on Windows and Linux) on empty chart space draws a selection box. Every drawing the box touches is added to the selection.
- **⌘-click** (Ctrl-click) a drawing to add it to the selection, or to take it out.
- **Drag** any of them to move them all together. Locked ones stay where they are.
- **Delete** or Backspace removes them all, and the [alerts](alerts.md) of the lines among them. Undo brings the drawings back, but not their alerts.
- A click without a drag on one of them selects only that one; a click on empty space deselects all.

Moving or deleting several is one step for undo, and one write: either all of them are saved or none is.

## Context menu

Right-click a drawing (or Ctrl-click it on macOS) to open its menu. When it is part of a selection, the menu acts on the whole selection; otherwise the drawing is selected alone first.

| Item | What |
| --- | --- |
| Lock / Unlock | Lock them, or unlock them when all are locked. |
| Hide | Hide them until you show them again (see [Hide and show](#hide-and-show)). |
| Remove (Delete) | Delete them. |
| Settings… (Enter) | The style popover, or the text editor of a note. Only for one drawing. |

Arrow keys move between the items, Enter picks one, Esc or a click outside closes the menu. Each item is one undo step. The web view's own menu never opens over the app; in a text field you still get the usual edit menu.

## Style, lock and delete

Double-click a drawing, or select it and press Enter, to open its style popover. (On a note this opens the text editor instead.) Every change applies at once and is one undo step.

- **Colour**: one of eight colours, the same palette the indicators use.
- **Width**: 1 to 4 px.
- **Dashed**: a dashed line instead of a solid one.
- **Options of the tool**: extend left and right on a trend line, extend right on a rectangle, the levels of a Fibonacci retracement (at least one stays on).
- **Alert** (horizontal and trend lines): set an alert on the line, crossing it either way, above or below; see [Alerts](alerts.md). The alert is not part of the undo history.
- **Locked**: a locked drawing can still be selected, styled and deleted, but not moved or reshaped. Use it for levels you do not want to nudge by accident.
- **Delete** removes the drawing, and its alert with it.

Tab moves between the controls and stays inside the popover; Esc or a click outside closes it.

## Shift, ⌘, magnet and ruler

**Shift** depends on what you are doing:

- With no tool picked, Shift+drag on empty space measures with the ruler.
- With a tool picked, or while dragging a handle, holding Shift puts the point at the price of the previous point: the line comes out horizontal.

**The magnet** (Alt+M, or the magnet button) snaps every placed or dragged point to the open, high, low or close of the nearest bar, within 8 px. The magnet setting is remembered between sessions.

**⌘ (Ctrl)** held while you place a point or drag a handle snaps it to the bar under the pointer, magnet on or off: to the nearest of its open, high, low and close (a body end or a wick end), from anywhere between its high and low and up to 40 px above or below them. Keep ⌘ held while you drag and the point jumps from bar to bar. ⌘ on a handle snaps it, also on a drawing that is not selected yet. ⌘ on empty space starts a [selection box](#selecting-several) instead; ⌘ on a drawing's body adds it to the selection.

**The ruler** measures from where you press to where you release: the price change, the change in percent, the number of bars and the time. Start it with Shift+drag on empty space, or press Alt+R and then drag (with any tool picked). It is not saved; the next press or Esc puts it away.

## Hide and show

The eye button at the bottom of the tools rail opens a menu:

- **Hide all drawings** hides every drawing, so you can look at the bare chart. They are not painted and cannot be clicked, dragged, deleted or undone until you pick **Show all drawings**. Picking a tool shows them again, so a new drawing is never placed unseen. This lasts for the session and changes nothing in storage.
- **Show hidden drawings (n)** shows again every drawing hidden one by one with **Hide** in the [context menu](#context-menu). Such a drawing stays hidden after a restart, until you show it here (or undo). It is not painted and cannot be clicked, but it is still saved, and a line keeps firing its [alert](alerts.md).

## Shortcuts

| Keys | What |
| --- | --- |
| Alt+T, H, B, F, L, S, P, N | Pick the trend line, horizontal line, rectangle, Fibonacci, long, short, brush or note tool (press again to put it down) |
| Alt+R | Arm the ruler for the next drag |
| Alt+M | Magnet on or off |
| ⌘ / Ctrl held | Snap the point to the bar under the pointer while placing or dragging a handle |
| ⌘-drag / Ctrl-drag on empty space | Selection box |
| ⌘-click / Ctrl-click | Add a drawing to the selection or take it out |
| Right click | Context menu of the drawing or the selection |
| Shift held | Horizontal point with a tool or a handle; ruler with no tool |
| Enter, double-click | Style popover, or the text editor of a note |
| Delete, Backspace | Delete the selection (every selected drawing) |
| ⌘Z / Ctrl+Z | Undo |
| ⇧⌘Z / Ctrl+Shift+Z | Redo |
| ⌘Enter / Ctrl+Enter | Save a note |
| Esc | Cancel, close, deselect |

Shortcuts follow the physical key, so they work on any keyboard layout. They do nothing while you type in a text field.

## Where drawings are kept

Drawings are saved in the same local SQLite file as the candle cache, in your user data folder. Nothing is sent anywhere.

- A drawing belongs to a pair (for example BTCUSDT on Binance) and shows on **every timeframe** of that pair: a level drawn on 1h is on 15m and 1d too.
- Points are kept as a time and a price, never as a bar number, so drawings stay where they are when older history loads.
- A pair holds at most 2000 drawings.
- A drawing that cannot be shown is left out but stays saved and still counts toward the 2000: one written by a newer Sandchart version with a kind this one does not know, or one whose prices no longer fit after the exchange changed the pair's tick size. A newer version (or the old tick size) shows it again.
- If a drawing cannot be saved, a warning strip appears above the chart and the chart reloads what is stored, so it never shows a drawing that is not saved. If the drawings cannot be loaded either, the strip says so and the chart shows none until a later change is stored or the pair is opened again.

## Position outcomes

Sandchart works out what happened to a long or short position from the cached candles of the timeframe on the chart:

- It looks at the bars **after** the bar that contains the entry, up to the bar that opens at the position's end. The entry bar itself is skipped.
- A long is stopped when a bar's low reaches the stop, and takes profit when a bar's high reaches the take. A short is the mirror image.
- The first bar that reaches either decides. **A bar that touches both the stop and the take counts as a stop** and is marked with "?", because the bar alone cannot say which came first.
- Until then the position is open.
- The result is shown in R: the reward to risk on a take, −1 R on a stop. A marker shows the bar where it ended.

The outcome is worked out again after you place or move a position, when another timeframe or older history loads, and when a new bar arrives. Because it uses the bars of the timeframe on screen, a higher timeframe can give a different answer: one daily bar may touch both levels that hourly bars reached one after the other.
