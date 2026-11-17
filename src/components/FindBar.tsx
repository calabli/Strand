// Find in a diff or a file's full text (⌘F), and go to a line (⌘L), like an editor's find bar.
// Matches are marked by the views themselves (<mark class="find">, the same marks as search results); the bar counts
// them, steps through them with Enter / Shift+Enter (or ↑ ↓), and scrolls the current one into view. Esc closes it.
// Only text that's on screen can be found: folded unchanged parts of a diff are left out until expanded.

import { useEffect, useRef, useState, type RefObject } from "react";
import { findRegExp, keys } from "./format";
import { t } from "../i18n";

export type FindMode = "find" | "line";

/**
 * Find-bar state for one view. `host` is the element whose content is searched; `active` says the view is the one
 * on screen (several file tabs stay mounted), so only it answers ⌘F / ⌘L.
 */
export function useFind(host: RefObject<HTMLElement | null>, active: boolean) {
  const [mode, setMode] = useState<FindMode | null>(null);
  const [text, setText] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const re = mode === "find" && text ? findRegExp(text, regex, caseSensitive) : null;
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "f" && k !== "l") return;
      // Only when the view is on screen and no dialog is open
      if (!host.current?.offsetParent || document.querySelector(".modal-back, .palette")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMode(k === "f" ? "find" : "line");
    };
    // Capture: runs before the log's own ⌘F handler
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [active, host]);
  return { mode, setMode, text, setText, regex, setRegex, caseSensitive, setCase, re };
}

export type FindState = ReturnType<typeof useFind>;

export function FindBar({ f, host, onLine }: { f: FindState; host: RefObject<HTMLElement | null>; onLine: (line: number) => boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [cur, setCur] = useState(0);
  const [count, setCount] = useState(0);
  const [lineText, setLineText] = useState("");
  const [lineErr, setLineErr] = useState(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [f.mode]);

  // Count the marks after the view re-renders (syntax colors arrive a little later), and mark the current one
  const marks = () => [...(host.current?.querySelectorAll<HTMLElement>("mark.find") ?? [])];
  useEffect(() => {
    if (f.mode !== "find") return;
    setCur(0);
    const id = window.setTimeout(() => setCount(f.re ? marks().length : 0), 120);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.re?.source, f.re?.flags, f.mode]);
  useEffect(() => {
    if (f.mode !== "find" || !f.re) return;
    const id = window.setTimeout(() => {
      const ms = marks();
      setCount(ms.length);
      ms.forEach((m, i) => m.classList.toggle("find-cur", i === cur));
      ms[cur]?.scrollIntoView({ block: "center", inline: "nearest" });
    }, 140);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, count, f.re?.source, f.re?.flags]);
  const step = (d: 1 | -1) => count && setCur((c) => (c + d + count) % count);
  const close = () => {
    marks().forEach((m) => m.classList.remove("find-cur"));
    f.setMode(null);
  };

  if (!f.mode) return null;
  if (f.mode === "line")
    return (
      <div className="findbar" role="search" aria-label={t("跳到行")}>
        <input
          ref={input}
          className="mono"
          inputMode="numeric"
          placeholder={t("跳到第几行")}
          aria-label={t("跳到第几行")}
          aria-invalid={lineErr}
          value={lineText}
          onChange={(e) => (setLineText(e.target.value.replace(/[^\d]/g, "")), setLineErr(false))}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "Enter" && lineText) {
              if (onLine(Number(lineText))) close();
              else setLineErr(true);
            }
          }}
        />
        {lineErr && <span className="small err">{t("没有这一行，或在折叠的部分里")}</span>}
        <button type="button" className="ib sm" title={t("关闭（Esc）")} aria-label={t("关闭")} onClick={close}>
          ×
        </button>
      </div>
    );
  return (
    <div className="findbar" role="search" aria-label={t("查找")}>
      <input
        ref={input}
        placeholder={t("查找")}
        aria-label={t("查找")}
        value={f.text}
        onChange={(e) => f.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? -1 : 1));
          else if (e.key === "ArrowDown") (e.preventDefault(), step(1));
          else if (e.key === "ArrowUp") (e.preventDefault(), step(-1));
        }}
      />
      <button type="button" className={"ib sm mono" + (f.caseSensitive ? " pressed" : "")} aria-pressed={f.caseSensitive} title={t("区分大小写")} aria-label={t("区分大小写")} onClick={() => f.setCase(!f.caseSensitive)}>
        Aa
      </button>
      <button type="button" className={"ib sm mono" + (f.regex ? " pressed" : "")} aria-pressed={f.regex} title={t("正则表达式")} aria-label={t("正则表达式")} onClick={() => f.setRegex(!f.regex)}>
        .*
      </button>
      <span className="small dim findbar-n" aria-live="polite">
        {f.text ? (count ? t("{0} / {1}", cur + 1, count) : t("没有结果")) : ""}
      </span>
      <button type="button" className="ib sm" title={t("上一个（⇧↵）")} aria-label={t("上一个")} disabled={!count} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="ib sm" title={t("下一个（↵）")} aria-label={t("下一个")} disabled={!count} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="ib sm" title={t("跳到行（{0}）", keys("⌘L"))} aria-label={t("跳到行")} onClick={() => f.setMode("line")}>
        #
      </button>
      <button type="button" className="ib sm" title={t("关闭（Esc）")} aria-label={t("关闭")} onClick={close}>
        ×
      </button>
    </div>
  );
}

/** Scroll to the element for a line number (data-n) inside host and flash it; false when that line isn't on screen */
export function goToLine(host: HTMLElement | null, line: number): boolean {
  const el = host?.querySelector<HTMLElement>(`[data-n="${line}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.remove("line-flash");
  void el.offsetWidth;
  el.classList.add("line-flash");
  return true;
}
