import { StickyNote } from "lucide-react";
import type { DrawingBody } from "../../../backend/types";
import { SANS_FAMILY } from "../../theme";
import { boxesOverlap } from "../geometry";
import { pill } from "../label";
import type { ToolDef } from "../registry";

type Note = Extract<DrawingBody, { kind: "note" }>;

/** Longest note text in UTF-8 bytes (the engine's limit). */
export const NOTE_MAX_BYTES = 2000;
/** Longest tooltip line in characters, ellipsis included. */
const TOOLTIP_CHARS = 80;
const MARKER_R = 4;
/** Gap between the bar's high and the marker's centre. */
const ABOVE_HIGH = 10;
const TOOLTIP_FONT = `12px ${SANS_FAMILY}`;
const TOOLTIP_H = 22;
const PAD = 7;

const encoder = new TextEncoder();

export function noteBytes(text: string): number {
  return encoder.encode(text).length;
}

/** `text` cut to at most `max` UTF-8 bytes, at whole characters. */
export function clampNoteText(text: string, max = NOTE_MAX_BYTES): string {
  if (noteBytes(text) <= max) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const n = noteBytes(ch);
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/** The first line with text, shortened with "…" for the tooltip. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const chars = [...line];
  return chars.length > TOOLTIP_CHARS ? chars.slice(0, TOOLTIP_CHARS - 1).join("") + "…" : line;
}

interface NoteGeom {
  x: number;
  y: number;
  line: string;
}

/** A note on a bar: a small dot above the bar's high, its text in an editor and a tooltip. */
export const noteTool: ToolDef<Note, NoteGeom> = {
  id: "note",
  kind: "note",
  labelKey: "tools.note",
  icon: StickyNote,
  code: "KeyN",
  placement: { clicks: 1 },

  /** At the open time of the bar under the click. */
  create(points, c) {
    return { kind: "note", t: c.timeAt(Math.round(c.index(points[0]!.t))), text: "" };
  },

  timeSpan(body) {
    return [body.t, body.t];
  },

  /** On the bar that contains `t` (on another timeframe too); at the top when that bar is not loaded. */
  layout(body, c) {
    // The bar at or before t; the small epsilon keeps an exact open time on its own bar.
    const i = Math.floor(c.index(body.t) + 1e-9);
    const prices = c.prices(i);
    return {
      x: c.x(c.timeAt(i)),
      y: prices ? c.y(prices[1]) - ABOVE_HIGH : MARKER_R + 4,
      line: firstLine(body.text),
    };
  },

  paint(ctx, g) {
    ctx.beginPath();
    ctx.arc(g.x, g.y, MARKER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  },

  hitTest(g, x, y, tol) {
    return Math.hypot(x - g.x, y - g.y) <= MARKER_R + tol;
  },

  touches(g, box) {
    const r = MARKER_R;
    return boxesOverlap(g.x - r, g.y - r, g.x + r, g.y + r, box);
  },

  handles() {
    return [];
  },

  moveBy(body, m) {
    return { ...body, t: m.anchor({ t: body.t, p: 1 }).t };
  },

  moveHandle(body) {
    return body;
  },

  /** The first line above the marker. */
  paintHover(ctx, g, look, c) {
    if (!g.line) return;
    const th = look.theme;
    ctx.globalAlpha = 1;
    ctx.font = TOOLTIP_FONT;
    const w = ctx.measureText(g.line).width + 2 * PAD;
    const x = Math.min(Math.max(g.x - w / 2, 2), Math.max(2, c.plotW - w - 2));
    const above = g.y - MARKER_R - 6 - TOOLTIP_H;
    const y = above >= 2 ? above : g.y + MARKER_R + 6;
    pill(ctx, x, y, w, TOOLTIP_H, th);
    ctx.fillStyle = th.fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(g.line, x + PAD, y + TOOLTIP_H / 2);
  },

  text: {
    get: (body) => body.text,
    set: (body, text) => ({ ...body, text }),
    at: (g) => ({ x: g.x, y: g.y }),
  },
};
