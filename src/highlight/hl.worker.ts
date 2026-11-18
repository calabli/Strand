// The syntax highlighting worker: colors whole texts with highlight.js and returns per-line [start, end, kind] lists to the UI.
// Coloring the whole text at once (not line by line) gets multi-line comments and strings right. Only common languages are registered to keep the bundle small.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { CLOSE, LEVELS, NO_BRACKETS, OPEN } from "./brackets";

const LANGS = { bash, c, cpp, csharp, css, dart, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile, markdown, php, python, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** One colored run: [start, end, kind] (kind is the hljs class name without the prefix, e.g. keyword, string) */
export type Tok = [number, number, string];

/** Runs whose brackets are text, not code */
const QUIET = new Set(["string", "comment", "regexp", "quote", "char", "doctag", "meta-string"]);

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/**
 * Split highlight.js's HTML output into per-line colored runs. With `brackets`, (), [] and {} outside strings and
 * comments get their own runs "br0".."br3" by nesting depth; with `complete` (the whole file, not pieces of it) a
 * bracket without its partner is "br-bad".
 */
function toLines(html: string, brackets: boolean, complete: boolean): Tok[][] {
  const lines: Tok[][] = [[]];
  const stack: string[] = [];
  let col = 0;
  /** Open brackets: the closer they expect, and their run (relabeled when never closed) */
  const open: { want: string; tok: Tok }[] = [];
  const push = (a: number, b: number, kind: string) => {
    const cur = lines[lines.length - 1];
    const last = cur[cur.length - 1];
    if (last && last[1] === a && last[2] === kind && !kind.startsWith("br")) last[1] = b;
    else cur.push([a, b, kind]);
    return cur[cur.length - 1];
  };
  /** One piece of text of a single kind, on one line */
  const emit = (part: string, kind: string | undefined) => {
    if (!brackets || (kind && QUIET.has(kind))) {
      if (part && kind) push(col, col + part.length, kind);
      return;
    }
    let from = 0;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      const opener = OPEN[ch];
      if (!opener && !CLOSE.has(ch)) continue;
      if (i > from && kind) push(col + from, col + i, kind);
      if (opener) {
        const tok = push(col + i, col + i + 1, "br" + (open.length % LEVELS));
        open.push({ want: opener, tok });
      } else if (open.length && open[open.length - 1].want === ch) {
        open.pop();
        push(col + i, col + i + 1, "br" + (open.length % LEVELS));
      } else {
        // A closer with no partner (in a piece of a file, its opener may simply be outside the piece)
        push(col + i, col + i + 1, complete ? "br-bad" : "br0");
      }
      from = i + 1;
    }
    if (from < part.length && kind) push(col + from, col + part.length, kind);
  };
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      // "hljs-title function_" takes the first class name
      stack.push(m[1].split(" ")[0].replace(/^hljs-/, ""));
    } else if (m[0] === "</span>") {
      stack.pop();
    } else {
      const text = m[2].replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENT[e] ?? e);
      const kind = stack[stack.length - 1];
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) {
          lines.push([]);
          col = 0;
        }
        if (part) emit(part, kind);
        col += part.length;
      });
    }
  }
  if (complete) for (const o of open) o.tok[2] = "br-bad";
  return lines;
}

self.onmessage = (e: MessageEvent<{ id: number; lang: string; texts: string[]; complete?: boolean }>) => {
  const { id, lang, texts, complete = false } = e.data;
  const brackets = !NO_BRACKETS.has(lang);
  let out: (Tok[][] | null)[];
  try {
    out = texts.map((t) => (hljs.getLanguage(lang) ? toLines(hljs.highlight(t, { language: lang, ignoreIllegals: true }).value, brackets, complete) : null));
  } catch {
    out = texts.map(() => null);
  }
  (self as unknown as Worker).postMessage({ id, out });
};
