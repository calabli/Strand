// Ways to preview a file in its tab, besides its text: built-in previewers chosen by extension (images, Markdown,
// CSV, JSON, PDF, audio, video), the repository's textconv command for binary files, and preview plugins installed
// in the app's plugins folder. The last choice per extension is remembered.

import { useEffect, useState } from "react";
import { api } from "./api/commands";
import type { FileText, PreviewPlugin } from "./api/types";
import { setSettings, settings } from "./settings";
import { t } from "./i18n";

export type Builtin = "image" | "markdown" | "csv" | "json" | "pdf" | "audio" | "video" | "textconv";

export interface Choice {
  /** A built-in kind, or "plugin:<id>" */
  id: string;
  label: string;
  builtin?: Builtin;
  plugin?: PreviewPlugin;
  /** Made for this kind of file (not a catch-all plugin): may be picked by default */
  specific: boolean;
}

const EXT: Record<Exclude<Builtin, "textconv">, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"],
  markdown: ["md", "markdown"],
  csv: ["csv", "tsv"],
  json: ["json", "geojson", "webmanifest"],
  pdf: ["pdf"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"],
  video: ["mp4", "webm", "mov", "m4v", "ogv"],
};

const LABEL: Record<Builtin, () => string> = {
  image: () => t("图片"),
  markdown: () => t("Markdown 预览"),
  csv: () => t("表格"),
  json: () => t("JSON 树"),
  pdf: () => "PDF",
  audio: () => t("音频"),
  video: () => t("视频"),
  textconv: () => t("转成文本（textconv）"),
};

export const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** The ways this file can be previewed, best first */
export function choicesFor(path: string, f: FileText | null, plugins: PreviewPlugin[]): Choice[] {
  const ext = extOf(path);
  const out: Choice[] = [];
  for (const [kind, exts] of Object.entries(EXT) as [Builtin, string[]][]) {
    if (exts.includes(ext)) out.push({ id: kind, label: LABEL[kind](), builtin: kind, specific: true });
  }
  if (f?.binary && f.textconv) out.push({ id: "textconv", label: LABEL.textconv(), builtin: "textconv", specific: true });
  for (const p of plugins) {
    if (p.error) continue;
    const specific = !!ext && p.extensions.includes(ext);
    if (specific || p.extensions.includes("*")) out.push({ id: "plugin:" + p.id, label: p.name, plugin: p, specific });
  }
  // Plugins made for this extension come before catch-alls; built-ins first
  return out.sort((a, b) => Number(b.specific) - Number(a.specific));
}

/** What to show first: the last choice for this extension, else the first previewer made for it, else the text */
export function defaultChoice(path: string, choices: Choice[]): string {
  const remembered = settings().previewChoice[extOf(path)];
  if (remembered === "text" || choices.some((c) => c.id === remembered)) return remembered;
  return choices.find((c) => c.specific)?.id ?? "text";
}

export function rememberChoice(path: string, id: string) {
  const ext = extOf(path);
  if (!ext) return;
  setSettings({ previewChoice: { ...settings().previewChoice, [ext]: id } });
}

// ---------- Installed plugins ----------

let plugins: PreviewPlugin[] = [];
const subs = new Set<(p: PreviewPlugin[]) => void>();

/** Read the plugins folder again (cheap: one directory listing) */
export async function reloadPlugins(): Promise<PreviewPlugin[]> {
  try {
    plugins = await api.previewPlugins();
  } catch {
    plugins = [];
  }
  subs.forEach((f) => f(plugins));
  return plugins;
}

/** Installed plugins; read again whenever `key` changes (a file view reads them for each file it opens) */
export function usePlugins(key?: unknown): PreviewPlugin[] {
  const [p, set] = useState(plugins);
  useEffect(() => {
    subs.add(set);
    return () => {
      subs.delete(set);
    };
  }, []);
  useEffect(() => {
    void reloadPlugins();
  }, [key]);
  return p;
}

let opener: (() => void) | null = null;
/** The app registers how to open the plugins window */
export const setPluginsOpener = (f: (() => void) | null) => {
  opener = f;
};
export const openPluginsWindow = () => opener?.();

/** Whether the app is drawn dark right now (sent to plugins) */
export function isDark(): boolean {
  const th = settings().theme;
  if (th === "dark") return true;
  if (th === "light") return false;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Where a plugin's page is served (the strand-plugin protocol; Windows serves custom protocols over http) */
export function pluginUrl(p: PreviewPlugin): string {
  const base = /Windows/i.test(navigator.userAgent) ? "http://strand-plugin.localhost/" : "strand-plugin://localhost/";
  return base + encodeURIComponent(p.id) + "/" + p.entry.split("/").map(encodeURIComponent).join("/");
}
