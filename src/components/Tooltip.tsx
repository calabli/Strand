// Tooltips (spec §12.4): show a button's name next to it after the mouse rests on it for 350 ms; right after one tooltip, moving to the next button shows it immediately.
// Also shown when keyboard focus moves to a button.
//
// No per-button code: a global listener takes the element's title (aria-label for icon buttons without a title). While showing, the title is removed
// and restored on leave, so the system's own tooltip doesn't pop up as well (in the desktop app the system tooltip takes a second or two, and sometimes never appears).
// While the title is removed, elements without an aria-label temporarily get one so screen readers read the same name.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY = 350;
/** Moving to the next button within this long after the previous tooltip disappears shows it without waiting */
const WARM = 600;

type Tip = { text: string; rect: DOMRect };

/** Icon buttons: no visible text (or only one or two symbols, like ↑ ×) */
const iconOnly = (el: Element) => (el.textContent ?? "").replace(/\s/g, "").length <= 2;

/** Find the nearest ancestor with a tooltip; returns the element and text */
function tipOf(start: EventTarget | null): { el: HTMLElement; text: string } | null {
  let el = start instanceof Element ? (start as HTMLElement) : null;
  while (el && el !== document.body) {
    if (el.closest(".tooltip")) return null;
    const title = el.getAttribute("title") ?? el.dataset.tipTitle;
    if (title) return { el, text: title };
    if (el.matches("button, [role=button], [role=tab], [role=radio], a") && el.getAttribute("aria-label") && iconOnly(el)) {
      return { el, text: el.getAttribute("aria-label")! };
    }
    el = el.parentElement;
  }
  return null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cur: HTMLElement | null = null;
    let timer = 0;
    let lastHide = 0;
    let visible = false;
    let addedLabel = false;
    let watch: MutationObserver | null = null;
    /** While showing, check the element still exists (the tooltip disappears when a dialog is closed by code or the button is replaced) */
    let alive = 0;

    /** Remove the title (stash it in data-tip-title) and restore it on leave */
    const stash = (el: HTMLElement) => {
      const t = el.getAttribute("title");
      if (!t) return;
      el.dataset.tipTitle = t;
      el.removeAttribute("title");
      if (!el.hasAttribute("aria-label") && iconOnly(el)) {
        el.setAttribute("aria-label", t);
        addedLabel = true;
      }
    };
    const restore = (el: HTMLElement) => {
      const t = el.dataset.tipTitle;
      if (t !== undefined) {
        if (!el.hasAttribute("title")) el.setAttribute("title", t);
        delete el.dataset.tipTitle;
      }
      if (addedLabel) el.removeAttribute("aria-label");
      addedLabel = false;
    };
    const hide = () => {
      window.clearTimeout(timer);
      window.clearInterval(alive);
      watch?.disconnect();
      watch = null;
      if (cur) restore(cur);
      cur = null;
      if (visible) lastHide = Date.now();
      visible = false;
      setTip(null);
    };
    const show = (el: HTMLElement, text: string) => {
      if (document.body.classList.contains("resizing")) return;
      visible = true;
      setTip({ text, rect: el.getBoundingClientRect() });
      alive = window.setInterval(() => {
        if (!el.isConnected) hide();
      }, 250);
      // The UI wrote the title back while showing (e.g. the button state changed): switch to the new text, then remove it again
      watch = new MutationObserver(() => {
        const t = el.getAttribute("title");
        if (t) {
          el.dataset.tipTitle = t;
          el.removeAttribute("title");
          setTip({ text: t, rect: el.getBoundingClientRect() });
        }
      });
      watch.observe(el, { attributes: true, attributeFilter: ["title"] });
    };
    const enter = (target: EventTarget | null, immediate: boolean) => {
      const found = tipOf(target);
      if (found?.el === cur) return;
      hide();
      if (!found) return;
      cur = found.el;
      stash(found.el);
      const el = found.el;
      const text = found.text;
      const now = immediate || Date.now() - lastHide < WARM;
      if (now) show(el, text);
      else timer = window.setTimeout(() => cur === el && show(el, text), DELAY);
    };

    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      enter(e.target, false);
    };
    const out = (e: PointerEvent) => {
      if (cur && !(e.relatedTarget instanceof Node && cur.contains(e.relatedTarget))) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el.matches?.(":focus-visible")) enter(el, false);
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Placed below the element, horizontally centered by default; above when there's no room below, never outside the window horizontally
  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return setPos(null);
    const b = el.getBoundingClientRect();
    const r = tip.rect;
    let top = r.bottom + 6;
    if (top + b.height > window.innerHeight - 4) top = r.top - b.height - 6;
    const left = Math.max(4, Math.min(window.innerWidth - b.width - 4, r.left + r.width / 2 - b.width / 2));
    setPos({ left, top: Math.max(4, top) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="tooltip" role="tooltip" aria-hidden="true" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      {tip.text}
    </div>
  );
}
