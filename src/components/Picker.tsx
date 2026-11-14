// A dropdown with a search box (for the filter bar's branch, author and path). Arrow keys select, Enter confirms, Esc or clicking outside closes.
// With `free`, Enter uses the typed text directly (path filter).

import { useReturnFocus } from "./focus";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";

export interface PickItem {
  key: string;
  label: string;
  /** Grey extra text on the right, e.g. commit count */
  sub?: string;
}

interface Props {
  x: number;
  y: number;
  items: PickItem[];
  placeholder: string;
  selected?: string | null;
  /** Text of the "no filter" item at the top of the list; no such item when not given */
  clearLabel?: string;
  /** Enter may use the typed text directly */
  free?: boolean;
  initial?: string;
  /** The list is still loading */
  loading?: boolean;
  onPick: (key: string | null) => void;
  onClose: () => void;
}

const LIMIT = 200;

export function Picker({ x, y, items, placeholder, selected, clearLabel, free, initial = "", loading, onPick, onClose }: Props) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(initial);
  const [pos, setPos] = useState({ left: x, top: y });
  const [hi, setHi] = useState(-1);

  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = f ? items.filter((i) => i.label.toLowerCase().includes(f) || i.key.toLowerCase().includes(f)) : items;
    return list.slice(0, LIMIT);
  }, [items, q]);
  const rows: (PickItem | null)[] = clearLabel && !q ? [null, ...shown] : shown;

  useEffect(() => setHi(free ? -1 : 0), [q, free]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    input.current?.focus();
    input.current?.select();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);

  useEffect(() => {
    box.current?.querySelector(".pk-row.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (i: PickItem | null) => {
    onPick(i ? i.key : null);
    onClose();
  };

  return (
    <div
      className="picker"
      ref={box}
      style={pos}
      role="dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          setHi((h) => Math.min(rows.length - 1, h + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHi((h) => Math.max(free ? -1 : 0, h - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (hi >= 0 && hi < rows.length) pick(rows[hi]);
          else if (free) {
            onPick(q.trim() || null);
            onClose();
          }
        }
      }}
    >
      <input ref={input} className="pk-q" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      <div className="pk-list" role="listbox">
        {rows.map((r, i) => (
          <button
            key={r ? r.key : "\u0000"}
            type="button"
            role="option"
            aria-selected={r ? r.key === selected : !selected}
            className={"pk-row" + (i === hi ? " hi" : "") + ((r ? r.key === selected : !selected) ? " on" : "")}
            onMouseEnter={() => setHi(i)}
            onClick={() => pick(r)}
          >
            <span className="pk-label">{r ? r.label : clearLabel}</span>
            {r?.sub && <span className="dim pk-sub">{r.sub}</span>}
          </button>
        ))}
        {loading && <p className="pk-empty dim">{t("正在读取…")}</p>}
        {!loading && rows.length === 0 && !free && <p className="pk-empty dim">{t("没有匹配的项")}</p>}
        {free && <p className="pk-empty dim small">{t("回车按{0}过滤，匹配路径里的任意一段", q.trim() ? `“${q.trim()}”` : t("输入的文字"))}</p>}
      </div>
    </div>
  );
}
