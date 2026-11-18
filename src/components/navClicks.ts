// ⌘-click (Ctrl-click on Windows and Linux), ⌘B and ⌥F7 in a read-only code view (the file view's full text, diffs):
// find the line ([data-n]) and its code (.code) under the pointer, work out the column, and navigate from there.
// The keys use the text selection when there is one in the view, otherwise the word under the mouse.

import { useEffect, type RefObject } from "react";
import { matches } from "../keymap";
import { navigateAt } from "../nav";
import { isMac } from "./format";

interface Point {
  line: string;
  col: number;
  n: number;
}

/** The code line and column at a DOM position inside a .code element */
function pointAt(node: Node, offset: number): Point | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const code = el?.closest(".code");
  const row = code?.closest("[data-n]");
  if (!code || !row) return null;
  const pre = document.createRange();
  pre.setStart(code, 0);
  try {
    pre.setEnd(node, offset);
  } catch {
    return null;
  }
  return { line: code.textContent ?? "", col: pre.toString().length, n: Number(row.getAttribute("data-n")) };
}

function pointFromXY(x: number, y: number): Point | null {
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? pointAt(r.startContainer, r.startOffset) : null;
}

const modOf = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

// Like an IDE: while ⌘ (Ctrl) is held, the name or path under the pointer is underlined as a link.
// Uses the CSS Custom Highlight API (no DOM changes); where it's missing, there's just no underline.
type HighlightApi = { highlights?: Map<string, unknown> };
const highlights = (CSS as unknown as HighlightApi).highlights;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function linkRange(x: number, y: number): Range | null {
  const r = document.caretRangeFromPoint?.(x, y);
  const node = r?.startContainer;
  if (!r || !node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest(".code")) return null;
  const text = (node as Text).data;
  const isW = (c: string | undefined) => !!c && /[\w$]/.test(c);
  let a = r.startOffset;
  let b = r.startOffset;
  // A quoted path in one text node (a string token): the part between the quotes
  const q = text.match(/^(["'`])(.*)\1$/);
  if (q) {
    a = 1;
    b = text.length - 1;
  } else {
    while (a > 0 && isW(text[a - 1])) a--;
    while (b < text.length && isW(text[b])) b++;
  }
  if (b <= a || /^\d/.test(text.slice(a, b))) return null;
  const out = document.createRange();
  out.setStart(node, a);
  out.setEnd(node, b);
  return out;
}

function showLink(x: number, y: number, on: boolean) {
  if (!highlights || !HighlightCtor) return;
  const r = on ? linkRange(x, y) : null;
  if (r) highlights.set("nav-link", new HighlightCtor(r));
  else highlights.delete("nav-link");
}

export function useNavClicks(box: RefObject<HTMLElement | null>, path: string | null) {
  useEffect(() => {
    const el = box.current;
    if (!el || !path) return;
    let last: { x: number; y: number } | null = null;
    const click = (e: MouseEvent) => {
      if (e.button !== 0 || !modOf(e) || e.shiftKey || e.altKey) return;
      const p = pointFromXY(e.clientX, e.clientY);
      if (p && navigateAt(p.line, p.col, { path, line: p.n })) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const move = (e: MouseEvent) => {
      last = { x: e.clientX, y: e.clientY };
      el.classList.toggle("nav-mod", modOf(e));
      showLink(e.clientX, e.clientY, modOf(e));
    };
    const key = (e: KeyboardEvent) => {
      const held = e.type === "keydown" && modOf(e) && e.key !== "Shift";
      el.classList.toggle("nav-mod", held);
      if (last && el.offsetParent && el.matches(":hover")) showLink(last.x, last.y, held);
      if (e.type !== "keydown") return;
      const def = matches(e, "goDefinition");
      const all = matches(e, "allDefinitions");
      const use = matches(e, "findUsages");
      if (!def && !all && !use) return;
      // Only the view on screen, without a dialog over it, and not while typing somewhere else
      if (!el.offsetParent || document.querySelector(".modal-back, .palette")) return;
      if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]")) return;
      const sel = window.getSelection();
      const p = sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode) ? pointAt(sel.anchorNode!, sel.anchorOffset) : last ? pointFromXY(last.x, last.y) : null;
      if (!p) return;
      e.preventDefault();
      navigateAt(p.line, p.col, { path, line: p.n }, use ? "usages" : all ? "all" : "def");
    };
    const leave = () => {
      el.classList.remove("nav-mod");
      showLink(0, 0, false);
    };
    el.addEventListener("click", click, true);
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", leave);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", leave);
    return () => {
      el.removeEventListener("click", click, true);
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseleave", leave);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", leave);
    };
  }, [box, path]);
}
