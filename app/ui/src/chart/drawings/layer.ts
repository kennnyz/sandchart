import type { Anchor, Drawing, DrawingBody, DrawingKind, DrawingStyle } from "../../backend/types";
import { chartDebug } from "../debug";
import type { ChartTheme } from "../theme";
import type { Coords } from "./geometry";
import { toolFor, type Look, type Mover, type Point, type ToolDef } from "./registry";
import { DEFAULT_STYLE, DrawingState, type DrawingChange, type Owner, type Part } from "./state";

/** Distance in CSS px within which the pointer hits a drawing or a handle. */
export const HIT_TOLERANCE = 6;
const HANDLE_RADIUS = 4.5;
/** A press must move this far (CSS px) to count as a drag. */
const DRAG_THRESHOLD = 3;
/** Halo of a hovered drawing: this much wider than its line, at this opacity. */
const HALO_EXTRA = 6;
const HALO_ALPHA = 0.25;
const DASH = [6, 4];
const NO_DASH: number[] = [];

export type DrawingCommand = "undo" | "redo" | "delete" | "cancel";

/** What the layer needs from the chart. */
export interface LayerHost {
  /** Redraw both canvas layers. */
  invalidate(): void;
  invalidateOverlay(): void;
  commit(change: DrawingChange): void;
  tool(kind: DrawingKind | null): void;
}

/** Draws a price tag on the axis of the given canvas: price in ticks, background colour. */
export type TagFn = (price: number, color: string) => void;

/** A press on a drawing: what is dragged, from where, and the body it would get. */
interface Edit {
  id: string;
  part: Part;
  x0: number;
  y0: number;
  body0: DrawingBody;
  body: DrawingBody;
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
  private span: [number, number] = [0, 0];
  /** Screen geometry per drawing id, valid for that drawing object and that frame. */
  private readonly cache = new Map<string, { drawing: Drawing; coords: Coords; geom: unknown }>();
  private edit: Edit | null = null;
  /** Where the press that placed a point started (a press, drag and release places two). */
  private press: Point | null = null;
  private mouse: { x: number; y: number; shift: boolean } | null = null;

  constructor(private readonly host: LayerHost) {
    this.state = new DrawingState({ commit: (c) => host.commit(c), tool: (k) => host.tool(k) });
  }

  // ---- Commands from the chart's owner ----

  setDrawings(list: Drawing[]): void {
    this.edit = null;
    this.press = null;
    this.state.reset(list);
    this.cache.clear();
    this.host.invalidate();
  }

  setOwner(owner: Owner | null): void {
    this.state.setOwner(owner);
  }

  setTool(kind: DrawingKind | null): void {
    this.abort();
    this.state.setTool(kind);
    this.host.invalidateOverlay();
  }

  /** Runs a keyboard command; false when there was nothing to do. */
  command(cmd: DrawingCommand): boolean {
    if (cmd === "cancel") {
      this.abort();
      const any = this.state.cancel();
      this.host.invalidateOverlay();
      return any;
    }
    // Not in the middle of a drag: the history would change under it.
    if (this.edit || this.press) return false;
    const done = cmd === "undo" ? this.state.undo() : cmd === "redo" ? this.state.redo() : this.state.deleteSelected();
    if (done) this.host.invalidate();
    return done;
  }

  /** Drops a drag or placement press in progress without storing anything. */
  abort(): void {
    if (this.edit?.moved) this.host.invalidate();
    this.edit = null;
    this.press = null;
  }

  // ---- Painting ----

  /** Stored drawings, on the base layer after the indicators; `c` maps this frame. */
  paintBase(ctx: CanvasRenderingContext2D, c: Coords, dpr: number, theme: ChartTheme, tag: TagFn): void {
    this.coords = c;
    let painted = 0;
    if (c.count > 0 && c.plotW > 0 && c.priceH > 0) {
      this.span = c.visibleTimes();
      if (this.cache.size > this.state.drawings.length + 32) this.pruneCache();
      const dragged = this.edit?.moved ? this.edit.id : null;
      begin(ctx, c, dpr);
      for (const d of this.state.drawings) {
        const tool = this.visibleTool(d);
        if (!tool || d.id === dragged) continue;
        paintOne(ctx, tool, this.geom(tool, d), d.style, dpr, theme, false);
        painted++;
      }
      ctx.restore();
      for (const d of this.state.drawings) {
        const tool = this.visibleTool(d);
        if (tool?.axisPrices && d.id !== dragged) for (const p of tool.axisPrices(d.body)) tag(p, color(theme, d.style));
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
      debug.hoveredDrawing = this.state.hover?.id ?? null;
    }
    if (!c || c.count === 0 || c.plotW <= 0 || c.priceH <= 0) return;
    const s = this.state;
    const e = this.edit?.moved ? this.edit : null;
    const tags: [number, string][] = [];
    begin(ctx, c, dpr);

    const hovered = s.hover && s.hover.id !== e?.id ? s.byId(s.hover.id) : undefined;
    const hoverTool = hovered && this.visibleTool(hovered);
    if (hovered && hoverTool) paintOne(ctx, hoverTool, this.geom(hoverTool, hovered), hovered.style, dpr, theme, true);

    if (e) {
      const d = s.byId(e.id);
      const tool = d && toolFor(e.body.kind);
      if (d && tool) {
        const g = tool.layout(e.body, c);
        paintOne(ctx, tool, g, d.style, dpr, theme, false);
        paintHandles(ctx, tool.handles(g), color(theme, d.style), theme);
        for (const p of tool.axisPrices?.(e.body) ?? []) tags.push([p, color(theme, d.style)]);
      }
    }
    for (const id of new Set([s.selected, hovered?.id])) {
      const d = id && id !== e?.id ? s.byId(id) : undefined;
      const tool = d && this.visibleTool(d);
      if (d && tool) paintHandles(ctx, tool.handles(this.geom(tool, d)), color(theme, d.style), theme);
    }

    // The shape being placed: the points so far and the mouse as the next one.
    const placing = s.tool ? toolFor(s.tool) : undefined;
    if (placing && this.mouse) {
      const points = s.placingPoints(this.anchorAt(this.mouse.x, this.mouse.y), this.mouse.shift);
      const g = placing.layout(placing.create(points, c), c);
      paintOne(ctx, placing, g, DEFAULT_STYLE, dpr, theme, false);
      const col = color(theme, DEFAULT_STYLE);
      if (s.points.length > 0) paintHandles(ctx, points.map((a) => ({ x: c.x(a.t), y: c.y(a.p) })), col, theme);
      for (const p of placing.axisPrices?.(placing.create(points, c)) ?? []) tags.push([p, col]);
    }
    ctx.restore();
    for (const [p, col] of tags) tag(p, col);
  }

  // ---- Pointer input (CSS px inside the price plot) ----

  /** A press; true when the layer takes it (the chart does not pan then). */
  pointerDown(x: number, y: number, shift: boolean): boolean {
    const c = this.coords;
    if (!c || c.count === 0) return false;
    this.mouse = { x, y, shift };
    const s = this.state;
    if (s.tool) {
      this.press = { x, y };
      if (s.place(this.anchorAt(x, y), shift, c)) this.host.invalidate();
      else this.host.invalidateOverlay();
      return true;
    }
    const hit = this.hitAt(x, y);
    if (!hit) {
      if (s.selected !== null) {
        s.select(null);
        this.host.invalidateOverlay();
      }
      return false;
    }
    const d = s.byId(hit.id)!;
    s.select(d.id);
    // A locked drawing is selected but stays where it is.
    this.edit = d.locked ? null : { id: d.id, part: hit.part, x0: x, y0: y, body0: d.body, body: d.body, moved: false };
    this.host.invalidateOverlay();
    return true;
  }

  /** The pointer moved over the price plot, pressed or not. */
  pointerMove(x: number, y: number, shift: boolean): void {
    this.mouse = { x, y, shift };
    const c = this.coords;
    const e = this.edit;
    if (e && c) {
      if (!e.moved) {
        if (Math.hypot(x - e.x0, y - e.y0) < DRAG_THRESHOLD) return;
        e.moved = true;
        // The base is drawn once without it; from now on it moves on the overlay only.
        this.host.invalidate();
      }
      const tool = toolFor(e.body0.kind)!;
      e.body =
        e.part === "body"
          ? tool.moveBy(e.body0, mover(c, x - e.x0, y - e.y0))
          : tool.moveHandle(e.body0, e.part, this.anchorAt(x, y), shift);
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

  pointerUp(x: number, y: number, shift: boolean): void {
    const e = this.edit;
    this.edit = null;
    if (e) {
      if (e.moved) {
        this.state.edit(e.id, e.body);
        this.host.invalidate();
      }
      return;
    }
    const p = this.press;
    this.press = null;
    const c = this.coords;
    if (p && c && this.state.points.length > 0 && Math.hypot(x - p.x, y - p.y) >= DRAG_THRESHOLD) {
      if (this.state.place(this.anchorAt(x, y), shift, c)) this.host.invalidate();
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
    if (e) return e.part === "body" ? "move" : "grabbing";
    if (this.state.tool) return "crosshair";
    const h = this.state.hover;
    if (!h) return null;
    if (this.state.byId(h.id)?.locked) return "pointer";
    return h.part === "body" ? "move" : "grab";
  }

  // ---- Internals ----

  private anchorAt(x: number, y: number): Anchor {
    const c = this.coords!;
    return { t: c.t(x), p: c.p(y) };
  }

  /** The tool of a drawing that is shown and inside the visible times. */
  private visibleTool(d: Drawing): ToolDef | undefined {
    if (d.hidden) return undefined;
    const tool = toolFor(d.body.kind);
    if (!tool) return undefined;
    const [lo, hi] = tool.timeSpan(d.body);
    return hi < this.span[0] || lo > this.span[1] ? undefined : tool;
  }

  private geom(tool: ToolDef, d: Drawing): unknown {
    const c = this.coords!;
    const hit = this.cache.get(d.id);
    if (hit && hit.drawing === d && hit.coords === c) return hit.geom;
    const geom = tool.layout(d.body, c);
    this.cache.set(d.id, { drawing: d, coords: c, geom });
    return geom;
  }

  private pruneCache(): void {
    const ids = new Set(this.state.drawings.map((d) => d.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  /** Top-most hit: handles of every visible drawing first (the selected one before others), then bodies. */
  private hitAt(x: number, y: number): { id: string; part: Part } | null {
    const c = this.coords;
    if (!c || c.count === 0) return null;
    const list = this.state.drawings;
    const sel = this.state.selected;
    const order = sel ? [...list.filter((d) => d.id === sel), ...list.filter((d) => d.id !== sel).reverse()] : [...list].reverse();
    for (const d of order) {
      const tool = this.visibleTool(d);
      if (!tool) continue;
      const handles = tool.handles(this.geom(tool, d));
      for (let i = 0; i < handles.length; i++) {
        if (Math.hypot(handles[i]!.x - x, handles[i]!.y - y) <= HIT_TOLERANCE) return { id: d.id, part: i };
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]!;
      const tool = this.visibleTool(d);
      if (tool && tool.hitTest(this.geom(tool, d), x, y, HIT_TOLERANCE)) return { id: d.id, part: "body" };
    }
    return null;
  }
}

/** Moves anchors by (dx, dy) px from where they are drawn; an axis that did not move stays exact. */
function mover(c: Coords, dx: number, dy: number): Mover {
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

function paintOne(
  ctx: CanvasRenderingContext2D,
  tool: ToolDef,
  g: unknown,
  style: DrawingStyle,
  dpr: number,
  theme: ChartTheme,
  halo: boolean,
): void {
  const look: Look = { color: color(theme, style), width: style.width, dash: style.dash, dpr, theme };
  ctx.strokeStyle = look.color;
  ctx.fillStyle = look.color;
  ctx.lineWidth = halo ? style.width + HALO_EXTRA : style.width;
  ctx.globalAlpha = halo ? HALO_ALPHA : 1;
  ctx.setLineDash(style.dash && !halo ? DASH : NO_DASH);
  ctx.lineCap = "butt";
  tool.paint(ctx, g, look);
  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
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
