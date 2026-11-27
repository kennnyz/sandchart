import {
  toProblem,
  type Backend,
  type ComputedIndicator,
  type FailedIndicator,
  type IndicatorInfo,
  type IndicatorList,
  type IndicatorInstance,
  type IndicatorMeta,
  type InstrumentId,
  type ParamValue,
  type TimeframeCode,
} from "../backend/types";
import type { IndicatorLayer } from "../chart/indicators";

/** Live recomputes run at most this often; the trailing one always runs. */
export const RECOMPUTE_DEBOUNCE_MS = 250;

/** The chart a compute is for; `fromTime` is the time of its first loaded bar. */
export interface ComputeTarget {
  id: InstrumentId;
  tf: TimeframeCode;
  fromTime: number;
}

type Result = { computed: ComputedIndicator; error: null } | { computed: null; error: string };

const keyOf = (c: ComputeTarget) => `${c.id.source}/${c.id.symbol}/${c.tf}`;

/** Every param of `meta` with the saved value when it is still valid, else the default. */
export function resolvedParams(meta: IndicatorMeta, saved: [string, ParamValue][]): [string, ParamValue][] {
  return meta.params.map((spec) => {
    const v = saved.find(([id]) => id === spec.id)?.[1];
    return [spec.id, v !== undefined && validParam(spec.kind, v) ? v : spec.default];
  });
}

function validParam(kind: IndicatorMeta["params"][number]["kind"], v: ParamValue): boolean {
  if (kind === "boolean") return "boolean" in v;
  if ("int" in kind) return "int" in v && Number.isInteger(v.int) && v.int >= kind.int[0] && v.int <= kind.int[1];
  if ("float" in kind) return "float" in v && v.float >= kind.float[0] && v.float <= kind.float[1];
  return "choice" in v && kind.choice.includes(v.choice);
}

/**
 * The chart's indicator instances, the installed modules and the latest results.
 * Every change of the instance list is saved before it is recomputed (the engine
 * computes the saved list). A result is applied only when its request is still the
 * latest and was made for the current chart, so a slow compute for a chart the user
 * already left never draws.
 */
export class IndicatorState {
  instances: IndicatorInstance[] = [];
  infos: IndicatorInfo[] = [];
  /** Modules that could not be loaded; their chart instances stay stored in the engine. */
  failed: FailedIndicator[] = [];
  /** Why the indicator service could not do its work, from the last list. */
  serviceError: string | null = null;
  /** Why the last `load` failed; null once one succeeded. */
  loadError: string | null = null;
  /** The list the engine has: the last one loaded or saved. A failed save goes back to it. */
  private saved: IndicatorInstance[] = [];
  /** Number of the latest save; only its failure rolls back (a newer save carries the change too). */
  private saveSeq = 0;
  private results = new Map<string, Result>();
  /** Bumped on every change; `layers()` is rebuilt only when it moved. */
  private version = 0;
  private layersCache: { version: number; layers: IndicatorLayer[] } | null = null;
  /** Token of the latest compute request. */
  private token = 0;
  /** Token of the latest request while it runs. */
  private running: number | null = null;
  /** The chart of the last `recompute`; null after `clear`. */
  private target: ComputeTarget | null = null;
  private key: string | null = null;
  /** A debounced compute is scheduled. */
  private due = false;
  /** A debounced compute came due while the latest one ran: run it when that ends. */
  private again = false;
  /** Saves run one after another, so the engine never sees an older list last. */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: Backend,
    private readonly onChange: () => void,
    // A wrapper, not `setTimeout` itself: called as a method, WebKit throws on the foreign `this`.
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  /**
   * Installed modules and the saved instances; computes if a chart is set. A failure is
   * kept in `loadError` (shown by the dialog, which retries) and rethrown.
   */
  async load(): Promise<void> {
    let list: IndicatorList;
    let instances: IndicatorInstance[];
    try {
      [list, instances] = await Promise.all([this.backend.listIndicators(), this.backend.getChartIndicators()]);
    } catch (e) {
      this.loadError = toProblem(e).message;
      this.changed();
      throw new Error(this.loadError);
    }
    this.loadError = null;
    this.setList(list);
    this.instances = instances;
    this.saved = instances;
    this.changed();
    if (this.target) void this.run(this.target);
  }

  /** Installs (or replaces) a module; instances of a replaced module are recomputed. */
  async install(bytes: Uint8Array): Promise<void> {
    const info = await this.backend.installIndicator(bytes);
    this.setList(await this.backend.listIndicators());
    this.changed();
    if (this.target && this.instances.some((i) => i.moduleId === info.meta.id)) void this.run(this.target);
  }

  private setList(list: IndicatorList): void {
    this.infos = list.indicators;
    this.failed = list.failed;
    this.serviceError = list.error;
  }

  info(moduleId: string): IndicatorInfo | undefined {
    return this.infos.find((i) => i.meta.id === moduleId);
  }

  /** Puts a new instance of `moduleId` on the chart with default params and colours. */
  async add(moduleId: string): Promise<void> {
    const info = this.info(moduleId);
    if (!info) return;
    const colors: Record<string, number> = {};
    for (const s of info.meta.series) colors[s.id] = s.color;
    this.instances = [
      ...this.instances,
      {
        instance: crypto.randomUUID(),
        moduleId,
        params: info.meta.params.map((p) => [p.id, p.default]),
        colors,
        hidden: false,
      },
    ];
    await this.saveAndRecompute();
  }

  async update(
    instance: string,
    patch: Partial<Pick<IndicatorInstance, "params" | "colors" | "hidden">>,
  ): Promise<void> {
    if (!this.instances.some((i) => i.instance === instance)) return;
    this.instances = this.instances.map((i) => (i.instance === instance ? { ...i, ...patch } : i));
    // Colours only change the drawing; params and visibility change what is computed.
    await this.saveAndRecompute(patch.params !== undefined || patch.hidden !== undefined);
  }

  async remove(instance: string): Promise<void> {
    this.instances = this.instances.filter((i) => i.instance !== instance);
    this.results.delete(instance);
    await this.saveAndRecompute(false);
  }

  /** Uninstalls a module; the engine drops its chart instances, so both are re-read. */
  async uninstall(moduleId: string): Promise<void> {
    await this.saving;
    await this.backend.removeIndicator(moduleId);
    const [list, instances] = await Promise.all([this.backend.listIndicators(), this.backend.getChartIndicators()]);
    this.setList(list);
    this.instances = instances;
    this.saved = instances;
    this.changed();
  }

  /**
   * Computes the visible instances for `chart`: at once when `now`, else at most every
   * RECOMPUTE_DEBOUNCE_MS with the latest arguments (live candles).
   */
  recompute(chart: ComputeTarget, now = false): void {
    this.target = chart;
    this.key = keyOf(chart);
    if (now) {
      this.due = false;
      this.again = false;
      void this.run(chart);
      return;
    }
    if (this.due) return;
    this.due = true;
    this.schedule(() => {
      if (!this.due) return;
      this.due = false;
      if (this.running !== null) this.again = true;
      else if (this.target) void this.run(this.target);
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  /** The chart switched or closed: drops every result and every compute in flight or due. */
  clear(): void {
    this.token++;
    this.running = null;
    this.target = null;
    this.key = null;
    this.due = false;
    this.again = false;
    if (this.results.size > 0) {
      this.results = new Map();
      this.changed();
    }
  }

  /** The visible instances with an installed module, in order, as the chart draws them. */
  layers(): IndicatorLayer[] {
    if (this.layersCache?.version === this.version) return this.layersCache.layers;
    const layers: IndicatorLayer[] = [];
    for (const inst of this.instances) {
      const info = this.info(inst.moduleId);
      if (inst.hidden || !info) continue;
      const r = this.results.get(inst.instance);
      layers.push({
        instance: inst.instance,
        meta: info.meta,
        colors: inst.colors,
        computed: r?.computed ?? null,
        error: r?.error ?? null,
        repaints: info.repaints,
      });
    }
    this.layersCache = { version: this.version, layers };
    return layers;
  }

  /** The latest result of `instance`, if any. */
  result(instance: string): Result | undefined {
    return this.results.get(instance);
  }

  /**
   * Saves the local list, then computes it. A failed save puts the list back to what the
   * engine has (so the legend never shows params other than the computed ones) and
   * rejects with the reason for the caller to show.
   */
  private async saveAndRecompute(compute = true): Promise<void> {
    this.changed();
    const items = this.instances.map((i) => ({ ...i }));
    const seq = ++this.saveSeq;
    const save = this.saving.then(() => this.backend.setChartIndicators(items));
    this.saving = save.catch(() => undefined);
    try {
      await save;
    } catch (e) {
      if (seq === this.saveSeq) {
        this.instances = this.saved;
        this.changed();
        // A removed instance comes back without its result: compute it again.
        const missing = this.instances.some((i) => !i.hidden && !this.results.has(i.instance));
        if (missing && this.target) void this.run(this.target);
      }
      throw new Error(toProblem(e).message);
    }
    this.saved = items;
    if (compute && this.target) void this.run(this.target);
  }

  private async run(target: ComputeTarget): Promise<void> {
    const token = ++this.token;
    const key = keyOf(target);
    this.running = token;
    let next: Map<string, Result>;
    try {
      const res = await this.backend.computeIndicators(target.id, target.tf, target.fromTime);
      next = new Map(
        res.map((r): [string, Result] => [
          r.instance,
          "ok" in r.result ? { computed: r.result.ok, error: null } : { computed: null, error: r.result.err },
        ]),
      );
    } catch (e) {
      const error = toProblem(e).message;
      next = new Map(this.instances.filter((i) => !i.hidden).map((i): [string, Result] => [i.instance, { computed: null, error }]));
    }
    if (token !== this.token) return;
    this.running = null;
    // The latest request, but the chart moved on since (a debounced call for another key).
    if (key === this.key) {
      this.results = next;
      this.changed();
    }
    if (this.again && this.target) {
      this.again = false;
      void this.run(this.target);
    }
  }

  private changed(): void {
    this.version++;
    this.onChange();
  }
}

/** An `IndicatorState` that React components subscribe to (`useSyncExternalStore`). */
export interface IndicatorStore {
  state: IndicatorState;
  subscribe(cb: () => void): () => void;
  version(): number;
}

export function indicatorStore(backend: Backend): IndicatorStore {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = new IndicatorState(backend, () => {
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
