import { t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** Unix seconds → `2026/11/12 14:05` */
export function formatTime(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shortId = (id: string) => id.slice(0, 7);

/** Relative time: "3 hours ago" */
export function relTime(at: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return t("刚刚");
  if (s < 3600) return t("{0} 分钟前", Math.floor(s / 60));
  if (s < 86400) return t("{0} 小时前", Math.floor(s / 3600));
  if (s < 86400 * 60) return t("{0} 天前", Math.floor(s / 86400));
  if (s < 86400 * 730) return t("{0} 个月前", Math.floor(s / (86400 * 30)));
  return t("{0} 年前", Math.floor(s / (86400 * 365)));
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Shortcut display: as is on macOS; on other systems ⌘ becomes Ctrl, ⌥ becomes Alt, ⇧ becomes Shift (spec §12.3) */
export function keys(s: string): string {
  if (isMac) return s;
  return s.replace(/⇧⌘/g, "Ctrl+Shift+").replace(/⌥⌘/g, "Ctrl+Alt+").replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+");
}

/** Turn search text into a regex (plain text escaped; i added for case-insensitive); null when invalid */
export function findRegExp(text: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!text) return null;
  try {
    return new RegExp(regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}
