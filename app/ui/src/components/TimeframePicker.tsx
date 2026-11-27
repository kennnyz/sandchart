import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TimeframeCode } from "../backend/types";
import { t } from "../i18n";

/** Shown in the top bar; the rest sit behind the "more" chevron. */
export const MAIN_TIMEFRAMES: TimeframeCode[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];
export const MORE_TIMEFRAMES: TimeframeCode[] = ["3m", "30m", "2h", "6h", "8h", "12h", "3d", "1M"];

/** Display label: days and weeks are upper case ("1D", "1W"); "1M" is the month. */
export function tfLabel(tf: TimeframeCode): string {
  return /^\d+[dw]$/.test(tf) ? tf.toUpperCase() : tf;
}

export interface TimeframePickerProps {
  value: TimeframeCode;
  onChange: (tf: TimeframeCode) => void;
}

export function TimeframePicker({ value, onChange }: TimeframePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const moreActive = MORE_TIMEFRAMES.includes(value);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const pick = (tf: TimeframeCode) => {
    setOpen(false);
    onChange(tf);
  };

  return (
    <div className="timeframes mono" ref={ref}>
      {MAIN_TIMEFRAMES.map((tf) => (
        <button key={tf} className="tf" aria-pressed={tf === value} onClick={() => pick(tf)}>
          {tfLabel(tf)}
        </button>
      ))}
      <button
        className="tf"
        data-testid="tf-more"
        aria-pressed={moreActive}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("topbar.tf.more")}
        onClick={() => setOpen((o) => !o)}
      >
        {moreActive && tfLabel(value)}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {MORE_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className="tf"
              role="menuitem"
              aria-pressed={tf === value}
              onClick={() => pick(tf)}
            >
              {tfLabel(tf)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
