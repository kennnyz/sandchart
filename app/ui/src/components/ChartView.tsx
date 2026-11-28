import { Bell, BellOff, ChevronsDown, ChevronsUp, EyeOff, Lock, LockOpen, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Backend, ConnectionState, Drawing, InstrumentId, TimeframeCode } from "../backend/types";
import { Chart, type AlertMenuAt, type PriceMenuAt } from "../chart/chart";
import { formatDate, formatPrice, formatUtcClock } from "../chart/format";
import { priceMenuEntries } from "../chart/plus";
import { HorizontalLevelIcon } from "../icons";
import type { PriceScaleMode } from "../chart/scale";
import type { ChartTheme } from "../chart/theme";
import { t, useLanguage } from "../i18n";
import { altShortcutLabel, bannerText, deleteKeyLabel, enterKeyLabel, sourceName } from "../labels";
import { ChartSession, type SessionState } from "../state/chartSession";
import { alertKey } from "../chart/drawings/keys";
import type { DrawingPatch } from "../chart/drawings/state";
import type { AlertStore } from "../state/alerts";
import type { DrawingStore } from "../state/drawings";
import type { IndicatorStore } from "../state/indicators";
import { MAX_REPLAY_FILE_MIB, REPLAY_KEYS, type ReplayStore } from "../state/replay";
import { Banner } from "./Banner";
import { DrawingStyle, type LineAlert } from "./DrawingStyle";
import { IndicatorLegend } from "./IndicatorLegend";
import { IndicatorSettings } from "./IndicatorSettings";
import { Legend } from "./Legend";
import { Menu, type MenuItem } from "./Menu";
import { NoteEditor } from "./NoteEditor";
import { ReplayBar } from "./ReplayBar";
import { ReplayStats } from "./ReplayStats";
import { tfLabel } from "./TimeframePicker";
import { Confirm } from "./Confirm";

export interface ChartViewProps {
  backend: Backend;
  id: InstrumentId;
  tf: TimeframeCode;
  theme: ChartTheme;
  priceMode: PriceScaleMode;
  connection: ConnectionState;
  indicators: IndicatorStore;
  drawings: DrawingStore;
  replay: ReplayStore;
  alerts: AlertStore;
}

const NO_VALUES = new Map<string, Map<string, number>>();

/** A menu of the chart itself: the "+" at the crosshair price, or a right click on an alert level; `n` counts the openings. */
type ChartMenu = ({ kind: "price" } & PriceMenuAt) | ({ kind: "alert" } & AlertMenuAt);

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
export function ChartView({ backend, id, tf, theme, priceMode, connection, indicators, drawings, replay, alerts }: ChartViewProps) {
  const lang = useLanguage();
  const hostRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<{ chart: Chart; session: ChartSession } | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [hostHeight, setHostHeight] = useState(0);
  const [hostWidth, setHostWidth] = useState(0);
  const [chartMenu, setChartMenu] = useState<(ChartMenu & { n: number }) | null>(null);
  const [settings, setSettings] = useState<{ instance: string; top: number; bottom: number; left: number } | null>(
    null,
  );
  useSyncExternalStore(indicators.subscribe, indicators.version);
  useSyncExternalStore(drawings.subscribe, drawings.version);
  useSyncExternalStore(replay.subscribe, replay.version);
  useSyncExternalStore(alerts.subscribe, alerts.version);
  const rp = replay.state;
  /** The chart the props ask for, read when a replay ends. */
  const wanted = useRef({ id, tf });
  wanted.current = { id, tf };
  const ind = indicators.state;
  const textEdit = drawings.state.textEdit;
  const styleEdit = drawings.state.styleEdit;
  const menuEdit = drawings.state.menu;
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
    // Another timeframe of the replayed pair: the replay shows it (re-basing to a lower one)
    // and keeps its trades; its bars come through the feed, which drops the old results.
    if (rp.replays({ source, symbol })) {
      void rp.setTimeframe(tf);
      return;
    }
    // Results of the old chart would align by time on the new one: drop them first.
    ind.clear();
    computedFor.current = null;
    parts.chart.setIndicators(ind.layers(), 0);
    // Another pair was picked: the replay ends, and this chart loads live.
    if (rp.phase !== "off") void rp.exit(false);
    void parts.session.open({ source, symbol }, tf);
  }, [parts, source, symbol, tf, ind, rp]);

  // The replay puts its revealed bars on the chart, and the live chart back when it ends.
  useEffect(() => {
    if (!parts) return;
    // The bars are swapped: indicator results and position outcomes of the old ones must go.
    const swapped = () => {
      ind.clear();
      computedFor.current = null;
      drawings.state.resetOutcomes();
    };
    return rp.attach({
      show(st) {
        swapped();
        parts.session.showReplay(st);
        if (st.caughtUp) void parts.session.followReplay();
      },
      append(bars) {
        parts.session.appendReplay(bars);
      },
      follow() {
        void parts.session.followReplay();
      },
      reload() {
        swapped();
        const { id: to, tf: at } = wanted.current;
        void parts.session.open(to, at);
      },
    });
  }, [parts, rp, ind, drawings]);

  // Picking a start: a click on a bar of this chart starts the replay there.
  const picking = rp.phase === "picking";
  useEffect(() => {
    if (!chart || !picking) return;
    chart.setPick((time) => void rp.start({ source, symbol }, tf, time));
    return () => chart.setPick(null);
  }, [chart, picking, rp, source, symbol, tf]);

  const replayView = rp.phase === "on" ? rp.view : null;
  useEffect(() => {
    chart?.setReplay(
      replayView
        ? {
            trades: replayView.trades,
            time: replayView.time,
            close: replayView.close,
            cut: replayView.cut,
            label: t("replay.marker"),
            caughtUp: replayView.caughtUp,
          }
        : null,
    );
  }, [chart, replayView, lang]);
  useEffect(() => {
    if (!chart) return;
    chart.onReplayEdit((stop, take) => void rp.edit(stop, take));
    return () => chart.onReplayEdit(null);
  }, [chart, rp]);
  const pickByDate = useCallback(
    (time: number) => {
      const bar = chart?.barAtOrAfter(time);
      if (bar != null) void rp.start({ source, symbol }, tf, bar);
    },
    [chart, rp, source, symbol, tf],
  );

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

  // Active price alerts as levels on the chart, not over a replay's past bars; a press on
  // one picks it in the panel.
  const alertList = alerts.state.list;
  const replaying = rp.phase !== "off";
  useEffect(() => {
    if (!chart) return;
    chart.setAlerts(replaying ? [] : alertList);
    chart.onAlertClick((alertId) => alerts.state.select(alertId));
    return () => chart.onAlertClick(null);
  }, [chart, alerts, alertList, replaying]);
  // Lines with an active alert carry a bell tag.
  useEffect(() => {
    chart?.setDrawingAlerts(new Set(alertList.flatMap((a) => (a.active && a.kind.kind === "drawing" ? [a.kind.drawingId] : []))));
  }, [chart, alertList]);
  // A dragged level re-sets its alert at the new price, at the scale the chart shows it in.
  const scaleNow = state?.instrument?.priceScale ?? null;
  useEffect(() => {
    if (!chart || scaleNow === null) return;
    chart.onAlertMove((alertId, price) => alerts.state.movePrice(alertId, scaleNow, price));
    return () => chart.onAlertMove(null);
  }, [chart, alerts, scaleNow]);

  // The "+" at the crosshair price and a right click on an alert level open a menu of the chart.
  useEffect(() => {
    if (!chart) return;
    let n = 0;
    chart.onPriceMenu((at) => setChartMenu({ kind: "price", ...at, n: ++n }));
    chart.onAlertMenu((at) => setChartMenu({ kind: "alert", ...at, n: ++n }));
    return () => {
      chart.onPriceMenu(null);
      chart.onAlertMenu(null);
    };
  }, [chart]);
  // Another pair: its menu would act on the old one.
  useEffect(() => setChartMenu(null), [source, symbol]);
  const closeChartMenu = useCallback(() => setChartMenu(null), []);

  // Alt+A: a price alert at the crosshair price, on the pair the chart shows.
  useEffect(() => {
    if (!chart) return;
    const onKey = (e: KeyboardEvent) => {
      // A replay shows past bars: the crosshair price is no price to watch now.
      if (!alertKey(e) || replay.state.phase !== "off") return;
      const at = chart.crosshairPrice();
      if (!at) return;
      e.preventDefault();
      void alerts.state.createPrice(at.instrument.id, at.instrument.priceScale, at.price);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chart, alerts, replay]);

  // Deleting a line with an alert asks first: the engine deletes the alert with it, and undo cannot bring it back.
  useEffect(() => drawings.state.setAlertCheck((id) => alerts.state.forDrawing(id) !== undefined), [drawings, alerts]);
  const deleteQuestion = drawings.state.deleteQuestion;
  const answerDelete = useCallback((yes: boolean) => drawings.state.answerDelete(yes), [drawings]);

  const styled = styleEdit?.drawing;
  const lineAlert: LineAlert | undefined =
    styled && (styled.body.kind === "hline" || styled.body.kind === "trend")
      ? {
          current: alerts.state.forDrawing(styled.id),
          // The drawing may still be on its way to the engine; the alert waits for it.
          onSet: (direction) => void alerts.state.setForDrawing(styled, direction, drawings.state.settled()),
          onRemove: () => {
            const a = alerts.state.forDrawing(styled.id);
            if (a) void alerts.state.remove(a.id);
          },
        }
      : undefined;

  const saveText = useCallback((text: string) => drawings.state.saveText(text), [drawings]);
  const cancelText = useCallback(() => drawings.state.cancelText(), [drawings]);
  const deleteText = useCallback(() => drawings.state.deleteText(), [drawings]);
  const restyle = useCallback((patch: DrawingPatch) => drawings.state.restyle(patch), [drawings]);
  const closeStyle = useCallback(() => drawings.state.closeStyle(), [drawings]);
  const deleteStyled = useCallback(() => drawings.state.deleteStyled(), [drawings]);
  const closeMenu = useCallback(() => drawings.state.menuAction(null), [drawings]);
  /** A line's alert from its menu: a crossing alert at once (the popover changes the direction), or its removal. */
  const lineAlertItems = (line: Drawing | null): MenuItem[] => {
    if (!line) return [];
    const current = alerts.state.forDrawing(line.id);
    const run = (fn: () => void) => () => {
      drawings.state.menuAction(null);
      fn();
    };
    return current
      ? [{ id: "remove-alert", label: t("drawingMenu.removeAlert"), icon: BellOff, onSelect: run(() => void alerts.state.remove(current.id)) }]
      : [
          {
            id: "add-alert",
            label: t("drawingMenu.addAlert"),
            title: t("drawingMenu.addAlert.title"),
            icon: Bell,
            onSelect: run(() => void alerts.state.setForDrawing(line, "cross", drawings.state.settled())),
          },
        ];
  };
  // Over several drawings the menu says how many it acts on.
  const label = (action: "lock" | "unlock" | "hide" | "remove") =>
    menuEdit && !menuEdit.single ? t(`drawingMenu.${action}N`, { n: menuEdit.ids.length }) : t(`drawingMenu.${action}`);
  const menuItems: MenuItem[] = menuEdit
    ? [
        menuEdit.locked
          ? { id: "unlock", label: label("unlock"), icon: LockOpen, onSelect: () => drawings.state.menuAction("unlock") }
          : { id: "lock", label: label("lock"), icon: Lock, onSelect: () => drawings.state.menuAction("lock") },
        { id: "hide", label: label("hide"), icon: EyeOff, onSelect: () => drawings.state.menuAction("hide") },
        ...lineAlertItems(menuEdit.line),
        {
          id: "remove",
          label: label("remove"),
          icon: Trash2,
          shortcut: deleteKeyLabel(),
          keys: ["Delete", "Backspace"],
          onSelect: () => drawings.state.menuAction("remove"),
        },
        ...(menuEdit.single
          ? [
              {
                id: "settings",
                label: t("drawingMenu.settings"),
                icon: Settings2,
                shortcut: enterKeyLabel(),
                onSelect: () => drawings.state.menuAction("settings"),
              },
            ]
          : []),
      ]
    : [];

  let chartItems: MenuItem[] = [];
  if (chartMenu?.kind === "alert") {
    const alertId = chartMenu.id;
    chartItems = [
      {
        id: "remove",
        label: t("alertMenu.remove"),
        icon: Trash2,
        shortcut: deleteKeyLabel(),
        keys: ["Delete", "Backspace"],
        onSelect: () => {
          setChartMenu(null);
          void alerts.state.remove(alertId);
        },
      },
    ];
  } else if (chartMenu?.kind === "price") {
    const { instrument, price: at } = chartMenu;
    const price = formatPrice(at, instrument.priceScale);
    const pick = (run: () => void) => () => {
      setChartMenu(null);
      run();
    };
    // A replay's prices are from the past: no alert there, a paper trade at the current close instead.
    const entries = priceMenuEntries(rp.phase !== "off" ? { finished: rp.finished, hasOpen: rp.view?.open != null } : null);
    chartItems = entries.map((e): MenuItem => {
      const off = { disabled: e.disabled, title: e.realTime ? t("replay.realTime.title") : undefined };
      switch (e.id) {
        case "alert":
          return {
            id: "alert",
            label: t("priceMenu.alert", { symbol: instrument.id.symbol, price }),
            icon: Bell,
            shortcut: altShortcutLabel("A"),
            onSelect: pick(() => void alerts.state.createPrice(instrument.id, instrument.priceScale, at)),
          };
        case "hline":
          return {
            id: "hline",
            label: t("priceMenu.hline", { price }),
            icon: HorizontalLevelIcon,
            shortcut: altShortcutLabel("H"),
            onSelect: pick(() => drawings.state.addLevel(at)),
          };
        case "buy":
          return { id: "buy", label: t("replay.buy"), icon: ChevronsUp, shortcut: REPLAY_KEYS.buy, ...off, onSelect: pick(() => void rp.buy()) };
        case "sell":
          return { id: "sell", label: t("replay.sell"), icon: ChevronsDown, shortcut: REPLAY_KEYS.sell, ...off, onSelect: pick(() => void rp.sell()) };
      }
    });
  }

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

  const first = chart && count > 0 ? chart.candle(0) : null;
  const lastBar = chart && count > 0 ? chart.candle(count - 1) : null;
  const range: [number, number] | null = first && lastBar ? [first.time, lastBar.time] : null;

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
      {alerts.state.error !== null && (
        <Banner
          testId="alert-error"
          text={t("alerts.error", { error: alerts.state.error })}
          retryAt={null}
          retryLabel={() => ""}
          dismiss={{ label: t("alerts.errorClose"), onDismiss: () => alerts.state.dismissError() }}
        />
      )}
      {rp.fileError !== null && (
        <Banner
          testId="replay-file-error"
          text={
            rp.fileError.kind === "tooLarge"
              ? t("replay.tooLarge", { mib: MAX_REPLAY_FILE_MIB })
              : t(`replay.file.${rp.fileError.kind}`)
          }
          retryAt={null}
          retryLabel={() => ""}
          detail={rp.fileError.detail}
          dismiss={{ label: t("replay.file.close"), onDismiss: () => rp.dismissFileError() }}
        />
      )}
      {rp.error !== null && (
        <Banner
          testId="replay-error"
          text={t("replay.error", { error: rp.error })}
          retryAt={null}
          retryLabel={() => ""}
          detail={rp.error}
        />
      )}
      <div
        ref={hostRef}
        data-testid="chart"
        data-replay={rp.phase}
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
            alert={lineAlert}
            palette={theme.indicatorPalette}
            hostWidth={hostWidth}
            hostHeight={hostHeight}
            onChange={restyle}
            onDelete={deleteStyled}
            onClose={closeStyle}
          />
        )}
        {menuEdit && (
          <Menu
            key={`${menuEdit.ids.join(",")}@${menuEdit.x},${menuEdit.y}`}
            items={menuItems}
            label={t("drawingMenu.label")}
            testId="drawing-menu"
            x={menuEdit.x}
            y={menuEdit.y}
            width={hostWidth}
            height={hostHeight}
            onClose={closeMenu}
          />
        )}
        {chartMenu && chartItems.length > 0 && (
          <Menu
            key={chartMenu.n}
            items={chartItems}
            label={t(chartMenu.kind === "price" ? "priceMenu.label" : "alertMenu.label")}
            testId={chartMenu.kind === "price" ? "price-menu" : "alert-menu"}
            x={chartMenu.x}
            y={chartMenu.y}
            width={hostWidth}
            height={hostHeight}
            onClose={closeChartMenu}
          />
        )}
        {deleteQuestion && (
          <Confirm
            title={deleteQuestion.count === 1 ? t("drawingDelete.one") : t("drawingDelete.many", { n: deleteQuestion.count })}
            text={
              deleteQuestion.count === 1 ? t("drawingDelete.alertOne") : t("drawingDelete.alertMany", { n: deleteQuestion.alerts })
            }
            ok={t("drawingDelete.ok")}
            cancel={t("drawingDelete.cancel")}
            testId="drawing-delete-confirm"
            onAnswer={answerDelete}
          />
        )}
        {drawings.state.selectionCount > 1 && (
          <div className="selection-count" data-testid="selection-count">
            {t("drawings.selected", { n: drawings.state.selectionCount })}
          </div>
        )}
        {loading && <Loading symbol={symbol} tf={tfLabel(tf)} source={sourceLabel} />}
      </div>
      {rp.phase !== "off" && <ReplayBar replay={rp} range={range} onDate={pickByDate} />}
      {replayView && <ReplayStats replay={rp} />}
    </>
  );
}
