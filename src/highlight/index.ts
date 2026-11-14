// Syntax highlighting (diffs, full file text): language detected by extension, colored on a background thread (doesn't block the UI), producing per-line colored runs.
// Files that are too large (over 1 MB or 20k lines) aren't colored so opening stays fast (spec §17 "syntax highlighting: evaluate the impact on diff opening speed").

import type { Tok } from "./hl.worker";
export type { Tok };

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  rs: "rust", go: "go", py: "python", rb: "ruby", php: "php", swift: "swift", dart: "dart", lua: "lua",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp",
  css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
};
const NAMES: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", ".bashrc": "bash", ".zshrc": "bash" };

/** The file's language; null when unknown */
export function langOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES[base]) return NAMES[base];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? null;
}

const MAX_CHARS = 1 << 20;
const MAX_LINES = 20000;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (out: (Tok[][] | null)[]) => void>();

/** Color some texts; returns per-line colored runs for each (null for unknown languages or texts too large) */
export function highlight(lang: string | null, texts: string[]): Promise<(Tok[][] | null)[]> {
  const big = texts.reduce((n, t) => n + t.length, 0) > MAX_CHARS || texts.some((t) => t.split("\n", MAX_LINES + 1).length > MAX_LINES);
  if (!lang || big || typeof Worker === "undefined") return Promise.resolve(texts.map(() => null));
  if (!worker) {
    worker = new Worker(new URL("./hl.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; out: (Tok[][] | null)[] }>) => {
      waiting.get(e.data.id)?.(e.data.out);
      waiting.delete(e.data.id);
    };
  }
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, lang, texts });
  });
}
