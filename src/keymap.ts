// Customizable keyboard shortcuts (Settings → Keyboard shortcuts). Each action has a default combo; the user's
// overrides are kept in local storage. Combos are written like "Mod+Shift+T": Mod is ⌘ on macOS and Ctrl elsewhere.
// Keys handled by lists and editors themselves (arrows, Enter, Esc, ⌥ arrows in diffs) stay fixed.

import { useEffect, useState } from "react";
import { t } from "./i18n";

export type ActionId =
  | "palette"
  | "settings"
  | "undo"
  | "redo"
  | "searchLog"
  | "openDiff"
  | "find"
  | "goLine"
  | "closeTab"
  | "reopenTab"
  | "recentFiles"
  | "commit"
  | "commitPush"
  | "save"
  | "goDefinition"
  | "allDefinitions"
  | "findUsages"
  | "navBack"
  | "navForward"
  | "goFile"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

/** Actions in display order, with their default combo. Labels are translated when read. */
export const ACTIONS: { id: ActionId; label: string; def: string }[] = [
  { id: "palette", label: "打开或关闭命令面板", def: "Mod+K" },
  { id: "settings", label: "设置", def: "Mod+," },
  { id: "undo", label: "撤销", def: "Mod+Z" },
  { id: "redo", label: "重做", def: "Mod+Shift+Z" },
  { id: "searchLog", label: "搜索日志", def: "Mod+F" },
  { id: "openDiff", label: "在差异标签页里打开选中提交的文件", def: "Mod+D" },
  { id: "find", label: "在差异或文件里查找", def: "Mod+F" },
  { id: "goLine", label: "在差异或文件里跳到行", def: "Mod+L" },
  { id: "closeTab", label: "关闭当前文件或差异标签页", def: "Mod+W" },
  { id: "reopenTab", label: "重新打开刚关掉的文件", def: "Mod+Shift+T" },
  { id: "recentFiles", label: "最近的文件", def: "Mod+E" },
  { id: "commit", label: "提交（在提交说明里）", def: "Mod+Enter" },
  { id: "commitPush", label: "提交并推送（在提交说明里）", def: "Mod+Alt+Enter" },
  { id: "save", label: "保存正在编辑的文件", def: "Mod+S" },
  { id: "goDefinition", label: "跳到定义（也可以按住 ⌘ 或 Ctrl 单击）", def: "Mod+B" },
  { id: "allDefinitions", label: "列出所有同名的定义", def: "Mod+Alt+B" },
  { id: "findUsages", label: "查找用法", def: "Alt+F7" },
  { id: "navBack", label: "后退到跳转之前的位置", def: "Mod+[" },
  { id: "navForward", label: "前进", def: "Mod+]" },
  { id: "goFile", label: "按名字打开文件", def: "Mod+Shift+O" },
  { id: "zoomIn", label: "放大", def: "Mod+=" },
  { id: "zoomOut", label: "缩小", def: "Mod+-" },
  { id: "zoomReset", label: "实际大小（100%）", def: "Mod+0" },
];

/** Pairs that may share a combo because they never apply at the same time (the log vs. a diff or file view) */
const SAME_OK: [ActionId, ActionId][] = [["searchLog", "find"]];

const KEY = "strand.keys";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function load(): Partial<Record<ActionId, string>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let overrides = load();
const listeners = new Set<() => void>();

/** The combo bound to an action now */
export function comboOf(id: ActionId): string {
  return overrides[id] ?? ACTIONS.find((a) => a.id === id)!.def;
}

/** Bind an action to a combo; null puts back the default */
export function setCombo(id: ActionId, combo: string | null) {
  const next = { ...overrides };
  if (combo === null || combo === ACTIONS.find((a) => a.id === id)!.def) delete next[id];
  else next[id] = combo;
  overrides = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Only for this session */
  }
  listeners.forEach((f) => f());
}

export function resetAll() {
  overrides = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing */
  }
  listeners.forEach((f) => f());
}

/** Re-render when shortcuts change */
export function useKeymap(): Partial<Record<ActionId, string>> {
  const [v, set] = useState(overrides);
  useEffect(() => {
    const f = () => set(overrides);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return v;
}

/** The key part of an event, normalized: letters lower case, "Enter", ",", "F2"… (uses the physical key for letters and digits, so ⌥ and keyboard layouts don't change it) */
function keyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** The combo a key press makes, or null for a bare modifier press */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const k = keyName(e);
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}

/** Whether a key press is the combo of this action */
export function matches(e: KeyboardEvent, id: ActionId): boolean {
  const c = comboFromEvent(e);
  return !!c && c.toLowerCase() === comboOf(id).toLowerCase();
}

/** A combo as shown to people: ⌘⇧T on macOS, Ctrl+Shift+T elsewhere */
export function showCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const k = key === "Enter" ? "↵" : key.length === 1 ? key.toUpperCase() : key;
  if (isMac) {
    const m = (p: string) => ({ Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" })[p] ?? p;
    // macOS order: ⌃ ⌥ ⇧ ⌘
    const order = ["Ctrl", "Alt", "Shift", "Mod"];
    return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(m).join("") + k;
  }
  const m = (p: string) => ({ Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Ctrl: "Ctrl" })[p] ?? p;
  return [...parts.map(m), key === "Enter" ? "Enter" : k].join("+");
}

/** The shortcut hint for an action */
export const hintOf = (id: ActionId) => showCombo(comboOf(id));

/** Another action already using this combo (ignoring pairs that never apply together), or null */
export function conflictOf(id: ActionId, combo: string): ActionId | null {
  const c = combo.toLowerCase();
  const other = ACTIONS.find(
    (a) => a.id !== id && comboOf(a.id).toLowerCase() === c && !SAME_OK.some(([x, y]) => (x === id && y === a.id) || (y === id && x === a.id)),
  );
  return other?.id ?? null;
}

/** A combo is usable when it has ⌘/Ctrl or ⌥ (plain letters would fire while typing), or is a function key */
export function usable(combo: string): boolean {
  return /(^|\+)(Mod|Ctrl|Alt)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);
}

export const labelOf = (id: ActionId) => t(ACTIONS.find((a) => a.id === id)!.label);
