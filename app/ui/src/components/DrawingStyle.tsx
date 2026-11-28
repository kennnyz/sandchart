import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DrawingBody } from "../backend/types";
import type { StyleEdit } from "../chart/drawings/layer";
import { typing } from "../chart/drawings/keys";
import { toolFor } from "../chart/drawings/registry";
import type { DrawingPatch } from "../chart/drawings/state";
import { FIB_LEVELS } from "../chart/drawings/tools/fib";
import { t } from "../i18n";

export interface DrawingStyleProps {
  edit: StyleEdit;
  palette: readonly string[];
  hostWidth: number;
  hostHeight: number;
  onChange(patch: DrawingPatch): void;
  onDelete(): void;
  onClose(): void;
}

const WIDTH = 248;
/** Gap between the point it opened at and the popover. */
const GAP = 12;
const WIDTHS = [1, 2, 3, 4] as const;

/** The default levels, then any other the drawing holds, in order. */
function fibLevels(levels: readonly number[]): number[] {
  return [...new Set([...FIB_LEVELS, ...levels])].sort((a, b) => a - b);
}

function Toggle({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <div className="ind-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

/** The options of the drawing's own kind: extend flags, Fibonacci levels. */
function BodyOptions({ body, onBody }: { body: DrawingBody; onBody(b: DrawingBody): void }) {
  if (body.kind === "trend") {
    return (
      <>
        <Toggle id="dstyle-extend-left" label={t("drawingStyle.extendLeft")} checked={body.extendLeft} onChange={(on) => onBody({ ...body, extendLeft: on })} />
        <Toggle id="dstyle-extend-right" label={t("drawingStyle.extendRight")} checked={body.extendRight} onChange={(on) => onBody({ ...body, extendRight: on })} />
      </>
    );
  }
  if (body.kind === "rect") {
    return <Toggle id="dstyle-extend-right" label={t("drawingStyle.extendRight")} checked={body.extendRight} onChange={(on) => onBody({ ...body, extendRight: on })} />;
  }
  if (body.kind === "fib") {
    const on = new Set(body.levels);
    return (
      <fieldset className="dstyle-levels" data-testid="drawing-style-levels">
        <legend>{t("drawingStyle.levels")}</legend>
        {fibLevels(body.levels).map((l) => {
          const checked = on.has(l);
          return (
            <label key={l} className="mono">
              <input
                type="checkbox"
                checked={checked}
                // At least one level stays on: the engine rejects a Fibonacci drawing without levels.
                disabled={checked && on.size === 1}
                onChange={(e) =>
                  onBody({ ...body, levels: fibLevels(body.levels).filter((x) => (x === l ? e.target.checked : on.has(x))) })
                }
              />
              {l}
            </label>
          );
        })}
      </fieldset>
    );
  }
  return null;
}

/**
 * The look of a drawing in a small dialog next to it: colour slot, width, dash, the
 * options of its kind, lock and delete. Every change applies at once and is one undo step.
 * Esc closes, Tab stays inside.
 */
export function DrawingStyle({ edit, palette, hostWidth, hostHeight, onChange, onDelete, onClose }: DrawingStyleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const d = edit.drawing;
  const tool = toolFor(d.body.kind);
  const name = tool ? t(tool.labelKey) : d.body.kind;
  const [top, setTop] = useState(edit.y + GAP);
  const left = Math.min(Math.max(8, edit.x - 24), Math.max(8, hostWidth - WIDTH - 8));

  // Below the point when it fits, else above it, never off the chart.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const below = edit.y + GAP;
    setTop(below + h <= hostHeight - 8 ? below : Math.max(8, edit.y - GAP - h));
  }, [edit.y, hostHeight, d.body.kind]);

  // On the next frame: the press that opened it would otherwise move focus back to the page.
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // A press outside closes it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // ⌘Z / ⇧⌘Z reach the chart's shortcuts; every other key stays here (Enter, Delete, Space work on the controls).
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") return;
    e.stopPropagation();
    // Off a text field, Delete or Backspace does nothing here (WebKit would go back a page).
    if ((e.key === "Backspace" || e.key === "Delete") && !typing(e.target)) {
      e.preventDefault();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>("button, input:not(:disabled)") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next]?.focus();
    }
  };

  const style = (patch: Partial<typeof d.style>) => onChange({ style: { ...d.style, ...patch } });

  return (
    <div
      ref={ref}
      className="ind-settings dstyle"
      data-testid="drawing-style"
      role="dialog"
      aria-modal="true"
      aria-label={`${t("drawingStyle.title")}: ${name}`}
      style={{ top, left, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      <div className="ind-settings-header">
        <span>{name}</span>
        <button className="icon-button" aria-label={t("drawingStyle.close")} title={t("drawingStyle.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="ind-field">
        <span id="dstyle-color">{t("drawingStyle.color")}</span>
        <div className="ind-swatches" role="radiogroup" aria-labelledby="dstyle-color">
          {palette.map((color, n) => (
            <button
              key={n}
              className="ind-swatch"
              role="radio"
              data-testid={`drawing-color-${n}`}
              aria-checked={n === d.style.color}
              aria-label={t("drawingStyle.swatch", { n: n + 1 })}
              style={{ background: color }}
              onClick={() => style({ color: n })}
            />
          ))}
        </div>
      </div>
      <div className="ind-field">
        <span id="dstyle-width">{t("drawingStyle.width")}</span>
        <div className="dstyle-widths" role="radiogroup" aria-labelledby="dstyle-width">
          {WIDTHS.map((w) => (
            <button
              key={w}
              className="dstyle-width"
              role="radio"
              data-testid={`drawing-width-${w}`}
              aria-checked={w === d.style.width}
              aria-label={t("drawingStyle.widthN", { n: w })}
              title={t("drawingStyle.widthN", { n: w })}
              onClick={() => style({ width: w })}
            >
              <span style={{ height: w }} />
            </button>
          ))}
        </div>
      </div>
      <Toggle id="dstyle-dash" label={t("drawingStyle.dash")} checked={d.style.dash} onChange={(on) => style({ dash: on })} />
      <BodyOptions body={d.body} onBody={(body) => onChange({ body })} />
      <Toggle id="dstyle-lock" label={t("drawingStyle.lock")} checked={d.locked} onChange={(on) => onChange({ locked: on })} />
      <div className="note-editor-footer dstyle-footer">
        <button className="text-button" data-testid="drawing-style-delete" onClick={onDelete}>
          {t("drawingStyle.delete")}
        </button>
      </div>
    </div>
  );
}
