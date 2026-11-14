// Log filter bar (spec §5.1): branch tree toggle, search (regex, case sensitivity), branch, author, date, path, sort by time,
// refresh, cherry-pick, display options, jump to commit, rebase commits.
// Conditions are intersected; unset conditions show only an icon, set ones show their value and a clear button.

import { useEffect, useRef, useState } from "react";
import { api } from "../api/commands";
import type { AuthorMatch, LogAuthor, LogFilter, LogSort, RefsList } from "../api/types";
import { AuthorPicker, KIND_LABEL } from "./AuthorPicker";
import { DateRangePicker } from "./DateRangePicker";
import { Menu, type MenuState } from "./Menu";
import { Picker, type PickItem } from "./Picker";
import { t, tr, lazy } from "../i18n";
import { setSettings, useSettings } from "../settings";

export type DateRange = "all" | "today" | "3d" | "6d" | "custom";

/** The filter bar's UI state; `toFilter` converts it to the conditions sent to the core layer */
export interface LogUi {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  branch: string | null;
  /** Checked authors (multiple) */
  authors: LogAuthor[];
  /** Authors matched by rule, OR-ed with the checked ones */
  authorRule: AuthorMatch | null;
  date: DateRange;
  /** Start and end dates of a custom range (YYYY-MM-DD, both inclusive), used when date is custom */
  from: string | null;
  to: string | null;
  path: string | null;
  sort: LogSort;
  /** Where the search box searches: commit messages and hashes, or changes (commits that added or removed the text) */
  searchIn: "message" | "changes";
  /** First parent only */
  firstParent: boolean;
  /** Hide merge commits */
  noMerges: boolean;
  /** Collapse linear branches (only effective without other filters, in graph order) */
  collapse: boolean;
}

export const EMPTY_UI: LogUi = { text: "", regex: false, caseSensitive: false, branch: null, authors: [], authorRule: null, date: "all", from: null, to: null, path: null, sort: "topo", searchIn: "message", firstParent: false, noMerges: false, collapse: false };

const DATE_LABEL: Record<Exclude<DateRange, "custom">, string> = lazy(() => ({ all: t("所有日期"), today: t("今天"), "3d": t("最近 3 天"), "6d": t("最近 6 天") }));

/** Midnight of a day in the local time zone (YYYY-MM-DD), plus days */
function dayStart(d: string, days = 0): number {
  const [y, m, dd] = d.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, dd + days).getTime() / 1000);
}

/** Today's midnight minus days - 1 days ("last 3 days" is today and the two before) */
function sinceOf(d: DateRange): number | null {
  if (d === "all" || d === "custom") return null;
  const days = d === "today" ? 1 : d === "3d" ? 3 : 6;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - (days - 1));
  return Math.floor(t.getTime() / 1000);
}

export function toFilter(u: LogUi): LogFilter {
  return {
    text: u.text,
    regex: u.regex,
    case_sensitive: u.caseSensitive,
    branch: u.branch,
    authors: u.authors.map((a) => a.email),
    author_match: u.authorRule,
    since: u.date === "custom" ? (u.from ? dayStart(u.from) : null) : sinceOf(u.date),
    until: u.date === "custom" && u.to ? dayStart(u.to, 1) : null,
    path: u.path,
    search_in: u.searchIn,
    first_parent: u.firstParent,
    no_merges: u.noMerges,
    collapse_linear: u.collapse,
  };
}

export const isFiltered = (u: LogUi) => !!(u.text || u.branch || u.authors.length || u.authorRule || u.date !== "all" || u.path || u.sort !== "topo" || u.firstParent || u.noMerges);

/** The author condition shown as a short text: the first checked person's name (+N for more), followed by the rule when there is one */
function authorText(u: LogUi): string | null {
  const parts: string[] = [];
  if (u.authors.length) parts.push(u.authors[0].name + (u.authors.length > 1 ? ` +${u.authors.length - 1}` : ""));
  if (u.authorRule) parts.push(`${KIND_LABEL[u.authorRule.kind]} ${u.authorRule.text}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Text for the date condition */
function dateText(u: LogUi): string | null {
  if (u.date === "all") return null;
  if (u.date !== "custom") return DATE_LABEL[u.date];
  if (u.from && u.to) return u.from === u.to ? u.from : `${u.from} – ${u.to}`;
  return u.from ? t("{0} 起", u.from) : u.to ? t("到 {0}", u.to) : null;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const FILTER_ICONS = {
  tree: "M1.5 2.5h11v9h-11zM5 2.5v9",
  search: "M9.5 9.5 12.5 12.5M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0",
  branch: "M4 1.5v11M10 1.5v3c0 3-6 2.5-6 6",
  author: "M7 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M2.5 12.5c.5-2.5 2.3-3.5 4.5-3.5s4 1 4.5 3.5",
  date: "M2 3.5h10v8.5H2zM2 6.5h10M5 2v3M9 2v3",
  path: "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z",
  sort: "M4 2v10M2 10l2 2 2-2M8.5 3h4M8.5 7h3M8.5 11h2",
  jump: "M1.5 7h8M6.5 4l3 3-3 3M12.5 2v10",
  funnel: "M1.5 2.5h11L8.5 7.5v4l-3 1.2V7.5z",
  rebase: "M3 2v10M3 4.5h5a2 2 0 0 1 0 4H5M7 6.5 5 8.5l2 2M11 2v3M11 9v3",
  refresh: "M12 7a5 5 0 1 1-1.5-3.6M12 1.5V4.5H9",
  cherry: "M4.5 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M10 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M4.5 8.5C5 5 7.5 2.5 11 1.5M10 7.5C10 5 9 3 7.5 2",
  options: "M2 4h10M2 10h10M5 2.5v3M9 8.5v3",
};

interface Props {
  ui: LogUi;
  onChange: (u: LogUi) => void;
  refs: RefsList | null;
  treeOpen: boolean;
  onToggleTree: () => void;
  onJump: () => void;
  /** Open the rebase window (all rebaseable commits) */
  onRebase: () => void;
  /** Re-read the log */
  onRefresh: () => void;
  /** Cherry-pick the selected commits; why is the reason when unavailable */
  pick: { run: () => void; ok: boolean; why?: string | null; count: number };
  /** Start point of compare mode (spec §10.3); shows a "compare base" marker when given */
  compareBase?: string | null;
  onExitCompare?: () => void;
  /** The regex is invalid */
  badRegex: boolean;
  /** Request to focus the search box (⌘F); n differs every time */
  focus: number;
}

type Open = { kind: "branch" | "author" | "path" | "dates"; x: number; y: number } | null;

export function LogFilterBar({ ui, onChange, refs, treeOpen, onToggleTree, onJump, onRebase, onRefresh, pick, compareBase, onExitCompare, badRegex, focus }: Props) {
  const opts = useSettings();
  const [text, setText] = useState(ui.text);
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [authors, setAuthors] = useState<LogAuthor[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(ui);
  latest.current = ui;

  // Sync the input when conditions were cleared from outside (e.g. "locate", jump to commit)
  useEffect(() => setText(ui.text), [ui.text]);

  // Filter 150 ms after typing; searching changes runs git over the whole history every time, so wait 600 ms (or Enter)
  useEffect(() => {
    if (text === latest.current.text) return;
    const t = window.setTimeout(() => onChange({ ...latest.current, text }), latest.current.searchIn === "changes" ? 600 : 150);
    return () => window.clearTimeout(t);
  }, [text, onChange]);

  useEffect(() => {
    if (focus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focus]);

  const set = (patch: Partial<LogUi>) => onChange({ ...ui, ...patch });

  const at = (e: React.MouseEvent, kind: NonNullable<Open>["kind"]) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (kind === "author" && !authors) api.logAuthors().then(setAuthors, () => setAuthors([]));
    setOpen({ kind, x: r.left, y: r.bottom + 4 });
  };

  const branchItems: PickItem[] = [
    ...(refs?.branches ?? []).map((b) => ({ key: b.name, label: b.name, sub: b.is_current ? t("当前") : undefined })),
    ...(refs?.remotes ?? []).map((r) => ({ key: r.name, label: r.name })),
  ];

  const chip = (
    icon: string,
    label: string,
    value: string | null,
    onOpen: (e: React.MouseEvent) => void,
    clear: () => void,
  ) => (
    <span className={"fchip" + (value ? " on" : "")}>
      <button type="button" className="fchip-main" title={value ? `${label}：${value}` : label} aria-label={label} onClick={onOpen}>
        <Icon d={icon} />
        {value && <span className="fchip-val">{value}</span>}
      </button>
      {value && (
        <button type="button" className="fchip-x" title={t("清除{0}过滤", label)} aria-label={t("清除{0}过滤", label)} onClick={clear}>
          ×
        </button>
      )}
    </span>
  );

  return (
    <div className="fbar" role="toolbar" aria-label={t("日志过滤")}>
      <button type="button" className={"ib" + (treeOpen ? " pressed" : "")} title={treeOpen ? t("隐藏分支树") : t("显示分支树")} aria-label={t("分支树")} aria-pressed={treeOpen} onClick={onToggleTree}>
        <Icon d={FILTER_ICONS.tree} />
      </button>
      <label className={"fsearch" + (badRegex ? " bad" : "") + (ui.searchIn === "changes" ? " in-changes" : "")} title={badRegex ? t("正则表达式写得不对") : undefined}>
        <Icon d={FILTER_ICONS.search} />
        <button
          type="button"
          className={"ftog fs-mode" + (ui.searchIn === "changes" ? " on" : "")}
          title={
            ui.searchIn === "changes"
              ? t("正在搜改动内容：找加进来或删掉这段文字的提交（正则时找改动的行有匹配的提交）。点一下改回搜说明")
              : t("正在搜提交说明和哈希。点一下改为搜改动内容（在全部历史的代码改动里找）")
          }
          aria-label={t("搜索范围")}
          aria-pressed={ui.searchIn === "changes"}
          onClick={() => set({ searchIn: ui.searchIn === "changes" ? "message" : "changes", text })}
        >
          {ui.searchIn === "changes" ? t("改动") : t("说明")}
        </button>
        <input
          ref={input}
          value={text}
          placeholder={ui.searchIn === "changes" ? t("搜改动内容，如函数名") : t("搜索说明或哈希")}
          spellCheck={false}
          aria-invalid={badRegex}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text !== ui.text) {
              e.preventDefault();
              onChange({ ...ui, text });
            } else if (e.key === "Escape" && text) {
              e.stopPropagation();
              setText("");
              onChange({ ...ui, text: "" });
            }
          }}
        />
        <button type="button" className={"ftog mono" + (ui.regex ? " on" : "")} title={t("正则表达式")} aria-label={t("正则表达式")} aria-pressed={ui.regex} onClick={() => set({ regex: !ui.regex, text })}>
          .*
        </button>
        <button type="button" className={"ftog mono" + (ui.caseSensitive ? " on" : "")} title={t("区分大小写")} aria-label={t("区分大小写")} aria-pressed={ui.caseSensitive} onClick={() => set({ caseSensitive: !ui.caseSensitive, text })}>
          Cc
        </button>
      </label>
      {chip(FILTER_ICONS.branch, t("分支"), ui.branch, (e) => at(e, "branch"), () => set({ branch: null }))}
      {chip(FILTER_ICONS.author, t("作者"), authorText(ui), (e) => at(e, "author"), () => set({ authors: [], authorRule: null }))}
      {chip(
        FILTER_ICONS.date,
        t("日期"),
        dateText(ui),
        (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              ...(Object.keys(DATE_LABEL) as Exclude<DateRange, "custom">[]).map((d) => ({ label: (ui.date === d ? "✓ " : "　 ") + DATE_LABEL[d], run: () => set({ date: d, from: null, to: null }) })),
              "-" as const,
              { label: (ui.date === "custom" ? "✓ " : "　 ") + t("自定义范围…"), run: () => setOpen({ kind: "dates", x: r.left, y: r.bottom + 4 }) },
            ],
          });
        },
        () => set({ date: "all", from: null, to: null }),
      )}
      {chip(FILTER_ICONS.path, t("路径"), ui.path, (e) => at(e, "path"), () => set({ path: null }))}
      {compareBase && (
        <span className="fchip on cmp-chip" title={t("比较模式：在日志里选中另一个提交，看两者的差别")}>
          <span className="fchip-main">
            <span className="fchip-val">{t("比较起点 {0}", compareBase.slice(0, 7))}</span>
          </span>
          <button type="button" className="fchip-x" title={t("退出比较")} aria-label={t("退出比较")} onClick={onExitCompare}>
            ×
          </button>
        </span>
      )}
      {/* The action icons on the right form a group: when they don't fit, the whole group wraps to a second line, right-aligned */}
      <span className="fbar-acts">
      <button
        type="button"
        className={"ib" + (ui.sort === "date" || ui.firstParent || ui.noMerges || ui.collapse ? " pressed" : "")}
        title={t("排序和显示：按时间或图谱顺序、只看第一父提交、不显示合并、折叠线性分支")}
        aria-label={t("排序和显示")}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // Collapsing only works in graph order without other filters (no graph is drawn when filtering or sorting by time)
          const plain = !isFiltered({ ...ui, sort: "topo", firstParent: false, noMerges: false }) && ui.sort === "topo" && !ui.firstParent && !ui.noMerges;
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              { heading: true, label: t("排序") },
              { label: t("按提交时间"), checked: ui.sort === "date", run: () => set({ sort: "date" }) },
              { label: t("按图谱顺序（拓扑）"), checked: ui.sort === "topo", run: () => set({ sort: "topo" }) },
              "-",
              { heading: true, label: t("选项") },
              { label: t("只看第一父提交"), checked: ui.firstParent, run: () => set({ firstParent: !ui.firstParent }) },
              { label: t("不显示合并提交"), checked: ui.noMerges, run: () => set({ noMerges: !ui.noMerges }) },
              "-",
              { heading: true, label: t("分支") },
              { label: t("折叠线性分支"), checked: ui.collapse, disabled: !plain, why: t("按图谱顺序、没有过滤条件时才能折叠"), run: () => set({ collapse: true }) },
              { label: t("展开线性分支"), disabled: !ui.collapse, why: t("现在没有折叠"), run: () => set({ collapse: false }) },
            ],
          });
        }}
      >
        <Icon d={FILTER_ICONS.sort} />
      </button>
      <button type="button" className="ib" title={t("刷新日志")} aria-label={t("刷新日志")} onClick={onRefresh}>
        <Icon d={FILTER_ICONS.refresh} />
      </button>
      <button
        type="button"
        className="ib"
        title={pick.ok ? (pick.count > 1 ? t("拣选选中的 {0} 个提交到当前分支", pick.count) : t("拣选选中的提交到当前分支")) : t("拣选：{0}", tr(pick.why) || t("先选中一个提交"))}
        aria-label={t("拣选")}
        disabled={!pick.ok}
        onClick={pick.run}
      >
        <Icon d={FILTER_ICONS.cherry} />
      </button>
      <button
        type="button"
        className="ib"
        title={t("显示选项")}
        aria-label={t("显示选项")}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const item = (on: boolean, label: string, flip: () => void) => ({ label: (on ? "✓ " : "　 ") + label, run: flip });
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              item(opts.exactDates, t("显示精确日期"), () => setSettings({ exactDates: !opts.exactDates })),
              item(opts.mergeRefs, t("本地和远程在同一提交时合并标签"), () => setSettings({ mergeRefs: !opts.mergeRefs })),
              item(opts.dimMerges, t("合并提交显示为灰色"), () => setSettings({ dimMerges: !opts.dimMerges })),
            ],
          });
        }}
      >
        <Icon d={FILTER_ICONS.options} />
      </button>
      <button type="button" className="ib" title={t("整理提交（调整顺序、压缩、丢弃）")} aria-label={t("整理提交")} onClick={onRebase}>
        <Icon d={FILTER_ICONS.rebase} />
      </button>
      <button type="button" className="ib" title={t("跳到提交（哈希、分支或标签）")} aria-label={t("跳到提交")} onClick={onJump}>
        <Icon d={FILTER_ICONS.jump} />
      </button>
      </span>

      {open?.kind === "branch" && (
        <Picker
          x={open.x}
          y={open.y}
          items={branchItems}
          placeholder={t("搜索分支")}
          selected={ui.branch}
          clearLabel={t("所有分支")}
          onPick={(k) => set({ branch: k })}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "author" && (
        <AuthorPicker
          x={open.x}
          y={open.y}
          authors={authors}
          picked={ui.authors}
          rule={ui.authorRule}
          onChange={(picked, rule) => set({ authors: picked, authorRule: rule })}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "dates" && (
        <DateRangePicker
          x={open.x}
          y={open.y}
          from={ui.from}
          to={ui.to}
          onApply={(from, to) => set({ date: "custom", from, to })}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "path" && (
        <Picker
          x={open.x}
          y={open.y}
          items={[]}
          free
          initial={ui.path ?? ""}
          placeholder={t("路径的一部分，如 src/ui")}
          onPick={(k) => set({ path: k })}
          onClose={() => setOpen(null)}
        />
      )}
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
