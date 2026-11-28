import type { Anchor, Drawing, DrawingBody, DrawingStyle, PositionOutcome } from "../../backend/types";
import { chartDebug } from "../debug";
import type { ChartTheme } from "../theme";
import type { Coords } from "./geometry";
import { snapToBar } from "./magnet";
import { toolById, toolFor, type Box, type Look, type Mover, type Point, type ToolDef, type ToolId } from "./registry";
import { paintRuler } from "./ruler";
import { DEFAULT_STYLE, DrawingState, type DrawingChange, type DrawingPatch, type Owner, type Part } from "./state";

/** Distance in CSS px within which the pointer hits a drawing or a handle. */
export const HIT_TOLERANCE = 6;
const HANDLE_RADIUS = 4.5;
/** The ⌘ snap preview ring, a little larger than a handle so it reads around one. */
const SNAP_RING_RADIUS = 6;
/** A press must move this far (CSS px) to count as a drag. */
const DRAG_THRESHOLD = 3;
/** Halo of a hovered drawing: this much wider than its line, at this opacity. */
const HALO_EXTRA = 6;
const HALO_ALPHA = 0.25;
const DASH = [6, 4];
const NO_DASH: number[] = [];

const earliest = new WeakMap<DrawingBody, number>();

/**
 * The earliest anchor time of a drawing: every `t` in its body (anchors, a point list, a note),
 * found without per-tool code; -Infinity for one without a time (a horizontal line). Kept per
 * body object, since hit-testing asks on every pointer move.
 */
export function earliestTime(body: DrawingBody): number {
  const hit = earliest.get(body);
  if (hit !== undefined) return hit;
  let lo = Infinity;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) visit(x);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === "t" && typeof x === "number") lo = Math.min(lo, x);
        else visit(x);
      }
    }
  };
  visit(body);
  const t = lo === Infinity ? -Infinity : lo;
  earliest.set(body, t);
  return t;
}

/**
 * `ruler` arms the ruler for the next drag, whatever the tool (pressed again, disarms it);
 * `edit` opens the text editor of the selected drawing when it holds text, else its style popover.
 */
export type DrawingCommand = "undo" | "redo" | "delete" | "cancel" | "ruler" | "edit";

/** The text editor of a drawing is open: its text, and where to show it (CSS px of the price plot). */
export interface TextEdit {
  id: string;
  text: string;
  /** A new drawing: nothing is stored until it is saved with text. */
  isNew: boolean;
  x: number;
  y: number;
}

/** How the text editor was closed: saved with this text, deleted, or cancelled (null). */
export type TextResult = { text: string } | { delete: true } | null;

/** The style popover of a drawing is open: the drawing as it is now, and where (CSS px of the price plot). */
export interface StyleEdit {
  drawing: Drawing;
  x: number;
  y: number;
}

/** What the style popover does: changes the drawing (it stays open), deletes it, or closes (null). */
export type StyleAction = { patch: DrawingPatch } | { delete: true } | null;

/** The context menu of the selection is open: what it acts on, and where (CSS px of the price plot). */
export interface MenuEdit {
  ids: string[];
  /** Every one of them is locked: the menu offers Unlock instead of Lock. */
  locked: boolean;
  /** Settings… needs exactly one drawing. */
  single: boolean;
  x: number;
  y: number;
}

/** A context menu item, or close it (null). */
export type MenuAction = "lock" | "unlock" | "hide" | "remove" | "settings" | null;

/** What the layer needs from the chart. */
export interface LayerHost {
  /** Redraw both canvas layers. */
  invalidate(): void;
  invalidateOverlay(): void;
  /** One user action's changes, to store as one write. */
  commit(step: DrawingChange[]): void;
  tool(id: ToolId | null): void;
  /** Open (or move) the text editor, or close it with null. */
  text(edit: TextEdit | null): void;
  /** Open or refresh the style popover, or close it with null. */
  style(edit: StyleEdit | null): void;
  /** Open the context menu of the selection, or close it with null. */
  menu(edit: MenuEdit | null): void;
}

/** Draws a price tag on the axis of the given canvas: price in ticks, background colour. */
export type TagFn = (price: number, color: string) => void;

interface CacheEntry {
  drawing: Drawing;
  coords: Coords;
  geom: unknown;
  handles: Point[] | null;
  /** `ToolDef.markers` of the geometry, listed once like the handles. */
  markers: Point[] | null;
  live: boolean;
}

/** A drawing being dragged: its body at the press, and the body it would get. */
interface Dragged {
  id: string;
  body0: DrawingBody;
  body: DrawingBody;
}

/**
 * A press on a drawing: what is dragged and from where. A handle (`part` a number) reshapes
 * the one drawing in `items`; the body moves every item (the unlocked part of the selection).
 */
interface Edit {
  /** The drawing pressed. */
  id: string;
  part: Part;
  x0: number;
  y0: number;
  items: Dragged[];
  /** The ids of `items`: painting asks per drawing on every frame of the drag. */
  ids: Set<string>;
  moved: boolean;
}

/**
 * Drawings on the chart: paints them (stored ones on the base layer, hover, handles and
 * whatever is being placed or dragged on the overlay) and turns pointer input into
 * placement, selection and edits. Generic over the tool registry: no per-kind code.
 * Pointer coordinates are CSS px of the price plot; the chart calls in only for it.
 */
export class DrawingLayer {
  readonly state: DrawingState;
  /** Mapping of the last base frame; null until the first one with bars. */
  private coords: Coords | null = null;
  /** Times a drawing must reach into to be painted and hit: the plot's, with a margin. */
  private span: [number, number] = [0, 0];
  /**
   * Screen geometry and handles per drawing id, for that drawing object, kept while frames
   * map anchors alike (`Coords.sameLayout`): a live tick does not lay everything out again.
   * `live`: the layout read the last bar's prices, so it is redone when they change.
   */
  private readonly cache = new Map<string, CacheEntry>();
  private edit: Edit | null = null;
  /** Where the press that placed a point started (a press, drag and release places two). */
  private press: Point | null = null;
  /** Last pointer position added to a stroke. */
  private strokeAt: Point | null = null;
  /** `cmd`: ⌘ or Ctrl held, a placed or dragged point snaps strongly to the bar under it. */
  private mouse: { x: number; y: number; shift: boolean; cmd: boolean } | null = null;
  /** The ⌘-drag selection box: where it started and where the pointer is. */
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private magnet = false;
  /** The ruler on the overlay: `live` while its drag lasts, then shown until the next press or Esc. */
  private ruler: { a: Anchor; b: Anchor; live: boolean } | null = null;
  private rulerArmed = false;
  /** Engine outcomes of positions by drawing id. */
  private outcomes: ReadonlyMap<string, PositionOutcome> = new Map();
  /** The drawing whose text editor is open. */
  private textEdit: { id: string; isNew: boolean } | null = null;
  /** The drawing whose style popover is open, and where it opened. */
  private styleEdit: { id: string; at: Point } | null = null;
  /** The drawings the context menu acts on, and where it opened. */
  private menuEdit: { ids: string[]; at: Point } | null = null;
  /** Hide all: nothing is painted or hit; the drawings themselves are unchanged. */
  private hiddenAll = false;
  /** In a replay, the open time of the last revealed bar: a drawing anchored only later is not shown. */
  private cutoff: number | null = null;

  constructor(private readonly host: LayerHost) {
    this.state = new DrawingState({
      commit: (step) => {
        host.commit(step);
        this.syncStyle();
      },
      tool: (k) => host.tool(k),
    });
  }

  // ---- Commands from the chart's owner ----

  setDrawings(list: Drawing[]): void {
    this.edit = null;
    this.press = null;
    this.ruler = null;
    this.box = null;
    this.closeText();
    this.closeStyle();
    this.closeMenu();
    this.state.reset(list);
    this.cache.clear();
    this.host.invalidate();
  }

  setOwner(owner: Owner | null): void {
    this.state.setOwner(owner);
  }

  setTool(id: ToolId | null): void {
    this.abort();
    this.finishText(null);
    this.closeStyle();
    this.closeMenu();
    this.state.setTool(id);
    this.host.invalidateOverlay();
  }

  /** The engine stored `sent` as `saved` (another price scale): show and keep that copy. */
  stored(sent: Drawing, saved: Drawing): void {
    if (!this.state.stored(sent, saved)) return;
    this.syncStyle();
    this.host.invalidate();
  }

  /** Engine outcomes of the positions, painted with them; a position without one shows none. */
  setOutcomes(outcomes: ReadonlyMap<string, PositionOutcome>): void {
    this.outcomes = outcomes;
    this.cache.clear();
    const debug = chartDebug();
    if (debug) {
      debug.outcomes = {};
      for (const [id, o] of outcomes) debug.outcomes[id] = o.status + (o.ambiguous ? "?" : "");
    }
    this.host.invalidate();
  }

  /** Closes the text editor: stores the text, deletes the drawing, or (null) drops the change. */
  finishText(result: TextResult): void {
    const te = this.textEdit;
    if (!te) return;
    this.closeText();
    const s = this.state;
    const draft = te.isNew ? s.draft : null;
    const d = draft ?? s.byId(te.id);
    const tool = d && toolFor(d.body.kind);
    if (!d || !tool?.text) return;
    // An empty text means no note: a new one is dropped, an existing one deleted.
    const text = result && "text" in result ? result.text : null;
    if (te.isNew) {
      if (text) s.commitDraft(tool.text.set(d.body, text));
      else s.draft = null;
    } else if (result && (text === "" || "delete" in result)) {
      s.select(d.id);
      s.deleteSelected();
    } else if (text !== null) {
      s.edit(d.id, tool.text.set(d.body, text));
    }
    this.host.invalidate();
  }

  /**
   * A double-click on the price plot: opens the text editor of a drawing with text, the
   * style popover of any other; false when no drawing is there.
   */
  doubleClick(x: number, y: number): boolean {
    const hit = this.state.tool ? null : this.hitAt(x, y);
    if (!hit) return false;
    this.state.select(hit.id);
    return this.openText(hit.id) || this.openStyle(hit.id, { x, y });
  }

  /**
   * A right click on the price plot: on a drawing, opens the context menu of the selection
   * (a drawing outside it is selected alone first); false when no drawing is there.
   */
  contextMenu(x: number, y: number): boolean {
    const s = this.state;
    if (s.tool || this.edit || this.box) return false;
    const hit = this.hitAt(x, y);
    this.finishText(null);
    this.closeStyle();
    if (!hit) {
      this.closeMenu();
      return false;
    }
    if (!s.isSelected(hit.id)) s.select(hit.id);
    this.menuEdit = { ids: [...s.selection], at: { x, y } };
    this.syncMenu();
    this.host.invalidateOverlay();
    return true;
  }

  /** Runs what the context menu asked for on the drawings it opened for, and closes it. */
  menuAction(action: MenuAction): void {
    const me = this.menuEdit;
    if (!me) return;
    this.closeMenu();
    const s = this.state;
    const ids = me.ids.filter((id) => s.byId(id));
    if (!action || ids.length === 0) return;
    if (action === "settings") {
      if (ids.length === 1) {
        s.select(ids[0]!);
        if (!this.openText(ids[0]!)) this.openStyle(ids[0]!, me.at);
      }
      return;
    }
    if (action === "remove") {
      s.setSelection(ids);
      s.deleteSelected();
    } else {
      s.updateMany(ids, action === "hide" ? { hidden: true } : { locked: action === "lock" });
    }
    this.host.invalidate();
  }

  /** Shows every drawing hidden one by one again, as one undo step. */
  showHidden(): void {
    if (this.state.showHidden()) this.host.invalidate();
  }

  /** Runs what the style popover asked for (see `StyleAction`). */
  styleAction(action: StyleAction): void {
    const se = this.styleEdit;
    if (!se) return;
    if (!action) {
      this.closeStyle();
      return;
    }
    const s = this.state;
    if ("delete" in action) {
      s.select(se.id);
      s.deleteSelected();
    } else {
      s.update(se.id, action.patch);
    }
    this.host.invalidate();
  }

  /**
   * Hide all: no drawing is painted or hit until shown again (for this session; the
   * drawings are not changed). Hiding drops the selection, the tool, a drag and open editors.
   */
  setHiddenAll(on: boolean): void {
    if (on === this.hiddenAll) return;
    this.hiddenAll = on;
    if (on) {
      this.abort();
      this.finishText(null);
      this.closeStyle();
      this.closeMenu();
      this.state.setTool(null);
      this.state.select(null);
      this.state.hover = null;
    }
    this.host.invalidate();
  }

  /**
   * While a replay is on: the open time of its last revealed bar. A drawing whose earliest anchor
   * is after it would give a later bar away, so it is neither painted nor hit until a step reveals
   * that bar (null: every drawing). Drops the selection of a drawing it hides.
   */
  setCutoff(t: number | null): void {
    if (t === this.cutoff) return;
    this.cutoff = t;
    const s = this.state;
    const kept = t === null ? s.selection : s.selection.filter((id) => earliestTime(s.byId(id)!.body) <= t);
    if (kept.length !== s.selection.length) {
      this.abort();
      this.closeText();
      this.closeStyle();
      this.closeMenu();
      s.setSelection(kept);
    }
    this.host.invalidate();
  }

  /**
   * ⌘ (Ctrl) went down or up without the mouse moving: the last position is moved over again,
   * so the snap preview, a placement, a drag or the ruler follow at once. Overlay only.
   */
  modifiers(cmd: boolean): void {
    const m = this.mouse;
    if (!m || m.cmd === cmd) return;
    this.pointerMove(m.x, m.y, m.shift, cmd);
  }

  /**
   * With a tool armed and ⌘ held: the bar price the next point snaps to, on screen and as an
   * anchor (a ring on the overlay shows it before the click). Null otherwise.
   */
  snapPreview(): { x: number; y: number; anchor: Anchor } | null {
    const c = this.coords;
    const m = this.mouse;
    const tool = this.state.tool ? toolById(this.state.tool) : undefined;
    if (!c || !m?.cmd || !tool || tool.placement.stroke === true || this.ruler?.live) return null;
    const anchor = snapToBar(c, m.x, m.y, true);
    return anchor ? { x: c.x(anchor.t), y: c.y(anchor.p), anchor } : null;
  }

  /** Snaps placed and dragged points to bar prices (see `snapToBar`). */
  setMagnet(on: boolean): void {
    this.magnet = on;
  }

  /** Runs a keyboard command; false when there was nothing to do. */
  command(cmd: DrawingCommand): boolean {
    if (cmd === "cancel") {
      const ruler = this.ruler !== null || this.rulerArmed;
      this.ruler = null;
      this.rulerArmed = false;
      const menu = this.menuEdit !== null;
      this.abort();
      this.closeText();
      this.closeStyle();
      this.closeMenu();
      const any = this.state.cancel() || ruler || menu;
      this.host.invalidateOverlay();
      return any;
    }
    if (cmd === "ruler") {
      if (this.ruler?.live) return false;
      this.rulerArmed = !this.rulerArmed;
      return true;
    }
    if (cmd === "edit") {
      const id = this.state.selected;
      return id !== null && !this.edit && (this.openText(id) || this.openStyle(id, null));
    }
    // Not in the middle of a drag, nor on hidden drawings: the history would change unseen.
    if (this.edit || this.press || this.box || this.hiddenAll) return false;
    this.closeMenu();
    const done = cmd === "undo" ? this.state.undo() : cmd === "redo" ? this.state.redo() : this.state.deleteSelected();
    if (done) this.host.invalidate();
    return done;
  }

  /** Drops a drag, stroke, measurement or placement press in progress without storing anything. */
  abort(): void {
    if (this.edit?.moved) this.host.invalidate();
    this.edit = null;
    if (this.box) this.host.invalidateOverlay();
    this.box = null;
    if (this.press && this.placingStroke()) this.state.points = [];
    this.press = null;
    this.strokeAt = null;
    if (this.ruler?.live) this.ruler = null;
  }

  // ---- Painting ----

  /** Stored drawings, on the base layer after the indicators; `c` maps this frame. */
  paintBase(ctx: CanvasRenderingContext2D, c: Coords, dpr: number, theme: ChartTheme, tag: TagFn): void {
    this.coords = c;
    let painted = 0;
    if (c.count > 0 && c.plotW > 0 && c.priceH > 0) {
      // A marker or handle just outside the plot still shows, and a note sits at the open of
      // the bar that holds its time, up to one bar before it: cull with that much margin.
      const m = HANDLE_RADIUS + HIT_TOLERANCE;
      this.span = [c.addBars(c.t(-m), -1), c.addBars(c.t(c.plotW + m), 1)];
      if (this.cache.size > this.state.drawings.length + 32) this.pruneCache();
      const dragged = this.edit?.moved ? this.edit.ids : null;
      const isDragged = (id: string) => dragged?.has(id) === true;
      begin(ctx, c, dpr);
      for (const d of this.state.drawings) {
        const tool = this.visibleTool(d);
        if (!tool || isDragged(d.id)) continue;
        paintOne(ctx, tool, this.geom(tool, d), d.style, dpr, theme, false);
        painted++;
      }
      ctx.restore();
      for (const d of this.state.drawings) {
        const tool = this.visibleTool(d);
        if (tool?.axisPrices && !isDragged(d.id)) for (const p of tool.axisPrices(d.body)) tag(p, color(theme, d.style));
      }
    }
    const debug = chartDebug();
    if (debug) debug.drawingsPainted = painted;
  }

  /** Hover halo, handles, and the drawing being dragged or placed, on the overlay. */
  paintOverlay(ctx: CanvasRenderingContext2D, dpr: number, theme: ChartTheme, tag: TagFn): void {
    const c = this.coords;
    const debug = chartDebug();
    if (debug) {
      debug.selectedDrawing = this.state.selected;
      debug.selectedDrawings = [...this.state.selection];
      debug.selectionBox = this.box !== null;
      debug.hoveredDrawing = this.state.hover?.id ?? null;
      debug.ruler = null;
    }
    if (!c || c.count === 0 || c.plotW <= 0 || c.priceH <= 0) return;
    const s = this.state;
    const e = this.edit?.moved ? this.edit : null;
    const tags: [number, string][] = [];
    begin(ctx, c, dpr);

    const dragging = (id: string) => e?.ids.has(id) === true;
    const hovered = s.hover && !dragging(s.hover.id) ? s.byId(s.hover.id) : undefined;
    const hoverTool = hovered && this.visibleTool(hovered);
    if (hovered && hoverTool) paintOne(ctx, hoverTool, this.geom(hoverTool, hovered), hovered.style, dpr, theme, true);

    // A new drawing waiting for its text in the editor.
    const draft = s.draft;
    const draftTool = draft && toolFor(draft.body.kind);
    if (draft && draftTool) paintOne(ctx, draftTool, draftTool.layout(draft.body, c), draft.style, dpr, theme, false);

    for (const item of e?.items ?? NONE) {
      const d = s.byId(item.id);
      const tool = d && toolFor(item.body.kind);
      if (!d || !tool) continue;
      const g = tool.layout(item.body, c);
      paintOne(ctx, tool, g, d.style, dpr, theme, false);
      paintHandles(ctx, tool.handles(g), color(theme, d.style), theme);
      if (tool.markers) paintHandles(ctx, tool.markers(g), color(theme, d.style), theme);
      for (const p of tool.axisPrices?.(item.body) ?? []) tags.push([p, color(theme, d.style)]);
    }
    if (debug) debug.selectedHandles = [];
    for (const id of new Set([...s.selection, hovered?.id])) {
      const d = id && !dragging(id) ? s.byId(id) : undefined;
      const tool = d && this.visibleTool(d);
      if (!d || !tool) continue;
      const handles = this.handles(tool, d);
      const markers = s.isSelected(d.id) ? this.markers(tool, d) : NONE;
      paintHandles(ctx, handles, color(theme, d.style), theme);
      paintHandles(ctx, markers, color(theme, d.style), theme);
      if (debug && id === s.selected) debug.selectedHandles = [...handles, ...markers];
    }
    if (this.box) paintBox(ctx, boxOf(this.box), theme);

    // The shape being placed: the points so far and the mouse as the next one. A stroke
    // shows only once it is pressed, and without a handle on every point.
    const placing = s.tool ? toolById(s.tool) : undefined;
    const stroke = placing?.placement.stroke === true;
    if (placing && this.mouse && !this.ruler?.live && (!stroke || s.points.length > 0)) {
      const m = this.mouse;
      const next = stroke ? this.rawAnchor(m.x, m.y) : this.anchorAt(m.x, m.y, m.cmd);
      const points = s.placingPoints(next, m.shift && !stroke);
      const body = placing.create(points, c);
      paintOne(ctx, placing, placing.layout(body, c), DEFAULT_STYLE, dpr, theme, false);
      const col = color(theme, DEFAULT_STYLE);
      if (s.points.length > 0 && !stroke) paintHandles(ctx, points.map((a) => ({ x: c.x(a.t), y: c.y(a.p) })), col, theme);
      for (const p of placing.axisPrices?.(body) ?? []) tags.push([p, col]);
    }
    const snap = this.snapPreview();
    if (snap) paintSnap(ctx, snap, theme);
    if (debug) debug.snapRing = snap && { x: snap.x, y: snap.y };
    if (this.ruler) {
      const text = paintRuler(ctx, c, this.ruler.a, this.ruler.b, theme);
      if (debug) debug.ruler = text;
    }
    // A tooltip goes over everything else.
    if (hovered && hoverTool?.paintHover && !this.press) {
      hoverTool.paintHover(ctx, this.geom(hoverTool, hovered), look(theme, hovered.style, dpr), c);
    }
    ctx.restore();
    for (const [p, col] of tags) tag(p, col);
  }

  // ---- Pointer input (CSS px inside the price plot) ----

  /**
   * A press; true when the layer takes it (the chart does not pan then). `cmd` is ⌘ or
   * Ctrl: with a tool or on a handle the point snaps strongly to the bar under it; on a
   * drawing's body it adds the drawing to the selection or takes it out; on empty space a
   * drag draws a selection box.
   */
  pointerDown(x: number, y: number, shift: boolean, cmd = false): boolean {
    const c = this.coords;
    if (!c || c.count === 0) return false;
    this.mouse = { x, y, shift, cmd };
    const s = this.state;
    // A press on the chart while a text editor is open closes it without saving.
    this.finishText(null);
    this.closeStyle();
    this.closeMenu();
    // Any press puts a shown ruler away.
    if (this.ruler) {
      this.ruler = null;
      this.host.invalidateOverlay();
    }
    // The ruler: armed with Alt+R whatever the tool, or Shift+drag on empty space without one.
    if (this.rulerArmed || (shift && !s.tool && !this.hitAt(x, y))) {
      this.rulerArmed = false;
      const a = this.anchorAt(x, y, cmd);
      this.ruler = { a, b: a, live: true };
      this.host.invalidateOverlay();
      return true;
    }
    if (s.tool) {
      this.press = { x, y };
      if (this.placingStroke()) {
        s.points = [];
        s.stroke(this.rawAnchor(x, y));
        this.strokeAt = { x, y };
      } else if (s.place(this.anchorAt(x, y, cmd), shift, c)) {
        if (s.draft) {
          this.press = null;
          this.openText(s.draft.id);
        }
        this.host.invalidate();
        return true;
      }
      this.host.invalidateOverlay();
      return true;
    }
    const hit = this.hitAt(x, y);
    if (!hit) {
      if (cmd) {
        this.box = { x0: x, y0: y, x1: x, y1: y };
        return true;
      }
      if (s.selection.length > 0) {
        s.select(null);
        this.host.invalidateOverlay();
      }
      return false;
    }
    const d = s.byId(hit.id)!;
    const tool = toolFor(d.body.kind)!;
    // The grip moves the whole drawing, as its body does.
    const part: Part = hit.part === tool.grip ? "body" : hit.part;
    // ⌘ on a handle (of any drawing, hovered or selected) snaps it; on a body it picks.
    if (cmd && part === "body") {
      s.toggle(d.id);
      this.host.invalidateOverlay();
      return true;
    }
    if (!s.isSelected(d.id)) s.select(d.id);
    // A body press drags every unlocked selected drawing; a locked one stays where it is.
    const items = (part === "body" ? s.selectedDrawings() : [d])
      .filter((o) => !o.locked)
      .map((o) => ({ id: o.id, body0: o.body, body: o.body }));
    this.edit = { id: d.id, part, x0: x, y0: y, items, ids: new Set(items.map((i) => i.id)), moved: false };
    this.host.invalidateOverlay();
    return true;
  }

  /** The pointer moved over the price plot, pressed or not. */
  pointerMove(x: number, y: number, shift: boolean, cmd = false): void {
    this.mouse = { x, y, shift, cmd };
    const c = this.coords;
    const r = this.ruler;
    if (r?.live) {
      r.b = this.anchorAt(x, y, cmd);
      this.host.invalidateOverlay();
      return;
    }
    if (this.box) {
      this.box.x1 = x;
      this.box.y1 = y;
      this.host.invalidateOverlay();
      return;
    }
    const at = this.strokeAt;
    if (at && this.press) {
      // One point per pixel moved at most; the stroke is simplified on release.
      if (Math.hypot(x - at.x, y - at.y) >= 1) {
        this.state.stroke(this.rawAnchor(x, y));
        this.strokeAt = { x, y };
      }
      this.host.invalidateOverlay();
      return;
    }
    const e = this.edit;
    if (e && c) {
      if (!e.moved) {
        if (Math.hypot(x - e.x0, y - e.y0) < DRAG_THRESHOLD) return;
        e.moved = true;
        // Only locked drawings were pressed: a drag, but nothing moves.
        if (e.items.length === 0) return;
        // The base is drawn once without them; from now on they move on the overlay only.
        this.host.invalidate();
      }
      const m = mover(c, x - e.x0, y - e.y0);
      for (const item of e.items) {
        const tool = toolFor(item.body0.kind)!;
        item.body =
          e.part === "body"
            ? tool.moveBy(item.body0, m)
            : tool.moveHandle(item.body0, e.part, this.anchorAt(x, y, cmd), shift);
      }
      this.host.invalidateOverlay();
      return;
    }
    if (this.state.tool || this.press) {
      this.host.invalidateOverlay();
      return;
    }
    const hit = this.hitAt(x, y);
    const h = this.state.hover;
    if (hit?.id !== h?.id || hit?.part !== h?.part) {
      this.state.hover = hit;
      this.host.invalidateOverlay();
    }
  }

  pointerUp(x: number, y: number, shift: boolean, cmd = false): void {
    const r = this.ruler;
    if (r?.live) {
      r.b = this.anchorAt(x, y, cmd);
      r.live = false;
      // A Shift+click without a drag measures nothing.
      if (r.a.t === r.b.t && r.a.p === r.b.p) this.ruler = null;
      this.host.invalidateOverlay();
      return;
    }
    const box = this.box;
    if (box) {
      this.box = null;
      box.x1 = x;
      box.y1 = y;
      // A ⌘-click on empty space without a drag selects nothing more.
      if (Math.hypot(x - box.x0, y - box.y0) >= DRAG_THRESHOLD) {
        const s = this.state;
        s.setSelection([...s.selection, ...this.inBox(boxOf(box))]);
      }
      this.host.invalidateOverlay();
      return;
    }
    if (this.strokeAt) {
      this.strokeAt = null;
      this.press = null;
      const c = this.coords;
      if (c && this.state.endStroke(c)) this.host.invalidate();
      else this.host.invalidateOverlay();
      return;
    }
    const e = this.edit;
    this.edit = null;
    if (e) {
      if (e.moved) {
        // The base was drawn without the dragged ones: draw it again, moved or not.
        if (e.items.length > 0) {
          this.state.editMany(new Map(e.items.map((i) => [i.id, i.body])));
          this.host.invalidate();
        }
      } else if (!cmd && this.state.selection.length > 1) {
        // A click without a drag on one of several selected selects only it.
        this.state.select(e.id);
        this.host.invalidateOverlay();
      }
      return;
    }
    const p = this.press;
    this.press = null;
    const c = this.coords;
    if (p && c && this.state.points.length > 0 && Math.hypot(x - p.x, y - p.y) >= DRAG_THRESHOLD) {
      if (this.state.place(this.anchorAt(x, y, cmd), shift, c)) this.host.invalidate();
    }
  }

  /** The pointer left the price plot. */
  leave(): void {
    if (this.mouse === null && this.state.hover === null) return;
    this.mouse = null;
    this.state.hover = null;
    this.host.invalidateOverlay();
  }

  /** The cursor the layer wants, or null for the chart's own. */
  cursor(): string | null {
    const e = this.edit;
    if (e && e.items.length > 0) return e.part === "body" ? "move" : "grabbing";
    if (this.state.tool || this.rulerArmed || this.ruler?.live || this.box) return "crosshair";
    const h = this.state.hover;
    if (!h) return null;
    const d = this.state.byId(h.id);
    if (d?.locked) return "pointer";
    return h.part === "body" || h.part === (d && toolFor(d.body.kind)?.grip) ? "move" : "grab";
  }

  // ---- Internals ----

  /**
   * The point under (x, y): with `cmd` (⌘ held) on the nearest price of the bar under it
   * (`snapToBar`, strong); with the magnet on, on a bar price close to it; else as it is.
   */
  private anchorAt(x: number, y: number, cmd: boolean): Anchor {
    const c = this.coords!;
    const snapped = cmd ? snapToBar(c, x, y, true) : this.magnet ? snapToBar(c, x, y) : null;
    return snapped ?? this.rawAnchor(x, y);
  }

  /** Ids of the shown drawings that touch `box`. */
  private inBox(box: Box): string[] {
    const ids: string[] = [];
    for (const d of this.state.drawings) {
      const tool = this.visibleTool(d);
      if (tool && tool.touches(this.geom(tool, d), box)) ids.push(d.id);
    }
    return ids;
  }

  private rawAnchor(x: number, y: number): Anchor {
    const c = this.coords!;
    return { t: c.t(x), p: c.p(y) };
  }

  /** The active tool places by stroke. */
  private placingStroke(): boolean {
    const tool = this.state.tool ? toolById(this.state.tool) : undefined;
    return tool?.placement.stroke === true;
  }

  /** Opens the text editor of drawing `id` (or of the draft); false when it holds no text. */
  private openText(id: string): boolean {
    const s = this.state;
    const c = this.coords;
    const isNew = s.draft?.id === id;
    const d = isNew ? s.draft : s.byId(id);
    const tool = d && toolFor(d.body.kind);
    if (!c || !d || !tool?.text || (!isNew && d.locked)) return false;
    const at = tool.text.at(tool.layout(d.body, c, this.outcomes.get(d.id)));
    this.textEdit = { id, isNew };
    this.host.text({ id, text: tool.text.get(d.body), isNew, x: at.x, y: at.y });
    this.host.invalidateOverlay();
    return true;
  }

  private closeText(): void {
    if (!this.textEdit) return;
    this.textEdit = null;
    this.host.text(null);
  }

  /**
   * Opens the style popover of drawing `id` at `at`, or (null) at its last handle, else at
   * the mouse, else in the middle of the plot; false when it is not shown or has text.
   */
  private openStyle(id: string, at: Point | null): boolean {
    const c = this.coords;
    const d = this.state.byId(id);
    const tool = d && this.visibleTool(d);
    if (!c || !d || !tool || tool.text) return false;
    const where = at ?? this.handles(tool, d).at(-1) ?? this.mouse ?? { x: c.plotW / 2, y: c.priceH / 2 };
    this.styleEdit = { id, at: { x: where.x, y: where.y } };
    this.host.style({ drawing: d, x: where.x, y: where.y });
    this.host.invalidateOverlay();
    return true;
  }

  /** After a stored change: the open popover shows the drawing as it is now, or closes when it is gone. */
  private syncStyle(): void {
    const se = this.styleEdit;
    if (!se) return;
    const d = this.state.byId(se.id);
    if (d) this.host.style({ drawing: d, x: se.at.x, y: se.at.y });
    else this.closeStyle();
  }

  private closeStyle(): void {
    if (!this.styleEdit) return;
    this.styleEdit = null;
    this.host.style(null);
  }

  /** Tells the host where the context menu is and what it offers. */
  private syncMenu(): void {
    const me = this.menuEdit;
    if (!me) return;
    const list = me.ids.map((id) => this.state.byId(id)).filter((d) => d !== undefined);
    if (list.length === 0) {
      this.closeMenu();
      return;
    }
    this.host.menu({
      ids: list.map((d) => d.id),
      locked: list.every((d) => d.locked),
      single: list.length === 1,
      x: me.at.x,
      y: me.at.y,
    });
  }

  private closeMenu(): void {
    if (!this.menuEdit) return;
    this.menuEdit = null;
    this.host.menu(null);
  }

  /** The tool of a drawing that is shown and inside the visible times. */
  private visibleTool(d: Drawing): ToolDef | undefined {
    if (this.hiddenAll || d.hidden) return undefined;
    if (this.cutoff !== null && earliestTime(d.body) > this.cutoff) return undefined;
    const tool = toolFor(d.body.kind);
    if (!tool) return undefined;
    const [lo, hi] = tool.timeSpan(d.body);
    return hi < this.span[0] || lo > this.span[1] ? undefined : tool;
  }

  private geom(tool: ToolDef, d: Drawing): unknown {
    return this.entry(tool, d).geom;
  }

  /** The handles of `d` in this frame, listed once per geometry. */
  private handles(tool: ToolDef, d: Drawing): Point[] {
    const e = this.entry(tool, d);
    e.handles ??= tool.handles(e.geom);
    return e.handles;
  }

  /** The markers of `d` in this frame (none for most tools), listed once per geometry. */
  private markers(tool: ToolDef, d: Drawing): Point[] {
    if (!tool.markers) return NONE;
    const e = this.entry(tool, d);
    e.markers ??= tool.markers(e.geom);
    return e.markers;
  }

  private entry(tool: ToolDef, d: Drawing): CacheEntry {
    const c = this.coords!;
    const hit = this.cache.get(d.id);
    if (hit && hit.drawing === d) {
      if (hit.coords === c) return hit;
      if (hit.coords.sameLayout(c) && (!hit.live || hit.coords.sameLastBar(c))) {
        hit.coords = c;
        return hit;
      }
    }
    c.lastBarRead = false;
    const geom = tool.layout(d.body, c, this.outcomes.get(d.id));
    const e: CacheEntry = { drawing: d, coords: c, geom, handles: null, markers: null, live: c.lastBarRead };
    this.cache.set(d.id, e);
    return e;
  }

  private pruneCache(): void {
    const ids = new Set(this.state.drawings.map((d) => d.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  /**
   * Top-most hit: handles of every visible drawing first (the selected ones before others),
   * then bodies. Runs on every pointer move, so it allocates nothing but the result.
   */
  private hitAt(x: number, y: number): { id: string; part: Part } | null {
    const c = this.coords;
    if (!c || c.count === 0) return null;
    const list = this.state.drawings;
    const s = this.state;
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k]!;
      if (!s.isSelected(d.id)) continue;
      const i = this.handleAt(d, x, y);
      if (i >= 0) return { id: d.id, part: i };
    }
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k]!;
      if (s.isSelected(d.id)) continue;
      const i = this.handleAt(d, x, y);
      if (i >= 0) return { id: d.id, part: i };
    }
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k]!;
      const tool = this.visibleTool(d);
      if (tool && tool.hitTest(this.geom(tool, d), x, y, HIT_TOLERANCE)) return { id: d.id, part: "body" };
    }
    return null;
  }

  /** Index of the handle of `d` at (x, y), or -1. */
  private handleAt(d: Drawing, x: number, y: number): number {
    const tool = this.visibleTool(d);
    if (!tool) return -1;
    const handles = this.handles(tool, d);
    for (let i = 0; i < handles.length; i++) {
      if (Math.hypot(handles[i]!.x - x, handles[i]!.y - y) <= HIT_TOLERANCE) return i;
    }
    return -1;
  }
}

const NONE: never[] = [];

/** The box between two corners, in either order. */
function boxOf(b: { x0: number; y0: number; x1: number; y1: number }): Box {
  return { left: Math.min(b.x0, b.x1), top: Math.min(b.y0, b.y1), right: Math.max(b.x0, b.x1), bottom: Math.max(b.y0, b.y1) };
}

/** The ⌘-drag selection box: a faint fill and a thin outline. */
function paintBox(ctx: CanvasRenderingContext2D, b: Box, theme: ChartTheme): void {
  ctx.setLineDash(NO_DASH);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.muted;
  ctx.fillStyle = theme.muted;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(b.left + 0.5, b.top + 0.5, b.right - b.left, b.bottom - b.top);
  ctx.globalAlpha = 1;
}

/** Moves anchors by (dx, dy) px from where they are drawn; an axis that did not move stays exact. */
export function mover(c: Coords, dx: number, dy: number): Mover {
  return {
    anchor: (a) => ({ t: dx === 0 ? a.t : c.t(c.x(a.t) + dx), p: dy === 0 ? a.p : c.p(c.y(a.p) + dy) }),
    price: (p) => (dy === 0 ? p : c.p(c.y(p) + dy)),
  };
}

function color(theme: ChartTheme, style: DrawingStyle): string {
  const pal = theme.indicatorPalette;
  return pal[style.color] ?? pal[0]!;
}

/** CSS px transform, clipped to the price plot; the caller restores. */
function begin(ctx: CanvasRenderingContext2D, c: Coords, dpr: number): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.rect(0, 0, c.plotW, c.priceH);
  ctx.clip();
}

function look(theme: ChartTheme, style: DrawingStyle, dpr: number): Look {
  return { color: color(theme, style), width: style.width, dash: style.dash, dpr, theme };
}

function paintOne(
  ctx: CanvasRenderingContext2D,
  tool: ToolDef,
  g: unknown,
  style: DrawingStyle,
  dpr: number,
  theme: ChartTheme,
  halo: boolean,
): void {
  const lk = look(theme, style, dpr);
  ctx.strokeStyle = lk.color;
  ctx.fillStyle = lk.color;
  ctx.lineWidth = halo ? style.width + HALO_EXTRA : style.width;
  ctx.globalAlpha = halo ? HALO_ALPHA : 1;
  ctx.setLineDash(style.dash && !halo ? DASH : NO_DASH);
  ctx.lineCap = "butt";
  tool.paint(ctx, g, lk);
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
}

/** The ⌘ snap target: a ring around the bar price the next point takes. */
function paintSnap(ctx: CanvasRenderingContext2D, p: Point, theme: ChartTheme): void {
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.fg;
  ctx.beginPath();
  ctx.arc(p.x, p.y, SNAP_RING_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
}

function paintHandles(ctx: CanvasRenderingContext2D, points: Point[], stroke: string, theme: ChartTheme): void {
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = theme.bg;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
