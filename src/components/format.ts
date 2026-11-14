import { t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** Unix 秒 → `2026/11/12 14:05` */
export function formatTime(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shortId = (id: string) => id.slice(0, 7);

/** 相对时间：“3 小时前” */
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

/** 快捷键的显示：macOS 上原样，其他系统上 ⌘ 换成 Ctrl、⌥ 换成 Alt、⇧ 换成 Shift（说明书 12.3） */
export function keys(s: string): string {
  if (isMac) return s;
  return s.replace(/⇧⌘/g, "Ctrl+Shift+").replace(/⌥⌘/g, "Ctrl+Alt+").replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+");
}

/** 搜索文字换成正则（普通文字转义；不区分大小写加 i）；写错时返回 null */
export function findRegExp(text: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!text) return null;
  try {
    return new RegExp(regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}
