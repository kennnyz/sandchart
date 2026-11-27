import { useEffect, useRef, useState } from "react";
import type { Backend, Instrument, InstrumentId, TimeframeCode } from "../backend/types";
import { Chart } from "../chart/chart";
import type { PriceScaleMode } from "../chart/scale";
import type { ChartTheme } from "../chart/theme";
import { Legend } from "./Legend";

export interface ChartViewProps {
  backend: Backend;
  id: InstrumentId;
  tf: TimeframeCode;
  theme: ChartTheme;
  priceMode: PriceScaleMode;
  /** Display name of the data source, e.g. "Binance". */
  sourceLabel: string;
}

/** The chart canvas with its legend; loads candles, older history and live bars. */
export function ChartView({ backend, id, tf, theme, priceMode, sourceLabel }: ChartViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Chart | null>(null);
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Bumped whenever the series changes, so the legend re-reads its candle.
  const [, setVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = new Chart(host, theme);
    c.onCrosshair(setHover);
    setChart(c);
    return () => {
      c.destroy();
      setChart(null);
    };
    // Created once; the theme is applied by its own effect.
  }, []);

  useEffect(() => chart?.setTheme(theme), [chart, theme]);
  useEffect(() => chart?.setPriceMode(priceMode), [chart, priceMode]);

  const { source, symbol } = id;
  useEffect(() => {
    if (!chart) return;
    const instrumentId = { source, symbol };
    let alive = true;
    let stopLive: (() => void) | null = null;
    const bump = () => setVersion((v) => v + 1);

    chart.onNeedOlder(() => {
      const first = chart.candle(0);
      if (!first) return;
      backend
        .getCandles(instrumentId, tf, first.time)
        .then((older) => {
          if (!alive) return;
          chart.prependData(older);
          bump();
        })
        .catch((e: unknown) => console.error("loading older candles failed", e));
    });

    backend
      .getCandles(instrumentId, tf)
      .then(async (page) => {
        if (!alive) return;
        setInstrument(page.instrument);
        chart.setData(page);
        bump();
        const stop = await backend.subscribeLive(instrumentId, tf, (e) => {
          if (!alive) return;
          if (e.kind === "candle") chart.updateLast(e);
          else if (e.kind === "backfilled") {
            const b = e.candles;
            for (let i = 0; i < b.time.length; i++) {
              chart.updateLast({
                time: b.time[i]!,
                open: b.open[i]!,
                high: b.high[i]!,
                low: b.low[i]!,
                close: b.close[i]!,
                volume: b.volume[i]!,
                closed: true,
              });
            }
          }
          bump();
        });
        if (alive) stopLive = stop;
        else stop();
      })
      .catch((e: unknown) => console.error("loading candles failed", e));

    return () => {
      alive = false;
      stopLive?.();
    };
  }, [chart, backend, source, symbol, tf]);

  const index = hover ?? (chart && chart.count > 0 ? chart.count - 1 : null);
  const candle = chart && index !== null ? chart.candle(index) : null;
  const prev = chart && index !== null ? chart.candle(index - 1) : null;

  return (
    <div
      ref={hostRef}
      data-testid="chart"
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", background: theme.bg }}
    >
      <Legend
        symbol={symbol}
        subtitle={`${tf} · ${sourceLabel}`}
        candle={candle}
        prevClose={prev?.close ?? null}
        priceScale={instrument?.priceScale ?? 0}
        qtyScale={instrument?.qtyScale ?? 0}
        theme={theme}
      />
    </div>
  );
}
