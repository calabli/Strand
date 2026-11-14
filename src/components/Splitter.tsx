// 分隔线：拖动调整相邻区域的宽度（左边提交面板、右边提交详情、分支树）。
// 拖动时直接改容器上的 CSS 变量，不重新渲染界面；松开时存进设置。双击恢复默认宽度。
// 焦点在分隔线上时 ← → 每次调 16 像素（Shift 时 64），Home / End 到最小、最大。

import { useRef } from "react";
import { DEFAULTS, setSettings, settings, type Settings } from "../settings";
import { t } from "../i18n";

type Key = "paneLeft" | "paneRight" | "paneTree";

interface Props {
  /** 设置里的哪个宽度 */
  name: Key;
  /** 写 CSS 变量的元素 */
  host: React.RefObject<HTMLElement | null>;
  /** 分隔线在被调区域的右边（往右拖变宽）还是左边（往左拖变宽） */
  grow: "right" | "left";
  /** 允许的范围；max 按当时容器的宽度算 */
  min: number;
  max: () => number;
  label: string;
}

export const cssVar = (name: Key) => `--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;

/** 设置里的宽度换成容器上的 CSS 变量 */
export const paneVars = (s: Settings) => ({ [cssVar("paneLeft")]: `${s.paneLeft}px`, [cssVar("paneRight")]: `${s.paneRight}px`, [cssVar("paneTree")]: `${s.paneTree}px` }) as React.CSSProperties;

export function Splitter({ name, host, grow, min, max, label }: Props) {
  const drag = useRef<{ x: number; w: number; now: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), w)));
  const apply = (w: number) => host.current?.style.setProperty(cssVar(name), `${w}px`);
  const commit = (w: number) => setSettings({ [name]: w } as Partial<Settings>);
  const cur = () => settings()[name];

  return (
    <div
      className={"splitter " + name}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={cur()}
      aria-valuemin={min}
      tabIndex={0}
      title={t("拖动调整宽度，双击恢复默认")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: cur(), now: cur() };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        d.now = clamp(d.w + (grow === "right" ? dx : -dx));
        apply(d.now);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        document.body.classList.remove("resizing");
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (d && d.now !== d.w) commit(d.now);
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
        apply(cur());
      }}
      onDoubleClick={() => {
        apply(DEFAULTS[name]);
        commit(DEFAULTS[name]);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const sign = grow === "right" ? 1 : -1;
        let w: number | null = null;
        if (e.key === "ArrowRight") w = cur() + step * sign;
        else if (e.key === "ArrowLeft") w = cur() - step * sign;
        else if (e.key === "Home") w = min;
        else if (e.key === "End") w = max();
        if (w === null) return;
        e.preventDefault();
        w = clamp(w);
        apply(w);
        commit(w);
      }}
    />
  );
}
