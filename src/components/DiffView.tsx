// Diff (spec §10.1): shared by the diff tab, the diff box under commit details, and the file view.
//
// Shows the whole file (with a very large context the core layer returns the whole file in one block); long unchanged stretches fold into "⋯ expand N lines" by default,
// and a toolbar toggle expands them all; when only lines around changes are available (line checks, shelf), block headers show between blocks.
// Both views draw from the same set of "segments": unchanged segments and change segments (deleted and added lines paired in order).
// - Unified view: one column with old and new line number columns; change segments show deletions first, then additions.
// - Side by side: old on the left, new on the right, each side of a change segment laid out on its own with hatching under the shorter side; a narrow middle strip links matching changes with ribbons.
// A thin strip on the right marks every change in the whole file (green added, red deleted, blue modified); click to jump.
// Previous and next jump by change segment, wrapping around at the ends; "change i / n". The diff tab can also switch between files of the same commit (or comparison, worktree).
// Modified worktree files support line checks: each changed line and block header has a checkbox; unchecked lines fade and stay out of this commit (only 3 lines around changes are fetched then).
// Ignore whitespace only affects display: within a change group, deleted and added lines that are equal after removing whitespace are paired and shown as unchanged; check state is still recorded by the original lines.
// Deleted and added lines paired in order within a change group have their differing parts emphasized (as in the conflict window); search terms are marked when searching by content.
// Blame (toolbar toggle, context menu): each line shows on the left the date and author that last changed it, darker when newer; hover to see the commit, click to locate it in the log.
// Deleted lines and the left side are blamed on the old version, the rest on the new. The context menu (and the toolbar's "⋯") also has folding, show whitespace, show line numbers and word wrap, saved per user.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/commands";
import type { DiffLine, FileDiff } from "../api/types";
import { Menu, type MenuState } from "./Menu";
import { formatTime, shortId } from "./format";
import { highlight, langOf, type Tok } from "../highlight";
import { t, tr } from "../i18n";
import { setSettings, useSettings } from "../settings";
import { Hi, indentStyle, indentUnit } from "./inlineDiff";
import { EditFile } from "./EditFile";
import { Crumbs, useTopLine } from "./Crumbs";
import { ImageDiff, isImage } from "./ImageDiff";

interface Props {
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** Source label shown after the title, e.g. "worktree" or a short hash */
  source: string;
  onClose: () => void;
  /** Line checks: when given, show checkboxes. Line keys are "blockIndex:lineIndex" */
  pick?: {
    excluded: Set<string>;
    onToggle: (keys: string[], on: boolean, all: string[]) => void;
    /** When showing the whole file with checks recorded per block with 3 lines of context: changed line ("d:oldLine" / "a:newLine") → its "block:line" */
    keys?: Map<string, string>;
  };
  /** The narrow version (the diff box under files in commit details): only file name, line counts, prev/next and close, unified view fixed; onExpand opens it in a tab */
  compact?: boolean;
  onExpand?: () => void;
  /** When searching by changes: matching changed lines are marked, scrolling to the first on open */
  find?: RegExp | null;
  /** Switch between files in a group (diff tab): which one, how many, previous/next */
  files?: { at: number; total: number; go: (d: number) => void } | null;
  /** A historical version (read-only): a lock before the path */
  readOnly?: boolean;
  /** Which revision each side is blamed on: rev empty is the worktree; without it blame isn't available (e.g. shelf) */
  blameSides?: { left?: { path: string; rev: string | null } | null; right?: { path: string; rev: string | null } | null } | null;
  /** Clicking a commit in blame: locate it in the log */
  onLocate?: (id: string) => void;
  /** A worktree file: can be edited right here (pencil); onSaved re-reads the diff after saving */
  editable?: { path: string; onSaved: () => void } | null;
  /** Which revision each side of an image is (rev empty is the worktree); blameSides when not given */
  imageSides?: { left?: { path: string; rev: string | null } | null; right?: { path: string; rev: string | null } | null } | null;
}

/** The commit of one line in blame */
export type BInfo = { id: string; title: string; author: string; time: number; uncommitted: boolean; inLog: boolean; orig: number; previous?: string; previousPath?: string };
/** One side's blame result: line number → commit */
export type BSide = Map<number, BInfo>;

/** Blame one side's whole file */
export function blameSide(side: { path: string; rev: string | null } | null | undefined): Promise<BSide | null> {
  if (!side) return Promise.resolve(null);
  return api.blameFile(side.path, side.rev, 0, 1_000_000).then(
    (p) => new Map(p.lines.map((l) => { const c = p.commits[l.commit]; return [l.no, { id: c.id, title: c.title, author: c.author, time: c.time, uncommitted: c.uncommitted, inLog: c.in_log, orig: l.orig, previous: c.previous, previousPath: c.previous_path }] as const; })),
    // An added file doesn't exist in the old version: no blame on that side
    () => null,
  );
}

const key = (h: number, l: number) => `${h}:${l}`;
const squash = (s: string) => s.replace(/\s+/g, "");
/** Lines kept at each end of an unchanged segment */
const KEEP = 3;
/** Height of each line (matches line-height in the styles) */
const LH = 20;

/** A line: h and j are the block index and line index within the block from the core layer (checks are recorded by them); same means both sides are equal ignoring whitespace; pair is the paired line on the other side (to emphasize differences) */
type Item = { kind: "context" | "add" | "del"; h: number; j: number; line: DiffLine; same?: boolean; pair?: string };
type Row = { left?: Item; right?: Item };
/** Segments: unchanged, changed (id is the change number), block header (when only lines around changes are available) */
type Seg = { kind: "ctx"; rows: Row[] } | { kind: "chg"; rows: Row[]; id: number } | { kind: "gap"; h: number; title: string };

/** Pair the lines in a block left and right: deleted and added lines paired in order, the other side empty when counts differ; when ignoring whitespace, equal pairs count as unchanged */
function pairRows(lines: DiffLine[], h: number, ignoreWs: boolean): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (l.kind === "context") {
      const it: Item = { kind: "context", h, j: k, line: l };
      rows.push({ left: it, right: it });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < lines.length && lines[k].kind === "del") dels.push(k++);
    while (k < lines.length && lines[k].kind === "add") adds.push(k++);
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      if (ignoreWs && d !== undefined && a !== undefined && squash(lines[d].text) === squash(lines[a].text)) {
        rows.push({ left: { kind: "context", h, j: d, line: lines[d], same: true }, right: { kind: "context", h, j: a, line: lines[a], same: true } });
      } else {
        rows.push({
          left: d !== undefined ? { kind: "del", h, j: d, line: lines[d], pair: a !== undefined ? lines[a].text : undefined } : undefined,
          right: a !== undefined ? { kind: "add", h, j: a, line: lines[a], pair: d !== undefined ? lines[d].text : undefined } : undefined,
        });
      }
    }
  }
  return rows;
}

/** Split the whole diff into segments */
function segmentsOf(diff: FileDiff, ignoreWs: boolean, headers: boolean): Seg[] {
  const segs: Seg[] = [];
  let id = 0;
  diff.hunks.forEach((hk, h) => {
    if (headers) segs.push({ kind: "gap", h, title: hk.title });
    for (const r of pairRows(hk.lines, h, ignoreWs)) {
      const changed = r.left?.kind !== "context" || r.right?.kind !== "context";
      const last = segs[segs.length - 1];
      if (last && last.kind === (changed ? "chg" : "ctx")) last.rows.push(r);
      else segs.push(changed ? { kind: "chg", rows: [r], id: id++ } : { kind: "ctx", rows: [r] });
    }
  });
  return segs;
}

/** Kind of a change segment: only additions, only deletions, or both */
const chgKind = (rows: Row[]) => {
  const l = rows.some((r) => r.left);
  const r = rows.some((x) => x.right);
  return l && r ? "mod" : l ? "del" : "add";
};

const ICON = {
  unified: "M2 3h10M2 6h10M2 9h10M2 12h10",
  split: "M2 2h4.5v10H2zM7.5 2H12v10H7.5z",
  ws: "M2.5 7.5v3.5h9V7.5",
  expand: "M8.5 2H12v3.5M12 2L7.5 6.5M5.5 12H2V8.5M2 12l4.5-4.5",
  fold: "M4 2l3 3 3-3M4 12l3-3 3 3",
  lock: "M3.5 6.5h7v5.5h-7zM5 6.5V4.5a2 2 0 0 1 4 0v2",
  blame: "M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5",
  edit: "M9.5 2.5l2 2L5 11H3V9zM8 4l2 2",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function DiffView({ diff, loading, error, source, onClose, pick, compact, onExpand, find, files, readOnly, blameSides, onLocate, editable, imageSides }: Props) {
  const [cur, setCur] = useState(0);
  /** Editing: which line to open at */
  const [editAt, setEditAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const diffView = compact ? "unified" : settings.diffView;
  const ignoreWs = settings.ignoreWs;
  const fold = settings.diffFold;
  const showWs = settings.diffWs;
  const lineNo = settings.diffLineNo;
  const wrap = settings.diffWrap;
  const syntax = settings.diffSyntax;
  const guides = settings.diffIndent;
  // Unit of the indent guides (2 or 4 columns), judged from this file's lines
  const unit = useMemo(() => (diff ? indentUnit(diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).slice(0, 4000)) : 4), [diff]);

  // Syntax highlighting: assemble the old and new versions (two complete files when showing the whole file), color them on a background thread, match by line number
  const [hl, setHl] = useState<{ diff: FileDiff; old: Map<number, Tok[]>; neu: Map<number, Tok[]> } | null>(null);
  useEffect(() => {
    if (!diff || diff.binary || !syntax) return;
    const lang = langOf(diff.path);
    if (!lang) return;
    const old: { no: number; text: string }[] = [];
    const neu: { no: number; text: string }[] = [];
    for (const h of diff.hunks)
      for (const l of h.lines) {
        if (l.kind !== "add" && l.old_no) old.push({ no: l.old_no, text: l.text });
        if (l.kind !== "del" && l.new_no) neu.push({ no: l.new_no, text: l.text });
      }
    let live = true;
    highlight(lang, [old.map((x) => x.text).join("\n"), neu.map((x) => x.text).join("\n")]).then(([a, b]) => {
      if (!live) return;
      const map = (rows: typeof old, toks: Tok[][] | null) => new Map(toks ? rows.map((r, i) => [r.no, toks[i] ?? []] as const) : []);
      setHl({ diff, old: map(old, a), neu: map(neu, b) });
    });
    return () => {
      live = false;
    };
  }, [diff, syntax]);
  const hlNow = syntax && hl?.diff === diff ? hl : null;
  /** Syntax colors for a line: deleted lines (and the left side) use the old version, the rest the new version */
  const toksOf = (side: 0 | 1, no: number | undefined | null) => (hlNow && no ? (side === 0 ? hlNow.old : hlNow.neu).get(no) : undefined);
  const blameOn = settings.diffBlame && !!blameSides && !compact;

  // Side by side without wrapping, each side scrolls horizontally on its own: each has a scrollbar at the bottom, and horizontal swipes (or ⇧ + wheel) only move the side under the pointer
  const sheet = useRef<HTMLDivElement>(null);
  const bars = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const [over, setOver] = useState<[number, number]>([0, 0]);
  const sideScroll = !!diff && !diff.binary && diffView === "split" && !wrap;
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!sideScroll || !el) {
      setOver([0, 0]);
      return;
    }
    el.style.setProperty("--sx0", "0px");
    el.style.setProperty("--sx1", "0px");
    bars.forEach((b) => b.current && (b.current.scrollLeft = 0));
    // Measure the actual drawn width (correct for CJK full-width characters and tabs); measured again when expanding folds changes the height
    const measure = () => {
      const o = [0, 1].map((i) => {
        const code = el.querySelector<HTMLElement>(`.s${i} .code`);
        if (!code) return 0;
        let w = 0;
        el.querySelectorAll<HTMLElement>(`.s${i} .sx`).forEach((x) => (w = Math.max(w, x.offsetWidth)));
        return Math.max(0, Math.ceil(w - code.clientWidth + 8));
      });
      setOver((p) => (p[0] === o[0] && p[1] === o[1] ? p : [o[0], o[1]]));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideScroll, diff, lineNo, blameOn, !!pick, hlNow]);
  useEffect(() => {
    const el = box.current;
    if (!el || !sideScroll) return;
    const onWheel = (e: WheelEvent) => {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx || Math.abs(dx) < Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
      const side = (e.target as HTMLElement).closest?.(".s0, .s1, .sx-bar");
      if (!side) return;
      const i = side.classList.contains("s1") || side.classList.contains("b1") ? 1 : 0;
      const b = bars[i].current;
      if (!b) return;
      e.preventDefault();
      b.scrollLeft += dx;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideScroll]);
  const sxBar = (i: 0 | 1) => (
    <div
      ref={bars[i]}
      className={`sx-bar b${i}`}
      aria-hidden="true"
      onScroll={(e) => sheet.current?.style.setProperty(`--sx${i}`, `${e.currentTarget.scrollLeft}px`)}
    >
      <div style={{ width: `calc(100% + ${over[i]}px)` }} />
    </div>
  );
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Blame: blame each side's whole file and match by line number
  const [blame, setBlame] = useState<{ key: string; left: BSide | null; right: BSide | null } | null>(null);
  const blameKey = blameOn ? JSON.stringify(blameSides) : "";
  useEffect(() => {
    if (!blameKey) return;
    let live = true;
    Promise.all([blameSide(blameSides?.left), blameSide(blameSides?.right)]).then(([left, right]) => live && setBlame({ key: blameKey, left, right }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameKey]);
  const bl = blame?.key === blameKey ? blame : null;
  // Age coloring: 5 levels between the earliest and latest commit times in this file
  const [tMin, tMax] = useMemo(() => {
    const ts = [...(bl?.left?.values() ?? []), ...(bl?.right?.values() ?? [])].filter((b) => !b.uncommitted).map((b) => b.time);
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 0];
  }, [bl]);
  /** A line's blame annotation; side 0 is the old version (deleted lines, left), 1 the new version */
  const ann = (side: 0 | 1, no: number | undefined | null) => {
    if (!blameOn) return null;
    const b = no ? (side === 0 ? bl?.left : bl?.right)?.get(no) : undefined;
    if (!b) return <span className="ann" />;
    const heat = b.uncommitted ? "new" : String(tMax > tMin ? Math.round(((b.time - tMin) / (tMax - tMin)) * 4) : 4);
    const text = b.uncommitted ? t("还没提交") : `${formatTime(b.time).slice(0, 10)} ${b.author}`;
    return (
      <span
        className={"ann heat-" + heat + (b.inLog && onLocate ? " link" : "")}
        title={b.uncommitted ? t("还没提交的改动") : `${shortId(b.id)} ${b.title}\n${b.author} · ${formatTime(b.time)}` + (b.inLog ? t("\n点击在日志里定位") : "")}
        onClick={() => !b.uncommitted && b.inLog && onLocate?.(b.id)}
      >
        {text}
      </span>
    );
  };

  /** Context menu and toolbar "⋯": blame, folding, display options */
  const viewMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: t("逐行追溯"), checked: blameOn, disabled: !blameSides || compact, why: compact ? t("在差异标签页里打开后可以逐行追溯") : t("这个差异不能逐行追溯"), run: () => setSettings({ diffBlame: !settings.diffBlame }) },
        { label: t("折叠没改的部分"), checked: fold, run: () => (setSettings({ diffFold: !fold }), setOpened(new Set())) },
        "-",
        { heading: true, label: t("显示") },
        { label: t("语法高亮"), checked: syntax, run: () => setSettings({ diffSyntax: !syntax }) },
        { label: t("显示空白字符"), checked: showWs, run: () => setSettings({ diffWs: !showWs }) },
        { label: t("缩进参考线"), checked: guides, run: () => setSettings({ diffIndent: !guides }) },
        { label: t("显示行号"), checked: lineNo, run: () => setSettings({ diffLineNo: !lineNo }) },
        { label: t("自动换行"), checked: wrap, run: () => setSettings({ diffWrap: !wrap }) },
      ],
    });
  /** Unchanged segments that were expanded (by segment position) */
  const [opened, setOpened] = useState<Set<number>>(() => new Set());

  // No block headers when the whole file is one block (starting at line 1); always shown with line checks (the header has the whole-block checkbox)
  const whole = !!diff && diff.hunks.length === 1 && diff.hunks[0].old_start <= 1 && diff.hunks[0].new_start <= 1;
  // Block headers: shown when only lines around changes are available; also shown with line checks but no mapping table (the whole-block checkbox is on it)
  const pickKeys = pick?.keys;
  const segs = useMemo(() => (diff ? segmentsOf(diff, ignoreWs, (!!pick && !pickKeys) || !whole) : []), [diff, ignoreWs, pick, pickKeys, whole]);
  // Breadcrumbs: infer which function or class the top line is in from the new version's lines (the whole new file when showing the whole file)
  const newText = useMemo(() => {
    const m = new Map<number, string>();
    for (const h of diff?.hunks ?? []) for (const l of h.lines) if (l.kind !== "del" && l.new_no) m.set(l.new_no, l.text);
    return (k: number) => m.get(k);
  }, [diff]);
  const top = useTopLine(box, [segs, diffView, opened, fold, wrap]);
  /** Which line editing opens at: the first new-version line of the current change (the nearest following line when it's only deletions) */
  const editLine = () => {
    const i = segs.findIndex((s) => s.kind === "chg" && s.id === cur);
    for (let k = Math.max(0, i); k < segs.length; k++) {
      const s = segs[k];
      if (s.kind !== "gap") for (const r of s.rows) if (r.right?.line.new_no) return r.right.line.new_no;
    }
    return 1;
  };
  const n = segs.filter((s) => s.kind === "chg").length;

  useEffect(() => {
    setCur(0);
    setOpened(new Set());
  }, [diff?.path, source]);
  // When searching, scroll to the first matching changed line
  useEffect(() => {
    if (!find || !diff) return;
    const el = box.current?.querySelector(".found");
    if (el) el.scrollIntoView({ block: "center" });
  }, [diff, find]);
  const found = (it: Item | undefined) => (find && it && it.kind !== "context" && find.test(it.line.text) ? " found" : "");

  const scrollTo = (i: number, smooth = true) => box.current?.querySelector(`[data-block="${i}"]`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  const go = (d: number) => {
    if (n === 0) return;
    // Wrap around to the other end (spec §10.1)
    const next = (cur + d + n) % n;
    setCur(next);
    scrollTo(next);
  };

  const added = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "add").length, 0) ?? 0;
  const deleted = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "del").length, 0) ?? 0;
  // Keys of all changed lines (check state is recorded by them)
  const allKeys = pickKeys ? [...pickKeys.values()] : diff ? diff.hunks.flatMap((h, i) => h.lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(i, j)]))) : [];
  /** A changed line's key in the check record; null when it doesn't match (shouldn't happen), and the line can't be checked */
  const keyOf = (it: Item): string | null =>
    !pickKeys ? key(it.h, it.j) : pickKeys.get(it.kind === "del" ? `d:${it.line.old_no}` : `a:${it.line.new_no}`) ?? null;
  const picked = pick ? allKeys.filter((k) => !pick.excluded.has(k)).length : 0;

  /** The checkbox before a changed line (unchanged lines leave a blank space) */
  const check = (it: Item | undefined) =>
    !pick ? null : !it || it.kind === "context" ? (
      <span className="ck-pad" />
    ) : (
      <input
        type="checkbox"
        className="line-check"
        aria-label={t("提交第 {0} 行的改动", it.line.new_no ?? it.line.old_no)}
        checked={!pick.excluded.has(keyOf(it) ?? "")}
        disabled={keyOf(it) === null}
        onChange={(e) => {
          const k = keyOf(it);
          if (k) pick.onToggle([k], e.target.checked, allKeys);
        }}
      />
    );
  const off = (it: Item | undefined) => (pick && it && it.kind !== "context" && pick.excluded.has(keyOf(it) ?? "") ? " off" : "");

  /** Whole-file display with line checks: a strip above each change with a checkbox for all of its changed lines */
  const chgPick = (s: Seg & { kind: "chg" }) => {
    if (!pick || !pickKeys) return null;
    const keys = s.rows.flatMap((r) => [r.left, r.right]).flatMap((it) => (it && it.kind !== "context" ? [keyOf(it)] : [])).filter((k): k is string => !!k);
    const uniq = [...new Set(keys)];
    const on = uniq.filter((k) => !pick.excluded.has(k)).length;
    return (
      <div className="chg-pick">
        <input
          type="checkbox"
          className="hunk-check"
          aria-label={t("勾选这一处的全部改动行")}
          checked={on === uniq.length}
          ref={(el) => {
            if (el) el.indeterminate = on > 0 && on < uniq.length;
          }}
          onChange={() => pick.onToggle(uniq, on < uniq.length, allKeys)}
        />
        <span className="dim">{t("第 {0} 处 · 已选 {1} / {2} 行", s.id + 1, on, uniq.length)}</span>
      </div>
    );
  };

  /** An unchanged segment: fold the middle when too long. Returns the lines to show (null is the folded line) */
  const visibleRows = (s: Seg & { kind: "ctx" }, i: number): (Row | { hidden: number })[] => {
    const L = s.rows.length;
    const first = i === 0 || segs[i - 1].kind === "gap";
    const last = i === segs.length - 1 || segs[i + 1].kind === "gap";
    const head = first ? 0 : KEEP;
    const tail = last ? 0 : KEEP;
    if (!fold || opened.has(i) || L <= head + tail + 2) return s.rows;
    return [...s.rows.slice(0, head), { hidden: L - head - tail }, ...s.rows.slice(L - tail)];
  };
  const foldRow = (i: number, hidden: number, k: number, split: boolean) => (
    <button key={`f${k}`} type="button" className={"dl-fold" + (split ? " split" : "")} onClick={() => setOpened((o) => new Set(o).add(i))} title={t("展开这 {0} 行没改的代码", hidden)}>
      ⋯ {t("展开 {0} 行", hidden)}
    </button>
  );

  /** A line in the unified view */
  const uLine = (it: Item, k: string | number) => (
    <div key={k} data-n={it.kind !== "del" ? it.line.new_no ?? undefined : undefined} className={`dl dl-${it.kind}` + (pick ? " pickable" : "") + off(it) + (it.same ? " ws-same" : "") + found(it)} title={it.same ? t("只有空白不同") : undefined}>
      {check(it)}
      {it.kind === "del" ? ann(0, it.line.old_no) : ann(1, it.line.new_no)}
      <span className="ln">{it.kind === "add" ? "" : it.same ? "" : it.line.old_no ?? ""}</span>
      <span className="ln">{it.kind === "del" ? "" : it.line.new_no ?? ""}</span>
      <span className="sign">{it.kind === "add" ? "+" : it.kind === "del" ? "−" : ""}</span>
      <span className="code" style={guides ? indentStyle(it.line.text, unit) : undefined}>
        <Hi t={it.line.text} other={it.pair} find={find} ws={showWs} toks={it.kind === "del" ? toksOf(0, it.line.old_no) : toksOf(1, it.line.new_no)} />
      </span>
    </div>
  );

  /** A block header (when only lines around changes are available): with a whole-block checkbox when line checks are on */
  const gapRow = (s: Seg & { kind: "gap" }, i: number) => {
    const keys = pick && diff ? diff.hunks[s.h].lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(s.h, j)])) : [];
    const on = pick ? keys.filter((k) => !pick.excluded.has(k)).length : 0;
    return (
      <div key={`g${i}`} className="dl-gap mono">
        {pick && (
          <input
            type="checkbox"
            className="hunk-check"
            aria-label={t("勾选这个修改块的全部改动行")}
            checked={on === keys.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < keys.length;
            }}
            onChange={() => pick.onToggle(keys, on < keys.length, allKeys)}
          />
        )}
        {tr(s.title)}
      </div>
    );
  };

  const unified = () =>
    segs.map((s, i) => {
      if (s.kind === "gap") return gapRow(s, i);
      if (s.kind === "chg") {
        const items = [...s.rows.flatMap((r) => (r.left ? [r.left] : [])), ...s.rows.flatMap((r) => (r.right ? [r.right] : []))];
        return (
          <div key={i} className={"chg" + (s.id === cur ? " cur" : "")} data-block={s.id} data-kind={chgKind(s.rows)}>
            {chgPick(s)}
            {items.map((it, k) => uLine(it, k))}
          </div>
        );
      }
      return (
        <div key={i} className="ctx">
          {visibleRows(s, i).map((r, k) =>
            "hidden" in r ? foldRow(i, r.hidden, k, false) : uLine({ ...r.right!, same: false, line: { ...r.right!.line, old_no: r.left!.line.old_no } }, k),
          )}
        </div>
      );
    });

  /** A line on one side of the side-by-side view */
  const sLine = (it: Item, side: 0 | 1, k: string | number) => (
    <div key={k} data-n={side === 1 ? it.line.new_no ?? undefined : undefined} className={`sl-line s${side} dl-${it.kind}` + (pick ? " pickable" : "") + off(it) + (it.same ? " ws-same" : "") + found(it)} title={it.same ? t("只有空白不同") : undefined}>
      {check(it.kind !== "context" ? it : undefined)}
      {ann(side, side === 0 ? it.line.old_no : it.line.new_no)}
      <span className="ln">{(side === 0 ? it.line.old_no : it.line.new_no) ?? ""}</span>
      <span className="sign">{it.kind === "add" ? "+" : it.kind === "del" ? "−" : ""}</span>
      <span className="code" style={guides ? indentStyle(it.line.text, unit) : undefined}>
        <span className="sx">
          <Hi t={it.line.text} other={it.pair} find={find} ws={showWs} toks={toksOf(side, side === 0 ? it.line.old_no : it.line.new_no)} />
        </span>
      </span>
    </div>
  );

  const split = () =>
    segs.map((s, i) => {
      if (s.kind === "gap") return gapRow(s, i);
      if (s.kind === "chg")
        return (
          <div key={i}>
            {chgPick(s)}
            <ChgSeg id={s.id} cur={s.id === cur} kind={chgKind(s.rows)} left={s.rows.flatMap((r, k) => (r.left ? [sLine(r.left, 0, k)] : []))} right={s.rows.flatMap((r, k) => (r.right ? [sLine(r.right, 1, k)] : []))} />
          </div>
        );
      return (
        <div key={i} className="sseg ctx">
          {visibleRows(s, i).map((r, k) =>
            "hidden" in r ? (
              foldRow(i, r.hidden, k, true)
            ) : (
              <div key={k} className="srow">
                {sLine(r.left!, 0, "l")}
                <span className="sgut" />
                {sLine(r.right!, 1, "r")}
              </div>
            ),
          )}
        </div>
      );
    });

  return (
    <div
      className={"diff" + (compact ? " compact" : "")}
      onKeyDown={(e) => {
        // ⌥↑ ⌥↓ previous and next change; ⌥← ⌥→ previous and next file
        if (!e.altKey) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          go(e.key === "ArrowDown" ? 1 : -1);
        } else if (files && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          files.go(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <div className="diff-bar">
        {files && files.total > 1 && (
          <span className="diff-files">
            <button type="button" className="ib" onClick={() => files.go(-1)} title={t("上一个文件（⌥←）")} aria-label={t("上一个文件")}>
              ←
            </button>
            <span className="dim">{t("{0} / {1} 个文件", files.at + 1, files.total)}</span>
            <button type="button" className="ib" onClick={() => files.go(1)} title={t("下一个文件（⌥→）")} aria-label={t("下一个文件")}>
              →
            </button>
          </span>
        )}
        {readOnly && !compact && (
          <span className="dim diff-lock" title={t("历史版本，只能看")}>
            <Ico d={ICON.lock} />
          </span>
        )}
        <span className="mono diff-path" title={diff?.path}>
          {compact ? diff?.path.split("/").pop() : diff?.path}
        </span>
        {!compact && <span className="dim">{source}</span>}
        {diff && !diff.binary && (
          <>
            <span className="mono plus">+{added}</span>
            <span className="mono minus">−{deleted}</span>
          </>
        )}
        {pick && allKeys.length > 0 && <span className="dim">{t("已选 {0} / {1} 行", picked, allKeys.length)}</span>}
        <span className="grow" />
        {editable && !compact && diff && !diff.binary && (
          <button type="button" className="ib" title={t("编辑这个文件（工作区）")} aria-label={t("编辑这个文件")} onClick={() => setEditAt(editLine())}>
            <Ico d={ICON.edit} />
          </button>
        )}
        {!compact && (
          <span className="seg diff-seg" role="radiogroup" aria-label={t("差异视图")}>
            <button type="button" role="radio" aria-checked={diffView === "split"} className={diffView === "split" ? "on" : ""} title={t("左右对比")} aria-label={t("左右对比")} onClick={() => setSettings({ diffView: "split" })}>
              <Ico d={ICON.split} />
            </button>
            <button type="button" role="radio" aria-checked={diffView === "unified"} className={diffView === "unified" ? "on" : ""} title={t("合并视图")} aria-label={t("合并视图")} onClick={() => setSettings({ diffView: "unified" })}>
              <Ico d={ICON.unified} />
            </button>
          </span>
        )}
        {blameSides && !compact && (
          <button
            type="button"
            className={"ib" + (blameOn ? " pressed" : "")}
            aria-pressed={blameOn}
            title={blameOn ? (bl ? t("逐行追溯（已打开）") : t("正在逐行追溯…")) : t("逐行追溯：每行左边标出最后改它的日期和作者")}
            aria-label={t("逐行追溯")}
            onClick={() => setSettings({ diffBlame: !settings.diffBlame })}
          >
            <Ico d={ICON.blame} />
          </button>
        )}
        <button
          type="button"
          className={"ib" + (fold ? " pressed" : "")}
          aria-pressed={fold}
          title={fold ? t("折叠没改的部分（已打开，点一下显示整个文件）") : t("折叠没改的部分")}
          aria-label={t("折叠没改的部分")}
          onClick={() => {
            setSettings({ diffFold: !fold });
            setOpened(new Set());
          }}
        >
          <Ico d={ICON.fold} />
        </button>
        {!compact && (
          <button
            type="button"
            className={"ib" + (ignoreWs ? " pressed" : "")}
            aria-pressed={ignoreWs}
            title={ignoreWs ? t("忽略空白（已打开，只影响显示）") : t("忽略空白")}
            aria-label={t("忽略空白")}
            onClick={() => setSettings({ ignoreWs: !ignoreWs })}
          >
            <Ico d={ICON.ws} />
          </button>
        )}
        {n > 0 && (
          <>
            <span className="dim">{compact ? `${cur + 1}/${n}` : t("第 {0} / {1} 处", cur + 1, n)}</span>
            <button type="button" className="ib" onClick={() => go(-1)} disabled={n < 2} title={t("上一处（⌥↑）")} aria-label={t("上一处")}>
              ↑
            </button>
            <button type="button" className="ib" onClick={() => go(1)} disabled={n < 2} title={t("下一处（⌥↓）")} aria-label={t("下一处")}>
              ↓
            </button>
          </>
        )}
        <button
          type="button"
          className="ib"
          title={t("显示选项（也可以在差异里右键）")}
          aria-label={t("显示选项")}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            viewMenu(r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
        {onExpand && (
          <button type="button" className="ib" onClick={onExpand} title={t("在差异标签页里打开（可以左右对比）")} aria-label={t("在差异标签页里打开")}>
            <Ico d={ICON.expand} />
          </button>
        )}
        <button type="button" className="ib" onClick={onClose} title={t("关闭差异")} aria-label={t("关闭差异")}>
          ×
        </button>
      </div>
      {!compact && diff && !diff.binary && n > 0 && <Crumbs path={diff.path} get={newText} top={top} box={box} />}
      <div className="diff-main">
        <div
          className={"diff-body" + (diffView === "split" ? " split" : "")}
          ref={box}
          tabIndex={-1}
          onContextMenu={(e) => {
            e.preventDefault();
            viewMenu(e.clientX, e.clientY);
          }}
        >
          {loading && <p className="pad dim">{t("正在读取差异…")}</p>}
          {error && <p className="pad err">{tr(error)}</p>}
          {diff && diff.binary && (imageSides ?? blameSides) && isImage(diff.path) ? (
            <ImageDiff left={(imageSides ?? blameSides)!.left} right={(imageSides ?? blameSides)!.right} compact={compact} />
          ) : (
            diff && diff.binary && <p className="pad dim">{t("二进制文件，不显示差异")}</p>
          )}
          {diff && !diff.binary && n === 0 && !loading && <p className="pad dim">{t("没有内容差异（可能只改了文件权限）")}</p>}
          {diff && !diff.binary && n > 0 && (
            <div ref={sheet} className={"dfile" + (diffView === "split" ? " split" : "") + (wrap ? " wrap" : "") + (lineNo ? "" : " no-ln") + (showWs ? " show-ws" : "") + (blameOn ? " with-ann" : "")}>
              {diffView === "split" ? split() : unified()}
            </div>
          )}
          {sideScroll && n > 0 && (over[0] > 0 || over[1] > 0) && (
            <div className={"sx-bars" + (blameOn ? " with-ann" : "")}>
              {sxBar(0)}
              <span />
              {sxBar(1)}
            </div>
          )}
          {diff?.truncated && <p className="pad dim">{t("文件太大，只显示了前 20000 行")}</p>}
        </div>
        {diff && !diff.binary && n > 0 && <Ruler body={box} deps={[segs, opened, fold, diffView, wrap, lineNo, blameOn]} onPick={(i) => (setCur(i), scrollTo(i, false))} />}
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
      {editable && editAt != null && <EditFile path={editable.path} line={editAt} onClose={() => setEditAt(null)} onSaved={editable.onSaved} />}
    </div>
  );
}

/**
 * A change segment in the side-by-side view: each side laid out downward on its own, hatching under the shorter one, linked by a ribbon in the middle.
 * The ribbon's height at each end follows the actual laid-out height of each side (so it lines up even when long lines wrap).
 */
function ChgSeg({ id, cur, kind, left, right }: { id: number; cur: boolean; kind: string; left: React.ReactNode[]; right: React.ReactNode[] }) {
  const lref = useRef<HTMLDivElement>(null);
  const rref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<{ l: number; r: number }>({ l: left.length * LH, r: right.length * LH });
  useLayoutEffect(() => {
    const measure = () => setH({ l: lref.current?.offsetHeight ?? 0, r: rref.current?.offsetHeight ?? 0 });
    measure();
    const ro = new ResizeObserver(measure);
    if (lref.current) ro.observe(lref.current);
    if (rref.current) ro.observe(rref.current);
    return () => ro.disconnect();
  }, [left.length, right.length]);
  const H = Math.max(h.l, h.r, 2);
  const W = 36;
  // Ribbon: left [0, l], right [0, r], joined by cubic curves; when only one side has lines the other narrows to a line
  const lb = Math.max(h.l, 1);
  const rb = Math.max(h.r, 1);
  const d = `M0 0 C ${W / 2} 0, ${W / 2} 0, ${W} 0 L ${W} ${rb} C ${W / 2} ${rb}, ${W / 2} ${lb}, 0 ${lb} Z`;
  return (
    <div className={"sseg chg" + (cur ? " cur" : "")} data-block={id} data-kind={kind}>
      <div className="sside">
        <div ref={lref}>{left}</div>
        {h.l < H && <div className="sfill" />}
      </div>
      <svg className={"sgut ribbon " + kind} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={d} />
      </svg>
      <div className="sside">
        <div ref={rref}>{right}</div>
        {h.r < H && <div className="sfill" />}
      </div>
    </div>
  );
}

/** Change position markers on the right: each change drawn as a short segment at its position in the whole file; click to jump */
function Ruler({ body, deps, onPick }: { body: React.RefObject<HTMLDivElement | null>; deps: unknown[]; onPick: (i: number) => void }) {
  const [marks, setMarks] = useState<{ id: number; top: number; h: number; kind: string }[]>([]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const total = el.scrollHeight || 1;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      setMarks(
        [...el.querySelectorAll<HTMLElement>("[data-block]")].map((b) => {
          const r = b.getBoundingClientRect();
          return { id: Number(b.dataset.block), top: (r.top - base) / total, h: r.height / total, kind: b.dataset.kind ?? "mod" };
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const content = el.querySelector(".dfile");
    if (content) ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <div className="diff-ruler" aria-hidden="true">
      {marks.map((m) => (
        <span key={m.id} className={"rmark " + m.kind} style={{ top: `${m.top * 100}%`, height: `max(3px, ${m.h * 100}%)` }} onClick={() => onPick(m.id)} />
      ))}
    </div>
  );
}
