// Palette (spec §12.1): the component shared by the command palette and the branch popup (§6.2), with different content.
// A search box on top, a grouped list below: ↑ ↓ select (skipping disabled items), Enter runs, Esc or clicking outside closes.
// With onBack (inside a submenu), Esc and Backspace on an empty input go back a level first.
// Rows can have an icon, a grey prefix on the left (e.g. a short hash), a description and shortcut on the right; disabled rows fade and show the reason.

import { useReturnFocus } from "./focus";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { t, tr } from "../i18n";
import { keys } from "./format";
import { MenuIcon } from "./Menu";

export interface PaletteRow {
  key: string;
  /** Group name: a group heading shows when it differs from the previous row */
  section?: string;
  label: string;
  icon?: string;
  /** Grey monospace prefix on the left, e.g. a short hash */
  prefix?: string;
  /** Grey description on the right, e.g. the tracked remote branch, a date */
  detail?: string;
  /** Shortcut hint */
  hint?: string;
  disabled?: boolean;
  why?: string;
  danger?: boolean;
  /** Enter a submenu: the palette stays open after running */
  stay?: boolean;
  /** Shows "›" on the right, meaning it has a submenu */
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
  /** Inside a submenu: go back a level */
  onBack?: () => void;
  empty: string;
  /** Extra content below the list */
  footer?: ReactNode;
  className?: string;
}

export function Palette({ label, placeholder, query, onQuery, rows, onClose, onBack, empty, footer, className }: Props) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Highlight the first enabled item by default; skip "back" inside submenus
  const firstOk = () => {
    const i = rows.findIndex((r, k) => !r.disabled && !(k === 0 && r.key === BACK && rows.length > 1));
    return i < 0 ? Math.max(0, rows.findIndex((r) => !r.disabled)) : i;
  };
  // Right after the content changes, a mouse resting in place doesn't steal the highlight; follow only when it really moves
  const moved = useRef(false);
  const [hi, setHi] = useState(firstOk);

  // When the content changes (input changed, entering or leaving a submenu), go back to the first enabled item and refocus the input
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

/** The "back" row at the top of the palette inside a submenu */
const BACK = "\u0000back";
export const backRow = (onBack: () => void): PaletteRow => ({ key: BACK, label: t("← 返回"), stay: true, run: onBack });
