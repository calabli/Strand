// Context menu (spec §3.4, §12.2). Each item has an icon, text and an optional shortcut hint; groups are separated by dividers.
// Items with sub are submenus: open on hover, click or →; ← or Esc goes back a level.
// ↑ ↓ move between enabled items, Enter runs one. Closes on clicking outside, Esc, or the window losing focus; disabled items are greyed out and explain why on hover.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { tr } from "../i18n";
import { keys } from "./format";

export interface MenuItem {
  label: string;
  run?: () => void;
  disabled?: boolean;
  /** Why it's unavailable, shown on hover */
  why?: string;
  danger?: boolean;
  /** Shortcut hint, shown on the right */
  hint?: string;
  /** Icon: a 14×14 SVG path */
  icon?: string;
  /** Submenu */
  sub?: MenuEntry[];
  /** Group heading: small grey text, not clickable */
  heading?: boolean;
  /** Checked state: a ✓ on the left (in the icon slot) */
  checked?: boolean;
}
export type MenuEntry = MenuItem | "-";

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export function MenuIcon({ d }: { d?: string }) {
  return (
    <svg className="menu-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d && <path d={d} />}
    </svg>
  );
}

function List({
  items,
  x,
  y,
  /** When a submenu doesn't fit on the right, put it on the left: pass the parent item's left position */
  flipX,
  onClose,
  onBack,
  autoFocus,
}: {
  items: MenuEntry[];
  x: number;
  y: number;
  flipX?: number;
  onClose: () => void;
  onBack?: () => void;
  autoFocus: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [open, setOpen] = useState<{ i: number; x: number; y: number; flip: number; focus: boolean } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  // Shift back when it overflows the window; a submenu that doesn't fit on the right goes to the parent menu's left
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 4 && flipX != null ? Math.max(4, flipX - r.width) : Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    setPos({ left, top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    if (autoFocus) el.querySelector<HTMLButtonElement>(":scope > button:not(:disabled)")?.focus();
  }, [x, y, flipX, autoFocus, items]);

  const buttons = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? [])];
  const openSub = (i: number, el: HTMLElement, focus: boolean) => {
    const r = el.getBoundingClientRect();
    setOpen({ i, x: r.right - 2, y: r.top - 5, flip: r.left + 2, focus });
  };

  return (
    <>
      <div
        className="menu"
        role="menu"
        ref={box}
        style={pos}
        onKeyDown={(e) => {
          if (open && e.target instanceof Node && !box.current?.contains(e.target)) return;
          const list = buttons();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const n = list.length;
            if (n) list[(at + (e.key === "ArrowDown" ? 1 : n - 1 + (at < 0 ? 1 : 0))) % n]?.focus();
          } else if (e.key === "ArrowRight") {
            const el = document.activeElement as HTMLElement;
            const i = Number(el?.dataset.i);
            const it = items[i];
            if (it && it !== "-" && it.sub) {
              e.preventDefault();
              e.stopPropagation();
              openSub(i, el, true);
            }
          } else if ((e.key === "ArrowLeft" || e.key === "Escape") && onBack) {
            e.preventDefault();
            e.stopPropagation();
            onBack();
          }
        }}
      >
        {items.map((it, i) =>
          it === "-" ? (
            <div key={i} className="menu-sep" role="separator" />
          ) : it.heading ? (
            <div key={i} className="menu-heading" role="presentation">
              {tr(it.label)}
            </div>
          ) : (
            <button
              key={i}
              data-i={i}
              type="button"
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
              aria-haspopup={it.sub ? "menu" : undefined}
              aria-expanded={it.sub ? open?.i === i : undefined}
              className={(it.danger ? "danger-text" : "") + (open?.i === i ? " sub-open" : "")}
              disabled={it.disabled}
              title={it.disabled ? tr(it.why) : undefined}
              onMouseEnter={(e) => {
                window.clearTimeout(hoverTimer.current);
                const el = e.currentTarget;
                hoverTimer.current = window.setTimeout(() => (it.sub ? openSub(i, el, false) : setOpen(null)), it.sub ? 120 : 200);
              }}
              onClick={(e) => {
                if (it.sub) return openSub(i, e.currentTarget, true);
                onClose();
                it.run?.();
              }}
            >
              <MenuIcon d={it.checked ? "M3 7.5l2.5 2.5L11 4.5" : it.icon} />
              <span className="menu-label">{tr(it.label)}</span>
              {it.hint && <span className="kbd menu-hint">{keys(it.hint)}</span>}
              {it.sub && <span className="menu-more">›</span>}
            </button>
          ),
        )}
      </div>
      {open && items[open.i] !== "-" && (items[open.i] as MenuItem).sub && (
        <List
          key={open.i}
          items={(items[open.i] as MenuItem).sub!}
          x={open.x}
          y={open.y}
          flipX={open.flip}
          onClose={onClose}
          autoFocus={open.focus}
          onBack={() => {
            const i = open.i;
            setOpen(null);
            box.current?.querySelector<HTMLButtonElement>(`:scope > button[data-i="${i}"]`)?.focus();
          }}
        />
      )}
    </>
  );
}

export function Menu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && root.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={root} className="menu-root">
      <List items={menu.items} x={menu.x} y={menu.y} onClose={onClose} autoFocus />
    </div>
  );
}
