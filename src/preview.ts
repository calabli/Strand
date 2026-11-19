// Ways to preview a file in its tab, besides its text: built-in previewers chosen by extension (images, Markdown,
// CSV, JSON, PDF, audio, video), the repository's textconv command for binary files, and preview plugins installed
// in the app's plugins folder. The last choice per extension is remembered.

import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { api } from "./api/commands";
import type { FileText, PreviewPlugin } from "./api/types";
import { setSettings, settings } from "./settings";
export interface PreviewInput {
  path: string;
  rev: string | null;
  file: FileText | null;
  reloadKey?: number;
  anchor?: { id: string; n: number };
}

export interface PreviewProvider {
  id: string;
  label: () => string;
  matches: (file: Pick<PreviewInput, "path" | "file">) => boolean;
  View: ComponentType<PreviewInput>;
  /** Optional tools for editing a worktree text file with this built-in provider. */
  editor?: {
    View: ComponentType<{ path: string; text: string }>;
    actions: readonly EditorFormatAction[];
    wrap?: boolean;
    markdown?: boolean;
  };
}

export interface EditorFormatAction {
  id: string;
  label: () => string;
  icon: string;
  wholeLines?: boolean;
  shortcut?: string;
  delimiters?: readonly [string, string];
  insertMenu?: boolean;
  apply: (selection: string, cursorOnly: boolean) => { text: string; from?: number; to?: number };
}

export type Choice = { id: string; label: string; specific: boolean } & (
  | { provider: PreviewProvider; plugin?: never }
  | { plugin: PreviewPlugin; provider?: never }
);

export const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export const matchesExtensions = (extensions: readonly string[]) => ({ path }: Pick<PreviewInput, "path">) => {
  const ext = extOf(path);
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return !!ext && extensions.some((e) => ext === e || (e.includes(".") && name.endsWith(`.${e}`)));
};

/** Match built-in providers and installed manifest-declared previews in preference order. */
export function choicesFor(path: string, file: FileText, providers: readonly PreviewProvider[], plugins: PreviewPlugin[]): Choice[] {
  const out: Choice[] = providers.filter((p) => p.matches({ path, file })).map((p) => ({ id: p.id, label: p.label(), provider: p, specific: true }));
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  for (const p of plugins) {
    if (p.error) continue;
    const specific = !!p.filenames?.includes(name) || matchesExtensions(p.extensions)({ path });
    if (specific || p.extensions.includes("*")) out.push({ id: "plugin:" + p.id, label: p.name, plugin: p, specific });
  }
  // Plugins made for this extension come before catch-alls; built-ins first
  return out.sort((a, b) => Number(b.specific) - Number(a.specific));
}

/** What to show first: the last choice for this extension, else the first previewer made for it, else the text */
export function defaultChoice(path: string, choices: Choice[]): string {
  const remembered = settings().previewChoice[preferenceKey(path)];
  if (remembered === "text" || choices.some((c) => c.id === remembered)) return remembered;
  return choices.find((c) => c.specific)?.id ?? "text";
}

export function rememberChoice(path: string, id: string) {
  setSettings({ previewChoice: { ...settings().previewChoice, [preferenceKey(path)]: id } });
}

const preferenceKey = (path: string) => extOf(path) || `name:${path.slice(path.lastIndexOf("/") + 1).toLowerCase()}`;

// ---------- Installed plugins ----------

let plugins: PreviewPlugin[] = [];
let request = 0;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const getPlugins = () => plugins;

/** Read the plugins folder again (cheap: one directory listing) */
export async function reloadPlugins(): Promise<PreviewPlugin[]> {
  const id = ++request;
  const next = await api.previewPlugins();
  if (id === request) {
    plugins = next;
    subs.forEach((f) => f());
  }
  return next;
}

/** Installed plugins; read again whenever `key` changes (a file view reads them for each file it opens) */
export function usePlugins(key?: unknown): PreviewPlugin[] {
  useEffect(() => {
    void reloadPlugins().catch(() => {});
  }, [key]);
  return useSyncExternalStore(subscribe, getPlugins);
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
