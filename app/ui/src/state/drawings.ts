import type { Backend, Drawing, DrawingInput, DrawingKind, InstrumentId } from "../backend/types";
import type { DrawingCommand } from "../chart/drawings/layer";
import type { DrawingChange } from "../chart/drawings/state";

/** What the controller needs from the chart (`Chart` implements it). */
export interface DrawingSurface {
  setDrawings(list: Drawing[]): void;
  setDrawingMagnet(on: boolean): void;
  setDrawingTool(kind: DrawingKind | null): void;
  drawingCommand(cmd: DrawingCommand): boolean;
  onDrawingCommit(cb: ((c: DrawingChange) => void) | null): void;
  onDrawingTool(cb: ((kind: DrawingKind | null) => void) | null): void;
}

type DrawingBackend = Pick<Backend, "getDrawings" | "saveDrawing" | "deleteDrawing">;

/** Where the magnet switch is kept between sessions. */
export interface MagnetPref {
  /** The kept value; null when there is none. */
  load(): boolean | null;
  save(on: boolean): void;
}

const MAGNET_KEY = "sandchart.drawings.magnet";

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

/** The fields the UI sends; the engine sets `priceScale` and `updatedAt`. */
function toInput(d: Drawing): DrawingInput {
  return { id: d.id, instrument: d.instrument, body: d.body, style: d.style, locked: d.locked, hidden: d.hidden, z: d.z };
}

/**
 * Keeps the chart's drawings and the backend in step: loads the instrument's drawings,
 * stores every change the chart reports (undo and redo included) one after another, and
 * mirrors the chart's active tool and the magnet switch for the toolbar. A change that cannot be stored makes
 * it reload the list, so the chart never shows what the backend does not have.
 */
export class DrawingController {
  tool: DrawingKind | null = null;
  /** Points snap to bar prices; kept across sessions. */
  magnet: boolean;
  private surface: DrawingSurface | null = null;
  private id: InstrumentId | null = null;
  /** Token of the latest load. */
  private token = 0;
  /** Stores run one after another, and a load waits for them. */
  private saving: Promise<void> = Promise.resolve();

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
    surface.onDrawingTool((kind) => {
      this.tool = kind;
      this.onChange();
    });
    return () => {
      surface.onDrawingCommit(null);
      surface.onDrawingTool(null);
      if (this.surface !== surface) return;
      this.surface = null;
      this.tool = null;
      this.onChange();
    };
  }

  /** Shows the drawings of `id`: the chart is cleared at once, then filled when they arrive. */
  async open(id: InstrumentId): Promise<void> {
    this.id = id;
    await this.load(id, true);
  }

  toggleTool(kind: DrawingKind): void {
    this.surface?.setDrawingTool(this.tool === kind ? null : kind);
  }

  setTool(kind: DrawingKind | null): void {
    this.surface?.setDrawingTool(kind);
  }

  toggleMagnet(): void {
    this.magnet = !this.magnet;
    this.magnetPref.save(this.magnet);
    this.surface?.setDrawingMagnet(this.magnet);
    this.onChange();
  }

  /** Passes a keyboard command to the chart; false when it did nothing. */
  command(cmd: DrawingCommand): boolean {
    return this.surface?.drawingCommand(cmd) ?? false;
  }

  private async load(id: InstrumentId, blank: boolean): Promise<void> {
    const token = ++this.token;
    if (blank) this.surface?.setDrawings([]);
    await this.saving;
    let list: Drawing[];
    try {
      list = await this.backend.getDrawings(id);
    } catch (e) {
      console.error("loading the drawings failed", e);
      return;
    }
    if (token === this.token) this.surface?.setDrawings(list);
  }

  private store(c: DrawingChange): void {
    const run = c.after
      ? () => this.backend.saveDrawing(toInput(c.after!)).then(() => undefined)
      : () => this.backend.deleteDrawing(c.before!.id);
    this.saving = this.saving.then(run).catch((e: unknown) => {
      console.error("storing a drawing failed", e);
      if (this.id) void this.load(this.id, false);
    });
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
