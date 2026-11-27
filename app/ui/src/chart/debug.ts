/**
 * Test and diagnostics hook. Only the browser mock (backend/index.ts) enables it;
 * inside Tauri `chartDebug()` is always null and the chart records nothing.
 */
export interface ChartDebug {
  /** Duration of each `Chart.render` body in ms (cleared when it reaches 10 000). */
  drawMs: number[];
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
}

let debug: ChartDebug | null = null;

export function enableChartDebug(): void {
  debug = { drawMs: [], axisWidth: 0, widestLabel: 0, widestText: "", canvasWidth: 0, plotWidth: 0, historyLabel: null };
  (window as unknown as { __sandchartDebug: ChartDebug }).__sandchartDebug = debug;
}

export function chartDebug(): ChartDebug | null {
  return debug;
}
