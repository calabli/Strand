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
// Right-click a line → "blame the revision before this change": shows the file as it was just before the commit that last
// changed the line (following renames), blamed, near the same line; "back" returns step by step.
// Git LFS files whose content hasn't been downloaded show a note with a download button.

import { Crumbs } from "./Crumbs";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf, wholeFile } from "../api/commands";
import type { FileDiff, FileHistory, FileText } from "../api/types";
import { DiffView, blameSide, type BSide } from "./DiffView";
import { Menu, type MenuState } from "./Menu";
import { FindBar, goToLine, useFind } from "./FindBar";
import { useNavClicks } from "./navClicks";
import { FileEditor } from "./EditFile";
import { StatusBadge } from "./FileRow";
import { Splitter, sizeVars } from "./Splitter";
import { findRegExp, formatTime, relTime, shortId } from "./format";
import { Found, indentStyle, indentUnit } from "./inlineDiff";
import { highlight, textLangOf, type Tok } from "../highlight";
import { settings, useSettings } from "../settings";
import { PreviewPane, previewProviders } from "./Preview";
import { choicesFor, defaultChoice, openPluginsWindow, rememberChoice, usePlugins } from "../preview";
import { LineRollbackGutter, type RollbackControls } from "./lineRollback";
import { t, tr, lang } from "../i18n";

const WORK = "work";
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);
const MAX_LINES = 20000;

interface Props {
  path: string;
  /** Show the change chain on open (when opened from the "file history" icon); normally collapsed, shown via the toolbar's "change chain" */
  showHistory?: boolean;
  /** Which line to jump to and which revision to show after opening (empty is the worktree); n differs every time */
  at?: { line: number; rev: string | null; anchor?: string; find?: { text: string; regex: boolean; caseSensitive: boolean } | null; n: number } | null;
  /** This file has uncommitted changes in the worktree (or is untracked) */
  changed: boolean;
  /** Locate this commit in the log */
  onLocate: (id: string) => void;
  /** Changes when contents should be read again (after downloading LFS files) */
  reloadKey?: number;
  /** Worktree refresh generation for the active file tab. Hidden tabs catch up when shown. */
  worktreeRead: number | null;
  rollback?: RollbackControls;
  /** Download the repository's LFS files; absent when it doesn't use LFS */
  onLfsPull?: () => void;
}

type Load<T> = { data: T | null; loading: boolean; error: string | null };
const idle = { data: null, loading: false, error: null };

export function FileView({ path, at, changed, onLocate, showHistory, reloadKey, worktreeRead, rollback, onLfsPull }: Props) {
  /** Blame annotations on the left of the full text (per tab, off by default) */
  const [annot, setAnnot] = useState(false);
  /** Editing the worktree file in place of the text: the line to open at; null when not editing */
  const [editAt, setEditAt] = useState<number | null>(null);
  /** Bumped after saving, so the text is read again */
  const [saved, setSaved] = useState(0);
  /** Whether the change chain column is open: collapsed by default, content takes the full width */
  const [chain, setChain] = useState(!!showHistory);
  useEffect(() => setChain(!!showHistory), [path, showHistory]);
  const [hist, setHist] = useState<Load<FileHistory>>({ ...idle, loading: true });
  /** Selected: WORK or commit hashes; at most two, in click order */
  const [sel, setSel] = useState<string[]>([WORK]);
  /** What to show when only one is selected: the diff (the commit's change, uncommitted changes) or the full text */
  const [mode, setMode] = useState<"diff" | "text">("text");
  const [text, setText] = useState<Load<FileText> & { key?: string; read?: number | null }>(idle);
  const [diff, setDiff] = useState<Load<FileDiff>>(idle);
  const host = useRef<HTMLDivElement>(null);
  // When opened from search results: mark the search term in full text and diffs (cleared when switching files)
  const findRe = at?.find ? findRegExp(at.find.text, at.find.regex, at.find.caseSensitive) : null;
  /** The revision (branch or tag names work) and line a content search result points to; cleared when clicking something else in the chain */
  const [jump, setJumpState] = useState<{ line: number; rev: string | null; path?: string; anchor?: string; blame?: boolean } | null>(null);
  /** Revisions passed through with "blame the revision before this change", for "back" */
  const [trail, setTrail] = useState<(typeof jump)[]>([]);
  const setJump = (j: typeof jump) => {
    setTrail([]);
    setJumpState(j);
  };
  useEffect(() => {
    if (!at) return;
    setJump({ line: at.line, rev: at.rev, anchor: at.anchor });
    setView(null);
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
    if (jump?.rev) return { kind: "text", rev: jump.rev, path: jump.path ?? path };
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
  const isWorktree = req?.kind === "text" ? req.rev === null : req?.kind === "diff" && req.to === null;
  const requestReadKey = isWorktree ? `${reqKey}:${worktreeRead ?? "hidden"}` : reqKey;
  useEffect(() => {
    if (!req || (isWorktree && worktreeRead === null)) return;
    let live = true;
    if (req.kind === "text") {
      setText((x) => ({ ...x, loading: true, error: null }));
      api.fileText(req.path, req.rev).then(
        (data) => live && setText({ key: reqKey, read: worktreeRead, data, loading: false, error: null }),
        (e) => live && setText({ key: reqKey, read: worktreeRead, data: null, loading: false, error: errOf(e).message }),
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
  }, [requestReadKey, reloadKey, saved]);

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

  // Previews (rendered Markdown, images, tables, plugins…) in place of the text; the choice is per file and revision
  const plugins = usePlugins(path);
  const textReq = req?.kind === "text" ? req : null;
  const fileNow = textReq && text.key === reqKey && text.data && !text.data.missing && !text.data.lfs_missing ? text.data : null;
  const choices = useMemo(() => (fileNow ? choicesFor(fileNow.path, fileNow, previewProviders, plugins) : []), [fileNow, plugins, lang]);
  const [view, setView] = useState<string | null>(null);
  const [pvMenu, setPvMenu] = useState<MenuState | null>(null);
  useEffect(() => setView(null), [textReq?.path, textReq?.rev]);
  const anchor = useMemo(() => jump?.anchor ? { id: jump.anchor, n: at?.n ?? 0 } : undefined, [jump?.anchor, at?.n]);
  const anchorProvider = anchor && choices.find((c) => c.provider?.id === "markdown")?.id;
  const current = textReq && choices.length ? (view ?? (anchorProvider || defaultChoice(textReq.path, choices))) : "text";
  // Search results and blame need the text
  const toText = annot || (view === null && (!!at?.find || (jump?.line ?? 0) > 1));
  const choice = toText ? null : (choices.find((c) => c.id === current) ?? null);
  const pick2 = (id: string) => {
    setView(id);
    if (textReq) rememberChoice(textReq.path, id);
    if (id !== "text") setAnnot(false);
  };
  const lastPv = choices.find((c) => c.id === current) ?? choices.find((c) => c.specific) ?? choices[0];
  const canEdit = textReq?.rev === null && fileNow?.text != null && !fileNow.binary && !fileNow.truncated;
  const textRollback = canEdit && text.read === worktreeRead && !text.loading ? rollback : undefined;

  return (
    <div className="fview" ref={host} style={sizeVars(settings(), ["paneHistory"])}>
      <div className="fv-bar">
        <span className="mono fv-path" title={path}>
          {path}
        </span>
        <span className="grow" />
        {editAt == null && textReq && choices.length > 0 && (
          <span className="fv-pv">
            <span className="seg" role="radiogroup" aria-label={t("显示方式")}>
              <button type="button" role="radio" aria-checked={!choice} className={!choice ? "on" : ""} onClick={() => pick2("text")}>
                {t("原文")}
              </button>
              <button type="button" role="radio" aria-checked={!!choice} className={choice ? "on" : ""} title={t("预览：{0}", lastPv.label)} onClick={() => pick2(lastPv.id)}>
                {lastPv.label}
              </button>
            </span>
            <button
              type="button"
              className="ib sm"
              title={t("选择预览方式")}
              aria-label={t("选择预览方式")}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPvMenu({
                  x: r.left,
                  y: r.bottom + 4,
                  items: [
                    { label: t("原文"), checked: !choice, run: () => pick2("text") },
                    ...choices.map((c) => ({ label: c.plugin ? t("{0}（插件）", c.label) : c.label, checked: choice?.id === c.id, run: () => pick2(c.id) })),
                    "-" as const,
                    { label: t("管理预览插件…"), run: openPluginsWindow },
                  ],
                });
              }}
            >
              ▾
            </button>
          </span>
        )}
        <button
          type="button"
          className={"btn sm fv-chain" + (chain ? " pressed" : "")}
          aria-pressed={chain}
          disabled={editAt != null}
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
        {editAt == null && canEdit && (
          <button type="button" className="btn sm" title={t("编辑这个文件（也可以双击某一行）")} onClick={() => setEditAt(1)}>
            {t("编辑")}
          </button>
        )}
        <button
          type="button"
          className={"ib" + (annot ? " pressed" : "")}
          aria-pressed={annot}
          disabled={editAt != null}
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
        {chain && editAt == null && (
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
        {chain && editAt == null && (
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
          {editAt != null ? (
            <FileEditor path={path} line={editAt} goto={at && !at.rev ? { line: at.line, n: at.n } : null} rollback={rollback} worktreeRead={worktreeRead} onClose={() => setEditAt(null)} onSaved={() => setSaved((n) => n + 1)} />
          ) : (
          <>
          {jump?.rev && (
            <div className="fv-mode">
              {jump.blame ? (
                <>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      const prev = trail[trail.length - 1] ?? null;
                      setTrail((tr) => tr.slice(0, -1));
                      setJumpState(prev);
                    }}
                  >
                    {t("← 返回")}
                  </button>
                  <span className="dim small">
                    {t("{0} 时的 {1}（改动之前的版本）", shortId(jump.rev), jump.path ?? path)}
                  </span>
                </>
              ) : (
                <span className="dim small">{at?.find ? t("{0} 时的内容（从搜索结果打开）", jump.rev) : t("版本 {0} 的内容", jump.rev.length === 40 ? shortId(jump.rev) : jump.rev)}</span>
              )}
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
          {req?.kind === "text" && choice ? (
            <PreviewPane key={JSON.stringify([choice.id, req.path, req.rev])} choice={choice} path={req.path} rev={req.rev} file={fileNow} reloadKey={(reloadKey ?? 0) + saved} anchor={anchor} />
          ) : req?.kind === "diff" ? (
            <DiffView diff={diff.data} loading={diff.loading} error={diff.error} source={req.label} find={findRe} readOnly={req.to !== null} rollback={single === WORK && req.to === null ? rollback : undefined} blameSides={{ left: req.from ? { path: req.fromPath, rev: req.from } : null, right: { path: req.toPath, rev: req.to } }} onLocate={onLocate} onClose={() => (sel.length === 2 ? setSel([sel[1]]) : setMode("text"))} />
          ) : (
            <TextView
              load={text}
              focus={jump?.line ?? null}
              find={findRe}
              blame={annot && req?.kind === "text" ? { path: req.path, rev: req.rev } : null}
              onToggleBlame={() => setAnnot((a) => !a)}
              onLocate={onLocate}
              onPrevious={(rev, p, line) => {
                setTrail((tr) => [...tr, jump]);
                setJumpState({ rev, path: p, line, blame: true });
                setAnnot(true);
              }}
              onLfsPull={onLfsPull}
              rollback={textRollback}
              onEditLine={canEdit ? (n) => setEditAt(n) : undefined}
            />
          )}
          </>
          )}
        </div>
      </div>
      {pvMenu && <Menu menu={pvMenu} onClose={() => setPvMenu(null)} />}
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
  find: findProp,
  blame,
  onToggleBlame,
  onLocate,
  onPrevious,
  onLfsPull,
  onEditLine,
  rollback,
}: {
  load: Load<FileText>;
  focus: number | null;
  find: RegExp | null;
  /** Which revision to blame (rev empty is the worktree); null hides the annotations */
  blame: { path: string; rev: string | null } | null;
  onToggleBlame: () => void;
  onLocate: (id: string) => void;
  /** Show the revision before the commit that changed a line (rev, path there, the line's number in that commit) */
  onPrevious: (rev: string, path: string, line: number) => void;
  onLfsPull?: () => void;
  /** Double-click a line to edit the worktree file there; absent for other revisions */
  onEditLine?: (line: number) => void;
  rollback?: RollbackControls;
}) {
  const f = load.data;
  // ⌘F finds in the text, ⌘L goes to a line (only the file tab on screen answers)
  const box = useRef<HTMLDivElement>(null);
  const finder = useFind(box, true);
  const find = finder.re ?? findProp;
  // ⌘-click / ⌘B / ⌥F7: definitions, usages, imported files (searched in the worktree)
  useNavClicks(box, f?.path ?? null);
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
    // Every line shows its date and author; lines continuing the same commit are dimmer, so commits read as blocks
    const same = side?.get(no - 1)?.id === b.id;
    return (
      <span
        className={"ann heat-" + heat + (b.inLog ? " link" : "") + (same ? " cont" : "")}
        title={b.uncommitted ? t("还没提交的改动") : `${shortId(b.id)} ${b.title}\n${b.author} · ${formatTime(b.time)}` + (b.inLog ? t("\n点击在日志里定位") : "")}
        onClick={() => !b.uncommitted && b.inLog && onLocate(b.id)}
      >
        {b.uncommitted ? t("还没提交") : `${formatTime(b.time).slice(0, 10)} ${b.author}`}
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
              {
                label: t("追溯改动之前的版本"),
                disabled: !b.previous,
                why: t("这一行是 {0} 新建文件时加的，没有更早的版本", shortId(b.id)),
                run: () => b.previous && onPrevious(b.previous, b.previousPath ?? f?.path ?? "", b.orig),
              },
              { label: t("在日志里定位 {0}", shortId(b.id)), disabled: !b.inLog, why: t("这个提交不在当前日志里"), run: () => onLocate(b.id) },
              { label: t("复制版本号"), run: () => void navigator.clipboard.writeText(b.id) },
            ]
          : []),
      ],
    });
  };
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
    highlight(textLangOf(f.path), [f.text], !f.truncated).then(([t]) => live && t && setToks({ f, lines: t }));
    return () => {
      live = false;
    };
  }, [f, syntax]);
  const lineToks = syntax && toks?.f === f ? toks.lines : null;
  const guides = useSettings().diffIndent;
  const unit = useMemo(() => indentUnit(lines.slice(0, 4000)), [lines]);
  const get = useMemo(() => (k: number) => (k <= MAX_LINES ? lines[k - 1] : undefined), [lines]);
  const deletedBefore = (line: number) => rollback?.deleted.get(line)?.map((row) => (
    <div key={`deleted:${row.old_no}`} className="tv-line tv-deleted">
      <LineRollbackGutter row={row} controls={rollback} />
      {blame && <span className="ann" />}
      <span className="ln" title={t("已删除的第 {0} 行", row.old_no)}>−{row.old_no}</span>
      <span className="code">{row.old_text}</span>
    </div>
  ));
  return (
    <>
    {f?.text !== undefined && lines.length > 0 && <Crumbs path={f.path} get={get} box={box} layout={[lines]} />}
    <div className="fv-textwrap">
    <FindBar f={finder} host={box} onLine={(n) => goToLine(box.current, n)} />
    <div className="fv-text" ref={box} onContextMenu={onMenu}>
      {load.loading && !f && <p className="pad dim">{t("正在读取…")}</p>}
      {load.error && <p className="pad err">{tr(load.error)}</p>}
      {f?.missing && <p className="pad dim">{t("这个版本里没有这个文件（已删除或还没创建）")}</p>}
      {f?.binary && (
        <p className="pad dim">
          {t("二进制文件，不显示内容（{0} 字节）", f.size)}{" "}
          <button type="button" className="bal-link" onClick={openPluginsWindow}>
            {t("用预览插件查看…")}
          </button>
        </p>
      )}
      {f?.lfs_missing && (
        <div className="fv-lfs">
          <span>{t("这是 Git LFS 文件，内容还没下载（{0}），下面是它的指针。", fmtSize(f.lfs_missing.size))}</span>
          {onLfsPull && (
            <button type="button" className="btn sm" onClick={onLfsPull}>
              {t("下载 LFS 文件")}
            </button>
          )}
        </div>
      )}
      {f?.text !== undefined && (
        <div className={"tv mono" + (load.loading ? " stale" : "") + (blame ? " with-ann" : "") + (rollback ? " with-line-rollback" : "")} style={{ "--lnw": `${String(Math.min(lines.length, MAX_LINES)).length + 2}ch` } as React.CSSProperties}>
          {lines.slice(0, MAX_LINES).flatMap((l, i) => {
            const no = i + 1;
            const row = rollback?.current.get(no);
            return [...(deletedBefore(no) ?? []), (
              <div key={no} data-n={no} className={"tv-line" + (focus === no ? " focus" : "")} onDoubleClick={onEditLine ? () => onEditLine(no) : undefined}>
                {rollback && <LineRollbackGutter row={row?.new_text === l.replace(/\r$/, "") ? row : undefined} controls={rollback} />}
                {blame && ann(no)}
                <span className="ln">{no}</span>
                <span className="code" style={guides ? indentStyle(l, unit) : undefined}>
                  <Found t={l} find={find} toks={lineToks?.[i]} />
                </span>
              </div>
            )];
          })}
          {lines.length <= MAX_LINES && deletedBefore(lines.length + 1)}
          {(lines.length > MAX_LINES || f.truncated) && <p className="pad dim">{t("文件太大，只显示了前面一部分")}</p>}
        </div>
      )}
    </div>
    </div>
    {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
