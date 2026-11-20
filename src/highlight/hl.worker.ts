// The syntax highlighting worker: colors whole texts with highlight.js and returns per-line [start, end, kind] lists to the UI.
// Coloring the whole text at once (not line by line) gets multi-line comments and strings right. Only common languages are registered to keep the bundle small (each is a few KB).

import hljs from "highlight.js/lib/core";
import apache from "highlight.js/lib/languages/apache";
import arduino from "highlight.js/lib/languages/arduino";
import asciidoc from "highlight.js/lib/languages/asciidoc";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import clojure from "highlight.js/lib/languages/clojure";
import cmake from "highlight.js/lib/languages/cmake";
import coffeescript from "highlight.js/lib/languages/coffeescript";
import cpp from "highlight.js/lib/languages/cpp";
import crystal from "highlight.js/lib/languages/crystal";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import delphi from "highlight.js/lib/languages/delphi";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import elixir from "highlight.js/lib/languages/elixir";
import elm from "highlight.js/lib/languages/elm";
import erb from "highlight.js/lib/languages/erb";
import erlang from "highlight.js/lib/languages/erlang";
import fortran from "highlight.js/lib/languages/fortran";
import fsharp from "highlight.js/lib/languages/fsharp";
import glsl from "highlight.js/lib/languages/glsl";
import go from "highlight.js/lib/languages/go";
import gradle from "highlight.js/lib/languages/gradle";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import handlebars from "highlight.js/lib/languages/handlebars";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import julia from "highlight.js/lib/languages/julia";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import less from "highlight.js/lib/languages/less";
import lisp from "highlight.js/lib/languages/lisp";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import nim from "highlight.js/lib/languages/nim";
import nix from "highlight.js/lib/languages/nix";
import objectivec from "highlight.js/lib/languages/objectivec";
import ocaml from "highlight.js/lib/languages/ocaml";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scheme from "highlight.js/lib/languages/scheme";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import stylus from "highlight.js/lib/languages/stylus";
import swift from "highlight.js/lib/languages/swift";
import tcl from "highlight.js/lib/languages/tcl";
import thrift from "highlight.js/lib/languages/thrift";
import typescript from "highlight.js/lib/languages/typescript";
import vbnet from "highlight.js/lib/languages/vbnet";
import verilog from "highlight.js/lib/languages/verilog";
import vhdl from "highlight.js/lib/languages/vhdl";
import vim from "highlight.js/lib/languages/vim";
import wasm from "highlight.js/lib/languages/wasm";
import x86asm from "highlight.js/lib/languages/x86asm";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { CLOSE, LEVELS, OPEN, strictBrackets } from "./brackets";

const LANGS = {
  apache, arduino, asciidoc, bash, c, clojure, cmake, coffeescript, cpp, crystal, csharp, css, dart, delphi, diff, dockerfile, dos, elixir, elm, erb, erlang, fortran, fsharp, glsl, go, gradle, graphql, groovy, handlebars, haskell, ini, java, javascript, json, julia, kotlin, latex, less, lisp, lua, makefile, markdown, nginx, nim, nix, objectivec, ocaml, perl, php, plaintext, powershell, properties, protobuf, python, r, ruby, rust, scala, scheme, scss, sql, stylus, swift, tcl, thrift, typescript, vbnet, verilog, vhdl, vim, wasm, x86asm, xml, yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** One colored run: [start, end, kind] (kind is the hljs class name without the prefix, e.g. keyword, string) */
export type Tok = [number, number, string];

/** Runs whose brackets are text, not code */
const QUIET = new Set(["string", "comment", "regexp", "quote", "char", "doctag", "meta-string"]);

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/**
 * Split highlight.js's HTML output into per-line colored runs. (), [] and {} outside strings and comments get their
 * own runs "br0".."br3" by nesting depth; with `strict` (a whole file, in a language where every bracket has a
 * partner) a bracket without its partner is "br-bad".
 */
function toLines(html: string, strict: boolean): Tok[][] {
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
    if (kind && QUIET.has(kind)) {
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
        // A closer with no partner (in a piece of a file its opener may simply be outside the piece; in prose and
        // markup it's normal)
        push(col + i, col + i + 1, strict ? "br-bad" : "br0");
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
  if (strict) for (const o of open) o.tok[2] = "br-bad";
  return lines;
}

self.onmessage = (e: MessageEvent<{ id: number; lang: string; texts: string[]; complete?: boolean }>) => {
  const { id, lang, texts, complete = false } = e.data;
  const strict = complete && strictBrackets(lang);
  let out: (Tok[][] | null)[];
  try {
    out = texts.map((t) => (hljs.getLanguage(lang) ? toLines(hljs.highlight(t, { language: lang, ignoreIllegals: true }).value, strict) : null));
  } catch {
    out = texts.map(() => null);
  }
  (self as unknown as Worker).postMessage({ id, out });
};
