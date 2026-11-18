// Go to definition, find usages and open the file an import points at — by searching the project's text (git grep),
// not by analyzing code: no language server to install, works for most languages, but a name defined in several
// places gives a list to pick from. Definitions are lines where the name follows a defining keyword (fn, function,
// def, class, struct, interface, type, const…), or where a line starts with it like a method or function
// declaration; same file first, then files of the same language.

import { api } from "./api/commands";

export interface Loc {
  path: string;
  line: number;
  text: string;
  /** "definition" kinds rank above "method-like" ones */
  kind?: "def" | "method" | "use";
}

const KEYWORDS =
  "fn|func|function|def|class|struct|enum|trait|interface|type|typedef|mod|module|namespace|const|let|var|val|impl|union|macro_rules!|object|record|protocol|extension|package|sub|proc|defn|defmacro";
/** Words that precede a call or an expression, not a declaration */
const NOT_DECL = /^(return|new|await|throw|else|case|yield|typeof|delete|in|of|if|for|while|switch|catch|do|echo|print|assert)$/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name worth looking up: an identifier (letters, digits, _, $), not a number or a keyword-only word */
export function isIdent(w: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(w) && !NOT_DECL.test(w) && w !== "void";
}

/** The search pattern (valid for both git grep -P and Rust's regex) that finds candidate definition lines */
export function defPattern(name: string): string {
  const n = esc(name);
  return [
    // keyword NAME, keyword Type NAME (e.g. "const int NAME"), Go methods "func (r *T) NAME"
    `\\b(?:${KEYWORDS})\\s+(?:[\\w:<>,\\s*&]+\\s+)?${n}\\b`,
    `\\bfunc\\s*\\([^)]*\\)\\s*${n}\\b`,
    // A line starting with (modifiers / a return type and) NAME( — functions and methods in C-like languages, JS classes
    `^\\s*(?:[A-Za-z_][\\w<>,\\[\\]:*&.]*\\s+)*[*&]*(?:\\w+::)*${n}\\s*(?:<[^>]*>)?\\s*\\(`,
    // Class fields and object properties holding functions: NAME = (…) =>, NAME: function
    `^\\s*(?:(?:public|private|protected|static|readonly|async|export|override)\\s+)*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|<)`,
  ].join("|");
}

/** Whether a candidate line really declares the name, and how strongly */
export function classify(text: string, name: string): Loc["kind"] | null {
  const n = esc(name);
  const t = text.trim();
  const kw = t.match(new RegExp(`\\b(${KEYWORDS})\\s+(?:[\\w:<>,\\s*&]+\\s+)?${n}\\b`));
  if (kw) {
    // "f(let NAME…)", "x = class NAME" sit inside an expression
    const before = t.slice(0, kw.index).trim();
    if (/[=(,]$/.test(before)) return null;
    // impl / extension blocks add to a type defined elsewhere: below the real definition
    return kw[1] === "impl" || kw[1] === "extension" ? "method" : "def";
  }
  if (new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s*${n}\\b`).test(t)) return "def";
  const field = new RegExp(`^(?:(?:public|private|protected|static|readonly|async|export|override)\\s+)*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|<)`);
  if (field.test(t)) return "method";
  const m = t.match(new RegExp(`^((?:[A-Za-z_][\\w<>,\\[\\]:*&.]*\\s+)*)[*&]*(?:\\w+::)*${n}\\s*(?:<[^>]*>)?\\s*\\((.*)$`));
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  if (words.some((w) => NOT_DECL.test(w))) return null;
  const rest = m[2];
  // A call statement: ends with ";" or chains on; a declaration's line ends with "{", ")", "=>", ":" or a type
  if (/;\s*(\/\/.*)?$/.test(rest) || /^\s*\)\s*[.;]/.test(rest)) return null;
  // Without modifiers or a return type it must open a body: "name(…) {", "name(…): T {", "name(…) =>"
  if (words.length === 0 && !/[{:]\s*(\/\/.*)?$|=>\s*\{?\s*$/.test(rest)) return null;
  return "method";
}

/** The language family of a path, to prefer definitions in the same kind of file */
export function family(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const groups: Record<string, string> = {
    ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
    rs: "rs", py: "py", pyi: "py", go: "go", java: "jvm", kt: "jvm", kts: "jvm", scala: "jvm", groovy: "jvm",
    c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", m: "c", mm: "c",
    cs: "cs", swift: "swift", rb: "rb", php: "php", dart: "dart", lua: "lua", ex: "ex", exs: "ex",
  };
  return groups[ext] ?? ext;
}

const flatten = (r: Awaited<ReturnType<typeof api.projectSearch>>) => r.files.flatMap((f) => f.hits.map((h) => ({ path: f.path, line: h.line, text: h.text })));

/** Where a name is defined, best first */
export async function findDefinitions(name: string, from?: { path: string; line: number }): Promise<Loc[]> {
  const r = await api.projectSearch(defPattern(name), true, true, null);
  const fam = from ? family(from.path) : null;
  const locs: Loc[] = [];
  for (const h of flatten(r)) {
    const kind = classify(h.text, name);
    // The line being looked up from is not its own definition (unless it is one)
    if (kind) locs.push({ ...h, kind });
  }
  const score = (l: Loc) =>
    (from && l.path === from.path ? 0 : 4) + (fam && family(l.path) === fam ? 0 : 2) + (l.kind === "def" ? 0 : 1) + (/(^|\/)(tests?|__tests__|spec)\//.test(l.path) ? 1 : 0);
  return locs.sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path) || a.line - b.line);
}

/** Every line mentioning the name as a whole word (case-sensitive), same file first */
export async function findUsages(name: string, from?: { path: string }): Promise<{ locs: Loc[]; truncated: boolean }> {
  const r = await api.projectSearch(`\\b${esc(name)}\\b`, true, true, null);
  const locs: Loc[] = flatten(r).map((h) => ({ ...h, kind: classify(h.text, name) ? "def" : "use" }));
  locs.sort((a, b) => (from ? Number(b.path === from.path) - Number(a.path === from.path) : 0) || a.path.localeCompare(b.path) || a.line - b.line);
  return { locs, truncated: r.truncated };
}

// ---------- Import paths ----------

let files: { at: number; set: Set<string> } | null = null;
async function projectSet(): Promise<Set<string>> {
  if (files && Date.now() - files.at < 15000) return files.set;
  const list = await api.projectFiles();
  files = { at: Date.now(), set: new Set(list) };
  return files.set;
}
export const projectList = async () => [...(await projectSet())];

/** "a/./b/../c" → "a/c"; null when it leaves the repository */
export function normalize(p: string): string | null {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const EXTS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json", ".css", ".scss", ".less", ".rs", ".py", ".go", ".md", ".h", ".hpp"];
const INDEX = ["index.ts", "index.tsx", "index.js", "index.jsx", "mod.rs", "__init__.py"];

/** The files an import / include / mod / link text could mean, most likely first */
export function importCandidates(spec: string, fromPath: string): string[] {
  const s = spec.trim().replace(/^["'`<]|["'`>]$/g, "").split(/[?#]/)[0];
  if (!s || /^[a-z]+:\/\//i.test(s)) return [];
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const bases: string[] = [];
  const add = (b: string | null) => b !== null && !bases.includes(b) && bases.push(b);
  if (s.startsWith("/")) add(normalize(s));
  else {
    add(normalize(`${dir}/${s}`));
    if (!s.startsWith(".")) {
      // Bare paths: from the repository root, src/, and aliases like "@/x" or "~/x"
      add(normalize(s));
      add(normalize(`src/${s}`));
      const alias = s.match(/^[@~]\/(.*)$/);
      if (alias) (add(normalize(`src/${alias[1]}`)), add(normalize(alias[1])));
    }
  }
  // Rust "mod foo" next to the declaring file: in lib.rs / main.rs / mod.rs the sibling, elsewhere a folder named after the file
  if (/^[A-Za-z_]\w*$/.test(s) && fromPath.endsWith(".rs")) {
    const stem = fromPath.slice(fromPath.lastIndexOf("/") + 1, -3);
    const base = ["lib", "main", "mod"].includes(stem) ? dir : `${dir ? dir + "/" : ""}${stem}`;
    bases.unshift(normalize(`${base}/${s}`) ?? s);
  }
  // Python dotted modules "a.b.c"
  if (/^\.*[A-Za-z_][\w.]*$/.test(s) && s.includes(".") && fromPath.endsWith(".py")) {
    const lead = s.match(/^\.*/)![0].length;
    const mod = s.slice(lead).replace(/\./g, "/");
    let base = dir;
    for (let i = 1; i < lead; i++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    add(normalize(lead ? `${base}/${mod}` : mod));
  }
  const out: string[] = [];
  for (const b of bases) {
    for (const e of EXTS) out.push(b + e);
    for (const i of INDEX) out.push(`${b}/${i}`);
  }
  return out.filter((c, i) => c && out.indexOf(c) === i);
}

/** The project file an import-like text points at, or null */
export async function resolveImport(spec: string, fromPath: string): Promise<string | null> {
  const set = await projectSet();
  return importCandidates(spec, fromPath).find((c) => set.has(c)) ?? null;
}

/** Looks like a path rather than prose: has a slash or a file extension, no spaces */
export const pathLike = (s: string) => s.length > 0 && s.length < 300 && !/\s/.test(s) && (/[/\\]/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s));

/** Rank paths for quick open: every typed character in order; filename matches and shorter paths first */
export function fuzzy(q: string, paths: string[], limit = 60): string[] {
  const query = q.trim().toLowerCase().replace(/\s+/g, "");
  if (!query) return [];
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let s: number;
    if (name.startsWith(query)) s = 0;
    else if (name.includes(query)) s = 1;
    else if (lower.includes(query)) s = 3;
    else {
      // Subsequence: count gaps
      let i = 0;
      let gaps = 0;
      let last = -1;
      for (let k = 0; k < lower.length && i < query.length; k++) {
        if (lower[k] === query[i]) {
          if (last >= 0 && k > last + 1) gaps++;
          last = k;
          i++;
        }
      }
      if (i < query.length) continue;
      s = 5 + gaps;
    }
    scored.push({ p, s: s * 1000 + p.length });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.p);
}

/** What a ⌘-click (or ⌘B) at column `col` of a line points at: a file (a quoted path, `mod foo;`, a Python import) or a name */
export function clickTarget(line: string, col: number): { spec?: string; name?: string } | null {
  // Inside a quoted string that looks like a path: the file it names
  const quote = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  for (let m; (m = quote.exec(line)); ) {
    if (col >= m.index && col <= m.index + m[0].length) return pathLike(m[2]) ? { spec: m[2] } : null;
  }
  // Rust `mod foo;` and Python `import a.b` / `from a.b import c` (clicking the module part)
  const rmod = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/);
  if (rmod) return { spec: rmod[1] };
  const py = line.match(/^(\s*(?:from|import)\s+)(\.*[A-Za-z_][\w.]*)/);
  if (py && col >= py[1].length && col <= py[1].length + py[2].length) return { spec: py[2] };
  // C includes with angle brackets are system headers; with quotes they were handled above
  // Otherwise the identifier under the click
  const isW = (c: string | undefined) => !!c && /[\w$]/.test(c);
  let a = col;
  let b = col;
  while (a > 0 && isW(line[a - 1])) a--;
  while (b < line.length && isW(line[b])) b++;
  const word = line.slice(a, b);
  return isIdent(word) ? { name: word } : null;
}
