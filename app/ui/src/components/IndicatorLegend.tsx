import { Eye, EyeOff, Settings2, X } from "lucide-react";
import type { IndicatorInfo, IndicatorInstance, ParamValue } from "../backend/types";
import { formatValue } from "../chart/format";
import { hasOwnPane, layoutPanes } from "../chart/indicators";
import { TIME_AXIS_HEIGHT, type ChartTheme } from "../chart/theme";
import { t } from "../i18n";
import { resolvedParams, type IndicatorState } from "../state/indicators";

/** Top of the indicator rows on the price plot: under the two lines of the main legend. */
const PRICE_ROWS_TOP = 54;
const PANE_ROWS_INSET = 4;

export interface IndicatorLegendProps {
  state: IndicatorState;
  /** Instance to series id to value at the crosshair bar (or the last one); see `Chart.indicatorValues`. */
  values: Map<string, Map<string, number>>;
  theme: ChartTheme;
  priceScale: number;
  hostHeight: number;
  onSettings: (instance: string, row: HTMLElement) => void;
}

function paramText(v: ParamValue): string | null {
  if ("int" in v) return String(v.int);
  if ("float" in v) return String(v.float);
  if ("choice" in v) return v.choice;
  return null; // booleans have no short form
}

/** `SMA 20 close`: the name and the param values in order. */
export function indicatorTitle(info: IndicatorInfo, inst: IndicatorInstance): string {
  const parts = resolvedParams(info.meta, inst.params)
    .map(([, v]) => paramText(v))
    .filter((s): s is string => s !== null);
  return [info.meta.name, ...parts].join(" ");
}

interface RowProps extends Omit<IndicatorLegendProps, "hostHeight"> {
  inst: IndicatorInstance;
}

function Row({ state, values, theme, priceScale, onSettings, inst }: RowProps) {
  const info = state.info(inst.moduleId);
  const name = info?.meta.name ?? inst.moduleId;
  const result = inst.hidden ? undefined : state.result(inst.instance);
  const at = values.get(inst.instance);
  const error = result?.error ?? null;
  const action = (p: Promise<void>) => void p.catch((e: unknown) => console.error("changing an indicator failed", e));
  return (
    <div
      className="ind-row"
      data-testid="indicator-legend-row"
      data-instance={inst.instance}
      data-hidden={inst.hidden}
      data-error={error !== null}
    >
      <span className="ind-title" data-testid="indicator-title">
        {info ? indicatorTitle(info, inst) : name}
      </span>
      {info &&
        at &&
        info.meta.series.map((s) => {
          if (s.kind !== "line" && s.kind !== "histogram") return null;
          const v = at.get(s.id);
          const color = theme.indicatorPalette[inst.colors[s.id] ?? s.color] ?? theme.fg;
          const decimals = s.pane === "price" || (v !== undefined && Math.abs(v) < 1) ? Math.max(2, priceScale) : 2;
          return (
            <span key={s.id} className="ind-value mono" data-testid="indicator-value" style={{ color }}>
              {v === undefined ? "—" : formatValue(v, decimals)}
            </span>
          );
        })}
      {info?.repaints && (
        <span className="ind-badge" data-testid="indicator-repaints">
          {t("indicators.repaints")}
        </span>
      )}
      {error !== null && (
        <span className="ind-error" data-testid="indicator-error" style={{ color: theme.down }}>
          {t("indicators.failed", { name, error })}
        </span>
      )}
      <span className="ind-actions">
        <button
          className="ind-action"
          aria-label={inst.hidden ? t("indicators.show") : t("indicators.hide")}
          title={inst.hidden ? t("indicators.show") : t("indicators.hide")}
          onClick={() => action(state.update(inst.instance, { hidden: !inst.hidden }))}
        >
          {inst.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        {info && (
          <button
            className="ind-action"
            aria-label={t("indicators.settings")}
            title={t("indicators.settings")}
            onClick={(e) => onSettings(inst.instance, e.currentTarget.closest<HTMLElement>(".ind-row")!)}
          >
            <Settings2 size={14} />
          </button>
        )}
        <button
          className="ind-action"
          aria-label={t("indicators.remove")}
          title={t("indicators.remove")}
          onClick={() => action(state.remove(inst.instance))}
        >
          <X size={14} />
        </button>
      </span>
    </div>
  );
}

/**
 * One row per chart indicator: on the price plot under the main legend, or at the top
 * of its own pane (laid out like the chart lays the panes out).
 */
export function IndicatorLegend(props: IndicatorLegendProps) {
  const { state, hostHeight } = props;
  const own = state.layers().filter(hasOwnPane);
  const { panes } = layoutPanes(hostHeight - TIME_AXIS_HEIGHT, own.length);
  const paneOf = new Map(own.map((l, i) => [l.instance, i]));
  const priceRows = state.instances.filter((i) => !paneOf.has(i.instance));
  return (
    <>
      {priceRows.length > 0 && (
        <div className="ind-legend" style={{ top: PRICE_ROWS_TOP }}>
          {priceRows.map((inst) => (
            <Row key={inst.instance} {...props} inst={inst} />
          ))}
        </div>
      )}
      {state.instances.map((inst) => {
        const pane = paneOf.get(inst.instance);
        if (pane === undefined) return null;
        return (
          <div key={inst.instance} className="ind-legend" style={{ top: panes[pane]!.top + PANE_ROWS_INSET }}>
            <Row {...props} inst={inst} />
          </div>
        );
      })}
    </>
  );
}
