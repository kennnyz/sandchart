import { ChevronDown, ChevronUp } from "lucide-react";
import { memo } from "react";
import type { ReplayTrade } from "../backend/types";
import { formatCrosshairTime } from "../chart/format";
import { formatR } from "../chart/replay";
import { t, useLanguage, type Language } from "../i18n";
import type { ReplayController } from "../state/replay";

const DASH = "—";

/** Coloured only by sign: up above zero, down below, plain at zero. */
function signClass(r: number): string | undefined {
  const s = formatR(r);
  return s === "0.0R" ? undefined : r > 0 ? "up" : "down";
}

function Stat({ id, label, value, tone }: { id: string; label: string; value: string; tone?: string }) {
  return (
    <div className="replay-stat">
      <span className="label">{label}</span>
      <span className={tone ? `value mono ${tone}` : "value mono"} data-testid={`replay-stat-${id}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * When a fill happened: the close time of the candle it filled on, to the minute in UTC, the
 * same on every chart timeframe and update interval.
 */
export const fillTime = (ms: number) => formatCrosshairTime(ms, "1m");

/** Why a trade ended, or that it has not. */
const EXIT_LABEL: Record<ReplayTrade["reason"], string> = {
  take: "replay.trades.take",
  stop: "replay.trades.stop",
  manual: "replay.trades.manual",
  open: "replay.trades.open",
  unfinished: "replay.trades.unfinished",
};

/**
 * One row of the trades table. The controller keeps a closed trade's object as it is, so a step
 * renders only the open trade's row again, however long the list (`lang` changes the text).
 */
const TradeRow = memo(function TradeRow({ tr, n }: { tr: ReplayTrade; n: number; lang: Language }) {
  return (
    <tr data-testid="replay-trade" data-reason={tr.reason}>
      <td className="mono">{n}</td>
      <td>{t(tr.side === "long" ? "replay.trades.long" : "replay.trades.short")}</td>
      <td className="mono" data-testid="replay-trade-entry" data-time={tr.entryFillTime}>
        {fillTime(tr.entryFillTime)}
      </td>
      <td className={tr.exitFillTime === null ? "muted" : "mono"} data-testid="replay-trade-exit" data-time={tr.exitFillTime ?? ""}>
        {tr.exitFillTime === null
          ? t(EXIT_LABEL[tr.reason])
          : `${fillTime(tr.exitFillTime)} · ${t(EXIT_LABEL[tr.reason])}${tr.ambiguous ? " ?" : ""}`}
      </td>
      <td className={`num mono ${signClass(tr.r) ?? ""}`}>{formatR(tr.r)}</td>
    </tr>
  );
});

/**
 * The replay's results under the replay bar, from the engine: a row of statistics over the
 * closed trades and the open trade's R, and below it the trades, newest first. It folds to the
 * row (remembered by the controller).
 */
export function ReplayStats({ replay: r }: { replay: ReplayController }) {
  const lang = useLanguage();
  const view = r.view;
  if (!view) return null;
  const s = view.stats;
  const none = s.count === 0;
  const open = view.open;
  const collapsed = r.resultsCollapsed;
  const trades = view.trades.map((tr, i) => ({ tr, n: i + 1 })).reverse();
  return (
    <section className="replay-results" aria-label={t("replay.stats")} data-testid="replay-stats" data-collapsed={collapsed}>
      <div className="replay-results-head">
        <button
          className="text-button with-icon replay-results-toggle"
          data-testid="replay-results-toggle"
          aria-expanded={!collapsed}
          aria-controls="replay-trades"
          title={collapsed ? t("replay.results.expand") : t("replay.results.collapse")}
          onClick={() => r.toggleResults()}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {t("replay.results")}
        </button>
        <div className="replay-stats-row">
          <Stat id="trades" label={t("replay.stats.trades")} value={String(s.count)} />
          <Stat id="win-rate" label={t("replay.stats.winRate")} value={none ? DASH : `${Math.round(s.winRate * 100)}%`} />
          <Stat id="total-r" label={t("replay.stats.totalR")} value={formatR(s.totalR)} tone={signClass(s.totalR)} />
          <Stat
            id="average-r"
            label={t("replay.stats.averageR")}
            value={none ? DASH : formatR(s.averageR)}
            tone={none ? undefined : signClass(s.averageR)}
          />
          <Stat
            id="profit-factor"
            label={t("replay.stats.profitFactor")}
            value={s.profitFactor === null ? DASH : s.profitFactor.toFixed(2)}
          />
          <Stat id="max-drawdown" label={t("replay.stats.maxDrawdown")} value={`${s.maxDrawdownR.toFixed(1)}R`} />
          <Stat id="losing-streak" label={t("replay.stats.losingStreak")} value={String(s.longestLosingStreak)} />
          <Stat
            id="open-r"
            label={t("replay.stats.open")}
            value={open ? formatR(open.r) : DASH}
            tone={open ? signClass(open.r) : undefined}
          />
        </div>
      </div>
      {!collapsed && (
        <div className="replay-trades" id="replay-trades" data-testid="replay-trades" tabIndex={0} aria-label={t("replay.stats")}>
          {trades.length === 0 ? (
            <div className="replay-trades-none">{t("replay.trades.none")}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t("replay.trades.side")}</th>
                  <th scope="col">{t("replay.trades.entry")}</th>
                  <th scope="col">{t("replay.trades.exit")}</th>
                  <th scope="col" className="num">
                    {t("replay.trades.r")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {trades.map(({ tr, n }) => (
                  <TradeRow key={n} tr={tr} n={n} lang={lang} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
