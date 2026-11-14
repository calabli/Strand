// Return focus to where a dialog was opened from after it closes (spec §12.4).
//
// On open, remember the focused element; when it can't be used (no longer on the page, e.g. an item in a context menu that closed right away;
// or inside a dialog), look back for the most recent focused element that is still on the page and not in a dialog (e.g. the row that was right-clicked).
// On close, give focus back to it; if it's gone by then, look again.

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

/** Elements focus can return to: still on the page and not inside a dialog (elements inside a dialog vanish with it) */
const usable = (el: HTMLElement | null | undefined): el is HTMLElement =>
  !!el && el !== document.body && el.isConnected && !el.closest("[role=dialog]");

function returnTarget(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  if (usable(a)) return a;
  for (let i = history.length - 1; i >= 0; i--) if (usable(history[i])) return history[i];
  return null;
}

/** While open (open true), remember the element that triggered it, and return focus to it on close or unmount */
export function useReturnFocus(open = true) {
  // Kept in a ref: in development React mounts, unmounts and mounts the component again, and by the second mount focus is already in the dialog,
  // so recording then would be wrong; the ref is the same across both, so the first record survives
  const back = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    if (!back.current) back.current = returnTarget();
    // Focus must move into the dialog on open (spec §12.4): when the dialog didn't do it (e.g. the default button is disabled so autoFocus does nothing),
    // move it to the first usable control in the topmost dialog
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
      // Return focus after the re-render caused by closing (the element may just have been replaced). Not requestAnimationFrame: it doesn't fire while the window is in the background
      window.setTimeout(() => {
        // The dialog is still there (development's simulated unmount), or another dialog is open (e.g. a confirm opened from a panel): don't steal focus
        if (document.querySelector("[role=dialog]")) return;
        const b = back.current;
        back.current = null;
        // The action right after closing may make it temporarily unfocusable (e.g. the message box is disabled while committing): retry a bit later if it didn't take
        let tries = 0;
        const give = () => {
          if (document.querySelector("[role=dialog]")) return;
          // The user already moved focus elsewhere by retry time: don't steal it
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
