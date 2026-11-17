// Conflict resolution (spec §8): conflict list + three-pane merge window.
//
// Marks (accept, ignore, hand edit) are kept in the frontend, along with undo and redo; "continue later" saves them to local storage,
// so work can resume after closing and reopening the client. Applying a file hands all its marks to the core layer to build the result.

import { useReturnFocus } from "./focus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import type { Change, ChangeMark, ConflictFile, MergeSession, OpInfo, RepoState, Side, SideChange } from "../api/types";
import { formatTime, shortId } from "./format";
import { Found, Hi } from "./inlineDiff";
import { highlight, langOf, type Tok } from "../highlight";
import { useSettings } from "../settings";
import { ImageDiff, isImage } from "./ImageDiff";
import { t, tr, withNote, lazy } from "../i18n";

type Marks = Record<string, Record<string, ChangeMark>>; // file → change id → mark

const CHANGE_TEXT: Record<SideChange, string> = lazy(() => ({ modified: t("已修改"), deleted: t("已删除"), added: t("已新增"), renamed: t("已重命名") }));
const KIND_TEXT = lazy(() => ({ merge: t("合并"), rebase: t("变基"), cherry_pick: t("拣选"), revert: t("还原"), unstash: t("取回") }));
/** How long to wait after a change is fully marked before jumping to the next (spec §8.6) */
const AUTO_NEXT_MS = 650;

const changesOf = (f: ConflictFile) => f.segments.filter((s): s is Change & { type: "change" } => s.type === "change");
const markOf = (m: Record<string, ChangeMark> | undefined, id: string): ChangeMark => m?.[id] ?? { mine: "none", theirs: "none" };
/** How many blocks in this change are still unmarked */
const leftIn = (c: Change, m: ChangeMark) =>
  m.custom ? 0 : (c.mine && m.mine === "none" ? 1 : 0) + (c.theirs && m.theirs === "none" ? 1 : 0);
const blocksIn = (c: Change) => (c.mine ? 1 : 0) + (c.theirs ? 1 : 0);

/** The result pane's content (table in spec §8.6) */
function resultOf(c: Change, m: ChangeMark): { lines: string[]; note: string | null } {
  if (m.custom) return { lines: m.custom, note: null };
  const left = leftIn(c, m);
  const take: string[] = [];
  if (c.mine && m.mine === "accept") take.push(...c.mine);
  if (c.theirs && m.theirs === "accept") take.push(...c.theirs);
  if (left === 0) return { lines: take.length || (m.mine === "accept" || m.theirs === "accept") ? take : c.base, note: null };
  const mineLeft = c.mine && m.mine === "none";
  const theirsLeft = c.theirs && m.theirs === "none";
  const note = mineLeft && theirsLeft ? t("待处理：两边的修改块都要接受或舍弃") : mineLeft ? t("左边的修改块还没标记") : t("右边的修改块还没标记");
  return { lines: take, note };
}

interface Props {
  session: MergeSession;
  repo: RepoState;
  /** The operation finished (the whole merge ended), with the latest state and a notice */
  onDone: (state: RepoState, message: string, op?: OpInfo) => void;
  /** The repository state changed but didn't end (a file was applied, the rebase moved to the next commit); re-read the session */
  onChanged: (state: RepoState) => void;
  onLater: () => void;
  onAbort: () => void;
  onError: (message: string) => void;
  /** How many remain (unmarked blocks plus files that can only be taken whole), shown in the toolbar (spec §3.3) */
  onProgress?: (left: number) => void;
  /** A command from the command palette (spec §12.1): back to the conflict list, accept all non-conflicting blocks; n differs every time */
  command?: { kind: "list" | "auto"; n: number } | null;
}

export function ConflictView({ session, repo, onDone, onChanged, onLater, onAbort, onError, onProgress, command }: Props) {
  // Marks are saved per "this operation": when the commits on either side change (e.g. the rebase moved to the next commit), it's a new round
  const key = `strand.marks:${repo.path}:${session.kind}:${session.mine.commit ?? ""}:${session.theirs.commit ?? ""}`;
  const saved = session.saved_marks?.[key];
  const [marks, setMarks] = useState<Marks>(() => load(key, saved));
  const [undo, setUndo] = useState<Marks[]>([]);
  const [redo, setRedo] = useState<Marks[]>([]);
  const [resolved, setResolved] = useState<string[]>(() => loadResolved(key, saved));
  const [open, setOpen] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Binary files with the image preview expanded */
  const [preview, setPreview] = useState<Set<string>>(new Set());

  useEffect(() => {
    setMarks(load(key, saved));
    setResolved(loadResolved(key, saved));
    setUndo([]);
    setRedo([]);
    setChecked(false);
  }, [key]);
  useEffect(() => save(key, marks, resolved), [key, marks, resolved]);

  // The core layer also lists resolved files (including those git add-ed on the command line); show them together with the ones recorded here
  const files = useMemo(() => session.files.filter((f) => !f.resolved), [session.files]);
  const doneFiles = useMemo(() => {
    const byPath = new Map(session.files.filter((f) => f.resolved).map((f) => [f.path, f] as const));
    for (const p of resolved) if (!byPath.has(p) && !files.some((f) => f.path === p)) byPath.set(p, undefined as unknown as ConflictFile);
    return [...byPath.entries()].map(([path, f]) => ({ path, f }));
  }, [session.files, resolved, files]);
  const file = files.find((f) => f.path === open) ?? null;
  useEffect(() => {
    if (open && !file) setOpen(null);
  }, [open, file]);

  /** Change a mark: record an undo step */
  const change = useCallback((f: (m: Marks) => Marks) => {
    setMarks((m) => {
      setUndo((u) => [...u.slice(-200), m]);
      setRedo([]);
      return f(m);
    });
  }, []);
  const setMark = (path: string, id: string, patch: Partial<ChangeMark>) =>
    change((m) => ({ ...m, [path]: { ...m[path], [id]: { ...markOf(m[path], id), ...patch } } }));

  // Undoing past the last mark equals aborting (spec §8.7); after aborting, that step can be undone to come back (§8.9)
  const doUndo = () => {
    const prev = undo[undo.length - 1];
    if (!prev) return onAbort();
    setRedo((r) => [...r, marks]);
    setUndo((u) => u.slice(0, -1));
    setMarks(prev);
  };
  const doRedo = () => {
    const next = redo[redo.length - 1];
    if (!next) return;
    setUndo((u) => [...u, marks]);
    setRedo((r) => r.slice(0, -1));
    setMarks(next);
  };

  // Statistics
  const unmarkedIn = (f: ConflictFile) => changesOf(f).reduce((n, c) => n + leftIn(c, markOf(marks[f.path], c.id)), 0);
  const totalBlocks = files.reduce((n, f) => n + changesOf(f).reduce((k, c) => k + blocksIn(c), 0), 0);
  const unmarked = files.reduce((n, f) => n + (f.kind === "text" ? unmarkedIn(f) : 0), 0);
  const allFiles = files.length + doneFiles.length;
  const left = unmarked + files.filter((f) => f.kind !== "text").length;
  useEffect(() => onProgress?.(left), [left, onProgress]);

  /**
   * After a file is handled, its row moves to "resolved" and its buttons disappear, so keyboard users would lose their place (spec §12.4):
   * when focus was in the conflict view (or already fell to the page), move it to the first button of the next unresolved file; when all are done, to "finish"
   */
  const focusNext = () =>
    window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest(".cf-list-wrap, .mw")) return;
      const next = document.querySelector<HTMLButtonElement>(".cf-box .cf-row:not(.cf-th):not(.done) .cf-a button:not(:disabled)");
      const done = document.querySelector<HTMLButtonElement>(".cf-foot button.primary, .cf-foot .ib.lg:last-child");
      (next ?? done)?.focus();
    }, 300);

  /** After a write: finish if the session ended, otherwise let the outside re-read */
  const after = async (p: Promise<{ state: RepoState }>, path?: string) => {
    setBusy(true);
    try {
      const w = await p;
      if (path) setResolved((r) => [...new Set([...r, path])]);
      onChanged(w.state);
      if (path) focusNext();
      return true;
    } catch (e) {
      const err = errOf(e);
      if (err.code === "UNMARKED_BLOCKS") setChecked(true);
      onError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const finish = useCallback(async () => {
    setBusy(true);
    try {
      const w = await api.mergeFinish();
      if (w.result.done) {
        clear(key);
        onDone(w.state, withNote(t("{0}已完成", KIND_TEXT[session.kind]), w.note), w.op);
      } else {
        clear(key);
        onChanged(w.state);
        onError(t("第 {0} 个提交又有冲突，继续处理", (w.result.next?.step?.index ?? 0)));
      }
    } catch (e) {
      const err = errOf(e);
      if (err.code === "UNMARKED_BLOCKS") setChecked(true);
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }, [key, onDone, onChanged, onError, session.kind]);

  // Finish automatically once the last file is resolved here (spec §8.2). Not when the session starts with every
  // file already resolved (by rerere's recorded resolutions, or on the command line): those get checked first.
  const autoFinished = useRef(false);
  const hadOpen = useRef(false);
  useEffect(() => {
    if (files.length > 0) {
      hadOpen.current = true;
      autoFinished.current = false;
    } else if (hadOpen.current && doneFiles.length > 0 && !autoFinished.current && !busy) {
      autoFinished.current = true;
      finish();
    }
  }, [files.length, doneFiles.length, busy, finish]);

  const skip = async () => {
    setBusy(true);
    try {
      const w = await api.mergeSkip();
      clear(key);
      if (w.result.done) onDone(w.state, withNote(t("已跳过这个提交，变基已完成"), w.note), w.op);
      else onChanged(w.state);
    } catch (e) {
      onError(errOf(e).message);
    } finally {
      setBusy(false);
    }
  };

  const take = (f: ConflictFile, side: Side) => after(api.mergeTakeFile(f.path, side), f.path);
  const apply = async (f: ConflictFile) => {
    if (unmarkedIn(f) > 0) {
      setChecked(true);
      return;
    }
    if (await after(api.mergeApplyFile(f.path, marks[f.path] ?? {}), f.path)) {
      setOpen(null);
      setChecked(false);
    }
  };
  /** Accept all non-conflicting blocks (spec §8.7), across all files */
  const acceptNonConflicting = () => {
    let n = 0;
    const next: Marks = { ...marks };
    for (const f of files) {
      for (const c of changesOf(f)) {
        const m = markOf(next[f.path], c.id);
        if (m.custom || (c.mine && c.theirs)) continue;
        if (c.mine && m.mine === "none") (n++, (next[f.path] = { ...next[f.path], [c.id]: { ...m, mine: "accept" } }));
        if (c.theirs && m.theirs === "none") (n++, (next[f.path] = { ...next[f.path], [c.id]: { ...m, theirs: "accept" } }));
      }
    }
    if (n === 0) return onError(t("没有可以自动接受的修改块"));
    change(() => next);
  };

  // Command palette commands: back to the conflict list / accept all non-conflicting blocks
  const lastCmd = useRef(0);
  useEffect(() => {
    if (!command || command.n === lastCmd.current) return;
    lastCmd.current = command.n;
    if (command.kind === "list") setOpen(null);
    else acceptNonConflicting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);
  /** Take one side for the whole file (in the merge window): accept the chosen side, ignore the other, overriding existing marks */
  const wholeFile = (f: ConflictFile, side: Side) =>
    change((m) => {
      const fm: Record<string, ChangeMark> = {};
      for (const c of changesOf(f))
        fm[c.id] = { mine: side === "mine" ? "accept" : "discard", theirs: side === "theirs" ? "accept" : "discard" };
      return { ...m, [f.path]: fm };
    });

  const sideLabel = (s: Side) => (s === "mine" ? session.mine : session.theirs);
  const header = (
    <div className="cf-head">
      <h1>{t("冲突")}</h1>
      <p className="dim">
        {t("{0}时有 {1} 个文件两边都改了。", KIND_TEXT[session.kind], allFiles)} {t("“你的”是")} <b className="mine-ink">{tr(session.mine.label)}</b>
        {t("，“对方的”是")} <b className="theirs-ink">{tr(session.theirs.label)}</b>
        {t("。可以整个文件接受一边，或者打开合并窗口逐块处理。")}
      </p>
      {session.step && (
        <span className="pill">
          {t("变基 · 第 {0} / {1} 个提交", session.step.index, session.step.total)}
          {session.mine.commit && <span className="mono"> · {shortId(session.mine.commit)}</span>}
          {session.mine.title && <span> · {session.mine.title}</span>}
        </span>
      )}
    </div>
  );

  if (file) {
    return (
      <MergeWindow
        file={file}
        session={session}
        marks={marks[file.path] ?? {}}
        checked={checked}
        busy={busy}
        undoTip={undo.length > 0 ? t("撤销上一次标记（⌘Z）") : t("没有可以撤销的标记，再撤销就中止{0}（⌘Z）", KIND_TEXT[session.kind])}
        canRedo={redo.length > 0}
        onMark={(id, patch) => setMark(file.path, id, patch)}
        onWhole={(side) => wholeFile(file, side)}
        onAuto={acceptNonConflicting}
        onUndo={doUndo}
        onRedo={doRedo}
        onBack={() => {
          setOpen(null);
          setChecked(false);
        }}
        onApply={() => apply(file)}
        sideLabel={sideLabel}
      />
    );
  }

  return (
    <div className="cf-list-wrap">
      <div className="cf-box">
        {header}
        <div className="cf-row cf-th">
          <span className="grow">{t("文件")}</span>
          <span className="cf-c">{t("你的")}</span>
          <span className="cf-c">{t("对方的")}</span>
          <span className="cf-s">{t("状态")}</span>
          <span className="cf-a" />
        </div>
        {files.map((f) => {
          const n = changesOf(f).filter((c) => leftIn(c, markOf(marks[f.path], c.id)) > 0).length;
          const whole = f.kind !== "text";
          const tipMine =
            f.kind === "rename"
              ? t("接受你的：用你的文件名 {0}", f.mine_path ?? "")
              : f.kind === "modify_delete"
                ? f.mine_change === "deleted" ? t("接受你的：删除这个文件") : t("接受你的：保留你改过的文件")
                : t("整个文件接受你的");
          const tipTheirs =
            f.kind === "rename"
              ? t("接受对方的：用对方的文件名 {0}", f.theirs_path ?? "")
              : f.kind === "modify_delete"
                ? f.theirs_change === "deleted" ? t("接受对方的：删除这个文件") : t("接受对方的：保留对方改过的文件")
                : t("整个文件接受对方的");
          return (
            <div key={f.path} className="cf-row">
              <span className="grow mono cf-path">{f.path}</span>
              <span className="cf-c">{CHANGE_TEXT[f.mine_change]}</span>
              <span className="cf-c">{CHANGE_TEXT[f.theirs_change]}</span>
              <span className="cf-s">
                <span className="tag2">{whole ? t("待选择") : n > 0 ? t("{0} 处待处理", n) : t("可以应用")}</span>
              </span>
              <span className="cf-a">
                <button type="button" className="ib acc" title={tipMine} aria-label={tipMine} disabled={busy} onClick={() => take(f, "mine")}>
                  ⇥
                </button>
                <button type="button" className="ib acc" title={tipTheirs} aria-label={tipTheirs} disabled={busy} onClick={() => take(f, "theirs")}>
                  ⇤
                </button>
                {f.kind === "binary" && isImage(f.path) ? (
                  <button
                    type="button"
                    className={"ib" + (preview.has(f.path) ? " pressed" : "")}
                    aria-pressed={preview.has(f.path)}
                    title={t("看看两边的图片")}
                    aria-label={t("预览 {0} 两边的图片", f.path)}
                    onClick={() =>
                      setPreview((p) => {
                        const n = new Set(p);
                        if (n.has(f.path)) n.delete(f.path);
                        else n.add(f.path);
                        return n;
                      })
                    }
                  >
                    ◧
                  </button>
                ) : whole ? (
                  <span className="ib-gap" />
                ) : (
                  <button type="button" className="ib" title={t("打开合并窗口，逐块处理")} aria-label={t("打开合并窗口")} onClick={() => setOpen(f.path)}>
                    ⧉
                  </button>
                )}
              </span>
              {f.kind === "lock" && <span className="cf-note dim">{t("锁文件：建议用对方的，完成合并后重新生成")}</span>}
              {f.kind === "binary" && !isImage(f.path) && <span className="cf-note dim">{t("二进制文件，只能整个选一边")}</span>}
              {f.kind === "binary" && isImage(f.path) && !preview.has(f.path) && <span className="cf-note dim">{t("图片只能整个选一边，点 ◧ 先看看两边")}</span>}
              {f.kind === "binary" && isImage(f.path) && preview.has(f.path) && (
                <div className="cf-preview">
                  <ImageDiff
                    // During a rebase "yours" is git's theirs (index stage 3)
                    left={{ path: f.path, rev: session.kind === "rebase" ? ":3" : ":2" }}
                    right={{ path: f.path, rev: session.kind === "rebase" ? ":2" : ":3" }}
                    names={{ left: t("你的"), right: t("对方的"), leftNone: t("你这边删掉了"), rightNone: t("对方删掉了") }}
                  />
                </div>
              )}
              {f.kind === "rename" && (
                <span className="cf-note dim">
                  {t("两边改成了不同的名字：你的是 {0}，对方的是 {1}", f.mine_path ?? "", f.theirs_path ?? "")}
                </span>
              )}
            </div>
          );
        })}
        {doneFiles.map(({ path: p, f }) => (
          <div key={p} className="cf-row done">
            <span className="grow mono cf-path">{p}</span>
            <span className="cf-c">{f ? CHANGE_TEXT[f.mine_change] : ""}</span>
            <span className="cf-c">{f ? CHANGE_TEXT[f.theirs_change] : ""}</span>
            <span className="cf-s">
              <span className="tag2 ok">{t("已解决")}</span>
            </span>
            <span className="cf-a" />
          </div>
        ))}
        {files.length === 0 && doneFiles.length > 0 && !hadOpen.current && (
          <p className="pad small cf-prefilled">{t("这些文件已经解决了（比如按记住的解决方法自动改好的），检查一下，没问题就点“完成”。")}</p>
        )}
        {files.length === 0 && doneFiles.length === 0 && <p className="pad dim">{t("冲突都已经解决了，点“完成”结束这次{0}。", KIND_TEXT[session.kind])}</p>}
        <div className="cf-foot">
          {checked && files.length > 0 ? (
            <span className="grow err">
              {t("还有 {0} 个文件没有解决", files.length)}{unmarked ? t("（其中 {0} 个修改块没有标记）", unmarked) : ""}{t("，不能完成。每个修改块都要接受或舍弃。")}
            </span>
          ) : (
            <span className="grow dim">
              {t("已解决 {0} / {1} 个文件 · 已标记 {2} / {3} 个修改块", doneFiles.length, allFiles, totalBlocks - unmarked, totalBlocks)}
            </span>
          )}
          {session.kind === "rebase" && (
            <button type="button" className="ib lg" title={t("跳过这个提交：不把它带到新的历史里")} aria-label={t("跳过这个提交")} disabled={busy} onClick={skip}>
              ⤼
            </button>
          )}
          <button type="button" className="ib lg" title={t("稍后继续：先回到主界面，已标记的结果会保留")} aria-label={t("稍后继续")} onClick={onLater}>
            ⏸
          </button>
          <button type="button" className="ib lg danger-text" title={t("中止{0}，回到开始之前", KIND_TEXT[session.kind])} aria-label={t("中止")} disabled={busy} onClick={onAbort}>
            ⏹
          </button>
          <button
            type="button"
            className="btn primary ib lg"
            title={t("完成{0}", KIND_TEXT[session.kind])}
            aria-label={t("完成{0}", KIND_TEXT[session.kind])}
            disabled={busy}
            onClick={() => (files.length ? setChecked(true) : finish())}
          >
            ✓
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Merge window (spec §8.4–8.7) ----------

const ROW_H = 22;

interface WinProps {
  file: ConflictFile;
  session: MergeSession;
  marks: Record<string, ChangeMark>;
  checked: boolean;
  busy: boolean;
  undoTip: string;
  canRedo: boolean;
  onMark: (id: string, patch: Partial<ChangeMark>) => void;
  onWhole: (side: Side) => void;
  onAuto: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
  onApply: () => void;
  sideLabel: (s: Side) => MergeSession["mine"];
}

type MwView = "three" | "sides" | "result";
const VIEW_KEY = "strand.mergeView";
/** View switch buttons: the vertical lines in the icon show how many panes */
const VIEWS: { id: MwView; label: string; lines: number[] }[] = [
  { id: "three", label: "三栏：你的、结果、对方的", lines: [5.5, 10.5] },
  { id: "sides", label: "只看两边对比（隐藏结果栏）", lines: [8] },
  { id: "result", label: "只看结果", lines: [] },
];

function MergeWindow(p: WinProps) {
  const { file, marks, checked } = p;
  const changes = useMemo(() => changesOf(file), [file]);
  // Syntax highlighting: each pane is joined into one text in display order (yours, result, theirs), colored on a background thread and matched by each pane's line numbers; the result pane follows the marks
  const syntax = useSettings().diffSyntax;
  const cols = useMemo(() => {
    const A: string[] = [], B: string[] = [], C: string[] = [];
    for (const seg of file.segments) {
      if (seg.type === "context") {
        for (const x of seg.lines) A.push(x), B.push(x), C.push(x);
        continue;
      }
      const ch = seg as Change;
      A.push(...(ch.mine ?? ch.base));
      B.push(...(ch.theirs ?? ch.base));
      C.push(...resultOf(ch, markOf(marks, ch.id)).lines);
    }
    return [A.join("\n"), C.join("\n"), B.join("\n")];
  }, [file, marks]);
  const [tk, setTk] = useState<{ cols: string[]; a: Tok[][]; c: Tok[][]; b: Tok[][] } | null>(null);
  useEffect(() => {
    if (!syntax) return;
    let live = true;
    highlight(langOf(file.path), cols).then(([a, c, b]) => live && a && b && c && setTk({ cols, a, c, b }));
    return () => {
      live = false;
    };
  }, [cols, syntax, file.path]);
  const tks = syntax && tk ? tk : null;
  const [cur, setCur] = useState(0);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  useReturnFocus(!!edit);
  // View (spec §8.4): three panes, both sides only (result hidden), result only; remembered on this machine
  const [view, setViewState] = useState<MwView>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "sides" || v === "result" ? v : "three";
    } catch {
      return "three";
    }
  });
  const setView = (v: MwView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* Only for this session */
    }
  };
  const scroller = useRef<HTMLDivElement>(null);
  const jumpTimer = useRef<number>(0);
  // Focus the merge window when it opens (spec §12.4): the first button of the current change, otherwise the first button of the top tool row
  useEffect(() => {
    const t0 = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.closest(".mw")) return;
      const first =
        document.querySelector<HTMLButtonElement>(".mw .chead.cur button:not(:disabled)") ??
        document.querySelector<HTMLButtonElement>(".mw .mw-bar button:not(:disabled)");
      first?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  // After marking, that button disappears and focus would fall to the page: move it to the remaining buttons of this change; once it's fully marked and auto-jumps, to the next change's buttons
  useEffect(() => {
    const t0 = window.setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const next =
        document.querySelector<HTMLButtonElement>(".mw .chead.cur .m button, .mw .chead.cur .t button") ??
        document.querySelector<HTMLButtonElement>(".mw .chead .m button, .mw .chead .t button") ??
        document.querySelector<HTMLButtonElement>(".mw button[aria-label='" + t("应用") + "']");
      next?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t0);
  }, [marks, cur]);

  const left = changes.reduce((n, c) => n + leftIn(c, markOf(marks, c.id)), 0);
  const total = changes.reduce((n, c) => n + blocksIn(c), 0);

  const goTo = useCallback((i: number) => {
    const n = changes.length;
    if (!n) return;
    const k = ((i % n) + n) % n;
    setCur(k);
    scroller.current?.querySelector(`[data-change="${changes[k].id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [changes]);

  // After a change is fully marked, jump to the next unhandled one after 650 ms; cancelled by any other action meanwhile
  const prevLeft = useRef<Record<string, number>>({});
  useEffect(() => {
    const now: Record<string, number> = {};
    for (const c of changes) now[c.id] = leftIn(c, markOf(marks, c.id));
    const justDone = changes.findIndex((c) => (prevLeft.current[c.id] ?? 0) > 0 && now[c.id] === 0);
    prevLeft.current = now;
    window.clearTimeout(jumpTimer.current);
    if (justDone < 0) return;
    const next = changes.findIndex((c, i) => i > justDone && now[c.id] > 0);
    const target = next >= 0 ? next : changes.findIndex((c) => now[c.id] > 0);
    if (target >= 0) jumpTimer.current = window.setTimeout(() => goTo(target), AUTO_NEXT_MS);
  }, [marks, changes, goTo]);
  useEffect(() => {
    const cancel = () => window.clearTimeout(jumpTimer.current);
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, []);

  // ⌥↑ / ⌥↓ previous and next change; ⌘Z / ⇧⌘Z undo and redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (edit || (e.target instanceof HTMLElement && e.target.closest("textarea, input"))) return;
      if (e.altKey && e.key === "ArrowDown") (e.preventDefault(), goTo(cur + 1));
      else if (e.altKey && e.key === "ArrowUp") (e.preventDefault(), goTo(cur - 1));
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") (e.preventDefault(), e.shiftKey ? p.onRedo() : p.onUndo());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, goTo, edit, p]);

  // After a failed validation, jump to the first unmarked change
  useEffect(() => {
    if (!checked) return;
    const i = changes.findIndex((c) => leftIn(c, markOf(marks, c.id)) > 0);
    if (i >= 0) goTo(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  // Build the rows of the three panes
  const rows: React.ReactNode[] = [];
  const railMarks: { top: number; done: boolean; i: number }[] = [];
  let a = 0, b = 0, c = 0, y = 0, k = 0;
  for (const seg of file.segments) {
    if (seg.type === "context") {
      for (const t of seg.lines) {
        a++, b++, c++, (y += ROW_H);
        rows.push(
          <div className="tri-ln" key={`x${y}`}>
            <span className="n">{a}</span>
            <span className="t">
              <Found t={t} toks={tks?.a[a - 1]} />
            </span>
            <span className="n bl">{c}</span>
            <span className="t">
              <Found t={t} toks={tks?.c[c - 1]} />
            </span>
            <span className="n bl">{b}</span>
            <span className="t">
              <Found t={t} toks={tks?.b[b - 1]} />
            </span>
          </div>,
        );
      }
      continue;
    }
    const ch = seg as Change;
    const idx = k++;
    const m = markOf(marks, ch.id);
    const doneM = !ch.mine || m.mine !== "none" || !!m.custom;
    const doneT = !ch.theirs || m.theirs !== "none" || !!m.custom;
    const done = doneM && doneT;
    const isCur = idx === cur;
    const conflict = !!(ch.mine && ch.theirs);
    const mineLines = ch.mine ?? ch.base;
    const theirsLines = ch.theirs ?? ch.base;
    const need = checked && !done;
    railMarks.push({ top: y, done, i: idx });
    if (!done) {
      y += 36;
      const leftCount = leftIn(ch, m);
      const sideBar = (side: Side) => {
        const lines = side === "mine" ? ch.mine : ch.theirs;
        const marked = side === "mine" ? doneM : doneT;
        if (!lines || marked) return <div className={side === "mine" ? "o" : "o bl"} />;
        const info = p.sideLabel(side);
        const acc = (
          <button type="button" className="ib acc" title={t("接受{0}这个修改块", side === "mine" ? t("你的") : t("对方的"))} aria-label={t("接受{0}修改块", side === "mine" ? t("你的") : t("对方的"))} onClick={() => p.onMark(ch.id, { [side]: "accept" })}>
            {side === "mine" ? "»" : "«"}
          </button>
        );
        const x = (
          <button type="button" className="ib x" title={t("舍弃{0}这个修改块", side === "mine" ? t("你的") : t("对方的"))} aria-label={t("舍弃{0}修改块", side === "mine" ? t("你的") : t("对方的"))} onClick={() => p.onMark(ch.id, { [side]: "discard" })}>
            ✕
          </button>
        );
        // The commit that introduced this block (spec §8.5); this side's commit when not found
        const origin = side === "mine" ? ch.mine_origin : ch.theirs_origin;
        const label = (
          <span
            className="grow ell"
            title={origin ? `${shortId(origin.commit)} · ${origin.title}\n${origin.author} · ${formatTime(origin.time)}` : undefined}
          >
            <b>{t("修改块 · {0} 行", lines.length)}</b>
            {origin ? (
              <span className="dim">
                {" · "}
                <span className="mono">{shortId(origin.commit)}</span> {origin.author} · {origin.title}
              </span>
            ) : (
              info.commit && <span className="mono dim"> · {shortId(info.commit)}</span>
            )}
          </span>
        );
        return (
          <div className={(side === "mine" ? "m" : "t bl") + (need ? " need" : "")}>
            {side === "mine" ? (
              <>
                {label}
                {acc}
                {x}
              </>
            ) : (
              <>
                {x}
                {acc}
                {label}
              </>
            )}
          </div>
        );
      };
      rows.push(
        <div className={"tri chead" + (isCur ? " cur" : "")} key={`h${ch.id}`} data-change={ch.id} onClick={() => setCur(idx)}>
          {sideBar("mine")}
          <div className="c bl">
            <b>
              {conflict ? t("冲突") : t("修改")} {idx + 1}
            </b>
            <span className="tag2">{conflict ? t("还有 {0} 块没标记", leftCount) : t("没有冲突，还没标记")}</span>
            <span className="grow" />
            <button
              type="button"
              className="ib"
              title={t("手动编辑这一处的结果")}
              aria-label={t("手动编辑")}
              onClick={() => {
                const r = resultOf(ch, m);
                setEdit({ id: ch.id, text: (r.lines.length ? r.lines : ch.base).join("\n") });
              }}
            >
              ✎
            </button>
          </div>
          {sideBar("theirs")}
        </div>,
      );
    } else {
      rows.push(<div key={`h${ch.id}`} data-change={ch.id} className="anchor" />);
    }
    const res = resultOf(ch, m);
    const n = Math.max(mineLines.length, theirsLines.length, res.lines.length + (res.note ? 1 : 0));
    const pair = conflict && mineLines.length === theirsLines.length && !doneM && !doneT;
    for (let i = 0; i < n; i++) {
      const mt = mineLines[i], tt = theirsLines[i], r = res.lines[i];
      if (mt !== undefined) a++;
      if (tt !== undefined) b++;
      if (r !== undefined) c++;
      const ac = doneM || !ch.mine ? "" : mt === undefined ? "a-gap" : "a-on" + (i === mineLines.length - 1 ? " last" : "");
      const bc = doneT || !ch.theirs ? "" : tt === undefined ? "b-gap" : "b-on" + (i === theirsLines.length - 1 ? " last" : "");
      const isNote = res.note && i === res.lines.length;
      const cc = r !== undefined ? "" : isNote ? "c-pend" : done ? "" : "c-gap";
      y += ROW_H;
      rows.push(
        <div className="tri-ln" key={`${ch.id}-${i}`}>
          <span className={"n " + ac}>{mt === undefined ? "" : a}</span>
          <span className={"t " + ac}>{mt === undefined ? "" : <Hi t={mt} other={pair ? tt : undefined} toks={tks?.a[a - 1]} />}</span>
          <span className={"n bl " + cc}>{r !== undefined ? c : ""}</span>
          <span className={"t " + cc}>{r !== undefined ? <Found t={r} toks={tks?.c[c - 1]} /> : isNote ? res.note : ""}</span>
          <span className={"n bl " + bc}>{tt === undefined ? "" : b}</span>
          <span className={"t " + bc}>{tt === undefined ? "" : <Hi t={tt} other={pair ? mt : undefined} toks={tks?.b[b - 1]} />}</span>
        </div>,
      );
    }
  }
  const totalH = Math.max(y, 600);
  const mine = p.sideLabel("mine");
  const theirs = p.sideLabel("theirs");

  return (
    <div className={"mw" + (view === "three" ? "" : " view-" + view)}>
      <div className="mw-bar">
        <span className="mono mw-path">{file.path}</span>
        <button type="button" className="ib acc" title={t("整个文件都接受你的，舍弃对方的")} aria-label={t("整个文件接受你的")} onClick={() => p.onWhole("mine")}>
          ⇥
        </button>
        <button type="button" className="ib acc" title={t("整个文件都接受对方的，舍弃你的")} aria-label={t("整个文件接受对方的")} onClick={() => p.onWhole("theirs")}>
          ⇤
        </button>
        <button type="button" className="ib acc" title={t("接受所有没有冲突的修改块（所有文件）")} aria-label={t("接受所有没有冲突的修改块")} onClick={p.onAuto}>
          ✦
        </button>
        <span className="seg mw-view" role="radiogroup" aria-label={t("视图")}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="radio" aria-checked={view === v.id} className={view === v.id ? "on" : ""} title={t(v.label)} aria-label={t(v.label)} onClick={() => setView(v.id)}>
              <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <rect x="0.65" y="0.65" width="14.7" height="10.7" rx="1.5" />
                {v.lines.map((x) => (
                  <path key={x} d={`M${x} 1v10`} />
                ))}
              </svg>
            </button>
          ))}
        </span>
        <span className="grow" />
        <button type="button" className="ib" title={p.undoTip} aria-label={t("撤销")} disabled={p.busy} onClick={p.onUndo}>
          ↶
        </button>
        <button type="button" className="ib" title={t("重做（⇧⌘Z）")} aria-label={t("重做")} disabled={!p.canRedo} onClick={p.onRedo}>
          ↷
        </button>
        <button type="button" className="ib" title={t("上一处（⌥↑）")} aria-label={t("上一处")} onClick={() => goTo(cur - 1)}>
          ↑
        </button>
        <b className="mw-count">
          {t("第 {0} / {1} 处", changes.length ? cur + 1 : 0, changes.length)}
        </b>
        <button type="button" className="ib" title={t("下一处（⌥↓）")} aria-label={t("下一处")} onClick={() => goTo(cur + 1)}>
          ↓
        </button>
        <span className="legend">
          <span><i className="lg-mine" />{t("你改的")}</span>
          <span><i className="lg-theirs" />{t("对方改的")}</span>
          <span><i className="lg-pend" />{t("没标记")}</span>
        </span>
      </div>
      <div className="mw-body">
        <div className="mw-scroll" ref={scroller}>
          <div className="mw-inner">
            <div className="tri colhead">
              <div className="m">
                <b className="mine-ink">{t("你的")}</b>
                <span className="mono ell">{tr(mine.label)}</span>
                {mine.commit && <span className="dim ell small">{shortId(mine.commit)} · {mine.title}</span>}
              </div>
              <div className="c bl">
                <b>{t("结果预览")}</b>
                <span className="dim ell small">{t("应用后写入这个文件")}</span>
              </div>
              <div className="t bl">
                <b className="theirs-ink">{t("对方的")}</b>
                <span className="mono ell">{tr(theirs.label)}</span>
                {theirs.commit && <span className="dim ell small">{shortId(theirs.commit)} · {theirs.title}</span>}
              </div>
            </div>
            {rows}
          </div>
        </div>
        <div className="rail" aria-label={t("修改位置")}>
          {railMarks.map((r) => (
            <button
              type="button"
              key={r.i}
              className={(r.done ? "ok" : "") + (r.i === cur ? " cur" : "")}
              style={{ top: `${((r.top / totalH) * 100).toFixed(1)}%` }}
              title={t("跳到第 {0} 处", r.i + 1)}
              aria-label={t("跳到第 {0} 处", r.i + 1)}
              onClick={() => goTo(r.i)}
            />
          ))}
        </div>
      </div>
      <div className="mw-foot">
        {checked && left > 0 ? (
          <span className="err grow">{t("这个文件还有 {0} 个修改块没有标记，不能应用。每个修改块都要接受或舍弃。", left)}</span>
        ) : (
          <span className="dim grow">
            {t("这个文件已标记 {0} / {1} 个修改块", total - left, total)}
          </span>
        )}
        <button type="button" className="ib lg" title={t("返回冲突列表，已标记的结果会保留")} aria-label={t("返回冲突列表")} onClick={p.onBack}>
          ✕
        </button>
        <button type="button" className="btn primary ib lg" title={t("应用：这个文件处理完了")} aria-label={t("应用")} disabled={p.busy} onClick={p.onApply}>
          ✓
        </button>
      </div>
      {edit && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setEdit(null)}>
          <div className="modal wide" role="dialog" aria-label={t("手动编辑")} onKeyDown={(e) => e.key === "Escape" && setEdit(null)}>
            <h2>{t("手动编辑这一处的结果")}</h2>
            <p className="modal-msg">{t("保存后这一处视为已处理，两边的修改块都不再需要标记。")}</p>
            <textarea className="mono edit-area" autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={12} />
            <div className="modal-btns">
              <button type="button" className="btn" onClick={() => setEdit(null)}>
                {t("取消")}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  p.onMark(edit.id, { custom: edit.text === "" ? [] : edit.text.split("\n") });
                  setEdit(null);
                }}
              >
                {t("保存")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Local saving (continue later) ----------

/** One locally saved item; when absent locally, use what the core layer returned after undoing "abort merge" */
function stored(key: string, saved: unknown): { marks?: Marks; resolved?: string[] } {
  try {
    const local = localStorage.getItem(key);
    if (local) return JSON.parse(local) ?? {};
  } catch {
    /* Unreadable: use the core layer's */
  }
  return saved && typeof saved === "object" ? (saved as { marks?: Marks; resolved?: string[] }) : {};
}
function load(key: string, saved?: unknown): Marks {
  return stored(key, saved).marks ?? {};
}
function loadResolved(key: string, saved?: unknown): string[] {
  return stored(key, saved).resolved ?? [];
}

const prefixOf = (repoPath: string) => `strand.marks:${repoPath}:`;

/** This repository's locally saved conflict marks (handed to the core layer on abort, spec §8.9) */
export function marksOf(repoPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefixOf(repoPath))) out[k] = JSON.parse(localStorage.getItem(k) ?? "null");
    }
  } catch {
    /* Unreadable: go without marks */
  }
  return out;
}

/** Clear local marks after aborting */
export function dropMarks(repoPath: string) {
  for (const k of Object.keys(marksOf(repoPath))) clear(k);
}

function save(key: string, marks: Marks, resolved: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify({ marks, resolved }));
  } catch {
    /* Can't save: valid for this session only */
  }
}
function clear(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Ignore */
  }
}
