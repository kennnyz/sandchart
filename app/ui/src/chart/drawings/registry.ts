import type { LucideIcon } from "lucide-react";
import type { Anchor, DrawingBody, DrawingKind } from "../../backend/types";
import type { ChartTheme } from "../theme";
import type { Coords } from "./geometry";
import { brushTool } from "./tools/brush";
import { fibTool } from "./tools/fib";
import { hlineTool } from "./tools/hline";
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

/** A point in CSS px of the price plot. */
export interface Point {
  x: number;
  y: number;
}

/**
 * One drawing tool. The chart core knows tools only through this contract: a new tool is
 * one module listed in `TOOLS` (plus its `DrawingBody` variant and validation in Rust).
 * `G` is the tool's screen geometry, made by `layout` once per frame and drawing, and
 * then used by `paint`, `hitTest` and `handles`; it may cache a Path2D inside itself.
 */
export interface ToolDef<B extends DrawingBody = DrawingBody, G = unknown> {
  kind: B["kind"];
  /** i18n key of the tool's name. */
  labelKey: string;
  icon: LucideIcon;
  /** `KeyboardEvent.code` of its shortcut with Alt (⌥ on macOS). */
  code: string;
  placement: Placement;
  /** The tool stays picked after a placement, until Esc or another tool. */
  sticky?: boolean;
  /** The body from the placed points; also called with the mouse as the last point, for the preview. */
  create(points: Anchor[], c: Coords): B;
  /** Times the drawing spans, for culling; ±Infinity where it runs to the plot edge. */
  timeSpan(body: B): [number, number];
  layout(body: B, c: Coords): G;
  /** Draws on a context in CSS px, clipped to the price plot. */
  paint(ctx: CanvasRenderingContext2D, g: G, look: Look): void;
  /** Whether (x, y) is on the body, within `tol` px. Handles are tested by the core. */
  hitTest(g: G, x: number, y: number, tol: number): boolean;
  /** Points the user can drag, in the index order `moveHandle` takes. */
  handles(g: G): Point[];
  moveBy(body: B, m: Mover): B;
  /**
   * Handle `index` dragged to `a`; `horizontal` (Shift) puts it at the price of the other
   * end. Returns `body` itself when the result would be invalid.
   */
  moveHandle(body: B, index: number, a: Anchor, horizontal: boolean): B;
  /** Prices to tag on the price axis in the drawing's colour. */
  axisPrices?(body: B): number[];
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
  erase(brushTool),
];

const BY_KIND = new Map<DrawingKind, ToolDef>(TOOLS.map((t) => [t.kind, t]));

/** The tool of a drawing kind; undefined for a kind this version cannot draw yet. */
export function toolFor(kind: DrawingKind): ToolDef | undefined {
  return BY_KIND.get(kind);
}
