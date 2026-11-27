import type { LiveCandle } from "../backend/types";
import { formatChange, formatPrice } from "../chart/format";
import { MONO_FAMILY, type ChartTheme } from "../chart/theme";
import { t } from "../i18n";

export interface LegendProps {
  symbol: string;
  /** Timeframe and source, e.g. "1h · Binance". */
  subtitle: string;
  /** Symbol of the candles actually on the chart; empty while the chart is loading. */
  dataSymbol: string;
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
export function Legend({ symbol, subtitle, dataSymbol, candle, prevClose, priceScale, qtyScale, theme }: LegendProps) {
  const label = { color: theme.muted };
  const value = { color: theme.fg, marginRight: 10 };
  let change = null;
  if (candle) {
    const c = formatChange(candle.close - (prevClose ?? candle.open), prevClose ?? candle.open, priceScale);
    change = (
      <span style={{ color: c.dir < 0 ? theme.down : theme.up, marginRight: 10 }}>
        {c.abs} ({c.pct})
      </span>
    );
  }
  return (
    <div
      data-testid="legend"
      data-time={candle?.time ?? ""}
      data-symbol={dataSymbol}
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
          <span style={label}>{t("legend.open")} </span>
          <span style={value}>{formatPrice(candle.open, priceScale)}</span>
          <span style={label}>{t("legend.high")} </span>
          <span style={value}>{formatPrice(candle.high, priceScale)}</span>
          <span style={label}>{t("legend.low")} </span>
          <span style={value}>{formatPrice(candle.low, priceScale)}</span>
          <span style={label}>{t("legend.close")} </span>
          <span style={value}>{formatPrice(candle.close, priceScale)}</span>
          {change}
          <span style={label}>{t("legend.volume")} </span>
          <span style={value}>{trimZeros(formatPrice(candle.volume, qtyScale))}</span>
        </div>
      )}
    </div>
  );
}
