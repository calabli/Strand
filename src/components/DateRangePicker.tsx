// Custom date range (date filter in spec §5.1): from one day to another, both inclusive; filling just one end works too. Whole days in the local time zone.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReturnFocus } from "./focus";
import { t } from "../i18n";

interface Props {
  x: number;
  y: number;
  from: string | null;
  to: string | null;
  onApply: (from: string | null, to: string | null) => void;
  onClose: () => void;
}

export function DateRangePicker({ x, y, from, to, onApply, onClose }: Props) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [a, setA] = useState(from ?? "");
  const [b, setB] = useState(to ?? "");
  const [pos, setPos] = useState({ left: x, top: y });
  const reversed = !!a && !!b && a > b;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    first.current?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);

  const ok = (a || b) && !reversed;
  const apply = () => {
    if (!ok) return;
    onApply(a || null, b || null);
    onClose();
  };

  return (
    <div
      className="picker drp"
      ref={box}
      style={pos}
      role="dialog"
      aria-label={t("自定义日期范围")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      }}
    >
      <p className="drp-title">{t("自定义日期范围")}</p>
      <label className="drp-row">
        <span className="dim">{t("从")}</span>
        <input ref={first} type="date" value={a} max={b || undefined} onChange={(e) => setA(e.target.value)} />
      </label>
      <label className="drp-row">
        <span className="dim">{t("到")}</span>
        <input type="date" value={b} min={a || undefined} onChange={(e) => setB(e.target.value)} />
      </label>
      <p className={"small " + (reversed ? "apk-bad" : "dim")}>{reversed ? t("开始日期晚于结束日期") : t("两头都含；只填一头表示从那天起或到那天为止")}</p>
      <div className="apk-foot">
        <span className="grow" />
        <button type="button" className="btn sm" onClick={onClose}>
          {t("取消")}
        </button>
        <button type="button" className="btn sm primary" disabled={!ok} onClick={apply}>
          {t("应用")}
        </button>
      </div>
    </div>
  );
}
