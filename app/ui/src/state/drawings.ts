import type {
  Backend,
  Drawing,
  DrawingBody,
  DrawingInput,
  InstrumentId,
  PositionBody,
  PositionOutcome,
  TimeframeCode,
} from "../backend/types";
import { toProblem } from "../backend/types";
import type { DrawingCommand, MenuAction, MenuEdit, StyleAction, StyleEdit, TextEdit, TextResult } from "../chart/drawings/layer";
import type { ToolId } from "../chart/drawings/registry";
import type { DrawingChange, DrawingPatch } from "../chart/drawings/state";

/** What the controller needs from the chart (`Chart` implements it). */
export interface DrawingSurface {
  setDrawings(list: Drawing[]): void;
  setDrawingMagnet(on: boolean): void;
  setDrawingTool(id: ToolId | null): void;
  drawingCommand(cmd: DrawingCommand): boolean;
  setPositionOutcomes(outcomes: ReadonlyMap<string, PositionOutcome>): void;
  /** The engine stored `sent` as `saved`, rescaled to the instrument's new price scale. */
  drawingStored(sent: Drawing, saved: Drawing): void;
  finishDrawingText(result: TextResult): void;
  drawingStyle(action: StyleAction): void;
  setDrawingsHidden(on: boolean): void;
  drawingMenu(action: MenuAction): void;
  showHiddenDrawings(): void;
  /** Stores a whole drawing of the chart's pair (from a menu), selected. */
  addDrawing(body: DrawingBody): void;
  onDrawingCommit(cb: ((step: DrawingChange[]) => void) | null): void;
  onDrawingTool(cb: ((id: ToolId | null) => void) | null): void;
  onDrawingText(cb: ((edit: TextEdit | null) => void) | null): void;
  onDrawingStyle(cb: ((edit: StyleEdit | null) => void) | null): void;
  onDrawingMenu(cb: ((edit: MenuEdit | null) => void) | null): void;
  /** Asks before deleting drawings: true when `cb` took the question (and calls `go` on a yes). */
  onDrawingConfirmDelete(cb: ((ids: readonly string[], go: () => void) => boolean) | null): void;
}

/** Drawings about to be deleted that have alerts: waiting for a yes (see `DrawingController.askDelete`). */
export interface DeleteQuestion {
  /** How many drawings would go, and how many of them have an alert. */
  count: number;
  alerts: number;
  go: () => void;
}

/** A failed store, or a failed load (the chart then shows no drawings). */
export interface DrawingError {
  kind: "save" | "load";
  message: string;
}

type DrawingBackend = Pick<Backend, "getDrawings" | "saveDrawings" | "deleteDrawings" | "getPositionOutcomes">;

/** Where the magnet switch is kept between sessions. */
export interface MagnetPref {
  /** The kept value; null when there is none. */
  load(): boolean | null;
  save(on: boolean): void;
}

const MAGNET_KEY = "sandchart.drawings.magnet";
/** A load asks again at most this many times while changes keep coming in. */
const LOAD_TRIES = 3;

/** The magnet switch in localStorage; without storage it lasts for this session. */
export const localMagnetPref: MagnetPref = {
  load() {
    try {
      const v = globalThis.localStorage?.getItem(MAGNET_KEY);
      return v === "1" ? true : v === "0" ? false : null;
    } catch {
      return null;
    }
  },
  save(on) {
    try {
      globalThis.localStorage?.setItem(MAGNET_KEY, on ? "1" : "0");
    } catch {
      // No storage: the choice lasts for this session only.
    }
  },
};

/** The fields the UI sends; the engine sets `updatedAt` and rescales from `priceScale` if it changed. */
function toInput(d: Drawing): DrawingInput {
  return { id: d.id, instrument: d.instrument, priceScale: d.priceScale, body: d.body, style: d.style, locked: d.locked, hidden: d.hidden, z: d.z };
}

/** The position of a shown position drawing; null for any other, and for a hidden one (not painted, so not asked). */
function positionOf(d: Drawing | null | undefined): PositionBody | null {
  const body = d?.body;
  if (body?.kind !== "position" || d!.hidden) return null;
  const { side, entry, stop, take, endT } = body;
  return { side, entry, stop, take, endT };
}

const sameId = (a: InstrumentId, b: InstrumentId) => a.source === b.source && a.symbol === b.symbol;

/**
 * Keeps the chart's drawings and the backend in step: loads the instrument's drawings,
 * stores every step the chart reports (undo and redo included) one after another, each in
 * one call, and
 * mirrors the chart's active tool and the magnet switch for the toolbar. A change that cannot be stored makes
 * it reload the list, so the chart never shows what the backend does not have, and keeps
 * the error to show until a later change is stored or another instrument opens.
 *
 * It also asks the engine for the outcomes of the positions, all in one call: after a
 * load, after a position changes, and when the candles of the timeframe change (another
 * timeframe, an older page, a new bar). A take or a stop is final for that body, so only
 * open and unknown ones are asked again. A changed position loses its outcome at once.
 */
export class DrawingController {
  tool: ToolId | null = null;
  /** The text editor the chart has open, for the popover; null when closed. */
  textEdit: TextEdit | null = null;
  /** The style popover the chart has open; null when closed. */
  styleEdit: StyleEdit | null = null;
  /** The context menu the chart has open; null when closed. */
  menu: MenuEdit | null = null;
  /** A delete that would take alerts with it, waiting for the answer; null when none. */
  deleteQuestion: DeleteQuestion | null = null;
  /** Whether a drawing has an alert (set by the view from the alerts); none without it. */
  private hasAlert: (id: string) => boolean = () => false;
  /** Points snap to bar prices; kept across sessions. */
  magnet: boolean;
  /** Hide all: for this session only, the drawings are not changed. */
  hidden = false;
  /** Why the last store or load failed; null once a store succeeds or another instrument opens. */
  error: DrawingError | null = null;
  /** Ids of the shown pair's drawings hidden one by one (stored `hidden`). */
  private hiddenIds = new Set<string>();
  private surface: DrawingSurface | null = null;
  private id: InstrumentId | null = null;
  /** Token of the latest load. */
  private token = 0;
  /** Changes the chart reported, to tell whether one came while a list was loading. */
  private commits = 0;
  /** The last load failed: the chart may not show what is stored. */
  private stale = false;
  /** Stores run one after another, and a load waits for them. */
  private saving: Promise<void> = Promise.resolve();
  /** The positions of the shown drawings (not hidden one by one), by id; a body is replaced, never changed in place. */
  private positions = new Map<string, PositionBody>();
  private outcomes = new Map<string, PositionOutcome>();
  /** Timeframe of the outcomes, and of the candles last shown with their first and last bar time. */
  private tf: TimeframeCode | null = null;
  private bars: { tf: TimeframeCode; first: number; last: number } | null = null;
  /** Token of the latest outcome request, and of the latest one that asked each position. */
  private outcomeToken = 0;
  private asked = new Map<string, number>();

  constructor(
    private readonly backend: DrawingBackend,
    private readonly onChange: () => void,
    private readonly magnetPref: MagnetPref = localMagnetPref,
  ) {
    this.magnet = magnetPref.load() ?? false;
  }

  /** Connects a chart; the returned function disconnects it. */
  attach(surface: DrawingSurface): () => void {
    this.surface = surface;
    surface.setDrawingMagnet(this.magnet);
    surface.onDrawingCommit((c) => this.store(c));
    surface.onDrawingTool((id) => {
      this.tool = id;
      this.onChange();
    });
    surface.onDrawingText((edit) => {
      this.textEdit = edit;
      this.onChange();
    });
    surface.onDrawingStyle((edit) => {
      this.styleEdit = edit;
      this.onChange();
    });
    surface.onDrawingMenu((edit) => {
      this.menu = edit;
      this.onChange();
    });
    surface.onDrawingConfirmDelete((ids, go) => this.askDelete(ids, go));
    surface.setDrawingsHidden(this.hidden);
    return () => {
      surface.onDrawingCommit(null);
      surface.onDrawingTool(null);
      surface.onDrawingText(null);
      surface.onDrawingStyle(null);
      surface.onDrawingMenu(null);
      surface.onDrawingConfirmDelete(null);
      if (this.surface !== surface) return;
      this.deleteQuestion = null;
      this.surface = null;
      this.tool = null;
      this.textEdit = null;
      this.styleEdit = null;
      this.menu = null;
      this.onChange();
    };
  }

  /** Tells which drawings have alerts, so deleting one asks first. */
  setAlertCheck(hasAlert: (id: string) => boolean): void {
    this.hasAlert = hasAlert;
  }

  /**
   * Deleting `ids` would delete the alerts of the lines among them too (in the engine, with
   * the drawing), and undo brings back the drawing only: ask first. False when none has an alert.
   */
  private askDelete(ids: readonly string[], go: () => void): boolean {
    const alerts = ids.filter((id) => this.hasAlert(id)).length;
    if (alerts === 0) return false;
    this.deleteQuestion = { count: ids.length, alerts, go };
    this.onChange();
    return true;
  }

  /** The answer to `deleteQuestion`: yes deletes them (the ones still there), no keeps them. */
  answerDelete(yes: boolean): void {
    const q = this.deleteQuestion;
    if (!q) return;
    this.deleteQuestion = null;
    this.onChange();
    if (yes) q.go();
  }

  /** Shows the drawings of `id`: the chart is cleared at once, then filled when they arrive. */
  async open(id: InstrumentId): Promise<void> {
    // A question about the old pair's drawings is void.
    this.deleteQuestion = null;
    this.id = id;
    this.bars = null;
    this.setError(null);
    await this.load(id, true);
  }

  /**
   * The chart shows candles of `id` at `tf` from `first` to `last` (open times). When any
   * of these changed (so on every new bar), the positions still open are asked for again;
   * a take or a stop is final, unless older bars came in before its entry.
   */
  candles(id: InstrumentId, tf: TimeframeCode, first: number, last: number): void {
    if (!this.id || !sameId(id, this.id)) return;
    const was = this.bars;
    if (was && was.tf === tf && was.first === first && was.last === last) return;
    this.bars = { tf, first, last };
    if (tf !== this.tf) {
      this.tf = tf;
      this.setOutcomes(new Map());
    }
    const older = was && was.tf === tf && first < was.first ? was.first : null;
    void this.refreshOutcomes(older);
  }

  /**
   * The chart's bars were replaced by others of the same timeframe (a replay started or
   * ended): every outcome is dropped, also a final one, and answers still on the way are
   * ignored. The next `candles` asks for all of them again.
   */
  resetOutcomes(): void {
    this.outcomeToken++;
    this.asked.clear();
    this.bars = null;
    this.setOutcomes(new Map());
  }

  /** Picking a tool shows hidden drawings again: a new one should not be placed unseen. */
  toggleTool(id: ToolId): void {
    if (this.tool !== id) this.setHidden(false);
    this.surface?.setDrawingTool(this.tool === id ? null : id);
  }

  setTool(id: ToolId | null): void {
    if (id !== null) this.setHidden(false);
    this.surface?.setDrawingTool(id);
  }

  toggleHidden(): void {
    this.setHidden(!this.hidden);
  }

  private setHidden(on: boolean): void {
    if (on === this.hidden) return;
    this.hidden = on;
    this.surface?.setDrawingsHidden(on);
    this.onChange();
  }

  /** A horizontal line at exactly `price` (ticks), from the "+" menu; hide all is turned off, so it is not placed unseen. */
  addLevel(price: number): void {
    this.setHidden(false);
    this.surface?.addDrawing({ kind: "hline", p: price });
  }

  /** How many drawings of the shown pair are hidden one by one. */
  get hiddenCount(): number {
    return this.hiddenIds.size;
  }

  /** Shows them all again (one undo step); hide all is turned off too. */
  showHidden(): void {
    this.setHidden(false);
    this.surface?.showHiddenDrawings();
  }

  /** Runs an item of the open context menu, or closes it (null). */
  menuAction(action: MenuAction): void {
    this.surface?.drawingMenu(action);
  }

  /** Changes style, lock or options of the drawing in the style popover: one stored change. */
  restyle(patch: DrawingPatch): void {
    this.surface?.drawingStyle({ patch });
  }

  /** Deletes the drawing of the style popover. */
  deleteStyled(): void {
    this.surface?.drawingStyle({ delete: true });
  }

  closeStyle(): void {
    this.surface?.drawingStyle(null);
  }

  /** Saves the text of the open editor (empty: no note). */
  saveText(text: string): void {
    this.surface?.finishDrawingText({ text });
  }

  /** Deletes the drawing of the open editor. */
  deleteText(): void {
    this.surface?.finishDrawingText({ delete: true });
  }

  /** Closes the open editor without a change. */
  cancelText(): void {
    this.surface?.finishDrawingText(null);
  }

  toggleMagnet(): void {
    this.magnet = !this.magnet;
    this.magnetPref.save(this.magnet);
    this.surface?.setDrawingMagnet(this.magnet);
    this.onChange();
  }

  /** Resolves once every change reported so far was stored (or failed). */
  settled(): Promise<void> {
    return this.saving;
  }

  /** Passes a keyboard command to the chart; false when it did nothing. */
  command(cmd: DrawingCommand): boolean {
    return this.surface?.drawingCommand(cmd) ?? false;
  }

  private async load(id: InstrumentId, blank: boolean): Promise<void> {
    const token = ++this.token;
    if (blank) this.show([]);
    let list: Drawing[];
    try {
      // A change made while the list is on its way is stored after it was read: the list
      // would wipe it off the chart (and the undo history). Then load again after its store.
      for (let tries = 1; ; tries++) {
        await this.saving;
        if (token !== this.token) return;
        const commits = this.commits;
        list = await this.backend.getDrawings(id);
        if (token !== this.token || commits === this.commits) break;
        if (tries === LOAD_TRIES) {
          console.error(`the drawings kept changing during ${LOAD_TRIES} loads; showing the last one`);
          break;
        }
      }
    } catch (e) {
      console.error("loading the drawings failed", e);
      if (token !== this.token) return;
      // Whatever the chart shows may not be stored: show nothing and say why. The next
      // stored change loads the list again.
      this.stale = true;
      this.show([]);
      this.setError({ kind: "load", message: toProblem(e).message });
      return;
    }
    if (token !== this.token) return;
    this.stale = false;
    this.show(list);
    void this.refreshOutcomes();
  }

  /** Puts `list` on the chart and tracks its positions; their outcomes start unknown. */
  private show(list: Drawing[]): void {
    this.surface?.setDrawings(list);
    this.hiddenIds = new Set(list.filter((d) => d.hidden).map((d) => d.id));
    this.onChange();
    this.positions = new Map();
    this.asked.clear();
    for (const d of list) {
      const p = positionOf(d);
      if (p) this.positions.set(d.id, p);
    }
    this.setOutcomes(new Map());
  }

  private setOutcomes(outcomes: Map<string, PositionOutcome>): void {
    this.outcomes = outcomes;
    this.surface?.setPositionOutcomes(new Map(outcomes));
  }

  /**
   * Asks in one call for the outcome of every position that has none or is still open, and
   * (`olderThan`) of every one entered before that time. An answer for a position that
   * changed since, or that a later call asked again, is dropped.
   */
  private async refreshOutcomes(olderThan: number | null = null): Promise<void> {
    const id = this.id;
    const tf = this.tf;
    if (!id || !tf) return;
    const sent: { id: string; position: PositionBody }[] = [];
    for (const [drawingId, position] of this.positions) {
      const known = this.outcomes.get(drawingId);
      if (!known || known.status === "open" || (olderThan !== null && position.entry.t < olderThan)) {
        sent.push({ id: drawingId, position });
      }
    }
    if (sent.length === 0) return;
    const token = ++this.outcomeToken;
    for (const p of sent) this.asked.set(p.id, token);
    let answer: { id: string; outcome: PositionOutcome }[];
    try {
      answer = await this.backend.getPositionOutcomes(id, tf, sent);
    } catch (e) {
      console.error("resolving the positions failed", e);
      return;
    }
    if (this.id !== id || this.tf !== tf) return;
    const bodies = new Map(sent.map((s) => [s.id, s.position]));
    let next: Map<string, PositionOutcome> | null = null;
    for (const { id: drawingId, outcome } of answer) {
      const now = this.positions.get(drawingId);
      if (!now || now !== bodies.get(drawingId) || this.asked.get(drawingId) !== token) continue;
      this.asked.delete(drawingId);
      next ??= new Map(this.outcomes);
      next.set(drawingId, outcome);
    }
    if (next) this.setOutcomes(next);
  }

  /** Keeps the positions in step with changes; a changed one loses its outcome and all are asked for again, once. */
  private trackPositions(step: readonly DrawingChange[]): void {
    let next: Map<string, PositionOutcome> | null = null;
    let ask = false;
    for (const c of step) {
      const id = (c.after ?? c.before)!.id;
      const after = positionOf(c.after);
      if (!after && !this.positions.has(id)) continue;
      if (after) this.positions.set(id, after);
      else this.positions.delete(id);
      if (this.outcomes.has(id)) {
        next ??= new Map(this.outcomes);
        next.delete(id);
      }
      ask ||= after !== null;
    }
    if (next) this.setOutcomes(next);
    if (ask) void this.refreshOutcomes();
  }

  private setError(error: DrawingError | null): void {
    if (error?.kind === this.error?.kind && error?.message === this.error?.message) return;
    this.error = error;
    this.onChange();
  }

  /** Keeps the count of hidden drawings in step with a change. */
  private trackHidden(c: DrawingChange): void {
    const id = (c.after ?? c.before)!.id;
    const was = this.hiddenIds.has(id);
    const now = c.after?.hidden === true;
    if (was === now) return;
    if (now) this.hiddenIds.add(id);
    else this.hiddenIds.delete(id);
    this.onChange();
  }

  /** Stores one step in one call: all of it or none (a step only saves or only deletes). */
  private store(step: DrawingChange[]): void {
    if (step.length === 0) return;
    this.commits++;
    this.trackPositions(step);
    for (const c of step) this.trackHidden(c);
    const id = this.id;
    const saves: Drawing[] = [];
    const deletes: string[] = [];
    for (const c of step) {
      if (c.after) saves.push(c.after);
      else deletes.push(c.before!.id);
    }
    const run = async () => {
      if (saves.length > 0) {
        const stored = await this.backend.saveDrawings(saves.map(toInput));
        if (this.id !== id) return;
        // Rescaled: the chart must not keep showing (and later send) the old-scale copy.
        const rescaled: DrawingChange[] = [];
        stored.forEach((saved, i) => {
          const sent = saves[i]!;
          if (saved.priceScale === sent.priceScale) return;
          this.surface?.drawingStored(sent, saved);
          rescaled.push({ before: sent, after: saved });
        });
        this.trackPositions(rescaled);
      }
      if (deletes.length > 0) await this.backend.deleteDrawings(deletes);
    };
    this.saving = this.saving.then(run).then(
      () => {
        if (this.id !== id) return;
        this.setError(null);
        if (this.stale && id) void this.load(id, false);
      },
      (e: unknown) => {
        console.error("storing drawings failed", e);
        if (this.id === id) this.setError({ kind: "save", message: toProblem(e).message });
        if (this.id) void this.load(this.id, false);
      },
    );
  }
}

/** A `DrawingController` that React components subscribe to (`useSyncExternalStore`). */
export interface DrawingStore {
  state: DrawingController;
  subscribe(cb: () => void): () => void;
  version(): number;
}

export function drawingStore(backend: Backend): DrawingStore {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = new DrawingController(backend, () => {
    version++;
    for (const l of listeners) l();
  });
  return {
    state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    version: () => version,
  };
}
