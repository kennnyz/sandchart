// Every value comes from the Design Reference. Candles are monochrome; colour
// appears only in numbers (`up` / `down`) and in indicator series.

export interface CandleStyle {
  body: string;
  border: string;
  wick: string;
}

export interface ChartTheme {
  name: "dark" | "light";
  /** Chart ground. */
  bg: string;
  /** Top bar, status bar and watchlist. */
  panel: string;
  /** Separators and axis borders. */
  line: string;
  grid: string;
  fg: string;
  /** Axis text, secondary labels, crosshair lines. */
  muted: string;
  /** Number colours: change, P&L. */
  up: string;
  down: string;
  upCandle: CandleStyle;
  downCandle: CandleStyle;
  volume: string;
  volumeOpacity: number;
  /** Background of the crosshair labels on both axes; text is `fg`. */
  crosshairLabelBg: string;
  /** Last-price label: `fg` background with `bg` text; the dashed line is `muted`. */
  lastPriceBg: string;
  lastPriceText: string;
  lastPriceLine: string;
  /** Indicator series colours by palette slot (0..=7): calm, apart from each other and from the candles. */
  indicatorPalette: readonly string[];
  /** Fill opacity of a band between two indicator lines. */
  bandOpacity: number;
}

export const AXIS_FONT = '11px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const MONO_FAMILY = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const SANS_FAMILY = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

export const PRICE_AXIS_WIDTH = 72;
export const TIME_AXIS_HEIGHT = 26;
export const VOLUME_HEIGHT = 90;

export const dark: ChartTheme = {
  name: "dark",
  bg: "#1A1A1A",
  panel: "#0A0A0A",
  line: "#2A2A2A",
  grid: "#242424",
  fg: "#F2F2F2",
  muted: "#A1A1A6",
  up: "#56B683",
  down: "#F18169",
  upCandle: { body: "#9A9A9A", border: "#BBBBBB", wick: "#888888" },
  // Hollow: the body is the chart ground.
  downCandle: { body: "#1A1A1A", border: "#8A8A8E", wick: "#666666" },
  volume: "#8A8A8E",
  volumeOpacity: 0.22,
  crosshairLabelBg: "#3E3E3E",
  lastPriceBg: "#F2F2F2",
  lastPriceText: "#1A1A1A",
  lastPriceLine: "#A1A1A6",
  // Blue, amber, teal, violet, rose, green, orange, slate.
  indicatorPalette: ["#6E9FD8", "#D7A85A", "#4FB0A0", "#A58BD6", "#D9829B", "#94B85E", "#E08A5C", "#8FA3B8"],
  bandOpacity: 0.12,
};

export const light: ChartTheme = {
  name: "light",
  bg: "#FFFFFF",
  panel: "#F5F5F5",
  line: "#E5E5E5",
  grid: "#EFEFEF",
  fg: "#111111",
  muted: "#6B6B70",
  up: "#1E8E5A",
  down: "#D1493B",
  upCandle: { body: "#FFFFFF", border: "#111111", wick: "#111111" },
  downCandle: { body: "#111111", border: "#111111", wick: "#111111" },
  volume: "#111111",
  volumeOpacity: 0.12,
  crosshairLabelBg: "#E5E5E5",
  lastPriceBg: "#111111",
  lastPriceText: "#FFFFFF",
  lastPriceLine: "#6B6B70",
  indicatorPalette: ["#2F6DB5", "#B07A1E", "#1F8A7A", "#7357B8", "#B84F6E", "#5E8A2A", "#C2602E", "#5E7085"],
  bandOpacity: 0.12,
};
