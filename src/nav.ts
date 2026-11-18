// Jumping around code: go to definition, find usages, open the file an import points at, and back / forward
// through the places jumped from (like an IDE's ⌘[ ⌘]). The app registers a host that opens file tabs, shows a
// list to pick from and shows messages; viewers and the editor call these with what was clicked.

import { clickTarget, findDefinitions, findUsages, resolveImport, type Loc } from "./symbols";
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

/** Go to where a name is defined: straight there when it's one place, otherwise a list */
export async function goDefinition(name: string, from: Place) {
  try {
    const locs = (await findDefinitions(name, from)).filter((l) => !(l.path === from.path && l.line === from.line));
    if (!locs.length) {
      // Clicked on the definition itself (or nothing found): show the usages instead
      const self = (await findDefinitions(name, from)).some((l) => l.path === from.path && l.line === from.line);
      if (self) return goUsages(name, from);
      return host?.say(t("没找到 {0} 的定义", name));
    }
    const best = locs.filter((l) => l.kind === "def");
    if (locs.length === 1 || (best.length === 1 && best[0].path === from.path)) return jump(best[0] ?? locs[0], from);
    host?.pick(t("{0} 的定义", name), locs, from, t("按文字搜索找到的，可能有同名的其他东西"));
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

/** ⌘-click or ⌘B at a column of a line in `from.path` */
export function navigateAt(line: string, col: number, from: Place, usages = false) {
  const target = clickTarget(line, col);
  if (!target) return false;
  if (target.spec && !usages) void openSpec(target.spec, from);
  else if (target.name) void (usages ? goUsages(target.name, from) : goDefinition(target.name, from));
  else return false;
  return true;
}
