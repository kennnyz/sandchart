import { t } from "./i18n";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘K" on macOS, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl ${key}`;
}

/** Display name of a data source id ("binance" -> "Binance"); unknown ids as they are. */
export function sourceName(source: string): string {
  const key = `source.${source}`;
  const name = t(key);
  return name === key ? source : name;
}
