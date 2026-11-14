// File view (the "File · name" tab in the middle): the file's change chain on the left, content or diff on the right.
//
// The change chain runs newest to oldest: "current (worktree)" at the top, then commits that changed the file (following renames back; the rename step shows the old name).
// - Choose "current": shows the current content; with uncommitted changes, switch to "uncommitted changes".
// - Choose a commit: shows this commit's change to the file by default; switch to "content at this revision".
// - ⌘ or Shift click a second one: compare the two versions (old on the left, new on the right; works across renames).
// Diffs use the same display as the diff tab (unified or side by side, ignore whitespace, block navigation).
// When opened from content search results (at): shows that revision's (or the worktree's) full text, scrolled to and marking that line; choosing something else in the chain returns to normal.
// Blame (toolbar toggle, or right-click the text): the full text shows on the left of each line the date and author that last changed it,
// darker when newer; hover for the commit, click to locate it in the log. Applies to whichever revision's text is shown.

import { Crumbs, useTopLine } from "./Crumbs";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf, wholeFile } from "../api/commands";
import type { FileDiff, FileHistory, FileText } from "../api/types";
import { DiffView, blameSide, type BSide } from "./DiffView";
import { Menu, type MenuState } from "./Menu";
import { StatusBadge } from "./FileRow";
import { Splitter, sizeVars } from "./Splitter";
import { findRegExp, formatTime, relTime, shortId } from "./format";
import { Found, indentStyle, indentUnit } from "./inlineDiff";
import { highlight, langOf, type Tok } from "../highlight";
import { settings, useSettings } from "../settings";
import { t, tr, lang } from "../i18n";

const WORK = "work";
const MAX_LINES = 20000;

interface Props {
  path: string;
  /** Show the change chain on open (when opened from the "file history" icon); normally collapsed, shown via the toolbar's "change chain" */
  showHistory?: boolean;
  /** Which line to jump to and which revision to show after opening (empty is the worktree); n differs every time */
  at?: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null; n: number } | null;
  /** This file has uncommitted changes in the worktree (or is untracked) */
  changed: boolean;
  /** Locate this commit in the log */
  onLocate: (id: string) => void;
}

type Load<T> = { data: T | null; loading: boolean; error: string | null };
const idle = { data: null, loading: false, error: null };

export function FileView({ path, at, changed, onLocate, showHistory }: Props) {
  /** Blame annotations on the left of the full text (per tab, off by default) */
  const [annot, setAnnot] = useState(false);
  /** Whether the change chain column is open: collapsed by default, content takes the full width */
  const [chain, setChain] = useState(!!showHistory);
  useEffect(() => setChain(!!showHistory), [path, showHistory]);
  const [hist, setHist] = useState<Load<FileHistory>>({ ...idle, loading: true });
  /** Selected: WORK or commit hashes; at most two, in click order */
  const [sel, setSel] = useState<string[]>([WORK]);
  /** What to show when only one is selected: the diff (the commit's change, uncommitted changes) or the full text */
  const [mode, setMode] = useState<"diff" | "text">("text");
  const [text, setText] = useState<Load<FileText>>(idle);
  const [diff, setDiff] = useState<Load<FileDiff>>(idle);
  const host = useRef<HTMLDivElement>(null);
  // When opened from search results: mark the search term in full text and diffs (cleared when switching files)
  const findRe = at?.find ? findRegExp(at.find.text, at.find.regex, at.find.caseSensitive) : null;
  /** The revision (branch or tag names work) and line a content search result points to; cleared when clicking something else in the chain */
  const [jump, setJump] = useState<{ line: number; rev: string | null } | null>(null);
  useEffect(() => {
    if (!at) return;
    setJump({ line: at.line, rev: at.rev });
    setSel([WORK]);
    setMode("text");
  }, [at]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setHist({ ...idle, loading: true });
    setSel([WORK]);
    setMode("text");
    if (!at) setJump(null);
    api.fileHistory(path).then(
      (data) => live && setHist({ data, loading: false, error: null }),
      (e) => live && setHist({ data: null, loading: false, error: errOf(e).message }),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const versions = useMemo(() => hist.data?.versions ?? [], [hist.data]);
  /** Position in the list: the worktree is -1 (newest), commits start at 0 */
  const order = (k: string) => (k === WORK ? -1 : versions.findIndex((v) => v.commit.id === k));
  const byId = (k: string) => versions.find((v) => v.commit.id === k) ?? null;
  const head = versions[0] ?? null;

  // What to show on the right
  type Req = { kind: "text"; rev: string | null; path: string } | { kind: "diff"; from: string | null; fromPath: string; to: string | null; toPath: string; label: string };
  const req: Req | null = useMemo(() => {
    if (jump?.rev) return { kind: "text", rev: jump.rev, path };
    if (sel.length === 2) {
      const [a, b] = [...sel].sort((x, y) => order(y) - order(x)); // Older first
      const va = byId(a);
      const vb = b === WORK ? null : byId(b);
      if (!va) return null;
      return {
        kind: "diff",
        from: va.commit.id,
        fromPath: va.path,
        to: b === WORK ? null : b,
        toPath: vb?.path ?? path,
        label: t("比较 {0} → {1}", shortId(va.commit.id), b === WORK ? t("当前") : shortId(b)),
      };
    }
    const k = sel[0];
    if (k === WORK) {
      if (mode === "diff" && head) return { kind: "diff", from: head.commit.id, fromPath: head.path, to: null, toPath: path, label: t("未提交的改动") };
      return { kind: "text", rev: null, path };
    }
    const v = byId(k);
    if (!v) return null;
    if (mode === "text") return { kind: "text", rev: v.commit.id, path: v.path };
    return { kind: "diff", from: v.commit.parents[0] ?? null, fromPath: v.old_path ?? v.path, to: v.commit.id, toPath: v.path, label: t("提交 {0} 的修改", shortId(v.commit.id)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, mode, versions, path, head, jump, lang]);

  const reqKey = JSON.stringify(req);
  useEffect(() => {
    if (!req) return;
    let live = true;
    if (req.kind === "text") {
      setText((x) => ({ ...x, loading: true, error: null }));
      api.fileText(req.path, req.rev).then(
        (data) => live && setText({ data, loading: false, error: null }),
        (e) => live && setText({ data: null, loading: false, error: errOf(e).message }),
      );
    } else {
      setDiff((x) => ({ ...x, loading: true, error: null }));
      // The commit that deleted the file: the new side doesn't have it, so the diff shows a full deletion
      wholeFile((c) => api.fileDiffVersions(req.from, req.fromPath, req.to, req.toPath, c)).then(
        (data) => live && setDiff({ data, loading: false, error: null }),
        (e) => live && setDiff({ data: null, loading: false, error: errOf(e).message }),
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  /** Click to select one; ⌘ / Shift click to add a second (compare); clicking a selected one deselects it */
  const pick = (k: string, add: boolean) => {
    setJump(null);
    if (!add) {
      setSel([k]);
      setMode(k === WORK ? "text" : "diff");
      return;
    }
    setSel((s) => (s.includes(k) ? (s.length > 1 ? s.filter((x) => x !== k) : s) : [...s, k].slice(-2)));
  };

  // ↑ ↓ change versions in the change chain
  const keys = [WORK, ...versions.map((v) => v.commit.id)];
  const move = (d: number) => {
    const i = keys.indexOf(sel[sel.length - 1]);
    const k = keys[Math.max(0, Math.min(keys.length - 1, i + d))];
    pick(k, false);
    list.current?.querySelector(`[data-k="${k}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const single = sel.length === 1 ? sel[0] : null;
  const singleV = single && single !== WORK ? byId(single) : null;

  return (
    <div className="fview" ref={host} style={sizeVars(settings(), ["paneHistory"])}>
      <div className="fv-bar">
        <span className="mono fv-path" title={path}>
          {path}
        </span>
        <span className="grow" />
        <button
          type="button"
          className={"btn sm fv-chain" + (chain ? " pressed" : "")}
          aria-pressed={chain}
          title={chain ? t("收起修改链") : t("显示修改链：改过这个文件的提交，可以看每次的修改、某个版本的内容，或比较两个版本")}
          onClick={() => {
            if (chain) {
              // Back to the current content when collapsed
              setSel([WORK]);
              setMode("text");
            }
            setChain((c) => !c);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4v3.2l2 1.3" />
          </svg>
          {t("修改链")}
          {hist.data && <span className="dim">{versions.length + (hist.data.truncated ? "+" : "")}</span>}
        </button>
        <button
          type="button"
          className={"ib" + (annot ? " pressed" : "")}
          aria-pressed={annot}
          title={annot ? t("隐藏每行的修改人") : t("逐行追溯：每行左边显示最后改它的日期和作者")}
          aria-label={t("逐行追溯")}
          onClick={() => {
            if (!annot && req?.kind === "diff") setMode("text");
            setAnnot((a) => !a);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5" />
          </svg>
        </button>
      </div>
      <div className="fv-body">
        {chain && (
        <div
          className="fv-list"
          ref={list}
          role="listbox"
          aria-label={t("修改链")}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <p className="fv-tip dim small">{t("单击看一个版本；⌘ 或 Shift 单击再选一个，比较两个版本")}</p>
          <VersionRow k={WORK} sel={jump?.rev ? [] : sel} onPick={pick} first last={!versions.length}>
            <div className="fv-title">{t("当前（工作区）")}</div>
            <div className="fv-meta dim small">{changed ? <span className="fv-tag warn">{t("有没提交的改动")}</span> : t("和最新提交相同")}</div>
          </VersionRow>
          {versions.map((v, i) => (
            <VersionRow key={v.commit.id} k={v.commit.id} sel={jump?.rev ? [] : sel} onPick={pick} last={i === versions.length - 1}>
              <div className="fv-title" title={v.commit.title}>
                {v.commit.title}
              </div>
              <div className="fv-meta dim small">
                <span className="mono">{shortId(v.commit.id)}</span> · {v.commit.author.name} · {relTime(v.commit.time)}
              </div>
              <div className="fv-meta small">
                <StatusBadge s={v.status} />
                {v.status === "A" && <span className="dim">{t("新增")}</span>}
                {v.status === "D" && <span className="dim">{t("删除")}</span>}
                {v.status === "R" && v.old_path && <span className="dim mono fv-ren" title={`${v.old_path} → ${v.path}`}>{t("从 {0} 改名", v.old_path.slice(v.old_path.lastIndexOf("/") + 1))}</span>}
                {v.binary ? <span className="dim">{t("二进制")}</span> : (
                  <>
                    <span className="mono plus">+{v.added}</span>
                    <span className="mono minus">−{v.deleted}</span>
                  </>
                )}
                <span className="grow" />
                <button
                  type="button"
                  className="ib sm frow-act"
                  title={t("在日志里定位这个提交")}
                  aria-label={t("在日志里定位 {0}", shortId(v.commit.id))}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocate(v.commit.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="7" cy="7" r="3" />
                    <path d="M7 1v2.5M7 10.5V13M1 7h2.5M10.5 7H13" />
                  </svg>
                </button>
              </div>
            </VersionRow>
          ))}
          {hist.loading && <p className="dim pad small">{t("正在找出改过这个文件的提交…")}</p>}
          {hist.error && <p className="err pad">{tr(hist.error)}</p>}
          {hist.data && !versions.length && <p className="dim pad small">{t("这个文件还没有提交过（未跟踪的新文件）")}</p>}
        </div>
        )}
        {chain && (
        <Splitter
          name="paneHistory"
          host={host}
          grow="right"
          min={220}
          max={() => (host.current?.clientWidth ?? 900) - 360}
          size={() => list.current?.offsetWidth ?? 320}
          label={t("调整修改链的宽度")}
        />
        )}
        <div className="fv-main">
          {jump?.rev && (
            <div className="fv-mode">
              <span className="dim small">{t("{0} 时的内容（从搜索结果打开）", jump.rev)}</span>
            </div>
          )}
          {!jump?.rev && sel.length === 1 && (single === WORK ? changed && !!head : !!singleV) && (
            <div className="fv-mode">
              <span className="seg" role="radiogroup" aria-label={t("显示内容")}>
                <button type="button" role="radio" aria-checked={mode === "diff"} className={mode === "diff" ? "on" : ""} onClick={() => setMode("diff")}>
                  {single === WORK ? t("未提交的改动") : t("这次提交的修改")}
                </button>
                <button type="button" role="radio" aria-checked={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>
                  {single === WORK ? t("当前内容") : t("这个版本的内容")}
                </button>
              </span>
              {singleV && (
                <button type="button" className="btn sm" title={t("逐行追溯这个版本")} onClick={() => (setMode("text"), setAnnot(true))}>
                  {t("逐行追溯这个版本")}
                </button>
              )}
            </div>
          )}
          {req?.kind === "diff" ? (
            <DiffView diff={diff.data} loading={diff.loading} error={diff.error} source={req.label} find={findRe} readOnly={req.to !== null} blameSides={{ left: req.from ? { path: req.fromPath, rev: req.from } : null, right: { path: req.toPath, rev: req.to } }} onLocate={onLocate} onClose={() => (sel.length === 2 ? setSel([sel[1]]) : setMode("text"))} />
          ) : (
            <TextView
              load={text}
              focus={jump?.line ?? null}
              find={findRe}
              blame={annot && req?.kind === "text" ? { path: req.path, rev: req.rev } : null}
              onToggleBlame={() => setAnnot((a) => !a)}
              onLocate={onLocate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function VersionRow({ k, sel, onPick, first, last, children }: { k: string; sel: string[]; onPick: (k: string, add: boolean) => void; first?: boolean; last?: boolean; children: React.ReactNode }) {
  const on = sel.includes(k);
  const n = sel.indexOf(k);
  return (
    <div
      className={"fv-row" + (on ? " on" : "") + (first ? " first" : "") + (last ? " last" : "")}
      data-k={k}
      role="option"
      aria-selected={on}
      onClick={(e) => onPick(k, e.metaKey || e.ctrlKey || e.shiftKey)}
    >
      <span className="fv-dot" aria-hidden="true">
        {sel.length === 2 && on && <span className="fv-n">{n === 0 ? "A" : "B"}</span>}
      </span>
      <div className="fv-row-body">{children}</div>
    </div>
  );
}

/** The file's full text with line numbers */
function TextView({
  load,
  focus,
  find,
  blame,
  onToggleBlame,
  onLocate,
}: {
  load: Load<FileText>;
  focus: number | null;
  find: RegExp | null;
  /** Which revision to blame (rev empty is the worktree); null hides the annotations */
  blame: { path: string; rev: string | null } | null;
  onToggleBlame: () => void;
  onLocate: (id: string) => void;
}) {
  const f = load.data;
  // Blame the whole file once per revision; lines are matched by number
  const blameKey = blame ? JSON.stringify(blame) : "";
  const [bl, setBl] = useState<{ key: string; side: BSide | null } | null>(null);
  useEffect(() => {
    if (!blameKey) return;
    let live = true;
    blameSide(blame).then((side) => live && setBl({ key: blameKey, side }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameKey]);
  const side = bl?.key === blameKey ? bl.side : null;
  // Age coloring: 5 levels between the earliest and latest commit times in this file
  const [tMin, tMax] = useMemo(() => {
    const ts = [...(side?.values() ?? [])].filter((b) => !b.uncommitted).map((b) => b.time);
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 0];
  }, [side]);
  const ann = (no: number) => {
    const b = side?.get(no);
    if (!b) return <span className="ann" />;
    const heat = b.uncommitted ? "new" : String(tMax > tMin ? Math.round(((b.time - tMin) / (tMax - tMin)) * 4) : 4);
    // Consecutive lines from the same commit: only the first shows the text, the color runs on
    const same = side?.get(no - 1)?.id === b.id;
    return (
      <span
        className={"ann heat-" + heat + (b.inLog ? " link" : "") + (same ? " cont" : "")}
        title={b.uncommitted ? t("还没提交的改动") : `${shortId(b.id)} ${b.title}\n${b.author} · ${formatTime(b.time)}` + (b.inLog ? t("\n点击在日志里定位") : "")}
        onClick={() => !b.uncommitted && b.inLog && onLocate(b.id)}
      >
        {same ? "" : b.uncommitted ? t("还没提交") : `${formatTime(b.time).slice(0, 10)} ${b.author}`}
      </span>
    );
  };
  // Right-click: blame on/off, and for an annotated line locate or copy its commit
  const [menu, setMenu] = useState<MenuState | null>(null);
  const onMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // Leave copying selected text to the system menu
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tv-line");
    const b = row ? side?.get(Number(row.dataset.n)) : undefined;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t("逐行追溯（每行显示修改人）"), checked: !!blame, run: onToggleBlame },
        ...(b && !b.uncommitted
          ? [
              "-" as const,
              { label: t("在日志里定位 {0}", shortId(b.id)), disabled: !b.inLog, why: t("这个提交不在当前日志里"), run: () => onLocate(b.id) },
              { label: t("复制版本号"), run: () => void navigator.clipboard.writeText(b.id) },
            ]
          : []),
      ],
    });
  };
  const box = useRef<HTMLDivElement>(null);
  // Jump to the given line
  useEffect(() => {
    if (!focus || load.loading) return;
    box.current?.querySelector(".tv-line.focus")?.scrollIntoView({ block: "center" });
  }, [focus, f, load.loading]);
  const lines = useMemo(() => {
    const all = f?.text?.split("\n") ?? [];
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [f]);
  // Syntax highlighting (colored on a background thread; uncolored text shows first)
  const syntax = useSettings().diffSyntax;
  const [toks, setToks] = useState<{ f: FileText; lines: Tok[][] } | null>(null);
  useEffect(() => {
    if (!f?.text || !syntax) return;
    let live = true;
    highlight(langOf(f.path), [f.text]).then(([t]) => live && t && setToks({ f, lines: t }));
    return () => {
      live = false;
    };
  }, [f, syntax]);
  const lineToks = syntax && toks?.f === f ? toks.lines : null;
  const guides = useSettings().diffIndent;
  const unit = useMemo(() => indentUnit(lines.slice(0, 4000)), [lines]);
  const get = useMemo(() => (k: number) => (k <= MAX_LINES ? lines[k - 1] : undefined), [lines]);
  const top = useTopLine(box, [lines]);
  return (
    <>
    {f?.text !== undefined && lines.length > 0 && <Crumbs path={f.path} get={get} top={top} box={box} />}
    <div className="fv-text" ref={box} onContextMenu={onMenu}>
      {load.loading && !f && <p className="pad dim">{t("正在读取…")}</p>}
      {load.error && <p className="pad err">{tr(load.error)}</p>}
      {f?.missing && <p className="pad dim">{t("这个版本里没有这个文件（已删除或还没创建）")}</p>}
      {f?.binary && <p className="pad dim">{t("二进制文件，不显示内容（{0} 字节）", f.size)}</p>}
      {f?.text !== undefined && (
        <div className={"tv mono" + (load.loading ? " stale" : "") + (blame ? " with-ann" : "")}>
          {lines.slice(0, MAX_LINES).map((l, i) => (
            <div key={i} data-n={i + 1} className={"tv-line" + (focus === i + 1 ? " focus" : "")}>
              {blame && ann(i + 1)}
              <span className="ln">{i + 1}</span>
              <span className="code" style={guides ? indentStyle(l, unit) : undefined}>
                <Found t={l} find={find} toks={lineToks?.[i]} />
              </span>
            </div>
          ))}
          {(lines.length > MAX_LINES || f.truncated) && <p className="pad dim">{t("文件太大，只显示了前面一部分")}</p>}
        </div>
      )}
    </div>
    {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
