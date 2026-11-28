import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Backend, ConnectionState, InstrumentId, TimeframeCode } from "../backend/types";
import { Chart } from "../chart/chart";
import { formatDate, formatUtcClock } from "../chart/format";
import type { PriceScaleMode } from "../chart/scale";
import type { ChartTheme } from "../chart/theme";
import { t, useLanguage } from "../i18n";
import { bannerText, sourceName } from "../labels";
import { ChartSession, type SessionState } from "../state/chartSession";
import type { DrawingPatch } from "../chart/drawings/state";
import type { DrawingStore } from "../state/drawings";
import type { IndicatorStore } from "../state/indicators";
import { Banner } from "./Banner";
import { DrawingStyle } from "./DrawingStyle";
import { IndicatorLegend } from "./IndicatorLegend";
import { IndicatorSettings } from "./IndicatorSettings";
import { Legend } from "./Legend";
import { NoteEditor } from "./NoteEditor";
import { tfLabel } from "./TimeframePicker";

export interface ChartViewProps {
  backend: Backend;
  id: InstrumentId;
  tf: TimeframeCode;
  theme: ChartTheme;
  priceMode: PriceScaleMode;
  connection: ConnectionState;
  indicators: IndicatorStore;
  drawings: DrawingStore;
}

const NO_VALUES = new Map<string, Map<string, number>>();

/** Five small bars, one lit, and what is being loaded (Design Reference, States). */
export function Loading({ symbol, tf, source }: { symbol: string; tf: string; source: string }) {
  return (
    <div className="loading" data-testid="loading">
      <div className="bars">
        {[10, 16, 22, 14, 18].map((h, i) => (
          <span key={i} className={i === 2 ? "on" : undefined} style={{ height: h }} />
        ))}
      </div>
      <div className="title">{t("loading.title", { symbol, tf })}</div>
      <div className="detail">{t("loading.detail", { source })}</div>
    </div>
  );
}

/** The chart column: banner, canvas with legend and states; a `ChartSession` feeds it. */
export function ChartView({ backend, id, tf, theme, priceMode, connection, indicators, drawings }: ChartViewProps) {
  const lang = useLanguage();
  const hostRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<{ chart: Chart; session: ChartSession } | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [hostHeight, setHostHeight] = useState(0);
  const [hostWidth, setHostWidth] = useState(0);
  const [settings, setSettings] = useState<{ instance: string; top: number; bottom: number; left: number } | null>(
    null,
  );
  useSyncExternalStore(indicators.subscribe, indicators.version);
  useSyncExternalStore(drawings.subscribe, drawings.version);
  const ind = indicators.state;
  const textEdit = drawings.state.textEdit;
  const styleEdit = drawings.state.styleEdit;
  const drawingError = drawings.state.error;
  /** Chart and first bar time of the last recompute; a change of either recomputes at once. */
  const computedFor = useRef<{ key: string; first: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = new Chart(host, theme);
    const session = new ChartSession(backend, chart, setState);
    chart.onCrosshair(setHover);
    chart.onNeedOlder(() => void session.loadOlder());
    setParts({ chart, session });
    const resize = new ResizeObserver(() => {
      setHostHeight(host.clientHeight);
      setHostWidth(host.clientWidth);
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      session.close();
      ind.clear();
      chart.destroy();
      setParts(null);
    };
    // Created once per backend; theme and mode are applied by their own effects.
  }, [backend]);

  const chart = parts?.chart ?? null;
  useEffect(() => chart?.setTheme(theme), [chart, theme]);
  useEffect(() => chart?.setPriceMode(priceMode), [chart, priceMode]);
  useEffect(() => {
    chart?.setHistoryLabel((first) => [t("history.start"), t("history.first", { date: formatDate(first) })]);
  }, [chart, lang]);

  // The chart reports drawing changes to the controller, which stores them; attached before the first load.
  useEffect(() => (chart ? drawings.state.attach(chart) : undefined), [chart, drawings]);

  const { source, symbol } = id;
  useEffect(() => {
    if (chart) void drawings.state.open({ source, symbol });
  }, [chart, drawings, source, symbol]);

  useEffect(() => {
    if (!parts) return;
    // Results of the old chart would align by time on the new one: drop them first.
    ind.clear();
    computedFor.current = null;
    parts.chart.setIndicators(ind.layers(), 0);
    void parts.session.open({ source, symbol }, tf);
  }, [parts, source, symbol, tf, ind]);

  const priceScale = state?.instrument?.priceScale ?? 0;
  const layers = ind.layers();
  // The legend reads values back from the chart, so it renders again once the chart has the layers.
  const [, setDrawn] = useState<unknown>(null);
  useLayoutEffect(() => {
    if (!chart) return;
    chart.setIndicators(layers, priceScale);
    setDrawn(layers);
  }, [chart, layers, priceScale]);

  // Recompute on every change of the candles: at once when the chart or its first bar
  // changed (loaded, older page, reset), debounced for live candles.
  const version = state?.version;
  useEffect(() => {
    if (!chart || !state?.id || !state.instrument || state.status !== "ready") return;
    const first = chart.candle(0);
    if (!first) return;
    const key = `${state.id.source}/${state.id.symbol}/${state.tf}`;
    const prev = computedFor.current;
    computedFor.current = { key, first: first.time };
    ind.recompute({ id: state.id, tf: state.tf, fromTime: first.time }, prev?.key !== key || prev.first !== first.time);
    // `state` is read for its id and tf, which change only together with `version`.
  }, [chart, ind, version, state?.status, state?.instrument]);

  // Position outcomes follow the candles: another timeframe, an older page, a new bar.
  useEffect(() => {
    if (!chart || !state?.id || state.status !== "ready" || chart.count === 0) return;
    const first = chart.candle(0)!;
    const last = chart.candle(chart.count - 1)!;
    drawings.state.candles(state.id, state.tf, first.time, last.time);
    // `state` is read for its id and tf, which change only together with `version`.
  }, [chart, drawings, version, state?.status]);

  const saveText = useCallback((text: string) => drawings.state.saveText(text), [drawings]);
  const cancelText = useCallback(() => drawings.state.cancelText(), [drawings]);
  const deleteText = useCallback(() => drawings.state.deleteText(), [drawings]);
  const restyle = useCallback((patch: DrawingPatch) => drawings.state.restyle(patch), [drawings]);
  const closeStyle = useCallback(() => drawings.state.closeStyle(), [drawings]);
  const deleteStyled = useCallback(() => drawings.state.deleteStyled(), [drawings]);

  const openSettings = useCallback((instance: string, row: HTMLElement) => {
    const host = hostRef.current;
    if (!host) return;
    const h = host.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    setSettings({ instance, top: r.top - h.top, bottom: r.bottom - h.top, left: r.left - h.left });
  }, []);
  const closeSettings = useCallback(() => setSettings(null), []);

  // The connection came back: retry a failed request now instead of waiting.
  useEffect(() => {
    if (connection === "connected") void parts?.session.retryNow();
  }, [parts, connection]);

  const sourceLabel = sourceName(source);
  const count = chart?.count ?? 0;
  const index = hover ?? (count > 0 ? count - 1 : null);
  const candle = chart && index !== null ? chart.candle(index) : null;
  const prev = chart && index !== null ? chart.candle(index - 1) : null;
  const loading = !state || state.status === "loading";
  const problem = state?.problem ?? null;

  const settingsFor = settings ? ind.instances.find((i) => i.instance === settings.instance) : undefined;
  const settingsInfo = settingsFor ? ind.info(settingsFor.moduleId) : undefined;

  let banner = null;
  if (problem || connection === "offline") {
    const last = chart && count > 0 ? chart.candle(count - 1) : null;
    banner = (
      <Banner
        text={bannerText(
          problem?.code ?? "network",
          sourceLabel,
          last ? formatUtcClock(last.time, Date.now()) : null,
        )}
        retryAt={problem?.retryAt ?? null}
        retryLabel={(n) => t("banner.retry", { n })}
        detail={problem?.message}
      />
    );
  }

  return (
    <>
      {banner}
      {drawingError !== null && (
        <Banner
          testId="drawing-error"
          text={t(drawingError.kind === "load" ? "drawings.loadError" : "drawings.saveError")}
          retryAt={null}
          retryLabel={() => ""}
          detail={drawingError.message}
        />
      )}
      <div
        ref={hostRef}
        data-testid="chart"
        style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", background: theme.bg }}
      >
        <Legend
          symbol={symbol}
          subtitle={`${tfLabel(tf)} · ${sourceLabel}`}
          dataSymbol={state?.instrument?.id.symbol ?? ""}
          candle={loading ? null : candle}
          prevClose={loading ? null : (prev?.close ?? null)}
          priceScale={state?.instrument?.priceScale ?? 0}
          qtyScale={state?.instrument?.qtyScale ?? 0}
          theme={theme}
        />
        <IndicatorLegend
          state={ind}
          values={chart && index !== null ? chart.indicatorValues(index) : NO_VALUES}
          theme={theme}
          priceScale={priceScale}
          hostHeight={hostHeight}
          onSettings={openSettings}
        />
        {settingsFor && settingsInfo && settings && (
          <IndicatorSettings
            key={settings.instance}
            state={ind}
            instance={settingsFor}
            info={settingsInfo}
            palette={theme.indicatorPalette}
            log={ind.result(settings.instance)?.computed?.log ?? ""}
            anchor={settings}
            hostHeight={hostHeight}
            onClose={closeSettings}
          />
        )}
        {textEdit && (
          <NoteEditor
            key={`${textEdit.id}/${textEdit.isNew}`}
            edit={textEdit}
            hostWidth={hostWidth}
            hostHeight={hostHeight}
            onSave={saveText}
            onCancel={cancelText}
            onDelete={deleteText}
          />
        )}
        {styleEdit && (
          <DrawingStyle
            key={styleEdit.drawing.id}
            edit={styleEdit}
            palette={theme.indicatorPalette}
            hostWidth={hostWidth}
            hostHeight={hostHeight}
            onChange={restyle}
            onDelete={deleteStyled}
            onClose={closeStyle}
          />
        )}
        {loading && <Loading symbol={symbol} tf={tfLabel(tf)} source={sourceLabel} />}
      </div>
    </>
  );
}
