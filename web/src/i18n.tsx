/* eslint-disable react/only-export-components -- provider and its hooks belong together; only costs fast refresh */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import de from "./locales/de.json";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import fa from "./locales/fa.json";
import csCZ from "./locales/cs-CZ.json";
import ru from "./locales/ru.json";

export type Lang = "de" | "en" | "zh-CN" | "fa" | "cs-CZ" | "ru";
const RTL_LANGS = new Set<Lang>(["fa"]);
export type LangPref = "auto" | Lang;

const LANGUAGE_KEY = "webspeak3:language";

// Keyed flat dictionary, one JSON file per language under locales/. Every
// user-facing string in the app should have an entry in every file - falls
// back to the English string (or the raw key) if a translation is missing,
// so a partial dictionary never blanks out the UI. Plain JSON (not inline
// TS objects) so translation tools like Weblate can read/write these files
// directly.
const translations: Record<Lang, Record<string, string>> = {
  de,
  en,
  "zh-CN": zhCN,
  fa,
  "cs-CZ": csCZ,
  ru,
};

function detectSystemLang(): Lang {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const normalized = nav?.toLowerCase() ?? "en";
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("fa")) return "fa";
  if (normalized.startsWith("cs")) return "cs-CZ";
  if (normalized.startsWith("ru")) return "ru";
  return normalized.startsWith("de") ? "de" : "en";
}

export function resolveLang(pref: LangPref): Lang {
  return pref === "auto" ? detectSystemLang() : pref;
}

export function loadLangPref(): LangPref {
  const raw = localStorage.getItem(LANGUAGE_KEY);
  return raw === "de" || raw === "en" || raw === "zh-CN" || raw === "fa" || raw === "cs-CZ" || raw === "ru" || raw === "auto" ? raw : "auto";
}

export function saveLangPref(pref: LangPref) {
  localStorage.setItem(LANGUAGE_KEY, pref);
}

type TranslateFn = (key: string, vars?: Record<string, string>) => string;

function interpolate(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
}

const LanguageContext = createContext<{ lang: Lang; langPref: LangPref; setLangPref: (p: LangPref) => void; t: TranslateFn }>({
  lang: "en",
  langPref: "auto",
  setLangPref: () => {},
  t: (key) => translations.en[key] ?? key,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [langPref, setLangPrefState] = useState<LangPref>(() => loadLangPref());
  const lang = resolveLang(langPref);

  useEffect(() => {
    saveLangPref(langPref);
  }, [langPref]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
  }, [lang]);

  const t: TranslateFn = (key, vars) =>
    interpolate(translations[lang][key] ?? translations.en[key] ?? key, vars);

  return (
    <LanguageContext.Provider value={{ lang, langPref, setLangPref: setLangPrefState, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export function useT() {
  return useContext(LanguageContext).t;
}
