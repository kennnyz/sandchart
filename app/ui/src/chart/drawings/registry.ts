import type { Icon } from "../../icons";
import type { Anchor, DrawingBody, DrawingKind, PositionOutcome } from "../../backend/types";
import type { ChartTheme } from "../theme";
import type { Coords } from "./geometry";
import { brushTool } from "./tools/brush";
import { fibTool } from "./tools/fib";
import { hlineTool } from "./tools/hline";
import { noteTool } from "./tools/note";
import { longTool, shortTool } from "./tools/position";
import { rectTool } from "./tools/rect";
import { trendTool } from "./tools/trend";

/**
 * How a tool is placed: `clicks` points, one per click (or press, drag and release).
 * With `stroke` the points follow the pressed pointer instead, and the drawing is made
 * on release from at least `clicks` of them.
 */
export type Placement = { clicks: number; stroke?: boolean };

/** Moves anchors and prices by one screen offset (rigid on screen, also on a log scale). */
export interface Mover {
  anchor(a: Anchor): Anchor;
  price(p: number): number;
}

/** What a tool paints with. The core sets stroke, fill, width and dash from it first. */
export interface Look {
  /** Resolved palette colour. */
  color: string;
  /** Line width in CSS px. */
  width: number;
  dash: boolean;
  dpr: number;
  theme: ChartTheme;
}

/**
 * A tool in the rail: one per drawing kind, except the position, which is placed as a
 * long or as a short.
 */
export type ToolId = Exclude<DrawingKind, "position"> | "long" | "short";

/** A point in CSS px of the price plot. */
export interface Point {
  x: number;
  y: number;
}

/** A box in CSS px of the price plot: `left <= right`, `top <= bottom`. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One drawing tool. The chart core knows tools only through this contract: a new tool is
 * one module listed in `TOOLS` (plus its `DrawingBody` variant and validation in Rust).
 * `G` is the tool's screen geometry, made by `layout` once per frame and drawing, and
 * then used by `paint`, `hitTest` and `handles`; it may cache a Path2D inside itself.
 */
export interface ToolDef<B extends DrawingBody = DrawingBody, G = unknown> {
  id: ToolId;
  kind: B["kind"];
  /** i18n key of the tool's name. */
  labelKey: string;
  icon: Icon;
  /** `KeyboardEvent.code` of its shortcut with Alt (⌥ on macOS). */
  code: string;
  placement: Placement;
  /** The tool stays picked after a placement, until Esc or another tool. */
  sticky?: boolean;
  /** The body from the placed points; also called with the mouse as the last point, for the preview. */
  create(points: Anchor[], c: Coords): B;
  /** Times the drawing spans, for culling; ±Infinity where it runs to the plot edge. */
  timeSpan(body: B): [number, number];
  /** `outcome` is the engine's result for a stored position; none while it is placed or dragged. */
  layout(body: B, c: Coords, outcome?: PositionOutcome): G;
  /** Draws on a context in CSS px, clipped to the price plot. */
  paint(ctx: CanvasRenderingContext2D, g: G, look: Look): void;
  /** Whether (x, y) is on the body, within `tol` px. Handles are tested by the core. */
  hitTest(g: G, x: number, y: number, tol: number): boolean;
  /** Whether any painted part lies in `box` (the ⌘-drag selection box). */
  touches(g: G, box: Box): boolean;
  /** Points the user can drag, in the index order `moveHandle` takes. */
  handles(g: G): Point[];
  /** Index of a handle that moves the whole drawing, as a drag of its body does. */
  grip?: number;
  /** Points marked while it is selected that are not handles: a press there moves the drawing. */
  markers?(g: G): Point[];
  moveBy(body: B, m: Mover): B;
  /**
   * Handle `index` dragged to `a`; `horizontal` (Shift) puts it at the price of the other
   * end. Returns `body` itself when the result would be invalid.
   */
  moveHandle(body: B, index: number, a: Anchor, horizontal: boolean): B;
  /** Prices to tag on the price axis in the drawing's colour. */
  axisPrices?(body: B): number[];
  /** Extra painting on the overlay while the pointer is over the drawing (a tooltip). */
  paintHover?(ctx: CanvasRenderingContext2D, g: G, look: Look, c: Coords): void;
  /**
   * The drawing holds text written in an editor. Placing it opens the editor first, and
   * nothing is stored until it is saved with text; Enter or a double-click edits it.
   */
  text?: {
    get(body: B): string;
    set(body: B, text: string): B;
    /** Where the editor opens, in CSS px of the price plot. */
    at(g: G): Point;
  };
}

/** Erases a tool's own body and geometry types: the registry hands each tool only its own kind. */
function erase<B extends DrawingBody, G>(t: ToolDef<B, G>): ToolDef {
  return t as unknown as ToolDef;
}

/** Every tool in toolbar order. Tools import only types from this file. */
export const TOOLS: readonly ToolDef[] = [
  erase(trendTool),
  erase(hlineTool),
  erase(rectTool),
  erase(fibTool),
  erase(longTool),
  erase(shortTool),
  erase(brushTool),
  erase(noteTool),
];

// The first tool of a kind paints it: the long and the short paint any position alike.
const BY_KIND = new Map<DrawingKind, ToolDef>();
for (const t of TOOLS) if (!BY_KIND.has(t.kind)) BY_KIND.set(t.kind, t);
const BY_ID = new Map<ToolId, ToolDef>(TOOLS.map((t) => [t.id, t]));

/** The tool that paints and edits a drawing kind; undefined for a kind this version cannot draw. */
export function toolFor(kind: DrawingKind): ToolDef | undefined {
  return BY_KIND.get(kind);
}

/** The rail tool with this id. */
export function toolById(id: ToolId): ToolDef | undefined {
  return BY_ID.get(id);
}
