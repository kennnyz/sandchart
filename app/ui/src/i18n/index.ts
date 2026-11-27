import { useSyncExternalStore } from "react";
import en from "./en.json";
import ru from "./ru.json";

export type Language = "en" | "ru";
export type MessageKey = keyof typeof en;

const STRINGS: Record<Language, Record<string, string>> = { en, ru };
const STORAGE_KEY = "sandchart.lang";

/** `ru*` -> Russian, anything else -> English. */
export function detectLanguage(navigatorLanguage: string | undefined): Language {
  return navigatorLanguage?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function storedLanguage(): Language | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === "en" || v === "ru" ? v : null;
  } catch {
    return null;
  }
}

let language: Language =
  storedLanguage() ?? detectLanguage(typeof navigator === "undefined" ? undefined : navigator.language);
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return language;
}

/** Switches the language, remembers the choice and re-renders every `useLanguage` user. */
export function setLanguage(lang: Language): void {
  if (lang === language) return;
  language = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    // No storage (private mode, tests): the choice lasts for this session only.
  }
  for (const l of listeners) l();
}

/** The string for `key` in the current language, `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey | (string & {}), vars?: Record<string, string | number>): string {
  const s = STRINGS[language][key] ?? STRINGS.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : s;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The current language; the component re-renders when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage);
}
