import { formatR } from "../chart/replay";
import { t } from "../i18n";
import type { ReplayView } from "../state/replay";

const DASH = "—";

/** Coloured only by sign: up above zero, down below, plain at zero. */
function signClass(r: number): string | undefined {
  const s = formatR(r);
  return s === "0.0R" ? undefined : r > 0 ? "up" : "down";
}

function Row({ id, label, value, tone }: { id: string; label: string; value: string; tone?: string }) {
  return (
    <div className="replay-stat">
      <span className="label">{label}</span>
      <span className={tone ? `value mono ${tone}` : "value mono"} data-testid={`replay-stat-${id}`}>
        {value}
      </span>
    </div>
  );
}

/** The replay's results, from the engine: closed trades in R, then the open trade marked to the close. */
export function ReplayStats({ view }: { view: ReplayView }) {
  const s = view.stats;
  const none = s.count === 0;
  const open = view.open;
  return (
    <aside className="replay-stats" aria-label={t("replay.stats")} data-testid="replay-stats">
      <div className="replay-stats-title">{t("replay.stats")}</div>
      <Row id="trades" label={t("replay.stats.trades")} value={String(s.count)} />
      <Row id="win-rate" label={t("replay.stats.winRate")} value={none ? DASH : `${Math.round(s.winRate * 100)}%`} />
      <Row id="total-r" label={t("replay.stats.totalR")} value={formatR(s.totalR)} tone={signClass(s.totalR)} />
      <Row
        id="average-r"
        label={t("replay.stats.averageR")}
        value={none ? DASH : formatR(s.averageR)}
        tone={none ? undefined : signClass(s.averageR)}
      />
      <Row
        id="profit-factor"
        label={t("replay.stats.profitFactor")}
        value={s.profitFactor === null ? DASH : s.profitFactor.toFixed(2)}
      />
      <Row id="max-drawdown" label={t("replay.stats.maxDrawdown")} value={`${s.maxDrawdownR.toFixed(1)}R`} />
      <Row id="losing-streak" label={t("replay.stats.losingStreak")} value={String(s.longestLosingStreak)} />
      <div className="replay-stats-sep" />
      <Row
        id="open-r"
        label={t("replay.stats.open")}
        value={open ? formatR(open.r) : DASH}
        tone={open ? signClass(open.r) : undefined}
      />
    </aside>
  );
}
