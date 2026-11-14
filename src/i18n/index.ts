// 多语言（目前中文和英文）。
//
// 界面文字直接用中文原文做键：t("已切换到 {0}", name)。中文时原样返回，英文时查 en.ts。
// 核心层返回的文字（错误说明、操作日志的说明、冲突两边的名字）在显示时用 tr() 翻译：
// 先整句查表，查不到再按带 {0} 占位的模板匹配，还是查不到就原样显示。
//
// 切换语言不重新加载窗口（重新加载会白屏闪一下）：lang 是活的变量，切换后通知最外层，整个界面就地重画；
// 模块顶层要翻译的常量用 lazy() 包起来，每次读的时候才按当前语言翻译。

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
/** 当前语言（活的绑定：切换后别的模块读到的也是新的） */
export let lang: Lang = setting === "auto" ? systemLang() : setting;
const markDoc = () => {
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
};
markDoc();

export const langSetting = (): LangSetting => setting;

const listeners = new Set<() => void>();

/** 订阅语言变化：切换时这个组件重画（用在最外层，整个界面跟着重画） */
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

/** 保存语言设置，就地切换（不重新加载窗口） */
export function setLang(v: LangSetting) {
  try {
    if (v === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* 存不了就只在本次有效 */
  }
  setting = v;
  lang = v === "auto" ? systemLang() : v;
  markDoc();
  listeners.forEach((f) => f());
}

/**
 * 模块顶层要翻译的表（如状态名、选项列表）：每次读的时候才按当前语言翻译，切换语言后读到的就是新的。
 * 用法和原来的对象、数组一样（X[key]、Object.keys(X)、X.map）。
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

/** 界面文字：中文原文做键，{0} {1} 是参数 */
export function t(zh: string, ...args: unknown[]): string {
  if (lang === "zh") return fill(zh, args);
  const hit = en[zh];
  if (hit === undefined && import.meta.env.DEV) missing(zh);
  return fill(hit ?? zh, args);
}

// 带占位的模板，用来翻译核心层拼出来的句子
let patterns: { re: RegExp; to: string }[] | null = null;
function compile() {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  patterns = Object.entries(en)
    .filter(([k]) => /\{\d+\}/.test(k))
    // 长的模板优先，免得短模板吃掉更具体的句子
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => ({ re: new RegExp("^" + k.split(/\{\d+\}/).map(esc).join("([\\s\\S]+?)") + "$"), to: v }));
  return patterns;
}

/** 翻译运行时得到的中文句子（核心层的错误说明、操作说明等）；空字符串和已经是英文的原样返回 */
export function tr(text: string | null | undefined, quiet = false): string {
  if (!text) return text ?? "";
  if (lang === "zh" || !/[一-鿿]/.test(text)) return text;
  const hit = en[text];
  if (hit !== undefined) return hit;
  for (const p of patterns ?? compile()) {
    const m = p.re.exec(text);
    // 占位里的内容也可能是一句可以翻译的话（如操作说明），也可能是提交标题之类的原文
    if (m) return fill(p.to, m.slice(1).map((x) => tr(x, true)));
  }
  // 由几句拼起来的：按句号分开分别翻译
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

/** 提示后面接上核心层给的补充说明（如拉取后自动搁置的改动没能放回，说明书 7.2） */
export function withNote(message: string, note?: string | null): string {
  if (!note) return message;
  const n = tr(note);
  if (!message) return n;
  return lang === "zh" ? `${message.replace(/。$/, "")}。${n}` : `${message.replace(/\.$/, "")}. ${n}`;
}
