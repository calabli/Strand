// 语法高亮（差异、文件全文）：按扩展名认语言，在后台线程里着色（不卡界面），结果是每一行的着色段。
// 太大的文件（超过 1 MB 或 2 万行）不着色，免得拖慢打开速度（说明书 17 “语法高亮：需要评估对差异打开速度的影响”）。

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

/** 文件的语言；认不出时返回 null */
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

/** 给几段文字着色；每段返回每一行的着色段（不认识的语言、太大的文字返回 null） */
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
