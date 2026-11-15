// Commit panel (spec §4): change list, checking, commit message, commit.
//
// Implemented: file checks (new changes are checked by default), select all, untracked file list, commit message and title length, commit (⌘↵).
// Shelve to the shelf (checked files, asking for a name or shelving directly) and stash (all changes) are in the button row and on the "Changes" node (spec §4.7, §4.9).
// Line checks happen in the diff tab; checkboxes here are tri-state (all, partial, none), and clicking partial selects all (spec §4.3).
// Hovering a file row shows a discard icon; untracked files have add to version control, add to ignore rules, and delete icons.
// The top row of tool icons (spec §4.7): refresh, roll back, view diff, shelve directly, create patch, group by directory, expand or collapse "Changes".
// Commit options (spec §4.6): format before committing, run checks before committing (commands stored in the repository's Git config), sign-off. Committing formats first, then checks;
// on failure an issue list is shown and the user chooses to commit anyway or cancel; clicking the commit button while running cancels.
// Message history: the last 10 recorded on this machine plus messages you wrote in this repository (found by the email in Git config), searchable.
// Commit message template (Git's commit.template): filled in when the message box is empty; can't commit it unchanged.
// Author options: commit as another author, add co-authors (written as Co-authored-by lines).
// Changelists (like JetBrains changelists): group changes; new changes go into the "active" list; with only one list it looks as before with just "Changes".

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api/commands";
import type { Changelists, CheckRun, ChecksInfo, CommitCreated, ComposeInfo, OpInfo, RangeCommit, RepoState, Selection, WorktreeStatus } from "../api/types";
import { Menu, type MenuState } from "./Menu";
import { AuthorOptions, coAuthorsOf, identOk } from "./compose";
import { FileRow, FileTree, StatusBadge, treeOrder } from "./FileRow";
import { setSettings, settings, useSettings } from "../settings";
import { t, tr } from "../i18n";
import { ChecksOptions, ChecksReport } from "./checks";

interface Props {
  /** Current repository path (message history is kept per repository) */
  repoPath: string;
  /** After amending an earlier commit (Fixup / Squash Into): refresh and notify */
  onWritten: (state: RepoState, message: string, op?: OpInfo) => void;
  status: WorktreeStatus | null;
  disabled: boolean;
  activePath: string | null;
  onOpenDiff: (path: string) => void;
  /** push true means "commit and push" was clicked */
  onCommitted: (r: CommitCreated, files: number, push: boolean, amend?: boolean) => void;
  /** Shelve the checked files; askName false shelves directly (auto-named) */
  onShelve: (paths: string[], askName: boolean) => void;
  /** Stash all changes */
  onStash: () => void;
  /** Create a patch for the checked files */
  onPatch: (sel: Selection) => void;
  /** Apply a patch (opens the dialog) */
  onApplyPatch: () => void;
  /** Report check changes to the outside (for Fixup / Squash Into) */
  onPickedChange: (sel: Selection) => void;
  /** Line checks: path → unchecked lines and all changed lines (keys are "block:line") */
  lineSel: Record<string, { excluded: string[]; all: string[] }>;
  onClearLines: (path: string) => void;
  /** Discard these files' changes (confirms first) */
  onDiscard: (paths: string[]) => void;
  onUntracked: (kind: "add" | "ignore" | "delete", path: string) => void;
  /** Blame a file in the worktree */
  onBlame: (path: string) => void;
  /** File context menu (spec §12.2) */
  onFileMenu: (path: string, x: number, y: number) => void;
  /** Refresh in the tool row: re-read worktree status */
  onRefresh: () => void;
  /** Changes when the settings window closes: re-read the commit identity */
  configKey?: number;
  /** Open the Git settings (no commit identity set) */
  onOpenGitSettings?: () => void;
}

const DISCARD_ICON = "M4.5 2 1.5 5l3 3M1.5 5h7a4 4 0 0 1 0 8H6";
const ADD_ICON = "M7 2.5v9M2.5 7h9";
const IGNORE_ICON = "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M3.1 3.1l7.8 7.8";
const TRASH_ICON = "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.5 8.5h6l.5-8.5";

const BoxIcon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const SHELF_ICON = "M1.5 3.5h11M1.5 7h11M1.5 10.5h11M3 3.5v7M11 3.5v7";
const STASH_ICON = "M1.5 4.5h11v3h-11zM2.5 7.5v5h9v-5M5.5 10h3";
const PATCH_ICON = "M3.5 1.5h5l2.5 2.5v8.5h-7.5zM5.5 7h3M5.5 9.5h3";
const APPLY_PATCH_ICON = "M3.5 1.5h5l2.5 2.5v8.5h-7.5zM7 5.5v4.5M5 8l2 2 2-2";
const HISTORY_ICON = "M2.5 7a4.5 4.5 0 1 0 1.3-3.2M2.5 1.5v3h3M7 4.5V7l1.8 1.2";
const GENERATE_ICON = "M7 1.5l1.2 3.3L11.5 6 8.2 7.2 7 10.5 5.8 7.2 2.5 6l3.3-1.2zM11 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z";
const AUTHOR_ICON = "M7 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M2.5 12.5c.4-2.4 2.2-3.8 4.5-3.8s4.1 1.4 4.5 3.8";
const NEW_LIST_ICON = "M1.5 3.5h7M1.5 7h5M1.5 10.5h4M10.5 8v5M8 10.5h5";
const MOVE_ICON = "M1.5 4h7M1.5 7.5h4M8.5 9.5h4.5M11 7.5l2 2-2 2M1.5 11h4";
const ACTIVE_ICON = "M7 1.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L7 9.6l-3.3 1.9.8-3.7L1.7 5.3l3.7-.4z";
const RENAME_ICON = "M9.5 2.5l2 2-6.5 6.5H3V9zM8 4l2 2";
const OPTIONS_ICON = "M2 3.5h6M11 3.5h1M2 7h1M6 7h6M2 10.5h5M10 10.5h2M9.5 2v3M4.5 5.5v3M8.5 9v3";
const REFRESH_ICON = "M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3";
const DIFF_ICON = "M3.5 1.5h7v11h-7zM5.5 5h3M7 3.5v3M5.5 9.5h3";
const GROUP_ICON = "M1.5 3h4l1 1.5h6V12h-11zM4 7.5h6M4 9.5h4";
const QUICK_SHELF_ICON = "M1.5 7h11M1.5 10.5h11M3 7v3.5M11 7v3.5M7 1v4M5 3l2 2 2-2";

export function CommitPanel({ repoPath, onWritten, status, disabled, activePath, onOpenDiff, onCommitted, onShelve, onStash, onPatch, onApplyPatch, onPickedChange, lineSel, onClearLines, onDiscard, onUntracked, onBlame, onFileMenu, onRefresh, configKey, onOpenGitSettings }: Props) {
  const groupDir = useSettings().groupByDir;
  // Whether the "Changes" node is expanded or collapsed (spec §4.1)
  const [changesOpen, setChangesOpen] = useState(true);
  // Record "unchecked" paths so new changes are checked automatically
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  // Amend (spec §4.5): targets unpushed commits on the current branch, the last commit by default
  const [amend, setAmend] = useState(false);
  const [targets, setTargets] = useState<RangeCommit[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [histQ, setHistQ] = useState("");
  const [compose, setCompose] = useState<ComposeInfo | null>(null);
  const [author, setAuthor] = useState("");
  const [showAuthor, setShowAuthor] = useState(false);
  const template = compose?.template?.trim() ? compose.template : null;
  useEffect(() => {
    let live = true;
    setCompose(null);
    api.composeInfo().then(
      (c) => {
        if (!live) return;
        setCompose(c);
        if (c.template?.trim()) setMsg((m) => (m.trim() ? m : c.template!));
      },
      () => live && setCompose({ history: [] }),
    );
    return () => {
      live = false;
    };
  }, [repoPath, configKey]);
  /** After committing: the message box goes back to the template and message history is re-read */
  const afterCommit = () => {
    setMsg(template ?? "");
    setAuthor("");
    api.composeInfo().then((c) => setCompose(c), () => {});
  };
  const histAll = () => {
    const seen = new Set<string>();
    return [...readHistory(), ...(compose?.history ?? [])].filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  };
  const histKey = `strand.msgs:${repoPath}`;
  const readHistory = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(histKey) ?? "[]");
    } catch {
      return [];
    }
  };
  /** Message history: last 10, deduplicated, newest first (spec §4.6) */
  const remember = (m: string) => {
    const list = [m, ...readHistory().filter((x) => x !== m)].slice(0, 10);
    try {
      localStorage.setItem(histKey, JSON.stringify(list));
    } catch {
      /* Only for this session */
    }
  };
  useEffect(() => {
    if (!amend) return;
    let live = true;
    setTargets(null);
    api.rebaseRange().then(
      (r) => {
        if (!live) return;
        const list = r.commits.filter((c) => !c.pushed).reverse();
        setTargets(list);
        setTarget(list[0]?.id ?? null);
      },
      () => live && setTargets([]),
    );
    return () => {
      live = false;
    };
  }, [amend, status]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Commit options and pre-commit checks
  const [checks, setChecks] = useState<ChecksInfo | null>(null);
  const [showOpts, setShowOpts] = useState(false);
  /** The running step and its task id (for cancelling) */
  const [phase, setPhase] = useState<{ kind: "format" | "check"; task: string } | null>(null);
  const [report, setReport] = useState<{ run: CheckRun; canCommit: boolean; resolve: (go: boolean) => void } | null>(null);
  /** Commit options being loaded: when committing right after opening a repository, wait for them so checks aren't skipped */
  const checksLoading = useRef<Promise<ChecksInfo | null>>(Promise.resolve(null));
  useEffect(() => {
    let live = true;
    setChecks(null);
    const p = api.checksConfig().catch(() => null);
    checksLoading.current = p;
    p.then((c) => live && setChecks(c));
    return () => {
      live = false;
    };
  }, [repoPath]);
  const input = useRef<HTMLTextAreaElement>(null);

  const changes = status?.changes ?? [];
  const untracked = status?.untracked ?? [];
  // Files whose lines were all unchecked by line checks count as unchecked
  const allOff = (p: string) => !!lineSel[p] && lineSel[p].excluded.length >= lineSel[p].all.length;
  const picked = useMemo(
    () => changes.filter((c) => !unchecked.has(c.path) && !allOff(c.path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, unchecked, lineSel],
  );
  /** The selection sent to the core layer: partially checked files carry the lines to commit */
  const selectionOf = (list: typeof picked): Selection => ({
    files: list.map((c) => {
      const ls = lineSel[c.path];
      if (!ls || ls.excluded.length === 0) return { path: c.path, old_path: c.old_path, whole: true };
      const ex = new Set(ls.excluded);
      return {
        path: c.path,
        whole: false,
        lines: ls.all.filter((k) => !ex.has(k)).map((k) => {
          const [hunk, line] = k.split(":").map(Number);
          return { hunk, line };
        }),
      };
    }),
  });

  // When a file disappears, clear its unchecked record
  useEffect(() => {
    const live = new Set(changes.map((c) => c.path));
    setUnchecked((u) => {
      const n = new Set([...u].filter((p) => live.has(p)));
      return n.size === u.size ? u : n;
    });
  }, [changes]);

  const toggle = (path: string) =>
    setUnchecked((u) => {
      const n = new Set(u);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  /** Checkbox on a directory row: when everything under it is checked, clicking unchecks all; otherwise clicking checks all (same as the "Changes" node) */
  const dirCheck = (items: (typeof changes)[number][]) => {
    const on = items.filter((c) => !unchecked.has(c.path) && !allOff(c.path)).length;
    return (
      <input
        type="checkbox"
        aria-label={t("提交这个目录下的 {0} 个文件", items.length)}
        title={t("勾选或取消这个目录下的全部文件")}
        checked={on === items.length}
        ref={(el) => {
          if (el) el.indeterminate = on > 0 && on < items.length;
        }}
        onChange={() =>
          setUnchecked((u) => {
            const n = new Set(u);
            for (const c of items) {
              if (on === items.length) n.add(c.path);
              else n.delete(c.path);
            }
            return n;
          })
        }
      />
    );
  };

  // When everything is checked, clicking unchecks all; otherwise clicking checks all (spec §4.3)
  const toggleAll = () => setUnchecked(picked.length === changes.length ? new Set(changes.map((c) => c.path)) : new Set());

  // ---------- Changelists ----------
  const [cl, setCl] = useState<Changelists | null>(null);
  /** Collapsed lists */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Naming in progress: id null means new; moving is the files to move in once created */
  const [naming, setNaming] = useState<{ id: string | null; value: string; moving?: string[] } | null>(null);
  const [moveMenu, setMoveMenu] = useState<MenuState | null>(null);
  useEffect(() => {
    let live = true;
    setCl(null);
    api.changelistsGet().then(
      (c) => live && setCl(c),
      () => live && setCl({ lists: [{ id: "default", name: "" }], active: "default", files: {} }),
    );
    return () => {
      live = false;
    };
  }, [repoPath]);
  const multi = !!cl && cl.lists.length > 1;
  const listOf = (path: string) => (cl ? cl.files[path] ?? cl.active : "default");
  const listName = (id: string) => {
    const l = cl?.lists.find((x) => x.id === id);
    return l?.name.trim() || t("改动");
  };
  const saveCl = (next: Changelists) => {
    // Only keep files that still have changes
    const live = new Set(changes.map((c) => c.path));
    const files = Object.fromEntries(Object.entries(next.files).filter(([p]) => live.has(p)));
    const n = { ...next, files };
    setCl(n);
    api.changelistsSet(n).then(setCl, (e) => setError(e instanceof ApiError ? e.message : String(e)));
  };
  const moveTo = (paths: string[], id: string, base = cl) => {
    if (!base) return;
    saveCl({ ...base, files: { ...base.files, ...Object.fromEntries(paths.map((p) => [p, id])) } });
  };
  const finishNaming = () => {
    if (!naming || !cl) return;
    const name = naming.value.trim();
    if (!name && naming.id !== "default") return setNaming(null);
    if (cl.lists.some((l) => l.id !== naming.id && (l.name.trim() || t("改动")).toLowerCase() === (name || t("改动")).toLowerCase())) return setError(t("已经有同名的变更列表"));
    if (naming.id === null) {
      const id = `cl-${Date.now().toString(36)}`;
      const next = { ...cl, lists: [...cl.lists, { id, name }] };
      if (naming.moving?.length) moveTo(naming.moving, id, next);
      else saveCl(next);
    } else {
      saveCl({ ...cl, lists: cl.lists.map((l) => (l.id === naming.id ? { ...l, name } : l)) });
    }
    setNaming(null);
    setError(null);
  };
  /** Set as the active list: new changes go here; only this list's files stay checked */
  const makeActive = (id: string) => {
    if (!cl) return;
    const files = { ...cl.files };
    for (const c of changes) if (!files[c.path]) files[c.path] = cl.active;
    saveCl({ ...cl, files, active: id });
    setUnchecked(new Set(changes.filter((c) => (files[c.path] ?? id) !== id).map((c) => c.path)));
  };
  /** Delete a list: its files go back to the default list */
  const removeList = (id: string) => {
    if (!cl || id === "default") return;
    const files = { ...cl.files };
    for (const c of changes) if ((files[c.path] ?? cl.active) === id) files[c.path] = "default";
    saveCl({ ...cl, files, lists: cl.lists.filter((l) => l.id !== id), active: cl.active === id ? "default" : cl.active });
  };
  const openMove = (paths: string[], el: HTMLElement) => {
    if (!cl) return;
    const r = el.getBoundingClientRect();
    const here = paths.length === 1 ? listOf(paths[0]) : null;
    setMoveMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        { label: paths.length === 1 ? t("移到变更列表") : t("把 {0} 个勾选的文件移到", paths.length), heading: true },
        ...cl.lists.map((l) => ({ label: listName(l.id), checked: here === l.id, disabled: here === l.id, run: () => moveTo(paths, l.id) })),
        "-" as const,
        { label: t("新建变更列表…"), icon: ADD_ICON, run: () => setNaming({ id: null, value: "", moving: paths }) },
      ],
    });
  };
  const nameInput = (
    <input
      className="cl-name-in"
      autoFocus
      value={naming?.value ?? ""}
      placeholder={t("变更列表的名字")}
      aria-label={t("变更列表的名字")}
      spellCheck={false}
      onChange={(e) => naming && setNaming({ ...naming, value: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finishNaming();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setNaming(null);
        }
      }}
      onBlur={finishNaming}
      onClick={(e) => e.preventDefault()}
    />
  );

  const title = msg.split("\n")[0];
  // Renamed files are shelved together with their old paths
  const pickedPaths = picked.flatMap((c) => (c.old_path ? [c.path, c.old_path] : [c.path]));
  const pickedKey = picked.map((c) => c.path).join("\n") + JSON.stringify(lineSel);
  useEffect(() => {
    onPickedChange(selectionOf(picked));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  /** Run one format or check step; on failure show the issue list; returns whether to continue committing */
  const runStep = async (kind: "format" | "check", files: string[], canCommit: boolean): Promise<boolean> => {
    const task = `checks-${Date.now()}`;
    setPhase({ kind, task });
    let run: CheckRun;
    try {
      run = await api.checksRun(task, kind, files);
    } catch (e) {
      if (e instanceof ApiError && e.code === "CANCELLED") return false;
      setError(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setPhase(null);
    }
    if (run.ok && (canCommit || kind === "format")) return true;
    return new Promise<boolean>((resolve) => setReport({ run, canCommit, resolve }));
  };

  /** Pre-commit steps (spec §4.4): per the commit options, format first (only whole-file checked files), then check */
  const preCommit = async (list: typeof picked): Promise<boolean> => {
    const c = checks ?? (await checksLoading.current);
    if (!c) return true;
    const live = list.filter((x) => x.status !== "D");
    if (c.format_on_commit && c.format_command.trim()) {
      const whole = live.filter((x) => !lineSel[x.path] || lineSel[x.path].excluded.length === 0).map((x) => x.path);
      if (whole.length && !(await runStep("format", whole, true))) return false;
    }
    if (c.check_on_commit && c.check_command.trim() && live.length) {
      if (!(await runStep("check", live.map((x) => x.path), true))) return false;
    }
    return true;
  };

  const commit = async (push = false) => {
    if (phase) {
      api.taskCancel(phase.task);
      return;
    }
    if (busy || disabled) return;
    setError(null);
    if (amend) return doAmend();
    if (picked.length === 0) return setError(t("至少勾选一个文件"));
    if (author.trim() && !identOk(author)) return setError(t("作者要写成“名字 <邮箱>”"));
    if (template && msg.trim() === template.trim()) {
      setError(t("说明还是模板原样，先改成这次的说明"));
      input.current?.focus();
      return;
    }
    if (!title.trim()) {
      setError(t("先写一句提交说明"));
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (!(await preCommit(picked))) return;
      const r = await api.commitCreate(msg, selectionOf(picked), settings().signOff, author.trim() || null);
      remember(msg.trim());
      afterCommit();
      onCommitted(r, picked.length, push);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      if (e instanceof ApiError && e.code === "EMPTY_MESSAGE") input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  /** Amend: the last commit uses git commit --amend; earlier commits use Fixup (Squash Into when there's a message) */
  const doAmend = async () => {
    if (!target) return setError(targets && targets.length === 0 ? t("当前分支上没有还没推送的提交，不能修订") : t("正在读取可以修订的提交…"));
    const m = msg.trim() && msg.trim() !== template?.trim() ? msg : null;
    if (author.trim() && !identOk(author)) return setError(t("作者要写成“名字 <邮箱>”"));
    if (picked.length === 0 && !m && !author.trim()) return setError(t("勾选要并入的文件，或者写一段新的说明"));
    setBusy(true);
    try {
      if (picked.length && !(await preCommit(picked))) return;
      if (target === targets?.[0]?.id) {
        const r = await api.commitAmend(m, selectionOf(picked), settings().signOff, author.trim() || null);
        if (m) remember(m.trim());
        afterCommit();
        setAmend(false);
        onCommitted(r, picked.length, false, true);
      } else {
        if (picked.length === 0) {
          setError(t("修订更早的提交时要勾选要并入的文件"));
          return;
        }
        if (author.trim()) {
          setError(t("修订更早的提交时不能换作者"));
          return;
        }
        const w = await api.commitFixup(target, selectionOf(picked), m);
        if (m) remember(m.trim());
        afterCommit();
        setAmend(false);
        onWritten(w.state, t("已把改动并入“{0}”", targets?.find((x) => x.id === target)?.title ?? ""), w.op);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Generate a message (spec §4.6): build a sentence from the checked changes for the user to edit */
  const generate = () => {
    if (picked.length === 0) return setError(t("先勾选文件"));
    const name = (p: string) => p.split("/").pop() ?? p;
    const kind = picked.every((c) => c.status === "A") ? "A" : picked.every((c) => c.status === "D") ? "D" : "M";
    const first = name(picked[0].path);
    const head =
      picked.length === 1
        ? kind === "A" ? t("新增 {0}", first) : kind === "D" ? t("删除 {0}", first) : t("修改 {0}", first)
        : kind === "A" ? t("新增 {0} 等 {1} 个文件", first, picked.length) : kind === "D" ? t("删除 {0} 等 {1} 个文件", first, picked.length) : t("修改 {0} 等 {1} 个文件", first, picked.length);
    const dirs = [...new Set(picked.map((c) => (c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ".")))].slice(0, 4);
    const add = picked.reduce((a, c) => a + c.added, 0);
    const del = picked.reduce((a, c) => a + c.deleted, 0);
    setMsg(`${head}\n\n${t("涉及：{0}", dirs.join(t("、")))}\n+${add} −${del}`);
    setError(null);
    input.current?.focus();
  };

  // After committing all changes the message box disappears: if the message box was just in use (keyboard commit), focus the "no changes" text,
  // so screen readers announce it and Tab continues from there instead of falling back to the top of the page (spec §12.4)
  const cleanNote = useRef<HTMLParagraphElement>(null);
  const composeUsedAt = useRef(0);
  const nothingLeft = !!status && status.changes.length === 0;
  useEffect(() => {
    if (!nothingLeft || Date.now() - composeUsedAt.current > 30_000) return;
    const t0 = window.setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) cleanNote.current?.focus();
    }, 200);
    return () => window.clearTimeout(t0);
  }, [nothingLeft]);

  const optsTitle = (() => {
    const on = [
      checks?.format_on_commit && checks.format_command.trim() ? t("格式化") : null,
      checks?.check_on_commit && checks.check_command.trim() ? t("检查") : null,
    ].filter(Boolean);
    return on.length ? t("提交选项（提交前：{0}）", on.join(t("、"))) : t("提交选项");
  })();

  /** A file row under "Changes"; depth is the level in tree view (only the file name is shown) */
  const changeRow = (c: (typeof changes)[number], depth?: number) => (
              <div
                key={c.path}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onFileMenu(c.path, e.clientX, e.clientY);
                }}
                // When focus is on this row (file button or checkbox), Shift+F10 or the menu key opens the context menu (spec §12.4)
                onKeyDown={(e) => {
                  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    onFileMenu(c.path, r.left + 40, r.bottom);
                  }
                }}
              >
              <FileRow
                depth={depth}
                f={c}
                active={activePath === c.path}
                onOpen={() => onOpenDiff(c.path)}
                lead={
                  <input
                    type="checkbox"
                    aria-label={t("提交 {0}", c.path)}
                    checked={!unchecked.has(c.path) && !allOff(c.path) && !lineSel[c.path]?.excluded.length}
                    ref={(el) => {
                      if (el) el.indeterminate = !unchecked.has(c.path) && !!lineSel[c.path]?.excluded.length && !allOff(c.path);
                    }}
                    title={lineSel[c.path]?.excluded.length ? t("只勾选了部分行，点一下改为整个文件") : undefined}
                    onChange={() => {
                      // Clicking the partial state selects all (spec §4.3)
                      if (lineSel[c.path]?.excluded.length) {
                        onClearLines(c.path);
                        if (unchecked.has(c.path)) toggle(c.path);
                      } else toggle(c.path);
                    }}
                  />
                }
                trail={
                  <span className="frow-acts">
                  {c.status !== "D" && (
                    <button type="button" className="ib sm frow-act" title={t("逐行追溯")} aria-label={t("逐行追溯 {0}", c.path)} onClick={() => onBlame(c.path)}>
                      <BoxIcon d="M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5" />
                    </button>
                  )}
                  {multi && (
                    <button type="button" className="ib sm frow-act" title={t("移到另一个变更列表")} aria-label={t("把 {0} 移到另一个变更列表", c.path)} onClick={(e) => openMove([c.path], e.currentTarget)}>
                      <BoxIcon d={MOVE_ICON} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="ib sm frow-act"
                    title={t("丢弃这个文件的改动")}
                    aria-label={t("丢弃 {0} 的改动", c.path)}
                    disabled={disabled}
                    onClick={() => onDiscard(c.old_path ? [c.path, c.old_path] : [c.path])}
                  >
                    <BoxIcon d={DISCARD_ICON} />
                  </button>
                  </span>
                }
              />
              </div>
  );

  if (!status) return <div className="cp-empty dim">{t("正在读取工作区…")}</div>;

  const allState = picked.length === 0 ? false : picked.length === changes.length ? true : "mixed";

  return (
    <div className="cp">
      {/* Tool icon row (spec §4.1, §4.7): refresh, roll back, view diff, shelve directly, create patch, group by directory, expand or collapse */}
      <div className="cp-tools">
        <button type="button" className="ib sm" title={t("刷新（重新读取工作区）")} aria-label={t("刷新")} onClick={onRefresh}>
          <BoxIcon d={REFRESH_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={picked.length ? t("回滚：丢弃勾选文件的改动") : t("先勾选要回滚的文件")}
          aria-label={t("回滚")}
          disabled={disabled || picked.length === 0}
          onClick={() => onDiscard(pickedPaths)}
        >
          <BoxIcon d={DISCARD_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={changes.length ? t("查看差异（第一个勾选的文件）") : t("没有改动")}
          aria-label={t("查看差异")}
          disabled={changes.length === 0}
          onClick={() => {
            // Take the first in the order shown in the list (directories are sorted in tree view)
            const list = picked.length ? picked : changes;
            const first = groupDir ? treeOrder(list, (c) => c.path)[0] : list[0];
            onOpenDiff(first.path);
          }}
        >
          <BoxIcon d={DIFF_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={picked.length ? t("直接搁置勾选的文件（自动命名）") : t("先勾选要搁置的文件")}
          aria-label={t("直接搁置")}
          disabled={disabled || picked.length === 0}
          onClick={() => onShelve(pickedPaths, false)}
        >
          <BoxIcon d={QUICK_SHELF_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={picked.length ? t("为勾选的文件创建补丁") : t("先勾选要做成补丁的文件")}
          aria-label={t("创建补丁")}
          disabled={picked.length === 0}
          onClick={() => onPatch(selectionOf(picked))}
        >
          <BoxIcon d={PATCH_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={t("应用补丁…（也可以把 .patch 文件拖进窗口）")}
          aria-label={t("应用补丁")}
          disabled={disabled}
          onClick={onApplyPatch}
        >
          <BoxIcon d={APPLY_PATCH_ICON} />
        </button>
        <button type="button" className="ib sm" title={t("新建变更列表（把改动分组，分开提交）")} aria-label={t("新建变更列表")} disabled={!cl} onClick={() => setNaming({ id: null, value: "" })}>
          <BoxIcon d={NEW_LIST_ICON} />
        </button>
        {multi && (
          <button
            type="button"
            className="ib sm"
            title={picked.length ? t("把勾选的文件移到另一个变更列表") : t("先勾选要移动的文件")}
            aria-label={t("移动勾选的文件")}
            disabled={picked.length === 0}
            onClick={(e) => openMove(picked.map((c) => c.path), e.currentTarget)}
          >
            <BoxIcon d={MOVE_ICON} />
          </button>
        )}
        <button
          type="button"
          className={"ib sm" + (groupDir ? " pressed" : "")}
          aria-pressed={groupDir}
          title={t("按目录树显示（提交详情里的文件列表也一样）")}
          aria-label={t("按目录树显示")}
          onClick={() => setSettings({ groupByDir: !groupDir })}
        >
          <BoxIcon d={GROUP_ICON} />
        </button>
        <button
          type="button"
          className="ib sm"
          title={changesOpen ? t("折叠“改动”") : t("展开“改动”")}
          aria-label={changesOpen ? t("折叠“改动”") : t("展开“改动”")}
          disabled={changes.length === 0}
          onClick={() => {
            if (!multi) return setChangesOpen((o) => !o);
            setCollapsed(changesOpen ? new Set(cl!.lists.map((l) => l.id)) : new Set());
            setChangesOpen((o) => !o);
          }}
        >
          <BoxIcon d={changesOpen ? "M4 6l3-3 3 3M4 11l3-3 3 3" : "M4 3l3 3 3-3M4 8l3 3 3-3"} />
        </button>
      </div>
      <div className="cp-list">
        {naming?.id === null && <div className="cp-node cl-node naming">{nameInput}</div>}
        {multi ? (
          cl!.lists.map((l) => {
            const items = changes.filter((c) => listOf(c.path) === l.id);
            const on = items.filter((c) => !unchecked.has(c.path) && !allOff(c.path)).length;
            const open = !collapsed.has(l.id);
            const active = cl!.active === l.id;
            return (
              <div key={l.id} className="cl-group">
                <div className={"cp-node cl-node" + (active ? " active" : "")}>
                  <button
                    type="button"
                    className="fold"
                    aria-expanded={open}
                    title={open ? t("折叠") : t("展开")}
                    aria-label={open ? t("折叠“{0}”", listName(l.id)) : t("展开“{0}”", listName(l.id))}
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(l.id)) n.delete(l.id);
                        else n.add(l.id);
                        return n;
                      })
                    }
                  >
                    {open ? "▾" : "▸"}
                  </button>
                  <input
                    type="checkbox"
                    aria-label={t("提交“{0}”里的文件", listName(l.id))}
                    disabled={items.length === 0}
                    checked={items.length > 0 && on === items.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < items.length;
                    }}
                    onChange={() =>
                      setUnchecked((u) => {
                        const n = new Set(u);
                        for (const c of items) {
                          if (on === items.length) n.add(c.path);
                          else n.delete(c.path);
                        }
                        return n;
                      })
                    }
                  />
                  {naming?.id === l.id ? nameInput : <span className="cp-node-name" onDoubleClick={() => setNaming({ id: l.id, value: l.name })}>{listName(l.id)}</span>}
                  {active && (
                    <span className="cl-active" title={t("新出现的改动放进这个列表")}>
                      {t("活动")}
                    </span>
                  )}
                  <span className="dim">{items.length ? t("已选 {0} / {1}", on, items.length) : t("空")}</span>
                  <span className="cl-acts">
                    {!active && (
                      <button type="button" className="ib sm" title={t("设为活动列表（新改动放进这里，只勾选这里的文件）")} aria-label={t("把“{0}”设为活动列表", listName(l.id))} onClick={() => makeActive(l.id)}>
                        <BoxIcon d={ACTIVE_ICON} />
                      </button>
                    )}
                    <button type="button" className="ib sm" title={t("重命名")} aria-label={t("重命名“{0}”", listName(l.id))} onClick={() => setNaming({ id: l.id, value: l.name })}>
                      <BoxIcon d={RENAME_ICON} />
                    </button>
                    {l.id !== "default" && (
                      <button type="button" className="ib sm" title={items.length ? t("删除这个列表（里面的文件回到“{0}”）", listName("default")) : t("删除这个列表")} aria-label={t("删除“{0}”", listName(l.id))} onClick={() => removeList(l.id)}>
                        <BoxIcon d={TRASH_ICON} />
                      </button>
                    )}
                  </span>
                </div>
                {open && (groupDir ? <FileTree items={items} pathOf={(c) => c.path} leaf={(c, d) => changeRow(c, d)} dirLead={dirCheck} /> : items.map((c) => changeRow(c)))}
              </div>
            );
          })
        ) : changes.length === 0 ? (
          <p className="cp-clean dim" ref={cleanNote} tabIndex={-1}>
            {t("没有改动，工作区是干净的")}
          </p>
        ) : (
          <>
            <label className="cp-node">
              <button
                type="button"
                className="fold"
                aria-expanded={changesOpen}
                title={changesOpen ? t("折叠") : t("展开")}
                aria-label={changesOpen ? t("折叠“改动”") : t("展开“改动”")}
                onClick={(e) => {
                  e.preventDefault();
                  setChangesOpen((o) => !o);
                }}
              >
                {changesOpen ? "▾" : "▸"}
              </button>
              <input
                type="checkbox"
                checked={allState === true}
                ref={(el) => {
                  if (el) el.indeterminate = allState === "mixed";
                }}
                onChange={toggleAll}
              />
              {naming?.id === "default" ? nameInput : <span className="cp-node-name">{cl ? listName("default") : t("改动")}</span>}
              <span className="dim">
                {t("已选 {0} / {1}", picked.length, changes.length)}
              </span>
            </label>
            {changesOpen &&
              (groupDir ? <FileTree items={changes} pathOf={(c) => c.path} leaf={(c, d) => changeRow(c, d)} dirLead={dirCheck} /> : changes.map((c) => changeRow(c)))}
          </>
        )}
        {untracked.length > 0 && (
          <>
            <div className="cp-group dim">{t("未跟踪的文件")} {untracked.length}</div>
            {untracked.map((p) => (
              <div
                key={p}
                className={"frow untracked" + (activePath === p ? " active" : "")}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onFileMenu?.(p, e.clientX, e.clientY);
                }}
              >
                <button type="button" className="frow-main" onClick={() => onOpenDiff(p)} title={p}>
                  <StatusBadge s="?" />
                  <span className="fpath mono">{p}</span>
                </button>
                <span className="frow-acts">
                  <button type="button" className="ib sm frow-act" title={t("加入版本控制")} aria-label={t("把 {0} 加入版本控制", p)} onClick={() => onUntracked("add", p)}>
                    <BoxIcon d={ADD_ICON} />
                  </button>
                  <button type="button" className="ib sm frow-act" title={t("加入忽略规则（.gitignore）")} aria-label={t("忽略 {0}", p)} onClick={() => onUntracked("ignore", p)}>
                    <BoxIcon d={IGNORE_ICON} />
                  </button>
                  <button type="button" className="ib sm frow-act x" title={t("删除（移到废纸篓）")} aria-label={t("删除 {0}", p)} onClick={() => onUntracked("delete", p)}>
                    <BoxIcon d={TRASH_ICON} />
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {changes.length > 0 && (
        <div className="cp-compose">
          <div className="cp-count dim">
            <span>{t("提交说明")}</span>
            <span className="cp-tools">
              <button type="button" className="ib sm" title={t("说明历史")} aria-label={t("说明历史")} onClick={() => setHistory((h) => !h)}>
                <BoxIcon d={HISTORY_ICON} />
              </button>
              <button type="button" className="ib sm" title={t("按勾选的改动生成说明")} aria-label={t("生成说明")} onClick={generate}>
                <BoxIcon d={GENERATE_ICON} />
              </button>
              <button
                type="button"
                className={"ib sm" + (showAuthor ? " pressed" : "")}
                title={author.trim() ? t("作者：{0}", author.trim()) : coAuthorsOf(msg).length ? t("作者和共同作者（{0} 个共同作者）", coAuthorsOf(msg).length) : t("作者和共同作者")}
                aria-label={t("作者和共同作者")}
                aria-expanded={showAuthor}
                onClick={() => setShowAuthor((v) => !v)}
              >
                <BoxIcon d={AUTHOR_ICON} />
                {author.trim() || coAuthorsOf(msg).length ? <span className="ib-dot" /> : null}
              </button>
              <button
                type="button"
                className={"ib sm" + (showOpts ? " pressed" : "")}
                title={optsTitle}
                aria-label={t("提交选项")}
                aria-expanded={showOpts}
                onClick={() => setShowOpts((v) => !v)}
              >
                <BoxIcon d={OPTIONS_ICON} />
                {(checks?.check_on_commit && checks.check_command.trim()) || (checks?.format_on_commit && checks.format_command.trim()) ? <span className="ib-dot" /> : null}
              </button>
            </span>
            <span className={title.length > 50 ? "warn" : ""}>{t("标题")} {title.length} / 50</span>
          </div>
          {showOpts && (
            <ChecksOptions
              info={checks}
              running={!!phase}
              onSave={async (c) => setChecks(await api.checksConfigSet(c))}
              onRunNow={() => {
                const files = picked.filter((x) => x.status !== "D").map((x) => x.path);
                if (!files.length) return setError(t("先勾选文件"));
                setError(null);
                runStep("check", files, false);
              }}
            />
          )}
          {compose && !compose.me && (
            <div className="cp-ident" role="note">
              <span>{t("还没有设置提交用的用户名和邮箱，提交会失败")}</span>
              {onOpenGitSettings && (
                <button type="button" className="btn sm" onClick={onOpenGitSettings}>
                  {t("去设置")}
                </button>
              )}
            </div>
          )}
          {showAuthor && <AuthorOptions repoPath={repoPath} me={compose?.me ?? null} author={author} setAuthor={setAuthor} msg={msg} setMsg={setMsg} />}
          {history && (
            <div className="cp-history" role="listbox" aria-label={t("说明历史")}>
              {histAll().length > 6 && (
                <input
                  className="pk-q cp-hist-q"
                  autoFocus
                  value={histQ}
                  placeholder={t("搜索说明历史")}
                  aria-label={t("搜索说明历史")}
                  spellCheck={false}
                  onChange={(e) => setHistQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setHistory(false))}
                />
              )}
              {histAll().length === 0 && <p className="dim small pad">{t("还没有说明历史")}</p>}
              {histAll()
                .filter((m) => !histQ.trim() || m.toLowerCase().includes(histQ.trim().toLowerCase()))
                .map((m) => (
                <button
                  key={m}
                  type="button"
                  className="cp-hist-row"
                  title={m}
                  onClick={() => {
                    setMsg(m);
                    setHistory(false);
                    setHistQ("");
                    input.current?.focus();
                  }}
                >
                  {m.split("\n")[0]}
                </button>
              ))}
            </div>
          )}
          <textarea
            aria-label={t("提交说明")}
            onFocus={() => (composeUsedAt.current = Date.now())}
            ref={input}
            value={msg}
            rows={4}
            placeholder={t("第一行是标题\n\n空一行后写正文")}
            title={template ? t("说明框里是提交说明模板（{0}）", compose?.template_path ?? "commit.template") : undefined}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit(e.altKey);
              }
            }}
          />
          <div className="cp-amend">
            <label className="check">
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} disabled={disabled} />
              {t("修订")}
            </label>
            {amend && (
              <select className="cp-target" value={target ?? ""} onChange={(e) => setTarget(e.target.value)} disabled={!targets || targets.length === 0}>
                {!targets && <option value="">{t("正在读取…")}</option>}
                {targets?.length === 0 && <option value="">{t("没有还没推送的提交")}</option>}
                {targets?.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {i === 0 ? t("上一次提交：{0}", c.title) : `${c.id.slice(0, 7)} ${c.title}`}
                  </option>
                ))}
              </select>
            )}
          </div>
          {amend && target && target !== targets?.[0]?.id && <p className="dim small cp-note">{t("修订更早的提交：勾选的改动并入它，它之后的提交会被改写")}</p>}
          {error && (
            <p className="err cp-err" role="alert">
              {tr(error)}
            </p>
          )}
          <div className="cp-btns">
            <button
              type="button"
              className="primary cp-commit"
              onClick={() => commit()}
              disabled={(busy && !phase) || disabled}
              title={phase ? t("点击取消") : t("{0}（⌘↵）", busy ? t("正在提交…") : amend ? t("修订") : t("提交 {0} 个文件", picked.length))}
            >
              <span className="cp-commit-label">
                {phase ? (phase.kind === "format" ? t("正在格式化… 点击取消") : t("正在检查… 点击取消")) : busy ? t("正在提交…") : amend ? t("修订") : t("提交 {0} 个文件", picked.length)}
              </span>
              <span className="kbd">⌘↵</span>
            </button>
            <button
              type="button"
              className="btn cp-push"
              title={t("提交并推送（⌥⌘↵）")}
              aria-label={t("提交并推送")}
              hidden={amend}
              onClick={() => commit(true)}
              disabled={busy || disabled}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10" />
              </svg>
            </button>
            <button
              type="button"
              className="btn cp-push"
              title={picked.length ? t("搁置勾选的文件到暂存架…") : t("先勾选要搁置的文件")}
              aria-label={t("搁置到暂存架")}
              onClick={() => onShelve(pickedPaths, true)}
              disabled={busy || disabled || picked.length === 0}
            >
              <BoxIcon d={SHELF_ICON} />
            </button>
            <button type="button" className="btn cp-push" title={t("贮藏全部改动")} aria-label={t("贮藏")} onClick={onStash} disabled={busy || disabled}>
              <BoxIcon d={STASH_ICON} />
            </button>
          </div>
        </div>
      )}
      {moveMenu && <Menu menu={moveMenu} onClose={() => setMoveMenu(null)} />}
      {report && (
        <ChecksReport
          run={report.run}
          canCommit={report.canCommit}
          onCommit={() => {
            report.resolve(true);
            setReport(null);
          }}
          onCancel={() => {
            report.resolve(false);
            setReport(null);
          }}
          onOpen={(p) => {
            if (!changes.some((c) => c.path === p)) return;
            report.resolve(false);
            setReport(null);
            onOpenDiff(p);
          }}
        />
      )}
    </div>
  );
}
