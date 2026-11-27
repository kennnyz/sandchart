import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IndicatorInfo, IndicatorInstance, ParamSpec, ParamValue } from "../backend/types";
import { t } from "../i18n";
import { resolvedParams, type IndicatorState } from "../state/indicators";

export interface IndicatorSettingsProps {
  state: IndicatorState;
  instance: IndicatorInstance;
  info: IndicatorInfo;
  palette: readonly string[];
  /** Captured output of the last compute; shown when not empty. */
  log: string;
  /** The legend row it opened from, in px of the chart host. */
  anchor: { top: number; bottom: number; left: number };
  hostHeight: number;
  onClose: () => void;
}

/** A number field that applies only whole, in-range values; anything else stays a draft. */
function NumberParam({ spec, value, onValue }: { spec: ParamSpec; value: number; onValue: (v: ParamValue) => void }) {
  const [draft, setDraft] = useState(String(value));
  const isInt = typeof spec.kind === "object" && "int" in spec.kind;
  const [min, max] = typeof spec.kind === "object" && "int" in spec.kind ? spec.kind.int : (spec.kind as { float: [number, number] }).float;
  const n = draft.trim() === "" ? NaN : Number(draft);
  const valid = Number.isFinite(n) && n >= min && n <= max && (!isInt || Number.isInteger(n));
  return (
    <input
      id={`ind-param-${spec.id}`}
      className="mono"
      type="number"
      min={min}
      max={max}
      step={isInt ? 1 : "any"}
      value={draft}
      aria-invalid={!valid}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = e.target.value.trim() === "" ? NaN : Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max && (!isInt || Number.isInteger(v))) {
          onValue(isInt ? { int: v } : { float: v });
        }
      }}
      onBlur={() => !valid && setDraft(String(value))}
    />
  );
}

function ParamControl({ spec, value, onValue }: { spec: ParamSpec; value: ParamValue; onValue: (v: ParamValue) => void }) {
  const id = `ind-param-${spec.id}`;
  let control;
  if (spec.kind === "boolean") {
    control = (
      <input id={id} type="checkbox" checked={"boolean" in value && value.boolean} onChange={(e) => onValue({ boolean: e.target.checked })} />
    );
  } else if ("choice" in spec.kind) {
    control = (
      <select id={id} className="mono" value={"choice" in value ? value.choice : ""} onChange={(e) => onValue({ choice: e.target.value })}>
        {spec.kind.choice.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  } else {
    const n = "int" in value ? value.int : "float" in value ? value.float : 0;
    control = <NumberParam spec={spec} value={n} onValue={onValue} />;
  }
  return (
    <div className="ind-field">
      <label htmlFor={id}>{spec.label}</label>
      {control}
    </div>
  );
}

/** Generated controls for one instance: params, a colour per series and the module output. */
export function IndicatorSettings({ state, instance, info, palette, log, anchor, hostHeight, onClose }: IndicatorSettingsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.bottom + 4);
  const params = resolvedParams(info.meta, instance.params);

  // Below the row when it fits, else above it, never off the chart.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 4;
    setTop(below + h <= hostHeight - 8 ? below : Math.max(8, anchor.top - 4 - h));
  }, [anchor.top, anchor.bottom, hostHeight, log]);

  useEffect(() => ref.current?.querySelector<HTMLElement>("input, select, button")?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const save = (patch: Parameters<IndicatorState["update"]>[1]) =>
    void state.update(instance.instance, patch).catch((e: unknown) => console.error("saving indicator settings failed", e));

  return (
    <div
      ref={ref}
      className="ind-settings"
      data-testid="indicator-settings"
      role="dialog"
      aria-label={`${t("indicators.settings")}: ${info.meta.name}`}
      style={{ top, left: anchor.left }}
    >
      <div className="ind-settings-header">
        <span>{info.meta.name}</span>
        <button className="icon-button" aria-label={t("indicators.close")} title={t("indicators.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {info.meta.params.map((spec, i) => (
        <ParamControl
          key={spec.id}
          spec={spec}
          value={params[i]![1]}
          onValue={(v) => save({ params: params.map(([id, old]) => [id, id === spec.id ? v : old]) })}
        />
      ))}
      {info.meta.series.map((s) => {
        const slot = instance.colors[s.id] ?? s.color;
        return (
          <div key={s.id} className="ind-field">
            <span id={`ind-color-${s.id}`}>{s.label}</span>
            <div className="ind-swatches" role="radiogroup" aria-labelledby={`ind-color-${s.id}`}>
              {palette.map((color, n) => (
                <button
                  key={n}
                  className="ind-swatch"
                  role="radio"
                  aria-checked={n === slot}
                  aria-label={t("indicators.swatch", { n: n + 1 })}
                  title={t("indicators.color", { series: s.label })}
                  style={{ background: color }}
                  onClick={() => save({ colors: { ...instance.colors, [s.id]: n } })}
                />
              ))}
            </div>
          </div>
        );
      })}
      {log !== "" && (
        <div className="ind-log">
          <div className="ind-section">{t("indicators.log")}</div>
          <pre className="mono">{log}</pre>
        </div>
      )}
    </div>
  );
}
