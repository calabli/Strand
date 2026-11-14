// 悬停提示（说明书 12.4）：鼠标停在按钮上 350 ms 后在旁边显示按钮名称；刚看过一个提示时，移到下一个按钮立刻显示。
// 键盘把焦点移到按钮上时也显示。
//
// 不用给每个按钮单独写：全局监听，取元素的 title（没有 title 的图标按钮取 aria-label）。显示时先把 title 拿掉、
// 离开时放回去，免得系统自己的提示再冒出来一个（桌面应用里系统提示要等一两秒，有时根本不出）。
// title 被拿掉期间，没有 aria-label 的元素临时补上 aria-label，读屏软件读到的名字不变。

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY = 350;
/** 上一个提示消失后这么久内移到下一个按钮，不再等 */
const WARM = 600;

type Tip = { text: string; rect: DOMRect };

/** 图标按钮：没有可见文字（或只有一两个符号，如 ↑ ×） */
const iconOnly = (el: Element) => (el.textContent ?? "").replace(/\s/g, "").length <= 2;

/** 往上找第一个有提示的元素，返回元素和文字 */
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
    /** 显示期间检查元素还在不在（对话框被代码关掉、按钮被换掉时，提示跟着消失） */
    let alive = 0;

    /** 把 title 拿掉（放到 data-tip-title），离开时再放回 */
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
      // 显示期间界面又把 title 写回来（比如按钮状态变了）：换成新文字，再拿掉
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

  // 默认放在元素下面、水平居中；下面放不下就放上面，左右不出窗口
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
