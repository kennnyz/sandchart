import type { ProblemCode } from "./backend/types";
import { isMac } from "./chart/drawings/keys";
import { t } from "./i18n";

/** "⌘K" on macOS, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl ${key}`;
}

/** "⌥T" on macOS, "Alt T" elsewhere. */
export function altShortcutLabel(key: string): string {
  return isMac ? `⌥${key}` : `Alt ${key}`;
}

/** The Delete key as printed on this platform's keyboard. */
export function deleteKeyLabel(): string {
  return isMac ? "⌫" : "Del";
}

/** The Enter key as printed on this platform's keyboard. */
export function enterKeyLabel(): string {
  return isMac ? "↵" : "Enter";
}

/** Display name of a data source id ("binance" -> "Binance"); unknown ids as they are. */
export function sourceName(source: string): string {
  const key = `source.${source}`;
  const name = t(key);
  return name === key ? source : name;
}

const BANNER_KEYS: Record<ProblemCode, string> = {
  network: "banner.network",
  rate_limited: "banner.rateLimited",
  blocked: "banner.blocked",
  other: "banner.other",
  unsafe_ticks: "banner.unsafeTicks",
};

/**
 * The banner sentence for a problem: what went wrong, then what the chart shows.
 * `cachedUpTo` is the clock time of the newest candle on the chart, null without one.
 */
export function bannerText(code: ProblemCode, source: string, cachedUpTo: string | null): string {
  const cause = t(BANNER_KEYS[code], { source });
  if (code === "unsafe_ticks") return cause;
  const shown = cachedUpTo === null ? t("banner.noCache") : t("banner.cachedUpTo", { time: cachedUpTo });
  return `${cause} ${shown}`;
}
