import type { Alert, AlertDirection, Backend, Drawing, InstrumentId } from "../backend/types";
import { toProblem } from "../backend/types";

type AlertBackend = Pick<
  Backend,
  "getAlerts" | "setAlert" | "rearmAlert" | "deleteAlert" | "onAlertFired" | "onAlertsChanged"
>;

/** How long the toast of a fired alert stays unless it is closed. */
export const TOAST_MS = 12_000;

/**
 * The alerts as the engine has them (ADR 0007): the list for the panel, the toast of the
 * last one that fired, and which fired ones were not looked at yet. Every change goes to
 * the engine, and the list is read back after it and whenever the engine says it changed,
 * so the UI never shows an alert the engine does not have.
 */
export class AlertController {
  list: Alert[] = [];
  /** Fired in this session and not looked at yet; highlighted in the panel. */
  unseen = new Set<string>();
  /** The last alert that fired, while its toast shows. */
  toast: Alert | null = null;
  /** Why the last change was refused; null once one succeeds. */
  error: string | null = null;
  private token = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly backend: AlertBackend,
    private readonly onChange: () => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Loads the list and listens to the engine; the returned function stops listening. */
  start(): () => void {
    let alive = true;
    const stops: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((stop) => (alive ? stops.push(stop) : stop())).catch((e: unknown) => console.error("listening to alerts failed", e));
    keep(this.backend.onAlertFired((a) => this.fired(a)));
    keep(this.backend.onAlertsChanged(() => void this.load()));
    void this.load();
    return () => {
      alive = false;
      for (const s of stops) s();
      if (this.toastTimer) clearTimeout(this.toastTimer);
    };
  }

  async load(): Promise<void> {
    const token = ++this.token;
    try {
      const list = await this.backend.getAlerts();
      if (token !== this.token) return;
      this.list = list;
      // A fired alert that was deleted or armed again is no longer news.
      for (const id of this.unseen) if (!list.some((a) => a.id === id && !a.active)) this.unseen.delete(id);
      this.onChange();
    } catch (e) {
      console.error("loading the alerts failed", e);
    }
  }

  /** The alert that follows a drawing, if any. */
  forDrawing(drawingId: string): Alert | undefined {
    return this.list.find((a) => a.kind.kind === "drawing" && a.kind.drawingId === drawingId);
  }

  /** A price alert at `price` ticks of `instrument` (at `priceScale`). */
  createPrice(instrument: InstrumentId, priceScale: number, price: number, direction: AlertDirection = "cross"): Promise<void> {
    return this.change(() =>
      this.backend.setAlert({ id: this.newId(), instrument, priceScale, kind: { kind: "price", price }, direction }),
    );
  }

  /**
   * Sets the alert of a line drawing: a new one, or the same id with another direction (which
   * arms it again). `saved` resolves once the drawing is stored, so the engine knows it.
   */
  setForDrawing(d: Drawing, direction: AlertDirection, saved: Promise<void> = Promise.resolve()): Promise<void> {
    const id = this.forDrawing(d.id)?.id ?? this.newId();
    return this.change(async () => {
      await saved;
      return this.backend.setAlert({
        id,
        instrument: d.instrument,
        priceScale: d.priceScale,
        kind: { kind: "drawing", drawingId: d.id },
        direction,
      });
    });
  }

  rearm(id: string): Promise<void> {
    this.unseen.delete(id);
    return this.change(() => this.backend.rearmAlert(id));
  }

  remove(id: string): Promise<void> {
    this.unseen.delete(id);
    if (this.toast?.id === id) this.dismissToast();
    return this.change(() => this.backend.deleteAlert(id));
  }

  /** The fired alert was looked at: no highlight any more. */
  seen(id: string): void {
    if (this.unseen.delete(id)) this.onChange();
  }

  dismissToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    if (this.toast === null) return;
    this.toast = null;
    this.onChange();
  }

  private fired(a: Alert): void {
    this.unseen.add(a.id);
    this.toast = a;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.dismissToast(), TOAST_MS);
    this.list = this.list.map((x) => (x.id === a.id ? a : x));
    this.onChange();
    void this.load();
  }

  private async change(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
      this.error = null;
    } catch (e) {
      console.error("changing an alert failed", e);
      this.error = toProblem(e).message;
    }
    await this.load();
    this.onChange();
  }
}

/** An `AlertController` that React components subscribe to (`useSyncExternalStore`). */
export interface AlertStore {
  state: AlertController;
  subscribe(cb: () => void): () => void;
  version(): number;
}

export function alertStore(backend: AlertBackend): AlertStore {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = new AlertController(backend, () => {
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
