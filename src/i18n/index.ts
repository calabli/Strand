// Internationalization (Chinese and English for now).
//
// UI text uses the original Chinese as the key: t("已切换到 {0}", name). Returned as is in Chinese; looked up in en.ts in English.
// Text returned by the core layer (error messages, op log labels, conflict side names) is translated at display time with tr():
// first the whole sentence is looked up, then templates with {0} placeholders are matched, and otherwise it's shown as is.
//
// Switching languages doesn't reload the window (reloading flashes white): lang is a live variable, and switching notifies the root so the whole UI re-draws in place;
// module-level constants that need translating are wrapped in lazy() and translated with the current language on every read.

import { useEffect, useState } from "react";
import { en } from "./en";

export type Lang = "zh" | "en";
export type LangSetting = Lang | "auto";

const KEY = "strand.lang";

function readSetting(): LangSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "zh" || v === "en" ? v : "auto";
  } catch {
    return "auto";
  }
}

function systemLang(): Lang {
  const l = (typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language : "zh") || "zh";
  return l.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let setting = readSetting();
/** Current language (a live binding: other modules read the new value after switching) */
export let lang: Lang = setting === "auto" ? systemLang() : setting;
const markDoc = () => {
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
};
markDoc();

export const langSetting = (): LangSetting => setting;

const listeners = new Set<() => void>();

/** Subscribe to language changes: this component re-draws on switch (used at the root, so the whole UI follows) */
export function useLang(): Lang {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return lang;
}

/** Save the language setting and switch in place (no window reload) */
export function setLang(v: LangSetting) {
  try {
    if (v === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* Can't save: valid for this session only */
  }
  setting = v;
  lang = v === "auto" ? systemLang() : v;
  markDoc();
  listeners.forEach((f) => f());
}

/**
 * Module-level tables that need translating (e.g. status names, option lists): translated with the current language on every read, so reads after switching get the new one.
 * Used like the original objects and arrays (X[key], Object.keys(X), X.map).
 */
export function lazy<T extends object>(make: () => T): T {
  const target = (Array.isArray(make()) ? [] : {}) as T;
  return new Proxy(target, {
    get: (_, k) => {
      const v = make() as Record<PropertyKey, unknown>;
      const x = v[k];
      return typeof x === "function" ? (x as (...a: unknown[]) => unknown).bind(v) : x;
    },
    has: (_, k) => k in make(),
    ownKeys: () => Reflect.ownKeys(make()),
    getOwnPropertyDescriptor: (_, k) => {
      const d = Reflect.getOwnPropertyDescriptor(make(), k);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

function fill(s: string, args: unknown[]): string {
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;
}

/** UI text: the original Chinese is the key, {0} {1} are arguments */
export function t(zh: string, ...args: unknown[]): string {
  if (lang === "zh") return fill(zh, args);
  const hit = en[zh];
  if (hit === undefined && import.meta.env.DEV) missing(zh);
  return fill(hit ?? zh, args);
}

// Templates with placeholders, for translating sentences assembled by the core layer
let patterns: { re: RegExp; to: string }[] | null = null;
function compile() {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  patterns = Object.entries(en)
    .filter(([k]) => /\{\d+\}/.test(k))
    // Longer templates first so short templates don't swallow more specific sentences
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => ({ re: new RegExp("^" + k.split(/\{\d+\}/).map(esc).join("([\\s\\S]+?)") + "$"), to: v }));
  return patterns;
}

/** Translate Chinese sentences obtained at runtime (core layer error messages, op descriptions, etc.); empty strings and English text are returned as is */
export function tr(text: string | null | undefined, quiet = false): string {
  if (!text) return text ?? "";
  if (lang === "zh" || !/[一-鿿]/.test(text)) return text;
  const hit = en[text];
  if (hit !== undefined) return hit;
  for (const p of patterns ?? compile()) {
    const m = p.re.exec(text);
    // A placeholder's content may itself be a translatable sentence (e.g. an op description), or original text like a commit title
    if (m) return fill(p.to, m.slice(1).map((x) => tr(x, true)));
  }
  // Several sentences joined together: split on full stops and translate each
  if (/[。；]/.test(text)) {
    const parts = text.split(/(?<=[。；])/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts.map((p) => tr(p.replace(/[。；]$/, ""), quiet) + (p.endsWith("。") ? "." : p.endsWith("；") ? ";" : "")).join(" ");
  }
  if (import.meta.env.DEV && !quiet) missing(text);
  return text;
}

const seen = new Set<string>();
function missing(s: string) {
  if (seen.has(s)) return;
  seen.add(s);
  console.warn("[i18n] 缺英文：", s);
}

/** Append the core layer's extra note to a notice (e.g. auto-shelved changes couldn't be restored after a pull, spec §7.2) */
export function withNote(message: string, note?: string | null): string {
  if (!note) return message;
  const n = tr(note);
  if (!message) return n;
  return lang === "zh" ? `${message.replace(/。$/, "")}。${n}` : `${message.replace(/\.$/, "")}. ${n}`;
}
