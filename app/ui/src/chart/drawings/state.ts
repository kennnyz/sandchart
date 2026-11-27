import type { Anchor, Drawing, DrawingBody, DrawingKind, DrawingStyle, InstrumentId } from "../../backend/types";
import type { Coords } from "./geometry";
import { toolFor } from "./registry";

/** One stored change: a new drawing (`before` null), an edit, or a delete (`after` null). */
export interface DrawingChange {
  before: Drawing | null;
  after: Drawing | null;
}

/** The part of a drawing under the pointer: its body or the handle with this index. */
export type Part = "body" | number;

/** Who new drawings belong to: the instrument on the chart and its tick scale. */
export interface Owner {
  instrument: InstrumentId;
  priceScale: number;
}

export interface StateListener {
  /** A change to store; undo and redo come through here too. */
  commit(change: DrawingChange): void;
  /** The active tool changed (picked, placed, cancelled). */
  tool(kind: DrawingKind | null): void;
}

/** Palette slot 0 (blue in both themes), 2 px, solid. */
export const DEFAULT_STYLE: DrawingStyle = { color: 0, width: 2, dash: false };
/** Undo steps kept for the session. */
export const HISTORY_LIMIT = 200;

const byZ = (a: Drawing, b: Drawing) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameBody = (a: DrawingBody, b: DrawingBody) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The drawings of the instrument on the chart and everything the user does with them:
 * selection, hover, the active tool and its placed points, and the undo history. Pure
 * logic without the DOM; every stored change goes to `listener.commit`.
 */
export class DrawingState {
  /** Paint order: z ascending, then id; the last one is on top. */
  drawings: Drawing[] = [];
  selected: string | null = null;
  hover: { id: string; part: Part } | null = null;
  tool: DrawingKind | null = null;
  /** Points placed so far with the active tool. */
  points: Anchor[] = [];
  private owner: Owner | null = null;
  private undoStack: DrawingChange[] = [];
  private redoStack: DrawingChange[] = [];

  constructor(
    private readonly listener: StateListener,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  setOwner(owner: Owner | null): void {
    this.owner = owner;
  }

  /** A new list (another instrument, or reloaded): selection, placement and history start over. */
  reset(list: Drawing[]): void {
    this.drawings = [...list].sort(byZ);
    this.selected = null;
    this.hover = null;
    this.points = [];
    this.undoStack = [];
    this.redoStack = [];
  }

  byId(id: string): Drawing | undefined {
    return this.drawings.find((d) => d.id === id);
  }

  setTool(kind: DrawingKind | null): void {
    this.points = [];
    if (kind !== null) this.selected = null;
    if (kind === this.tool) return;
    this.tool = kind;
    this.listener.tool(kind);
  }

  select(id: string | null): void {
    this.selected = id !== null && this.byId(id) ? id : null;
  }

  /** The placed points plus `mouse` as the next one, for the preview. */
  placingPoints(mouse: Anchor, horizontal: boolean): Anchor[] {
    return [...this.points, this.nextPoint(mouse, horizontal)];
  }

  /**
   * Places the next point of the active tool. Returns the drawing once it is complete:
   * it is stored, selected, and the tool is put down.
   */
  place(a: Anchor, horizontal: boolean, c: Coords): Drawing | null {
    const tool = this.tool ? toolFor(this.tool) : undefined;
    if (!tool || !this.owner) return null;
    const p = this.nextPoint(a, horizontal);
    const last = this.points.at(-1);
    if (last && last.t === p.t && last.p === p.p) return null;
    this.points.push(p);
    if (this.points.length < tool.placement.clicks) return null;
    const d: Drawing = {
      id: this.newId(),
      instrument: { ...this.owner.instrument },
      priceScale: this.owner.priceScale,
      body: tool.create(this.points, c),
      style: { ...DEFAULT_STYLE },
      locked: false,
      hidden: false,
      z: this.drawings.reduce((z, o) => Math.max(z, o.z), 0) + 1,
      updatedAt: 0,
    };
    this.points = [];
    this.record({ before: null, after: d });
    this.selected = d.id;
    this.setTool(null);
    return d;
  }

  /** Replaces the body of a drawing; false when it is unknown, locked or unchanged. */
  edit(id: string, body: DrawingBody): boolean {
    const d = this.byId(id);
    if (!d || d.locked || sameBody(d.body, body)) return false;
    this.record({ before: d, after: { ...d, body } });
    return true;
  }

  deleteSelected(): boolean {
    const d = this.selected ? this.byId(this.selected) : undefined;
    if (!d) return false;
    this.record({ before: d, after: null });
    return true;
  }

  undo(): boolean {
    const c = this.undoStack.pop();
    if (!c) return false;
    this.redoStack.push(c);
    this.apply({ before: c.after, after: c.before });
    return true;
  }

  redo(): boolean {
    const c = this.redoStack.pop();
    if (!c) return false;
    this.undoStack.push(c);
    this.apply(c);
    return true;
  }

  /** Esc: drops the placed points, the tool and the selection; false when there was none. */
  cancel(): boolean {
    const any = this.points.length > 0 || this.tool !== null || this.selected !== null;
    this.selected = null;
    this.setTool(null);
    return any;
  }

  private nextPoint(a: Anchor, horizontal: boolean): Anchor {
    const last = this.points.at(-1);
    return horizontal && last ? { t: a.t, p: last.p } : { t: a.t, p: a.p };
  }

  /** A new change by the user: applied, stored, and the redo steps are dropped. */
  private record(c: DrawingChange): void {
    this.undoStack.push(c);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.apply(c);
  }

  private apply(c: DrawingChange): void {
    const id = (c.after ?? c.before)!.id;
    const rest = this.drawings.filter((d) => d.id !== id);
    if (c.after) {
      rest.push(c.after);
      rest.sort(byZ);
    }
    this.drawings = rest;
    this.selected = c.after ? c.after.id : this.selected === id ? null : this.selected;
    if (this.hover?.id === id && !c.after) this.hover = null;
    this.listener.commit(c);
  }
}
