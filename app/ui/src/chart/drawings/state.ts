import type { Anchor, Drawing, DrawingBody, DrawingStyle, InstrumentId } from "../../backend/types";
import type { Coords } from "./geometry";
import { toolById, type ToolDef, type ToolId } from "./registry";

/** One stored change: a new drawing (`before` null), an edit, or a delete (`after` null). */
export interface DrawingChange {
  before: Drawing | null;
  after: Drawing | null;
}

/** What the style popover changes: the look, the lock, or the tool's options in the body. */
export type DrawingPatch = Partial<Pick<Drawing, "style" | "locked" | "body">>;

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
  tool(id: ToolId | null): void;
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
  tool: ToolId | null = null;
  /** Points placed so far with the active tool. */
  points: Anchor[] = [];
  /** A new drawing of a text tool waiting for its text (see `ToolDef.text`); not stored yet. */
  draft: Drawing | null = null;
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
    this.draft = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  byId(id: string): Drawing | undefined {
    return this.drawings.find((d) => d.id === id);
  }

  setTool(id: ToolId | null): void {
    this.points = [];
    if (id !== null) this.selected = null;
    if (id === this.tool) return;
    this.tool = id;
    this.listener.tool(id);
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
   * it is stored, selected, and the tool is put down (a sticky tool stays, nothing is selected).
   * A text tool's drawing is not stored but becomes the `draft`.
   */
  place(a: Anchor, horizontal: boolean, c: Coords): Drawing | null {
    const tool = this.tool ? toolById(this.tool) : undefined;
    if (!tool || !this.owner) return null;
    const p = this.nextPoint(a, horizontal);
    const last = this.points.at(-1);
    if (last && last.t === p.t && last.p === p.p) return null;
    this.points.push(p);
    if (this.points.length < tool.placement.clicks) return null;
    return this.complete(tool, this.owner, c);
  }

  /** The pressed pointer of a stroke tool reached `a`; a repeated point is dropped. */
  stroke(a: Anchor): void {
    const tool = this.tool ? toolById(this.tool) : undefined;
    if (!tool?.placement.stroke) return;
    const last = this.points.at(-1);
    if (!last || last.t !== a.t || last.p !== a.p) this.points.push({ t: a.t, p: a.p });
  }

  /** The stroke ended: the drawing when it has enough points (see `place`), else nothing. */
  endStroke(c: Coords): Drawing | null {
    const tool = this.tool ? toolById(this.tool) : undefined;
    if (!tool?.placement.stroke || !this.owner || this.points.length < tool.placement.clicks) {
      this.points = [];
      return null;
    }
    return this.complete(tool, this.owner, c);
  }

  /** Makes and stores the drawing from the placed points; a tool that is not sticky is put down. */
  private complete(tool: ToolDef, owner: Owner, c: Coords): Drawing {
    const d: Drawing = {
      id: this.newId(),
      instrument: { ...owner.instrument },
      priceScale: owner.priceScale,
      body: tool.create(this.points, c),
      style: { ...DEFAULT_STYLE },
      locked: false,
      z: this.drawings.reduce((z, o) => Math.max(z, o.z), 0) + 1,
      updatedAt: 0,
    };
    this.points = [];
    if (tool.text) {
      this.draft = d;
      this.selected = null;
      this.setTool(null);
      return d;
    }
    this.record({ before: null, after: d });
    if (tool.sticky) {
      this.selected = null;
    } else {
      this.selected = d.id;
      this.setTool(null);
    }
    return d;
  }

  /** Stores the draft with this body (its text written) and selects it; null without a draft. */
  commitDraft(body: DrawingBody): Drawing | null {
    const draft = this.draft;
    if (!draft) return null;
    this.draft = null;
    const d = { ...draft, body };
    this.record({ before: null, after: d });
    return d;
  }

  /** Replaces the body of a drawing; false when it is unknown, locked or unchanged. */
  edit(id: string, body: DrawingBody): boolean {
    const d = this.byId(id);
    if (!d || d.locked || sameBody(d.body, body)) return false;
    this.record({ before: d, after: { ...d, body } });
    return true;
  }

  /**
   * Changes style, lock or body of a drawing as one undo step, locked or not (the lock
   * only keeps it from being dragged); false when it is unknown or nothing changes.
   */
  update(id: string, patch: DrawingPatch): boolean {
    const d = this.byId(id);
    if (!d) return false;
    const next: Drawing = { ...d, ...patch };
    const same =
      next.locked === d.locked &&
      next.style.color === d.style.color &&
      next.style.width === d.style.width &&
      next.style.dash === d.style.dash &&
      sameBody(next.body, d.body);
    if (same) return false;
    this.record({ before: d, after: next });
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

  /**
   * The engine stored `sent` as `saved` (rescaled to a new price scale): `saved` takes its
   * place in the history, and in the list unless a later change replaced it there. Not a
   * new change, so nothing is committed. True when the list changed.
   */
  stored(sent: Drawing, saved: Drawing): boolean {
    const swap = (d: Drawing | null) => (d === sent ? saved : d);
    for (const stack of [this.undoStack, this.redoStack]) {
      for (let i = 0; i < stack.length; i++) {
        const c = stack[i]!;
        if (c.before === sent || c.after === sent) stack[i] = { before: swap(c.before), after: swap(c.after) };
      }
    }
    const i = this.drawings.indexOf(sent);
    if (i < 0) return false;
    this.drawings[i] = saved;
    return true;
  }

  /** Esc: drops the placed points, the draft, the tool and the selection; false when there was none. */
  cancel(): boolean {
    const any = this.points.length > 0 || this.tool !== null || this.selected !== null || this.draft !== null;
    this.draft = null;
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
