// 语法高亮的后台线程：用 highlight.js 给整段文字着色，拆成每一行的 [开始, 结束, 种类] 列表交回界面。
// 整段一起着色（不是一行一行），跨行的注释、字符串才认得对。只注册常用的语言，打包体积不会太大。

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

const LANGS = { bash, c, cpp, csharp, css, dart, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile, markdown, php, python, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** 一段着色：[开始, 结束, 种类]（种类是 hljs 的类名去掉前缀，如 keyword、string） */
export type Tok = [number, number, string];

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** 把 highlight.js 输出的 HTML 拆成每一行的着色段 */
function toLines(html: string): Tok[][] {
  const lines: Tok[][] = [[]];
  const stack: string[] = [];
  let col = 0;
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      // “hljs-title function_” 取第一个类名
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
        if (part && kind) {
          const cur = lines[lines.length - 1];
          const last = cur[cur.length - 1];
          if (last && last[1] === col && last[2] === kind) last[1] += part.length;
          else cur.push([col, col + part.length, kind]);
        }
        col += part.length;
      });
    }
  }
  return lines;
}

self.onmessage = (e: MessageEvent<{ id: number; lang: string; texts: string[] }>) => {
  const { id, lang, texts } = e.data;
  let out: (Tok[][] | null)[];
  try {
    out = texts.map((t) => (hljs.getLanguage(lang) ? toLines(hljs.highlight(t, { language: lang, ignoreIllegals: true }).value) : null));
  } catch {
    out = texts.map(() => null);
  }
  (self as unknown as Worker).postMessage({ id, out });
};
