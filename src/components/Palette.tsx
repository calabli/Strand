// 面板（说明书 12.1）：命令面板和分支弹窗（6.2）共用的组件，只是内容不同。
// 顶部搜索框，下面是分组的列表：↑ ↓ 选择（跳过不可用的项），回车执行，Esc 或点外面关闭。
// 有 onBack（在子菜单里）时，Esc 和输入框为空时的退格先回到上一级。
// 行可以带图标、左边的灰色前缀（如短哈希）、右边的说明和快捷键；不可用的行变淡并显示原因。

import { useReturnFocus } from "./focus";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { t, tr } from "../i18n";
import { keys } from "./format";
import { MenuIcon } from "./Menu";

export interface PaletteRow {
  key: string;
  /** 分组名：和上一行不同时显示组标题 */
  section?: string;
  label: string;
  icon?: string;
  /** 左边的灰色等宽前缀，如短哈希 */
  prefix?: string;
  /** 右边的灰色说明，如跟踪的远程分支、日期 */
  detail?: string;
  /** 快捷键提示 */
  hint?: string;
  disabled?: boolean;
  why?: string;
  danger?: boolean;
  /** 进入子菜单：执行后不关闭面板 */
  stay?: boolean;
  /** 右边显示“›”，表示有子菜单 */
  more?: boolean;
  run: () => void;
}

interface Props {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (q: string) => void;
  rows: PaletteRow[];
  onClose: () => void;
  /** 在子菜单里时：回到上一级 */
  onBack?: () => void;
  empty: string;
  /** 列表下面的补充内容 */
  footer?: ReactNode;
  className?: string;
}

export function Palette({ label, placeholder, query, onQuery, rows, onClose, onBack, empty, footer, className }: Props) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // 默认高亮第一个可用的项；子菜单里跳过“返回”
  const firstOk = () => {
    const i = rows.findIndex((r, k) => !r.disabled && !(k === 0 && r.key === BACK && rows.length > 1));
    return i < 0 ? Math.max(0, rows.findIndex((r) => !r.disabled)) : i;
  };
  // 内容刚换掉时，停在原处的鼠标不抢高亮；鼠标真的动了才跟随
  const moved = useRef(false);
  const [hi, setHi] = useState(firstOk);

  // 换了内容（输入变了、进出子菜单）时回到第一个可用的项，焦点回到输入框
  const sig = rows.map((r) => r.key).join("\n");
  useEffect(() => {
    moved.current = false;
    setHi(firstOk());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const inSub = !!onBack;
  useEffect(() => input.current?.focus(), [inSub]);
  useEffect(() => {
    box.current?.querySelector(".pal-row.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const move = (d: 1 | -1) =>
    setHi((h) => {
      for (let i = h + d; i >= 0 && i < rows.length; i += d) if (!rows[i].disabled) return i;
      return h;
    });

  const run = (r: PaletteRow | undefined) => {
    if (!r || r.disabled) return;
    if (!r.stay) onClose();
    r.run();
  };

  let lastSection: string | undefined;
  return (
    <div className="modal-back top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={"palette" + (className ? " " + className : "")}
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (onBack) onBack();
            else onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            run(rows[hi]);
          } else if (e.key === "Backspace" && !query && onBack) {
            e.preventDefault();
            onBack();
          }
        }}
      >
        <input ref={input} className="pal-q" placeholder={placeholder} value={query} onChange={(e) => onQuery(e.target.value)} spellCheck={false} aria-label={placeholder} />
        <div className="pal-list" role="listbox" aria-label={label} onMouseMove={() => (moved.current = true)}>
          {rows.map((r, i) => {
            const head = r.section && r.section !== lastSection ? <div className="pal-sec dim">{r.section}</div> : null;
            if (r.section) lastSection = r.section;
            return (
              <div key={r.key}>
                {head}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === hi}
                  aria-disabled={r.disabled || undefined}
                  className={"pal-row" + (i === hi ? " hi" : "") + (r.disabled ? " off" : "") + (r.danger ? " danger-text" : "")}
                  title={r.disabled ? tr(r.why) : undefined}
                  onMouseEnter={() => moved.current && !r.disabled && setHi(i)}
                  onMouseMove={() => !r.disabled && i !== hi && setHi(i)}
                  onClick={() => run(r)}
                >
                  {r.icon !== undefined && <MenuIcon d={r.icon} />}
                  {r.prefix && <span className="mono dim">{r.prefix}</span>}
                  <span className="pal-label">{r.label}</span>
                  {r.disabled && r.why && <span className="dim small pal-why">{tr(r.why)}</span>}
                  {r.detail && <span className="dim small pal-detail">{r.detail}</span>}
                  {r.hint && <span className="kbd pal-hint">{keys(r.hint)}</span>}
                  {r.more && <span className="dim pal-more">›</span>}
                </button>
              </div>
            );
          })}
          {rows.length === 0 && <p className="dim pal-empty">{empty}</p>}
          {footer}
        </div>
      </div>
    </div>
  );
}

/** 在子菜单里的面板顶部那一行“返回” */
const BACK = "\u0000back";
export const backRow = (onBack: () => void): PaletteRow => ({ key: BACK, label: t("← 返回"), stay: true, run: onBack });
