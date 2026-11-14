// 面包屑：看到哪儿，上面就标出这一行在哪个函数、类、模块里（文件 › class Foo › fn bar）。
// 不做语法分析，按缩进和常见的声明写法推断：从最上面看得到的那一行往上找，缩进比它小、看起来像声明的行就是外层；
// Markdown 按标题级别。点一级滚到那一行。

import { useEffect, useMemo, useState, type RefObject } from "react";
import { t } from "../i18n";

export type Scope = { n: number; label: string };

const MODS = /^(?:(?:export|default|pub(?:\([^)]*\))?|async|static|public|private|protected|internal|abstract|final|override|open|unsafe|extern|inline|virtual|declare|sealed|data|suspend|readonly|partial)\s+)+/;
const DECL = /^(?:fn|function\*?|class|struct|enum|union|impl|trait|mod|interface|type|def|func|namespace|module|object|protocol|extension|record|macro_rules!)\b/;
const ARROW = /^(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/;
const CONTROL = /^(?:if|else|for|while|do|switch|case|default|catch|try|finally|with|return|match|loop|unsafe\s*\{|elif|except|guard|defer|select|go|when)\b/;
const indentOf = (s: string) => {
  let c = 0;
  for (const ch of s) {
    if (ch === " ") c++;
    else if (ch === "\t") c += 4;
    else break;
  }
  return c;
};
const cut = (s: string) => (s.length > 48 ? s.slice(0, 47) + "…" : s);

/** 一行如果是声明（函数、类、模块……），给出简短的名字；不是就返回 null */
function declLabel(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.startsWith("//") || s.startsWith("#") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("}") || s.startsWith("@")) return null;
  const a = ARROW.exec(s);
  if (a) return a[1];
  s = s.replace(MODS, "");
  if (CONTROL.test(s)) return null;
  const body = s.replace(/\s*[{:]\s*$/, "").replace(/\s+/g, " ");
  if (DECL.test(s)) {
    // fn foo(…) → fn foo；class Foo extends Bar → class Foo extends Bar
    const p = body.indexOf("(");
    return cut(p > 0 && !/^(?:impl|class|struct|enum|trait|interface)\b/.test(body) ? body.slice(0, p) : body);
  }
  // 别的以 { 结尾的块（方法、describe("…", () => {、C/Java 的方法）
  // （赋值、let … else { 这类不算）
  if (/\{\s*$/.test(s) && !/^[{(\[]/.test(s) && !/[=,]\s*\{\s*$/.test(s) && !/^(?:let|const|var|val|auto)\b/.test(s) && !/[^=!<>]=[^=>]/.test(s) && !/\belse\s*\{\s*$/.test(s)) {
    const p = body.indexOf("(");
    return cut(p > 0 ? body.slice(0, p).replace(/^.*\s(?=[\w$.]+$)/, "") || body : body);
  }
  return null;
}

/**
 * 第 n 行外面的各层（从外到里）。get(k) 给出第 k 行的文字，没有（如差异里没拿到的部分）就跳过。
 */
export function scopesAt(get: (k: number) => string | undefined, n: number, markdown = false): Scope[] {
  const out: Scope[] = [];
  if (markdown) {
    let level = 7;
    for (let k = n; k >= 1 && level > 1; k--) {
      const m = /^(#{1,6})\s+(.*)$/.exec(get(k) ?? "");
      if (m && m[1].length < level) {
        level = m[1].length;
        out.unshift({ n: k, label: cut(m[2].trim()) });
      }
    }
    return out;
  }
  // 起点：第 n 行，空行往下找第一行有字的
  let min = Infinity;
  for (let k = n; k < n + 50; k++) {
    const s = get(k);
    if (s !== undefined && s.trim()) {
      min = indentOf(s) + 1; // 这一行本身是声明的话也算
      break;
    }
  }
  for (let k = n, steps = 0; k >= 1 && min > 0 && steps < 20000; k--, steps++) {
    const s = get(k);
    if (s === undefined || !s.trim()) continue;
    const ind = indentOf(s);
    if (ind >= min) continue;
    let at = k;
    let text = s;
    // 多行的函数签名：“) -> X {” 往上找到同样缩进的开头
    if (/^\s*[)\]]/.test(s)) {
      for (let j = k - 1; j >= Math.max(1, k - 30); j--) {
        const p = get(j);
        if (p !== undefined && p.trim() && indentOf(p) === ind) {
          at = j;
          text = p;
          break;
        }
      }
    }
    const label = declLabel(text);
    if (label) {
      out.unshift({ n: at, label });
      min = ind;
    }
  }
  return out;
}

/** 跟着滚动，给出最上面看得到的那一行的行号（行上带 data-n） */
export function useTopLine(box: RefObject<HTMLElement | null>, deps: unknown[]): number {
  const [top, setTop] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rows = el.querySelectorAll<HTMLElement>("[data-n]");
      if (!rows.length) return setTop(1);
      const y = el.getBoundingClientRect().top + 2;
      // 按文档顺序就是从上到下：二分找第一行底边在可见区域里的
      let lo = 0, hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().bottom > y) hi = mid;
        else lo = mid + 1;
      }
      setTop(Number(rows[lo].dataset.n) || 1);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", on, { passive: true });
    return () => {
      el.removeEventListener("scroll", on);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return top;
}

/** 面包屑条：文件名 › 外层 › 里层；点一级滚到那一行（文件名回到顶上） */
export function Crumbs({ path, get, top, box }: { path: string; get: (k: number) => string | undefined; top: number; box: RefObject<HTMLElement | null> }) {
  const md = /\.(md|markdown|mdx)$/i.test(path);
  const scopes = useMemo(() => scopesAt(get, top, md), [get, top, md]);
  const jump = (n: number | null) => {
    const el = box.current;
    if (!el) return;
    if (n == null) el.scrollTo({ top: 0 });
    else el.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: "start" });
  };
  return (
    <nav className="crumbs mono" aria-label={t("代码位置")}>
      <button type="button" className="crumb" title={t("回到文件开头")} onClick={() => jump(null)}>
        {path.slice(path.lastIndexOf("/") + 1)}
      </button>
      {scopes.map((s) => (
        <span key={s.n} className="crumb-wrap">
          <span className="crumb-sep" aria-hidden="true">
            ›
          </span>
          <button type="button" className="crumb" title={t("第 {0} 行", s.n)} onClick={() => jump(s.n)}>
            {s.label}
          </button>
        </span>
      ))}
    </nav>
  );
}
