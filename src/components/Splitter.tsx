// 分隔线：拖动调整相邻区域的大小。左右的（提交面板、提交详情、分支树的宽度）盖在两栏交界处；
// 上下的（提交详情里文件列表、提交信息的高度）放在两块之间。
// 拖动时直接改容器上的 CSS 变量，不重新渲染界面；松开时存进设置。双击恢复默认。
// 焦点在分隔线上时方向键每次调 16 像素（Shift 时 64），Home / End 到最小、最大。

import { useRef } from "react";
import { DEFAULTS, setSettings, settings, type Settings } from "../settings";
import { t } from "../i18n";

type Key = "paneLeft" | "paneRight" | "paneTree" | "detailFiles" | "detailInfo";

interface Props {
  /** 设置里的哪个尺寸 */
  name: Key;
  /** 写 CSS 变量的元素 */
  host: React.RefObject<HTMLElement | null>;
  /** 往哪个方向拖是变大：右、左（宽度），下、上（高度） */
  grow: "right" | "left" | "down" | "up";
  /** 允许的范围；max 按当时容器的大小算 */
  min: number;
  max: () => number;
  /** 现在实际的大小（设置里是自动时从界面上量） */
  size?: () => number;
  label: string;
}

export const cssVar = (name: Key) => `--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;

/** 设置里的尺寸换成 CSS 变量；自动（null）的不写 */
export const sizeVars = (s: Settings, keys: Key[]) =>
  Object.fromEntries(keys.filter((k) => s[k] != null).map((k) => [cssVar(k), `${s[k]}px`])) as React.CSSProperties;
export const paneVars = (s: Settings) => sizeVars({ ...s, paneLeft: Math.max(260, s.paneLeft) }, ["paneLeft", "paneRight", "paneTree"]);

export function Splitter({ name, host, grow, min, max, size, label }: Props) {
  const drag = useRef<{ at: number; w: number; now: number } | null>(null);
  const y = grow === "down" || grow === "up";
  const sign = grow === "right" || grow === "down" ? 1 : -1;
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), w)));
  const apply = (w: number | null) => (w == null ? host.current?.style.removeProperty(cssVar(name)) : host.current?.style.setProperty(cssVar(name), `${w}px`));
  const commit = (w: number | null) => setSettings({ [name]: w } as Partial<Settings>);
  const cur = () => settings()[name] ?? size?.() ?? min;
  const coord = (e: React.PointerEvent) => (y ? e.clientY : e.clientX);

  return (
    <div
      className={"splitter " + name + (y ? " y" : "")}
      role="separator"
      aria-orientation={y ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuenow={settings()[name] ?? undefined}
      aria-valuemin={min}
      tabIndex={0}
      title={y ? t("上下拖动调整高度，双击恢复默认") : t("拖动调整宽度，双击恢复默认")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { at: coord(e), w: cur(), now: cur() };
        document.body.classList.add("resizing", y ? "resizing-y" : "resizing-x");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.now = clamp(d.w + (coord(e) - d.at) * sign);
        apply(d.now);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        document.body.classList.remove("resizing", "resizing-y", "resizing-x");
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (d && d.now !== d.w) commit(d.now);
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove("resizing", "resizing-y", "resizing-x");
        apply(settings()[name]);
      }}
      onDoubleClick={() => {
        apply(DEFAULTS[name]);
        commit(DEFAULTS[name]);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const more = y ? (grow === "down" ? "ArrowDown" : "ArrowUp") : grow === "right" ? "ArrowRight" : "ArrowLeft";
        const less = y ? (grow === "down" ? "ArrowUp" : "ArrowDown") : grow === "right" ? "ArrowLeft" : "ArrowRight";
        let w: number | null = null;
        if (e.key === more) w = cur() + step;
        else if (e.key === less) w = cur() - step;
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
