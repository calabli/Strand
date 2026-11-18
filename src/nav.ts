// Jumping around code: go to definition, find usages, open the file an import points at, and back / forward
// through the places jumped from (like an IDE's ⌘[ ⌘]). The app registers a host that opens file tabs, shows a
// list to pick from and shows messages; viewers and the editor call these with what was clicked.

import { clickTarget, findDefinitions, findUsages, importSources, resolveImport, type Loc } from "./symbols";
import { api } from "./api/commands";
import { hintOf } from "./keymap";
import { t } from "./i18n";

export interface Place {
  path: string;
  line: number;
}

export interface NavHost {
  open: (to: Place) => void;
  /** Several results: let the user pick one (picking calls jump) */
  pick: (title: string, locs: Loc[], from: Place | null, note?: string) => void;
  say: (text: string) => void;
}

let host: NavHost | null = null;
export const setNavHost = (h: NavHost | null) => {
  host = h;
};

const back: Place[] = [];
const fwd: Place[] = [];
/** Where the last jump went: where "back" returns from */
let here: Place | null = null;

/** Open a place, remembering where we came from for ⌘[ */
export function jump(to: Place, from: Place | null) {
  if (from && !(from.path === to.path && from.line === to.line)) {
    back.push(from);
    if (back.length > 100) back.shift();
    fwd.length = 0;
  }
  here = to;
  host?.open(to);
}

export function goBack() {
  const to = back.pop();
  if (!to) return host?.say(t("没有可以后退的位置"));
  if (here) fwd.push(here);
  here = to;
  host?.open(to);
}

export function goForward() {
  const to = fwd.pop();
  if (!to) return host?.say(t("没有可以前进的位置"));
  if (here) back.push(here);
  here = to;
  host?.open(to);
}

/**
 * Go to where a name is defined, like an IDE: straight to the most likely place — the file it's imported from, this
 * file, the only real definition, or else the best-ranked one (saying how many others there are). `all` lists every
 * candidate instead. On the definition itself, shows its usages.
 */
export async function goDefinition(name: string, from: Place, all = false) {
  try {
    const text = (await api.fileText(from.path, null).catch(() => null))?.text ?? "";
    const prefer = text ? await importSources(text, name, from.path).catch(() => []) : [];
    const found = await findDefinitions(name, from, prefer);
    const locs = found.filter((l) => !(l.path === from.path && l.line === from.line));
    if (!locs.length) {
      if (found.length) return goUsages(name, from);
      // Imported from a file where the search found nothing (re-exported, generated…): open that file
      if (prefer.length) return jump({ path: prefer[0], line: 1 }, from);
      return host?.say(t("没找到 {0} 的定义", name));
    }
    if (all) return host?.pick(t("{0} 的定义", name), locs, from, t("按文字搜索找到的，可能有同名的其他东西"));
    const top = locs[0];
    jump(top, from);
    // Certain enough: from the import, in this file, or the only real definition
    const defs = locs.filter((l) => l.kind === "def");
    const sure = prefer.includes(top.path) || top.path === from.path || locs.length === 1 || (defs.length === 1 && defs[0] === top);
    if (!sure) host?.say(t("还有 {0} 处同名的定义，按 {1} 列出全部", locs.length - 1, hintOf("allDefinitions")));
  } catch (e) {
    host?.say(String((e as Error)?.message ?? e));
  }
}

export async function goUsages(name: string, from: Place) {
  try {
    const { locs, truncated } = await findUsages(name, from);
    if (!locs.length) return host?.say(t("没找到 {0} 的用法", name));
    host?.pick(t("{0} 的用法（{1} 处）", name, locs.length + (truncated ? "+" : "")), locs, from, truncated ? t("太多了，只列出前 2000 处") : undefined);
  } catch (e) {
    host?.say(String((e as Error)?.message ?? e));
  }
}

export async function openSpec(spec: string, from: Place) {
  const p = await resolveImport(spec, from.path).catch(() => null);
  if (p) jump({ path: p, line: 1 }, from);
  else host?.say(t("项目里找不到 {0}", spec));
}

/** ⌘-click, ⌘B (definition), ⌥⌘B (all definitions) or ⌥F7 (usages) at a column of a line in `from.path` */
export function navigateAt(line: string, col: number, from: Place, mode: "def" | "all" | "usages" = "def") {
  const target = clickTarget(line, col);
  if (!target) return false;
  if (target.spec && mode === "def") void openSpec(target.spec, from);
  else if (target.name) void (mode === "usages" ? goUsages(target.name, from) : goDefinition(target.name, from, mode === "all"));
  else return false;
  return true;
}
