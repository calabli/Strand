// Breadcrumbs: show which function, class or module the line in view is in (file › class Foo › fn bar).
// No parsing; inferred from indentation and common declaration forms: from the top visible line upward, lines with less indentation that look like declarations are the outer levels;
// Markdown goes by heading level. Clicking a level scrolls to that line.

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

/** If a line is a declaration (function, class, module…), give a short name; otherwise null */
function declLabel(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.startsWith("//") || s.startsWith("#") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("}") || s.startsWith("@")) return null;
  const a = ARROW.exec(s);
  if (a) return a[1];
  s = s.replace(MODS, "");
  if (CONTROL.test(s)) return null;
  const body = s.replace(/\s*[{:]\s*$/, "").replace(/\s+/g, " ");
  if (DECL.test(s)) {
    // fn foo(…) → fn foo; class Foo extends Bar → class Foo extends Bar
    const p = body.indexOf("(");
    return cut(p > 0 && !/^(?:impl|class|struct|enum|trait|interface)\b/.test(body) ? body.slice(0, p) : body);
  }
  // Other blocks ending with { (methods, describe("…", () => {, C/Java methods)
  // (assignments and let … else { don't count)
  if (/\{\s*$/.test(s) && !/^[{(\[]/.test(s) && !/[=,]\s*\{\s*$/.test(s) && !/^(?:let|const|var|val|auto)\b/.test(s) && !/[^=!<>]=[^=>]/.test(s) && !/\belse\s*\{\s*$/.test(s)) {
    const p = body.indexOf("(");
    return cut(p > 0 ? body.slice(0, p).replace(/^.*\s(?=[\w$.]+$)/, "") || body : body);
  }
  return null;
}

/**
 * The levels enclosing line n (outermost first). get(k) gives the text of line k; skipped when absent (e.g. parts not fetched in a diff).
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
  // Start: line n; for a blank line, look down for the first line with text
  let min = Infinity;
  for (let k = n; k < n + 50; k++) {
    const s = get(k);
    if (s !== undefined && s.trim()) {
      min = indentOf(s) + 1; // The line itself counts when it's a declaration
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
    // Multi-line function signatures: from ") -> X {" look up to the start with the same indentation
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

/** Follow scrolling and give the line number of the top visible line (lines carry data-n) */
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
      // Document order is top to bottom: binary search for the first line whose bottom edge is visible
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

/** The breadcrumb bar: file name › outer › inner; clicking a level scrolls to that line (the file name goes to the top) */
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
