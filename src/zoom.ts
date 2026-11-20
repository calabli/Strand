// Zoom: the whole window larger or smaller, like a browser's ⌘+ / ⌘− / ⌘0. In the app it's the webview's own zoom,
// so every size scales together and the fixed row heights of the log, diffs and the merge window still line up. The
// level is a setting, so it's remembered and shared by every window.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { inTauri } from "./api/commands";
import { comboFromEvent, comboOf, matches } from "./keymap";
import { setSettings, settings } from "./settings";

/** The levels ⌘+ and ⌘− step through */
export const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

/** The nearest level to a stored value (it may come from an older or hand-edited setting) */
export function zoomLevel(z = settings().zoom): number {
  return ZOOMS.reduce((best, l) => (Math.abs(l - z) < Math.abs(best - z) ? l : best), 1);
}

/** Apply the zoom setting to this window */
export function applyZoom() {
  const z = zoomLevel();
  if (inTauri) {
    getCurrentWebview()
      .setZoom(z)
      .catch(() => {
        /* Without zoom the app still works at 100% */
      });
  } else if (typeof document !== "undefined") {
    // In a browser (pnpm dev without Tauri) CSS zoom stands in, only so the setting can be tried
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
  }
}

export function setZoom(z: number) {
  setSettings({ zoom: zoomLevel(z) });
  applyZoom();
}

/** One level larger (+1) or smaller (−1) */
export function stepZoom(dir: 1 | -1) {
  const i = ZOOMS.indexOf(zoomLevel());
  setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))]);
}

export const zoomLabel = (z = zoomLevel()) => `${Math.round(z * 100)}%`;

/**
 * Handle a zoom shortcut; true when the key press was one. With the default ⌘= the key is also taken with ⇧ (⌘+ on
 * layouts where + needs Shift) and from the number pad.
 */
export function zoomKey(e: KeyboardEvent): boolean {
  const c = comboFromEvent(e) ?? "";
  const inDefault = comboOf("zoomIn") === "Mod+=" && /^Mod\+(Shift\+)?[+=]$/.test(c);
  const outDefault = comboOf("zoomOut") === "Mod+-" && c === "Mod+-";
  if (matches(e, "zoomIn") || inDefault) stepZoom(1);
  else if (matches(e, "zoomOut") || outDefault) stepZoom(-1);
  else if (matches(e, "zoomReset")) setZoom(1);
  else return false;
  e.preventDefault();
  return true;
}

applyZoom();
