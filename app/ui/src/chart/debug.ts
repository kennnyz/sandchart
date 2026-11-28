/**
 * Test and diagnostics hook. Only the browser mock (backend/index.ts) enables it;
 * inside Tauri `chartDebug()` is always null and the chart records nothing.
 */
export interface ChartDebug {
  /** Duration of each `Chart.render` body (one or both layers) in ms (cleared when it reaches 10 000). */
  drawMs: number[];
  /** Duration of each base layer draw and of each overlay draw in ms (same clearing). */
  baseMs: number[];
  overlayMs: number[];
  /** Base and overlay layer draws since the debug hook was enabled. */
  baseDraws: number;
  overlayDraws: number;
  /** Price axis width and the widest price label of the last frame, in CSS px. */
  axisWidth: number;
  widestLabel: number;
  /** The text of that widest label. */
  widestText: string;
  /** Canvas width and plot width of the last frame, in CSS px. */
  canvasWidth: number;
  plotWidth: number;
  /** Start-of-history marker text of the last frame ("line 1|line 2"), null when not drawn. */
  historyLabel: string | null;
  /** Own indicator panes of the last frame. */
  panes: number;
  /** Drawings painted on the last base frame (after culling). */
  drawingsPainted: number;
  /** Selected and hovered drawing ids at the last overlay frame. */
  selectedDrawing: string | null;
  hoveredDrawing: string | null;
  /** Handles of the selected drawing at the last overlay frame, in CSS px of the chart. */
  selectedHandles: { x: number; y: number }[];
  /** The ruler's numbers at the last overlay frame ("+1.00 (+0.50%)|12 bars, 12h"), null when it is not shown. */
  ruler: string | null;
  /** Position outcomes the chart was last given, by drawing id: "take", "stop", "open", with "?" when ambiguous. */
  outcomes: Record<string, string>;
  /** Open time of the chart's last bar at the last base frame, null without bars. */
  lastBarTime: number | null;
  /** `lastTime` of every indicator layer with a result at the last base frame, in layer order. */
  indicatorLastTimes: number[];
  /** Stop and take handles of the open replay trade at the last base frame, in CSS px of the chart. */
  replayHandles: { stop: { x: number; y: number }; take: { x: number; y: number } } | null;
  /** Closed replay trades painted at the last base frame. */
  replayClosed: number;
  /** Price alert levels painted at the last base frame, with their y in CSS px of the chart. */
  alertLevels: { id: string; y: number }[];
}

let debug: ChartDebug | null = null;

export function enableChartDebug(): void {
  debug = {
    drawMs: [],
    baseMs: [],
    overlayMs: [],
    baseDraws: 0,
    overlayDraws: 0,
    axisWidth: 0,
    widestLabel: 0,
    widestText: "",
    canvasWidth: 0,
    plotWidth: 0,
    historyLabel: null,
    panes: 0,
    drawingsPainted: 0,
    selectedDrawing: null,
    hoveredDrawing: null,
    selectedHandles: [],
    ruler: null,
    outcomes: {},
    lastBarTime: null,
    indicatorLastTimes: [],
    replayHandles: null,
    replayClosed: 0,
    alertLevels: [],
  };
  (window as unknown as { __sandchartDebug: ChartDebug }).__sandchartDebug = debug;
}

export function chartDebug(): ChartDebug | null {
  return debug;
}
