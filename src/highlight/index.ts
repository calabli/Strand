// Syntax highlighting (diffs, full file text): language detected by extension, colored on a background thread (doesn't block the UI), producing per-line colored runs.
// Files that are too large (over 1 MB or 20k lines) aren't colored so opening stays fast (spec §17 "syntax highlighting: evaluate the impact on diff opening speed").

import type { Tok } from "./hl.worker";
export type { Tok };

const EXT: Record<string, string> = {
  // Web
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", coffee: "coffeescript",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", geojson: "json", webmanifest: "json",
  css: "css", scss: "scss", sass: "scss", less: "less", styl: "stylus",
  html: "xml", htm: "xml", xhtml: "xml", vue: "xml", svelte: "xml", astro: "xml",
  hbs: "handlebars", handlebars: "handlebars", mustache: "handlebars", erb: "erb",
  graphql: "graphql", gql: "graphql",
  // Systems and applications
  rs: "rust", go: "go", swift: "swift", dart: "dart", v: "verilog", sv: "verilog", svh: "verilog", vhd: "vhdl", vhdl: "vhdl",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", "c++": "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ipp: "cpp", inl: "cpp",
  m: "objectivec", mm: "objectivec", ino: "arduino", cu: "cpp", cuh: "cpp", glsl: "glsl", vert: "glsl", frag: "glsl", hlsl: "cpp",
  cs: "csharp", csx: "csharp", fs: "fsharp", fsi: "fsharp", fsx: "fsharp", vb: "vbnet",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", sc: "scala", sbt: "scala", groovy: "groovy", gradle: "gradle",
  asm: "x86asm", s: "x86asm", wat: "wasm", wast: "wasm", pas: "delphi", f: "fortran", f90: "fortran", f95: "fortran",
  // Scripting
  py: "python", pyi: "python", pyw: "python", rb: "ruby", rake: "ruby", gemspec: "ruby", php: "php", phtml: "php",
  lua: "lua", pl: "perl", pm: "perl", r: "r", jl: "julia", tcl: "tcl", vim: "vim", nim: "nim", cr: "crystal",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", elm: "elm", ml: "ocaml", mli: "ocaml",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", scm: "scheme", rkt: "scheme", lisp: "lisp", el: "lisp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ksh: "bash", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  bat: "dos", cmd: "dos", nix: "nix",
  // Data and config
  sql: "sql", psql: "sql", proto: "protobuf", thrift: "thrift",
  xml: "xml", svg: "xml", xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", xaml: "xml", csproj: "xml", fsproj: "xml",
  vbproj: "xml", props: "xml", targets: "xml", resx: "xml", storyboard: "xml", rss: "xml", atom: "xml", wsdl: "xml", kml: "xml",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", editorconfig: "ini", properties: "properties",
  env: "properties", cmake: "cmake", mk: "makefile", dockerfile: "dockerfile",
  // Documents
  md: "markdown", markdown: "markdown", mdx: "markdown", adoc: "asciidoc", tex: "latex", sty: "latex", cls: "latex",
  diff: "diff", patch: "diff", txt: "plaintext", text: "plaintext", log: "plaintext",
};
const NAMES: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  "cmakelists.txt": "cmake", jenkinsfile: "groovy", "nginx.conf": "nginx", ".htaccess": "apache",
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby", vagrantfile: "ruby", brewfile: "ruby", fastfile: "ruby",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".bash_profile": "bash", ".zprofile": "bash",
  ".env": "properties", ".gitconfig": "ini", ".npmrc": "ini", ".babelrc": "json", ".prettierrc": "json", ".eslintrc": "json",
};

/** The file's language; null when unknown */
export function langOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES[base]) return NAMES[base];
  // Dockerfile.dev, .env.local
  if (base.startsWith("dockerfile.")) return "dockerfile";
  if (base.startsWith(".env.")) return "properties";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? null;
}

/** The language to color a file's text with: unknown files are plain text, which still gets rainbow brackets */
export function textLangOf(path: string): string {
  return langOf(path) ?? "plaintext";
}

const MAX_CHARS = 1 << 20;
const MAX_LINES = 20000;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (out: (Tok[][] | null)[]) => void>();

/**
 * Color some texts; returns per-line colored runs for each (null for unknown languages or texts too large).
 * `complete`: the texts are whole files, so a bracket without its partner is marked as an error (in pieces of a file,
 * like a diff that shows only the changes, the partner may be outside the piece).
 */
export function highlight(lang: string | null, texts: string[], complete = false): Promise<(Tok[][] | null)[]> {
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
    worker!.postMessage({ id, lang, texts, complete });
  });
}
