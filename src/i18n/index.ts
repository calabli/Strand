// 多语言（目前中文和英文）。
//
// 界面文字直接用中文原文做键：t("已切换到 {0}", name)。中文时原样返回，英文时查 en.ts。
// 核心层返回的文字（错误说明、操作日志的说明、冲突两边的名字）在显示时用 tr() 翻译：
// 先整句查表，查不到再按带 {0} 占位的模板匹配，还是查不到就原样显示。
//
// 切换语言时重新加载窗口（会自动重新打开上次的仓库），所以模块顶层的常量也可以直接调用 t()。

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

const setting = readSetting();
export const lang: Lang = setting === "auto" ? systemLang() : setting;
if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

export const langSetting = (): LangSetting => setting;

/** 切换语言重新加载窗口之前要做的事（界面把当前看的东西存起来，加载后回到原处） */
const beforeReload = new Set<() => void>();
export function onBeforeLangReload(fn: () => void): () => void {
  beforeReload.add(fn);
  return () => beforeReload.delete(fn);
}

/** 保存语言设置并重新加载窗口（加载前先让界面存下当前看的东西） */
export function setLang(v: LangSetting) {
  try {
    if (v === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* 存不了就只在本次有效 */
  }
  for (const fn of beforeReload) {
    try {
      fn();
    } catch {
      /* 存不了就回到默认的样子 */
    }
  }
  location.reload();
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
