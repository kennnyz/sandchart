import type { LiveCandle } from "../backend/types";
import { formatPrice } from "../chart/format";
import { MONO_FAMILY, type ChartTheme } from "../chart/theme";

export interface LegendProps {
  symbol: string;
  /** Timeframe and source, e.g. "1h · Binance". */
  subtitle: string;
  candle: LiveCandle | null;
  /** Close of the bar before `candle`; the change is measured from it (from the open when absent). */
  prevClose: number | null;
  priceScale: number;
  qtyScale: number;
  theme: ChartTheme;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Symbol, timeframe and O H L C V of the candle under the crosshair (or the last one). */
export function Legend({ symbol, subtitle, candle, prevClose, priceScale, qtyScale, theme }: LegendProps) {
  const label = { color: theme.muted };
  const value = { color: theme.fg, marginRight: 10 };
  let change = null;
  if (candle) {
    const base = prevClose ?? candle.open;
    const diff = candle.close - base;
    // Basis points of `base`, rounded: an integer, so formatPrice gives exactly 2 decimals.
    const bp = base !== 0 ? Math.round((diff * 10_000) / base) : 0;
    const sign = diff > 0 ? "+" : "";
    change = (
      <span style={{ color: diff >= 0 ? theme.up : theme.down, marginRight: 10 }}>
        {sign + formatPrice(diff, priceScale)} ({sign + formatPrice(bp, 2)}%)
      </span>
    );
  }
  return (
    <div
      data-testid="legend"
      data-time={candle?.time ?? ""}
      style={{
        position: "absolute",
        zIndex: 1,
        top: 14,
        left: 12,
        pointerEvents: "none",
        fontFamily: MONO_FAMILY,
        fontSize: 12,
        lineHeight: "18px",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      <div>
        <span style={{ color: theme.fg, fontSize: 15, fontWeight: 600, marginRight: 8 }}>{symbol}</span>
        <span style={{ color: theme.muted }}>{subtitle}</span>
      </div>
      {candle && (
        <div>
          <span style={label}>O </span>
          <span style={value}>{formatPrice(candle.open, priceScale)}</span>
          <span style={label}>H </span>
          <span style={value}>{formatPrice(candle.high, priceScale)}</span>
          <span style={label}>L </span>
          <span style={value}>{formatPrice(candle.low, priceScale)}</span>
          <span style={label}>C </span>
          <span style={value}>{formatPrice(candle.close, priceScale)}</span>
          {change}
          <span style={label}>V </span>
          <span style={value}>{trimZeros(formatPrice(candle.volume, qtyScale))}</span>
        </div>
      )}
    </div>
  );
}
