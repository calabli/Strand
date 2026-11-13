// 对话框关闭后焦点回到打开它的地方（说明书 12.4）。
//
// 打开时记下当时有焦点的元素；它不能用时（已经不在页面上，比如是右键菜单里的一项，菜单随即关掉了；
// 或者在对话框里），往前找最近一个有过焦点、还在页面上、不在对话框里的元素（比如被右键的那一行）。
// 关闭时把焦点还给它；它那时已经没了，就再找一次。

import { useLayoutEffect, useRef } from "react";

const history: HTMLElement[] = [];
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === document.body) return;
      history.push(el);
      if (history.length > 20) history.shift();
    },
    true,
  );
}

/** 能把焦点还回去的元素：还在页面上，不在某个对话框里（对话框里的元素随对话框关掉就没了） */
const usable = (el: HTMLElement | null | undefined): el is HTMLElement =>
  !!el && el !== document.body && el.isConnected && !el.closest("[role=dialog]");

function returnTarget(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  if (usable(a)) return a;
  for (let i = history.length - 1; i >= 0; i--) if (usable(history[i])) return history[i];
  return null;
}

/** 打开期间（open 为真）记下触发它的元素，关闭或卸载时把焦点还回去 */
export function useReturnFocus(open = true) {
  // 记在 ref 里：开发模式下 React 会把组件挂上、卸下、再挂上一次，第二次挂上时焦点已经进了对话框，
  // 这时再记就记错了；ref 在这两次之间是同一个，第一次记下的保留着
  const back = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    if (!back.current) back.current = returnTarget();
    // 打开时焦点要进到对话框里（说明书 12.4）：对话框自己没把焦点放进去（比如默认按钮是禁用的，autoFocus 不起作用），
    // 就放到最上面那个对话框里第一个能用的控件上
    const into = window.setTimeout(() => {
      const dialogs = document.querySelectorAll<HTMLElement>("[role=dialog]");
      const top = dialogs[dialogs.length - 1];
      if (!top || top.contains(document.activeElement)) return;
      const first = top.querySelector<HTMLElement>(
        "input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (first) first.focus({ preventScroll: true });
      else {
        top.tabIndex = -1;
        top.focus({ preventScroll: true });
      }
    }, 0);
    return () => {
      window.clearTimeout(into);
      // 等关闭引起的重新渲染做完再还（元素可能刚被替换）。不用 requestAnimationFrame：窗口在后台时它不触发
      window.setTimeout(() => {
        // 对话框还在（开发模式的模拟卸载），或另有对话框开着（比如从面板里打开了一个确认框）：不抢焦点
        if (document.querySelector("[role=dialog]")) return;
        const b = back.current;
        back.current = null;
        // 关闭后紧接着的操作可能让它暂时不能获得焦点（比如提交期间说明框是禁用的）：没还上就过一会儿再试
        let tries = 0;
        const give = () => {
          if (document.querySelector("[role=dialog]")) return;
          // 重试时用户已经把焦点放到别处了：不抢
          if (tries > 0 && document.activeElement && document.activeElement !== document.body) return;
          const to = usable(b) ? b : returnTarget();
          to?.focus({ preventScroll: true });
          if (to && document.activeElement !== to && ++tries < 8) window.setTimeout(give, 150);
        };
        give();
      }, 0);
    };
  }, [open]);
}
