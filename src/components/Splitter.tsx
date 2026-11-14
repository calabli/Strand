// Splitter: drag to resize neighboring areas. Horizontal ones (commit panel, commit details, branch tree widths) sit over the boundary between columns;
// vertical ones (file list and commit info heights in commit details) sit between the two blocks.
// Dragging changes CSS variables on the container directly without re-rendering; releasing saves to settings. Double-click restores the default.
// With focus on the splitter, arrow keys adjust by 16 px (64 with Shift), Home / End go to min and max.

import { useRef } from "react";
import { DEFAULTS, setSettings, settings, type Settings } from "../settings";
import { t } from "../i18n";

type Key = "paneLeft" | "paneRight" | "paneTree" | "detailFiles" | "detailInfo" | "paneHistory";

interface Props {
  /** Which size in settings */
  name: Key;
  /** The element that receives the CSS variable */
  host: React.RefObject<HTMLElement | null>;
  /** Which drag direction grows it: right, left (width), down, up (height) */
  grow: "right" | "left" | "down" | "up";
  /** Allowed range; max is computed from the container's current size */
  min: number;
  max: () => number;
  /** The current actual size (measured from the UI when the setting is automatic) */
  size?: () => number;
  label: string;
}

export const cssVar = (name: Key) => `--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;

/** Turn the sizes in settings into CSS variables; automatic (null) ones aren't written */
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
