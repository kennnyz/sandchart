import { useEffect, useRef, useState } from "react";
import type { Backend, ConnectionState, InstrumentId, TimeframeCode } from "../backend/types";
import { Chart } from "../chart/chart";
import { formatDate, formatUtcClock } from "../chart/format";
import type { PriceScaleMode } from "../chart/scale";
import type { ChartTheme } from "../chart/theme";
import { t, useLanguage } from "../i18n";
import { bannerText, sourceName } from "../labels";
import { ChartSession, type SessionState } from "../state/chartSession";
import { Banner } from "./Banner";
import { Legend } from "./Legend";
import { tfLabel } from "./TimeframePicker";

export interface ChartViewProps {
  backend: Backend;
  id: InstrumentId;
  tf: TimeframeCode;
  theme: ChartTheme;
  priceMode: PriceScaleMode;
  connection: ConnectionState;
}

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
export function ChartView({ backend, id, tf, theme, priceMode, connection }: ChartViewProps) {
  const lang = useLanguage();
  const hostRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<{ chart: Chart; session: ChartSession } | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = new Chart(host, theme);
    const session = new ChartSession(backend, chart, setState);
    chart.onCrosshair(setHover);
    chart.onNeedOlder(() => void session.loadOlder());
    setParts({ chart, session });
    return () => {
      session.close();
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

  const { source, symbol } = id;
  useEffect(() => {
    void parts?.session.open({ source, symbol }, tf);
  }, [parts, source, symbol, tf]);

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
        {loading && <Loading symbol={symbol} tf={tfLabel(tf)} source={sourceLabel} />}
      </div>
    </>
  );
}
