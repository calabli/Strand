import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errOf, inTauri, onRepoChanged, openUrl, pickFolder, revealPath, wholeFile } from "./api/commands";
import { treeOrder, TypeIcon } from "./components/FileRow";
import { CloneDialog, WorktreeDialog } from "./components/worktreeClone";
import type { Cap, Commit, CommitCaps, CommitCreated, Selection, FileChange, FileDiff, GitInfo, MergeSession, OpInfo, RefsList, RepoState, Submodule, Worktree, WorktreeStatus } from "./api/types";
import { COMMIT_ICONS, commitActions, useCommitOps } from "./components/commitOps";
import { useRebase } from "./components/RebaseWindow";
import { CompareView, PatchWindow, TreeWindow } from "./components/compareTools";
import { ApplyPatch } from "./components/ApplyPatch";
import { PickFiles } from "./components/PickFiles";
import { UpdateCard, useUpdates } from "./components/updates";
import { isImage } from "./components/ImageDiff";
import { ReflogWindow } from "./components/ReflogWindow";
import { RemotesWindow } from "./components/RemotesWindow";
import { BisectBar, useBisect } from "./components/BisectBar";
import { BlameWindow } from "./components/BlameWindow";
import { RepoList, RepoPopup, SettingsWindow } from "./components/RepoAndSettings";
import { rememberRepo, settings, useRecentRepos } from "./settings";
import { CommandPalette, SHORTCUTS, type PaletteCommand } from "./components/CommandPalette";
import { Timeline, useOplog } from "./components/oplog";
import { ShelfPanel, StashPanel, useStashShelf } from "./components/stashShelf";
import { ConflictView } from "./components/ConflictView";
import { useLog } from "./api/useLog";
import { BranchPopup } from "./components/BranchPopup";
import { BranchTree, branchActions } from "./components/BranchTree";
import { useBranchOps, useFavorites } from "./components/branchOps";
import { useDialog } from "./components/Dialog";
import { Menu, type MenuEntry, type MenuState } from "./components/Menu";
import { PullPanel, PushDialog, useRemoteOps } from "./components/remoteOps";
import { CommitPanel } from "./components/CommitPanel";
import { Detail } from "./components/Detail";
import { FileView } from "./components/FileView";
import { ProjectFiles } from "./components/ProjectFiles";
import { Splitter, paneVars } from "./components/Splitter";
import { DiffView } from "./components/DiffView";
import { findRegExp, keys, shortId } from "./components/format";
import { Palette } from "./components/Palette";
import { LogView } from "./components/LogView";
import { ConsoleView } from "./components/ConsoleView";
import { EMPTY_UI, LogFilterBar, isFiltered, toFilter, type LogUi } from "./components/LogFilterBar";
import { Toolbar } from "./components/Toolbar";
import { setLang, t, tr } from "./i18n";

/** What the diff tab shows: a file in the worktree or a file in a commit */
type DiffTarget =
  | { kind: "worktree"; path: string }
  | { kind: "commit"; id: string; path: string }
  | { kind: "compare"; from: string; to: string; path: string }
  /** A file in a shelf entry (spec §4.9) */
  | { kind: "shelf"; id: number; name: string; path: string }
  /** Any two contents compared (two files, a file and the clipboard); text null means a binary file (only images can be shown); file is the worktree path */
  | { kind: "texts"; path: string; left: TextSide; right: TextSide };
type TextSide = { label: string; text: string | null; file?: string };

const msgOf = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

const LAST_REPO = "strand.lastRepo";
const TREE_OPEN = "strand.treeOpen";
const PANEL_OPEN = "strand.panelOpen";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_REPO);
  } catch {
    return null;
  }
}
function writeLast(p: string | null) {
  try {
    if (p) localStorage.setItem(LAST_REPO, p);
    else localStorage.removeItem(LAST_REPO);
  } catch {
    /* Never mind if it can't be saved; open it manually next time */
  }
}

/** A pushpin, for pinned file tabs */
const PIN_ICON = "M5 1.5h4M5.8 1.5v4L3.5 8h7L8.2 5.5v-4M7 8v4.5";

/** A submodule's folder: the repository root plus its path, with the root's separator (Windows paths use \\) */
const joinPath = (root: string, rel: string) => {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
};

/** One file open in the middle: where to jump (from search results) and whether the change chain opens with it */
type FileTab = { path: string; pinned?: boolean; at: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null; n: number } | null; chain: boolean };
/** Open file tabs at most; past this the least recently shown closes */
const MAX_FILE_TABS = 15;

export default function App() {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Commit | null>(null);
  // Each open or refresh gets a new key, which clears the log cache
  const [logKey, setLogKey] = useState<string | null>(null);
  // Log filter conditions (spec §5.1), kept in the frontend only; cleared when switching repositories
  const [ui, setUi] = useState<LogUi>(EMPTY_UI);
  const query = useMemo(() => ({ filter: toFilter(ui), sort: ui.sort }), [ui]);
  const queryKey = JSON.stringify(query);
  const log = useLog(logKey, query);
  const [treeOpen, setTreeOpen] = useState(() => {
    try {
      return localStorage.getItem(TREE_OPEN) !== "0";
    } catch {
      return true;
    }
  });
  // Commit panel toggle (spec §3.2), remembered on this machine
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem(PANEL_OPEN) !== "0";
    } catch {
      return true;
    }
  });
  const togglePanel = () =>
    setPanelOpen((o) => {
      try {
        localStorage.setItem(PANEL_OPEN, o ? "0" : "1");
      } catch {
        /* Only for this session */
      }
      return !o;
    });
  const [focusSearch, setFocusSearch] = useState(0);
  // When jumping to another commit after clearing conditions, don't scroll the old selection back into view
  const skipKeep = useRef(false);
  /** The three-column container and the branch tree column in the log: splitters write widths here */
  const panesRef = useRef<HTMLDivElement>(null);
  const logSplitRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [tab, setTab] = useState<"log" | "console" | "diff" | "file">("log");
  /** Files open in the middle, one tab each (like an IDE's editor tabs); each keeps its own state while another is shown */
  const [files, setFiles] = useState<FileTab[]>([]);
  /** The file tab shown when the "file" tab is active */
  const [fileOpen, setFileOpen] = useState<string | null>(null);
  /** When each file tab was last shown: closing the active tab returns to the most recent one, and past the limit the least recent closes */
  const fileUsed = useRef(new Map<string, number>());
  const showFile = useCallback((p: string) => {
    fileUsed.current.set(p, Date.now());
    setFileOpen(p);
    setTab("file");
  }, []);
  const openFile = useCallback(
    (p: string, at?: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null }, history = false) => {
      const jump = at ? { ...at, n: Date.now() } : null;
      setFiles((fs) => {
        const i = fs.findIndex((f) => f.path === p);
        if (i >= 0) {
          const next = [...fs];
          next[i] = { ...fs[i], at: jump ?? fs[i].at, chain: history || fs[i].chain };
          return next;
        }
        // A new tab goes right of the one being shown
        const from = fs.findIndex((f) => f.path === fileOpenRef.current);
        const next = [...fs];
        next.splice(from >= 0 ? from + 1 : fs.length, 0, { path: p, at: jump, chain: history });
        if (next.length <= MAX_FILE_TABS) return next;
        const used = fileUsed.current;
        const oldest = next.filter((f) => f.path !== p && !f.pinned).sort((a, b) => (used.get(a.path) ?? 0) - (used.get(b.path) ?? 0))[0];
        if (!oldest) return next;
        used.delete(oldest.path);
        closedRef.current = [...closedRef.current.filter((c) => c !== oldest.path), oldest.path].slice(-30);
        return next.filter((f) => f !== oldest);
      });
      showFile(p);
    },
    [showFile],
  );
  const fileOpenRef = useRef(fileOpen);
  fileOpenRef.current = fileOpen;
  /** Recently closed file tabs, most recent last (⇧⌘T reopens, ⌘E lists them) */
  const closedRef = useRef<string[]>([]);
  /** Pin or unpin a file tab: pinned tabs sit on the left, aren't closed by "close others / all" or the tab limit */
  const pinFile = (p: string, pinned: boolean) =>
    setFiles((fs) => {
      const tab = fs.find((f) => f.path === p);
      if (!tab) return fs;
      const rest = fs.filter((f) => f !== tab);
      const n = rest.filter((f) => f.pinned).length;
      rest.splice(n, 0, { ...tab, pinned });
      return rest;
    });
  /** Close file tabs; when the shown one closes, show the most recently used of the rest, or go back to the log */
  const closeFiles = useCallback(
    (paths: string[]) => {
      const gone = new Set(paths);
      setFiles((fs) => {
        const rest = fs.filter((f) => !gone.has(f.path));
        gone.forEach((p) => fileUsed.current.delete(p));
        const closed = fs.filter((f) => gone.has(f.path)).map((f) => f.path);
        closedRef.current = [...closedRef.current.filter((c) => !gone.has(c)), ...closed].slice(-30);
        const cur = fileOpenRef.current;
        if (cur && gone.has(cur)) {
          const used = fileUsed.current;
          const back = [...rest].sort((a, b) => (used.get(b.path) ?? 0) - (used.get(a.path) ?? 0))[0];
          setFileOpen(back?.path ?? null);
          if (!back) setTab((tb) => (tb === "file" ? "log" : tb));
        }
        return rest;
      });
    },
    [],
  );
  /** Console, file view and diff tab use the middle plus right width without commit details (diffs compare side by side and would wrap if narrow) */
  const wide = tab === "console" || tab === "file" || tab === "diff";
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<{ data: FileDiff | null; loading: boolean; error: string | null; pickKeys?: Map<string, string> }>({
    data: null,
    loading: false,
    error: null,
  });
  // Toast; with op it shows an undo icon (spec §3.5, §11.1)
  const [toast, setToast] = useState<{ text: string; op?: OpInfo } | null>(null);
  const toastTimer = useRef<number>(0);
  // After a log refresh or jump, wait for that row to load before selecting it (empty id means don't check the id)
  const [selectAfterLoad, setSelectAfterLoad] = useState<{ row: number; id?: string } | null>(null);
  const [jump, setJump] = useState<{ row: number; n: number } | null>(null);
  const [refs, setRefs] = useState<RefsList | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [popup, setPopup] = useState(false);
  const [dialog, ask] = useDialog();
  // Conflict session: read while the repository is mid merge, rebase, etc.; hidden first on "continue later"
  const [session, setSession] = useState<MergeSession | null>(null);
  const [conflictHidden, setConflictHidden] = useState(false);
  // How many conflicts remain: reported by the conflict view and shown in the toolbar's "in progress" notice (spec §3.3)
  const [conflictLeft, setConflictLeft] = useState<number | null>(null);
  const [conflictCmd, setConflictCmd] = useState<{ kind: "list" | "auto"; n: number } | null>(null);

  const say = (text: string, op?: OpInfo) => {
    setToast({ text, op: op?.undoable ? op : undefined });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), op ? 6000 : 3000);
  };

  const refreshStatus = useCallback(() => {
    api.statusGet().then(setStatus, (e) => setError(msgOf(e)));
  }, []);

  const refreshRefs = useCallback(() => {
    api.refsList().then(setRefs, (e) => setError(msgOf(e)));
  }, []);
  const { favs, toggle: toggleFav } = useFavorites(repo?.path ?? null, refs, refreshRefs);

  /** Clear the filter conditions, jump to a commit, branch or tag in the log and select it; false when not found */
  const locate = useCallback(async (rev: string) => {
    const row = await api.logLocate(rev).catch(() => null);
    if (row == null) return false;
    skipKeep.current = true;
    setUi((u) => ({ ...EMPTY_UI, regex: u.regex, caseSensitive: u.caseSensitive }));
    setTab("log");
    setJump({ row, n: Date.now() });
    setSelectAfterLoad({ row });
    return true;
  }, []);

  // Filter conditions changed: scroll to the selected commit if it's still in the results
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (skipKeep.current) {
      skipKeep.current = false;
      return;
    }
    const c = selectedRef.current;
    if (!c) return;
    let live = true;
    const q = JSON.parse(queryKey) as typeof query;
    api.logLocate(c.id, q.filter, q.sort).then(
      (row) => live && row != null && setJump({ row, n: Date.now() }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [queryKey]);

  const toggleTree = () =>
    setTreeOpen((o) => {
      try {
        localStorage.setItem(TREE_OPEN, o ? "0" : "1");
      } catch {
        /* Only for this session */
      }
      return !o;
    });

  const jumpTo = () =>
    ask({
      title: t("跳到提交"),
      message: t("输入哈希前缀、分支名或标签名。跳转时会清空过滤条件。"),
      input: { initial: "", placeholder: t("如 a41f9c2、main 或 v0.4.0"), mono: true },
      confirm: t("跳到"),
      onSubmit: async (rev) => {
        if (!(await locate(rev.trim()))) return t("找不到 {0}", rev.trim());
      },
    });

  const loadDiff = useCallback((t: DiffTarget, quiet = false) => {
    setDiff((d) => ({ data: quiet ? d.data : null, loading: !quiet, error: null, pickKeys: quiet ? d.pickKeys : undefined }));
    if (t.kind === "worktree") {
      // Worktree: show the whole file; line checks are recorded per block with 3 lines of context (the core layer finds lines the same way when committing),
      // so also fetch a diff with 3 lines of context and map each changed line by line number to its "block:line" there
      Promise.all([api.diffWorktree(t.path), wholeFile((c) => api.diffWorktree(t.path, false, c))]).then(
        ([short, full]) => {
          const pickKeys = new Map<string, string>();
          short.hunks.forEach((h, i) =>
            h.lines.forEach((l, j) => {
              if (l.kind === "del" && l.old_no) pickKeys.set(`d:${l.old_no}`, `${i}:${j}`);
              if (l.kind === "add" && l.new_no) pickKeys.set(`a:${l.new_no}`, `${i}:${j}`);
            }),
          );
          setDiff({ data: full, loading: false, error: null, pickKeys });
        },
        (e) => setDiff({ data: null, loading: false, error: msgOf(e) }),
      );
      return;
    }
    const p =
      t.kind === "texts"
        ? t.left.text === null || t.right.text === null
          ? Promise.resolve({ path: t.path, binary: true, hunks: [], truncated: false })
          : api.textDiff(t.left.text, t.right.text, t.path)
        : t.kind === "compare"
          ? wholeFile((c) => api.diffCompare(t.from, t.to, t.path, c))
          : t.kind === "shelf"
            ? wholeFile((c) => api.shelfDiff(t.id, t.path, c))
            : wholeFile((c) => api.diffCommit(t.id, t.path, c));
    p.then(
      (data) => setDiff({ data, loading: false, error: null }),
      (e) => setDiff({ data: null, loading: false, error: msgOf(e) }),
    );
  }, []);

  const openDiff = (t: DiffTarget) => {
    setTarget(t);
    setTab("diff");
    loadDiff(t);
  };

  // The diff tab switches between files in one group (extension of spec §10.1): the same commit, the same comparison, the same shelf entry, worktree changes
  const [siblings, setSiblings] = useState<{ key: string; paths: string[] } | null>(null);
  const groupKey = !target ? "" : target.kind === "commit" ? `c:${target.id}` : target.kind === "compare" ? `p:${target.from}:${target.to}` : target.kind === "shelf" ? `s:${target.id}` : target.kind === "texts" ? "x" : "w";
  useEffect(() => {
    if (!target || target.kind === "worktree" || target.kind === "texts") return;
    if (siblings?.key === groupKey) return;
    let live = true;
    const order = (paths: string[]) => (settings().groupByDir ? treeOrder(paths, (p) => p) : paths);
    const p =
      target.kind === "commit"
        ? api.commitDetail(target.id).then((d) => d.files.map((f) => f.path))
        : target.kind === "compare"
          ? api.compare(target.from, target.to).then((c) => c.files.map((f) => f.path))
          : api.shelfFiles(target.id).then((fs) => fs.map((f) => f.path));
    p.then((paths) => live && setSiblings({ key: groupKey, paths: order(paths) }), () => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey]);
  const filesInGroup = target?.kind === "texts" ? [] : target?.kind === "worktree" ? [...(status?.changes.map((c) => c.path) ?? []), ...(status?.untracked ?? [])] : siblings?.key === groupKey ? siblings.paths : [];
  const fileNav =
    target && filesInGroup.length > 1 && filesInGroup.includes(target.path)
      ? {
          at: filesInGroup.indexOf(target.path),
          total: filesInGroup.length,
          go: (d: number) => {
            const i = filesInGroup.indexOf(target.path);
            const next = filesInGroup[(i + d + filesInGroup.length) % filesInGroup.length];
            openDiff({ ...target, path: next } as DiffTarget);
          },
        }
      : null;

  const open = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const st = await api.repoOpen(path);
      rememberRepo(st.path, st.name);
      setRepo(st);
      setSelected(null);
      setTarget(null);
      setFiles([]);
      setFileOpen(null);
      fileUsed.current.clear();
      setTab("log");
      setStatus(null);
      setRefs(null);
      setUi(EMPTY_UI);
      setLogKey(`${st.path}#${Date.now()}`);
      writeLast(path);
      api.statusGet().then(setStatus, (e) => setError(msgOf(e)));
      api.refsList().then(setRefs, (e) => setError(msgOf(e)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      writeLast(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([api.gitCheck(), api.launchPath()]).then(([g, launch]) => {
      setGit(g);
      // The repository from the launch arguments first, then the last opened one
      const target = launch ?? (settings().reopenLast ? readLast() : null) ?? (inTauri ? null : "/示例/strand-app");
      if (g.ok && target) open(target);
    });
  }, [open]);

  const choose = async () => {
    const p = await pickFolder();
    if (p) open(p);
  };

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const st = await api.repoReload();
      setRepo(st);
      setLogKey(`${st.path}#${Date.now()}`);
      refreshStatus();
      refreshRefs();
    } catch (e) {
      setError(msgOf(e));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, refreshRefs]);

  // File watching says refs changed: right after Strand's own write the core layer sees no change and doesn't re-read, so the log isn't fetched again
  const refreshFromWatch = useCallback(async () => {
    try {
      const { state: st, changed } = await api.repoRefresh();
      setRepo(st);
      if (changed) setLogKey(`${st.path}#${Date.now()}`);
      else oplogRefresh.current();
      refreshStatus();
      refreshRefs();
    } catch (e) {
      setError(msgOf(e));
    }
  }, [refreshStatus, refreshRefs]);

  // Branch and tag operations: refresh the log, branches and worktree on success; on failure the repository may have changed too (e.g. a merge stopped on conflicts), so re-read
  const ops = useBranchOps({
    repo,
    refs,
    ask,
    done: useCallback(
      (st: RepoState, message: string, op?: OpInfo) => {
        setRepo(st);
        setLogKey(`${st.path}#${Date.now()}`);
        setSelected(null);
        refreshRefs();
        refreshStatus();
        say(message, op);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [refreshRefs, refreshStatus],
    ),
    failed: useCallback(
      (message: string) => {
        setError(message);
        reload();
      },
      [reload],
    ),
    say: (m: string) => say(m),
  });

  const doneCb = useCallback(
    (st: RepoState, message: string, op?: OpInfo, keepLog?: boolean) => {
      setRepo(st);
      // When commits and refs are unchanged (e.g. a fetch with nothing new), don't re-read the log, so the list and filters being viewed aren't interrupted
      if (!keepLog) setLogKey(`${st.path}#${Date.now()}`);
      refreshRefs();
      refreshStatus();
      if (message) say(message, op);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshRefs, refreshStatus],
  );
  const failedCb = useCallback(
    (message: string) => {
      if (message) setError(message);
      reload();
    },
    [reload],
  );
  const remote = useRemoteOps({ repo, done: doneCb, failed: failedCb, say });
  // Submodules: re-read with the branch list and worktree status (their state follows both); only when the repository has a .gitmodules
  const [subs, setSubs] = useState<Submodule[] | null>(null);
  useEffect(() => {
    if (!repo?.submodules) return setSubs(null);
    let live = true;
    api.submoduleList().then((l) => live && setSubs(l), () => live && setSubs(null));
    return () => {
      live = false;
    };
  }, [repo?.path, repo?.submodules, refs, status]);
  /** Bumped after downloading LFS files so open file views read their contents again */
  const [lfsVer, setLfsVer] = useState(0);
  const lfsPull = async () => {
    if (!(await api.lfsInstalled())) return setError(t("没有安装 Git LFS（git-lfs），装好后才能下载 LFS 文件"));
    if (await remote.lfsPull()) setLfsVer((v) => v + 1);
  };
  const oplog = useOplog({
    refreshKey: logKey,
    ask,
    applied: doneCb,
    failed: useCallback((m: string) => {
      setError(m);
      reload();
    }, [reload]),
  });
  const oplogRefresh = useRef(oplog.refresh);
  oplogRefresh.current = oplog.refresh;
  // Undo is also blocked during a bisect (undo would move HEAD, out of sync with Git's bisect state)
  const undoBlocked = repo?.state !== "normal" || !!repo?.bisecting;
  const cur = refs?.branches.find((b) => b.is_current);

  const repoMode = repo?.state ?? "normal";
  const refreshSession = useCallback(() => {
    api.mergeSession().then(setSession, (e) => setError(msgOf(e)));
  }, []);
  useEffect(() => {
    if (repoMode === "normal") {
      setSession(null);
      setConflictHidden(false);
    } else refreshSession();
  }, [repoMode, logKey, refreshSession]);

  // Line checks (spec §4.3, §10.1): path → unchecked lines, all changed lines, and the changed line count when recorded; reset to all checked when the file content changes
  const [lineSel, setLineSel] = useState<Record<string, { excluded: string[]; all: string[]; sig: string }>>({});
  const sigOf = (path: string) => {
    const c = status?.changes.find((x) => x.path === path);
    return c ? `${c.added}/${c.deleted}` : "";
  };
  useEffect(() => {
    setLineSel((m) => {
      const n = Object.fromEntries(Object.entries(m).filter(([p, v]) => sigOf(p) === v.sig));
      return Object.keys(n).length === Object.keys(m).length ? m : n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const toggleLines = (path: string, keys: string[], on: boolean, all: string[]) =>
    setLineSel((m) => {
      const cur = new Set(m[path]?.excluded ?? []);
      for (const k of keys) {
        if (on) cur.delete(k);
        else cur.add(k);
      }
      const n = { ...m };
      if (cur.size === 0) delete n[path];
      else n[path] = { excluded: [...cur], all, sig: sigOf(path) };
      return n;
    });

  // Discarding changes, untracked files (spec §4.7, §4.8)
  const runWrite = async (p: Promise<{ state: RepoState; op?: OpInfo }>, message: string) => {
    try {
      const w = await p;
      doneCb(w.state, message, w.op);
    } catch (e) {
      failedCb(msgOf(e));
    }
  };
  const discard = (paths: string[]) =>
    ask({
      title: paths.length === 1 ? t("丢弃 {0} 的改动", paths[0]) : t("丢弃 {0} 个文件的改动", paths.length),
      message: t("这些文件回到最近一次提交的样子，新增的文件会被删除。可以在操作时间线里撤销。"),
      confirm: t("丢弃"),
      danger: true,
      onSubmit: () => runWrite(api.changesDiscard(paths), t("已丢弃改动")),
    });
  const onUntracked = (kind: "add" | "ignore" | "delete", path: string) => {
    if (kind === "add") return runWrite(api.untrackedAdd(path), t("已把 {0} 加入版本控制", path));
    if (kind === "ignore") return runWrite(api.untrackedIgnore(path), t("已把 {0} 加入 .gitignore", path));
    ask({
      title: t("删除 {0}", path),
      message: t("文件会移到系统的废纸篓，需要时可以从废纸篓里找回。"),
      confirm: t("删除"),
      danger: true,
      onSubmit: () => runWrite(api.untrackedDelete(path), t("已把 {0} 移到废纸篓", path)),
    });
  };

  // Shelf and stash (spec §4.9)
  const [panel, setPanel] = useState<"commit" | "shelf" | "stash" | "files">("commit");
  const ss = useStashShelf({ refreshKey: logKey, ask, done: doneCb, failed: failedCb, say });
  const ssRefresh = useRef(ss.refresh);
  ssRefresh.current = ss.refresh;

  // Commit operations (spec §5.6): shared by the detail icon row, context menu and F2
  const commitOps = useCommitOps({ ask, done: doneCb, failed: failedCb, say, head: repo?.head.commit });
  // Compare, patches, browsing a revision (spec §10.3–10.5)
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [patch, setPatch] = useState<{ title: string; text: string | null; name: string } | null>(null);
  /** Apply patch dialog: with a dragged-in patch, or opened empty */
  const [applying, setApplying] = useState<{ text: string; name?: string } | null>(null);
  const [pickFiles, setPickFiles] = useState<{ commit: Commit; files: FileChange[]; initial: string[]; revert: boolean } | null>(null);
  /** Compare any two files: the left side chosen first */
  const [cmpLeft, setCmpLeft] = useState<string | null>(null);
  const [reflogOpen, setReflogOpen] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  // Drag a .patch / .diff file into the window: opens the apply patch dialog (the desktop app gets the file path from the system; the browser preview reads the dropped file)
  const canApplyPatch = !!repo && repo.state === "normal";
  useEffect(() => {
    if (!canApplyPatch) return;
    const isPatch = (n: string) => /\.(patch|diff)$/i.test(n);
    const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    if (inTauri) {
      let off: (() => void) | undefined;
      let dead = false;
      import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent((e) => {
            if (e.payload.type !== "drop") return;
            const p = e.payload.paths.find(isPatch);
            if (p) api.fileReadText(p).then((text) => setApplying({ text, name: base(p) }), (err) => setError(msgOf(err)));
          })
          .then((u) => (dead ? u() : (off = u))),
      );
      return () => {
        dead = true;
        off?.();
      };
    }
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => isPatch(x.name));
      if (!f) return;
      e.preventDefault();
      f.text().then((text) => setApplying({ text, name: f.name }));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [canApplyPatch]);
  const [treeOf, setTreeOf] = useState<{ id: string; title: string } | null>(null);
  // Blame (spec §10.2)
  const [blame, setBlame] = useState<{ path: string; rev: string | null } | null>(null);
  const openPatch = (title: string, p: Promise<string>, name: string) => {
    setPatch({ title, text: null, name });
    p.then(
      (text) => setPatch((x) => (x && x.title === title ? { ...x, text } : x)),
      (e) => {
        setPatch(null);
        setError(msgOf(e));
      },
    );
  };
  // Leave compare mode when switching repositories
  useEffect(() => setCompareBase(null), [repo?.path]);
  // "Compare with current branch" on a branch: from the current branch's latest commit to that branch's latest commit
  const branchOps = {
    ...ops,
    compareWith: (name: string) => {
      const head = repo?.head.commit;
      if (!head) return;
      setCompareBase(head);
      locate(name);
    },
    submodule: {
      update: (paths: string[]) => void remote.submoduleUpdate(paths),
      open: (path: string) => repo && open(joinPath(repo.path, path)),
      reveal: (path: string) => repo && revealPath(joinPath(repo.path, path)).catch((e) => setError(errOf(e).message)),
      busy: !!remote.running,
    },
    // Worktrees (spec §6.6)
    worktree: {
      add: (branch?: string) => setWtDialog({ branch }),
      open: (path: string) => open(path),
      reveal: (path: string) => revealPath(path).catch((e) => setError(errOf(e).message)),
      remove: (w: Worktree) => {
        const name = w.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? w.path;
        const removeIt = async (force: boolean): Promise<string | void> => {
          try {
            const r = await api.worktreeRemove(w.path, force);
            doneCb(r.state, w.prunable ? t("已清理工作目录 {0} 的记录", name) : t("已移除工作目录 {0}", name), r.op);
          } catch (e) {
            const err = errOf(e);
            if (err.code !== "WORKTREE_CONFLICT" || force) return err.message;
            // There are changes: ask again after this dialog closes
            window.setTimeout(() =>
              ask({
                title: t("移除工作目录 {0}", name),
                message: t("{0}。仍然移除吗？", tr(err.message)),
                confirm: t("仍然移除"),
                danger: true,
                onSubmit: () => removeIt(true),
              }),
            );
          }
        };
        if (w.prunable) return void removeIt(false);
        ask({
          title: t("移除工作目录 {0}", name),
          message: w.branch ? t("删除文件夹 {0}。分支 {1} 和它的提交都保留。", w.path, w.branch) : t("删除文件夹 {0}。", w.path),
          confirm: t("移除"),
          danger: true,
          onSubmit: () => removeIt(false),
        });
      },
    },
  };

  // Rebasing commits (spec §9)
  const rebase = useRebase({ ask, done: doneCb, failed: failedCb, say });
  const bisect = useBisect({ refreshKey: `${logKey}|${repo?.bisecting ? 1 : 0}|${repo?.head.commit ?? ""}`, done: doneCb, failed: failedCb, say });
  const [panelSel, setPanelSel] = useState<Selection>({ files: [] });
  const extra = {
    checkout: (c: Commit) => ops.checkoutRev(c.id),
    newBranch: (c: Commit) => ops.create({ rev: c.id, label: shortId(c.id) }),
    newTag: (c: Commit) => ops.createTag(c.id),
    rebaseFrom: (c: Commit) => rebase.open(c.id),
    patch: (c: Commit) => openPatch(t("提交 {0} 的补丁", shortId(c.id)), api.patchCommit(c.id), `${shortId(c.id)}.patch`),
    tree: (c: Commit) => setTreeOf({ id: c.id, title: t("{0} 时的仓库", shortId(c.id)) }),
    compareLocal: (c: Commit) => {
      setCompareBase(c.id);
      locate("HEAD");
    },
    setBase: (c: Commit) => {
      setCompareBase(c.id);
      say(t("已设为比较起点，在日志里选另一个提交查看差别"));
    },
    pushTo: (c: Commit) => remote.openPush(c.id),
  };
  const commitMenu = (c: Commit, caps: CommitCaps | null): MenuEntry[] =>
    commitActions(c, caps, commitOps, ops.current, {
      checkout: () => extra.checkout(c),
      newBranch: () => extra.newBranch(c),
      newTag: () => extra.newTag(c),
      rebaseFrom: () => extra.rebaseFrom(c),
      patch: () => extra.patch(c),
      tree: () => extra.tree(c),
      compareLocal: () => extra.compareLocal(c),
      setBase: () => extra.setBase(c),
      pushTo: () => extra.pushTo(c),
      fixup: () => rebase.fixup(c, panelSel),
      squashInto: () => rebase.squashInto(c, panelSel),
      picked: panelSel.files.length,
      // Branch submenu: local branches pointing at this commit, or the current branch if none (spec §5.6)
      branches: (() => {
        const all = refs?.branches ?? [];
        const here = all.filter((b) => b.head === c.id);
        const list = here.length ? here : all.filter((b) => b.is_current);
        return list.map((b) => ({ name: b.name, items: branchActions(b, branchOps, favs.has(b.name), toggleFav, repo?.state !== "normal") }));
      })(),
      jump: jumpToCommit,
      openWeb: (url: string) => openUrl(url).catch((e) => setError(errOf(e).message)),
      bisect: repo?.state === "normal" || bisect.active ? { active: bisect.active, mark: (m) => bisect.mark(m, c.id) } : undefined,
      pickFiles: repo?.state === "normal" && !repo?.bisecting ? (revert) => openPickFiles(c, [], revert) : undefined,
    });

  // Availability for the selected commit; with multi-select, whether they can all be cherry-picked
  const [caps, setCaps] = useState<CommitCaps | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [multiPick, setMultiPick] = useState<Cap | null>(null);
  const anchor = useRef<number | null>(null);
  const selId = selected?.id;
  useEffect(() => {
    setCaps(null);
    if (!selId) return;
    let live = true;
    api.commitCaps(selId).then((c) => live && setCaps(c), () => {});
    return () => {
      live = false;
    };
  }, [selId, logKey, repo?.state]);
  const multiKey = multi.join(",");
  useEffect(() => {
    setMultiPick(null);
    const ids = multiKey ? multiKey.split(",") : [];
    if (ids.length < 2) return;
    let live = true;
    Promise.all(ids.map((id) => api.commitCaps(id))).then(
      (all) => {
        if (!live) return;
        const bad = all.find((c) => !c.cherry_pick.ok);
        setMultiPick(bad ? { ok: false, why: t("有提交不能拣选：{0}", tr(bad.cherry_pick.why)) } : { ok: true });
      },
      () => live && setMultiPick({ ok: false, why: t("读取失败") }),
    );
    return () => {
      live = false;
    };
  }, [multiKey, logKey]);
  // Clear multi-select after a log refresh (the commits may have changed)
  useEffect(() => setMulti([]), [logKey]);
  // Re-read the selected commit after a log refresh: "unpushed", ref labels etc. change after pushing; deselect when the commit is gone (rewritten)
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    let live = true;
    api.commitDetail(id).then(
      (d) => live && setSelected((s) => (s?.id === id && JSON.stringify(s) !== JSON.stringify(d.commit) ? d.commit : s)),
      () => live && setSelected((s) => (s?.id === id ? null : s)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logKey]);

  // The row of the selected commit (for ↑ ↓)
  const selRow = useRef<number | null>(null);
  const pick = (c: Commit, row: number, mods: { toggle: boolean; range: boolean }) => {
    selRow.current = row;
    if (mods.range && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, row), Math.max(anchor.current, row)];
      const ids: string[] = [];
      for (let i = a; i <= b; i++) {
        const r = log.row(i);
        if (r) ids.push(r.commit.id);
      }
      setMulti(ids);
      setSelected(c);
      return;
    }
    anchor.current = row;
    if (mods.toggle) {
      const base = multi.length ? multi : selected ? [selected.id] : [];
      const next = base.includes(c.id) ? base.filter((x) => x !== c.id) : [...base, c.id];
      setMulti(next);
      setSelected(c);
      return;
    }
    setMulti([]);
    setSelected(c);
  };

  /** Select and scroll to a commit: stay in the results if it's in the current filter, otherwise clear the filter conditions */
  const jumpToCommit = useCallback(
    async (id: string) => {
      const row = await api.logLocate(id, query.filter, query.sort).catch(() => null);
      if (row == null) return locate(id);
      setMulti([]);
      setJump({ row, n: Date.now() });
      setSelectAfterLoad({ row, id });
    },
    [query, locate],
  );

  // Changes pushed by file watching: refs changed → refresh the log; worktree changed → refresh the commit panel and the worktree diff being viewed
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!repo) return;
    return onRepoChanged((scopes) => {
      if (scopes.includes("refs")) refreshFromWatch();
      else if (scopes.includes("status")) {
        refreshStatus();
        // Files changed by the latest step were changed elsewhere: that step must show as not undoable on the timeline (spec §16)
        oplogRefresh.current();
        const t = targetRef.current;
        if (t?.kind === "worktree") loadDiff(t, true);
      }
      // Stash or shelf changed elsewhere (e.g. git stash on the command line): refresh only these two lists (re-reading the repository refreshes them too)
      if (!scopes.includes("refs") && (scopes.includes("stash") || scopes.includes("shelf"))) ssRefresh.current();
    });
  }, [repo?.path, refreshFromWatch, refreshStatus, loadDiff]);

  const committed = (r: CommitCreated, files: number, push: boolean, amend = false) => {
    setRepo(r.state);
    setLogKey(`${r.state.path}#${Date.now()}`);
    setSelectAfterLoad({ row: 0, id: r.id });
    refreshStatus();
    refreshRefs();
    if (target?.kind === "worktree") {
      setTarget(null);
      setTab("log");
    }
    say(amend ? t("已修订上一次提交") : t("已提交 {0} 个文件", files), r.op);
    if (push) remote.pushAfterCommit();
  };

  useEffect(() => {
    if (!selectAfterLoad) return;
    const r = log.row(selectAfterLoad.row);
    if (r) selRow.current = selectAfterLoad.row;
    if (r && (!selectAfterLoad.id || r.commit.id === selectAfterLoad.id)) {
      setSelected(r.commit);
      setSelectAfterLoad(null);
    }
  });

  // ⌘F / Ctrl+F: focus the log search box
  const logVisible = !!repo && tab === "log" && !(session && !conflictHidden);
  /** Scroll to row and select it (if not loaded yet, select after it loads) */
  const goRow = (row: number) => {
    if (log.total === 0) return;
    const next = Math.max(0, Math.min(log.total - 1, row));
    setMulti([]);
    selRow.current = next;
    setJump({ row: next, n: Date.now() });
    const r = log.row(next);
    if (r) setSelected(r.commit);
    else setSelectAfterLoad({ row: next });
  };
  /** Select the previous or next commit */
  const step = (d: 1 | -1) => goRow((selRow.current ?? -1) + d);
  /** ⌘D: open the selected commit's first file (in list order) in the diff tab, then switch files with ⌥← ⌥→ */
  const diffSelected = (c: Commit) =>
    api.commitDetail(c.id).then(
      (d) => {
        const paths = d.files.map((f) => f.path);
        const first = (settings().groupByDir ? treeOrder(paths, (p) => p) : paths)[0];
        if (first) openDiff({ kind: "commit", id: c.id, path: first });
      },
      () => {},
    );
  const keyCtx = useRef({ caps, selected, multi, commitOps, jumpToCommit, step, diffSelected });
  keyCtx.current = { caps, selected, multi, commitOps, jumpToCommit, step, diffSelected };
  useEffect(() => {
    if (!logVisible) return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFocusSearch(Date.now());
        return;
      }
      const t = e.target as HTMLElement;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d" && !t.closest("input, textarea, [contenteditable=true]")) {
        const k = keyCtx.current;
        if (k.selected && k.multi.length < 2) {
          e.preventDefault();
          k.diffSelected(k.selected);
        }
        return;
      }
      // →/← jump to parent and child commits, ↑/↓ previous and next commit, F2 reword (spec §5.4, §12.3)
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, [contenteditable=true], [role=dialog], .menu, .picker")) return;
      const k = keyCtx.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        k.step(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (!k.selected || k.multi.length >= 2) return;
      if (e.key === "ArrowRight" && k.caps?.parent) {
        e.preventDefault();
        k.jumpToCommit(k.caps.parent);
      } else if (e.key === "ArrowLeft" && k.caps?.child) {
        e.preventDefault();
        k.jumpToCommit(k.caps.child);
      } else if (e.key === "F2" && k.caps?.reword.ok) {
        e.preventDefault();
        k.commitOps.reword(k.selected);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [logVisible]);

  const setUiCb = useCallback((u: LogUi) => setUi(u), []);

  // Command palette (spec §12.1): ⌘K opens or closes it globally; ⌘, opens settings
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Open settings at a section (the commit panel's "set identity" opens the Git settings) */
  const [settingsSection, setSettingsSection] = useState<"git" | undefined>(undefined);
  /** Bumped when settings close, so the commit panel re-reads the commit identity */
  const [configKey, setConfigKey] = useState(0);
  const [repoPop, setRepoPop] = useState<{ x: number; y: number } | null>(null);
  const [wtDialog, setWtDialog] = useState<{ branch?: string } | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const cloneDialog = cloneOpen ? (
    <CloneDialog
      defaultDir={repo ? repo.path.replace(/[\\/][^\\/]*[\\/]?$/, "") : null}
      onClose={() => setCloneOpen(false)}
      onDone={(p) => {
        setCloneOpen(false);
        open(p);
      }}
    />
  ) : null;
  const recent = useRecentRepos();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (!repo) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [repo]);

  // File tabs: ⌘W closes the file (or diff) tab shown, and the window when neither is; ⇧⌘T reopens the last closed file; ⌘E lists recent files
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [recentFiles, setRecentFiles] = useState(false);
  const [recentQ, setRecentQ] = useState("");
  const reopenFile = () => {
    const last = closedRef.current[closedRef.current.length - 1];
    if (!last) return;
    closedRef.current = closedRef.current.slice(0, -1);
    openFile(last);
  };
  const reopenRef = useRef(reopenFile);
  reopenRef.current = reopenFile;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Leave it to open dialogs, menus and palettes
      if (document.querySelector(".modal-back, .palette, .menu")) return;
      if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        if (tabRef.current === "file" && fileOpenRef.current) closeFiles([fileOpenRef.current]);
        else if (tabRef.current === "diff") (setTarget(null), setTab("log"));
        else void api.windowClose();
      } else if (k === "t" && e.shiftKey && repo) {
        e.preventDefault();
        reopenRef.current();
      } else if (k === "e" && !e.shiftKey && repo) {
        e.preventDefault();
        setRecentQ("");
        setRecentFiles((o) => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [repo, closeFiles]);

  // ⌘Z undo, ⇧⌘Z redo (left to input boxes inside inputs; the conflict view has its own undo)
  const undoKeys = !!repo && !(session && !conflictHidden) && !undoBlocked;
  const oplogRef = useRef(oplog);
  oplogRef.current = oplog;
  useEffect(() => {
    if (!undoKeys) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      e.preventDefault();
      if (e.shiftKey) oplogRef.current.redo();
      else oplogRef.current.undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undoKeys]);

  // App updates: checked on startup when enabled; the card shows the new version and download progress
  const updates = useUpdates({ say });

  if (!git) return <div className="center dim">{t("正在检测 Git…")}</div>;

  if (!git.ok) {
    return (
      <div className="center">
        <div className="card">
          <h1>{git.found ? t("Git 版本过低") : t("没有找到 Git")}</h1>
          <p>
            {t("Strand 需要系统里安装 Git {0} 或更高版本", git.min_version)}
            {git.found && git.version ? t("，当前是 {0}", git.version) : ""}
            {t("。")}
          </p>
          <p className="dim">{t("安装后重新打开 Strand。下载地址：git-scm.com/downloads")}</p>
        </div>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="center">
        <div className="card">
          <h1>{t("打开一个仓库")}</h1>
          <p className="dim">{t("选择一个 Git 仓库所在的文件夹。")}</p>
          {error && <p className="err">{tr(error)}</p>}
          <div className="welcome-btns">
            <button type="button" className="primary" onClick={choose} disabled={busy}>
              {busy ? t("正在读取…") : t("选择文件夹")}
            </button>
            <button type="button" className="btn" onClick={() => setCloneOpen(true)} disabled={busy}>
              {t("克隆仓库…")}
            </button>
          </div>
          {recent.length > 0 && (
            <>
              <div className="dim small welcome-sec">{t("最近打开")}</div>
              <RepoList current={null} onOpen={open} autoFocus={false} />
            </>
          )}
        </div>
        {cloneDialog}
        <UpdateCard u={updates} />
      </div>
    );
  }

  // Command palette commands (spec §12.1), calling the same operations as icon buttons and context menus
  const normal = repo.state === "normal";
  const busyWhy = t("合并或变基还没完成");
  const paletteCommands = (): PaletteCommand[] => {
    const v = t("视图");
    const o = t("操作");
    const b = t("分支");
    const list: PaletteCommand[] = [
      { id: "go-log", section: v, icon: COMMIT_ICONS.history, label: t("转到历史"), run: () => setTab("log") },
      { id: "go-console", section: v, icon: COMMIT_ICONS.console, label: t("转到控制台"), run: () => setTab("console") },
      { id: "go-changes", section: v, icon: COMMIT_ICONS.changes, label: t("转到改动"), run: () => setPanel("commit") },
      { id: "fetch", section: o, icon: COMMIT_ICONS.fetch, label: t("抓取"), run: () => remote.fetch() },
      ...(repo.submodules
        ? [{ id: "submodules", section: o, icon: COMMIT_ICONS.pull, label: t("更新全部子模块"), disabled: !!remote.running, why: t("网络操作进行中"), run: () => void remote.submoduleUpdate([]) }]
        : []),
      ...(repo.lfs ? [{ id: "lfs-pull", section: o, icon: COMMIT_ICONS.fetch, label: t("下载 LFS 文件"), disabled: !!remote.running, why: t("网络操作进行中"), run: () => void lfsPull() }] : []),
      { id: "pull", section: o, icon: COMMIT_ICONS.pull, label: t("拉取"), run: () => remote.pull(), disabled: !normal || !cur?.upstream, why: !normal ? busyWhy : t("这个分支没有跟踪的远程分支") },
      { id: "push", section: o, icon: COMMIT_ICONS.push, label: t("推送"), run: () => remote.openPush(), disabled: repo.head.kind !== "branch", why: t("现在不在任何分支上") },
      { id: "undo", section: o, icon: COMMIT_ICONS.undo, label: t("撤销上一步"), hint: keys("⌘Z"), run: () => oplog.undo(), disabled: !oplog.list.can_undo || undoBlocked, why: undoBlocked ? busyWhy : t("没有可以撤销的操作") },
      { id: "redo", section: o, icon: COMMIT_ICONS.redo, label: t("重做"), hint: keys("⇧⌘Z"), run: oplog.redo, disabled: !oplog.list.can_redo || undoBlocked, why: undoBlocked ? busyWhy : t("没有可以重做的操作") },
      { id: "apply-patch", section: o, icon: COMMIT_ICONS.applyPatch, label: t("应用补丁…"), run: () => setApplying({ text: "" }), disabled: !normal, why: busyWhy },
      { id: "new-branch", section: b, icon: COMMIT_ICONS.branch, label: t("新建分支…"), run: () => ops.create() },
      { id: "checkout-rev", section: b, icon: COMMIT_ICONS.checkout, label: t("检出标签或指定版本…"), run: () => ops.checkoutRev(), disabled: !normal, why: busyWhy },
      ...(refs?.branches ?? [])
        .filter((x) => !x.is_current)
        .map((x) => ({ id: "switch-" + x.name, section: b, icon: COMMIT_ICONS.switch, label: t("切换到 {0}", x.name), run: () => ops.switchTo(x.name), disabled: !normal, why: busyWhy })),
      { id: "rebase", section: t("变基"), icon: COMMIT_ICONS.rebase, label: t("整理当前分支的提交…"), run: () => rebase.open(), disabled: !normal, why: busyWhy },
    ];
    if (session) {
      const c = t("冲突");
      list.push(
        { id: "conflicts", section: c, icon: COMMIT_ICONS.conflict, label: t("继续解决冲突"), run: () => setConflictHidden(false) },
        {
          id: "conflict-list",
          section: c,
          icon: COMMIT_ICONS.changes,
          label: t("打开冲突列表"),
          run: () => {
            setConflictHidden(false);
            setConflictCmd({ kind: "list", n: Date.now() });
          },
        },
        {
          id: "conflict-auto",
          section: c,
          icon: COMMIT_ICONS.merge,
          label: t("接受所有没有冲突的修改块"),
          run: () => {
            setConflictHidden(false);
            setConflictCmd({ kind: "auto", n: Date.now() });
          },
        },
        { id: "abort", section: c, icon: COMMIT_ICONS.cancel, label: t("中止合并…"), run: ops.abortMerge },
      );
    }
    const m = t("其他");
    list.push(
      { id: "remotes", section: o, icon: COMMIT_ICONS.fetch, label: t("管理远程…"), run: () => setRemotesOpen(true) },
      { id: "reflog", section: m, icon: COMMIT_ICONS.history, label: t("查看操作记录（reflog）…"), run: () => setReflogOpen(true) },
      { id: "jump", section: m, icon: COMMIT_ICONS.jump, label: t("跳到提交…"), run: jumpTo },
      { id: "search", section: m, icon: COMMIT_ICONS.search, label: t("搜索日志"), hint: keys("⌘F"), run: () => {
        setTab("log");
        setFocusSearch(Date.now());
      } },
      { id: "tree", section: m, icon: COMMIT_ICONS.sidebar, label: treeOpen ? t("隐藏分支树") : t("显示分支树"), run: toggleTree },
      { id: "panel", section: m, icon: COMMIT_ICONS.sidebar, label: panelOpen ? t("隐藏提交面板") : t("显示提交面板"), run: togglePanel },
      { id: "shelf", section: m, icon: COMMIT_ICONS.shelf, label: t("打开暂存架"), run: () => setPanel("shelf") },
      { id: "stash", section: m, icon: COMMIT_ICONS.stash, label: t("打开贮藏"), run: () => setPanel("stash") },
      { id: "files", section: m, icon: COMMIT_ICONS.tree, label: t("项目文件（目录树和文件修改链）"), run: () => {
        setPanel("files");
        if (!panelOpen) togglePanel();
      } },
      { id: "stash-push", section: m, icon: COMMIT_ICONS.stash, label: t("贮藏全部改动"), run: () => ss.stash(status?.untracked ?? []), disabled: !normal, why: busyWhy },
      { id: "reload", section: m, icon: COMMIT_ICONS.reload, label: t("重新读取仓库"), run: reload },
      { id: "repos", section: m, icon: COMMIT_ICONS.repo, label: t("切换仓库…"), run: () => setRepoPop({ x: 12, y: 48 }) },
      { id: "open", section: m, icon: COMMIT_ICONS.folder, label: t("打开仓库…"), run: choose },
      { id: "clone", section: m, icon: COMMIT_ICONS.clone, label: t("克隆仓库…"), run: () => setCloneOpen(true) },
      { id: "worktree-add", section: m, icon: COMMIT_ICONS.folder, label: t("新建工作目录…"), run: () => setWtDialog({}) },
      { id: "recent-files", section: m, icon: COMMIT_ICONS.history, label: t("最近的文件…"), hint: keys("⌘E"), run: () => (setRecentQ(""), setRecentFiles(true)) },
      { id: "reopen-file", section: m, icon: COMMIT_ICONS.history, label: t("重新打开关掉的标签页"), hint: keys("⇧⌘T"), disabled: !closedRef.current.length, why: t("还没有关过标签页"), run: reopenFile },
      { id: "settings", section: m, icon: COMMIT_ICONS.gear, label: t("设置…"), hint: keys("⌘,"), run: () => setSettingsOpen(true) },
      { id: "update-check", section: m, icon: COMMIT_ICONS.gear, label: t("检查更新…"), run: () => updates.check(true) },
      { id: "git-config", section: m, icon: COMMIT_ICONS.gear, label: t("Git 配置（用户名、邮箱、代理）…"), run: () => (setSettingsSection("git"), setSettingsOpen(true)) },
      { id: "lang-zh", section: m, icon: COMMIT_ICONS.web, label: "中文", run: () => setLang("zh") },
      { id: "lang-en", section: m, icon: COMMIT_ICONS.web, label: "English", run: () => setLang("en") },
      { id: "keys", section: m, icon: COMMIT_ICONS.keys, label: t("查看快捷键"), run: () =>
        ask({ title: t("快捷键"), items: SHORTCUTS.map(([k, d]) => `${keys(k)}　${t(d)}`), confirm: t("关闭"), onSubmit: () => {} }) },
    );
    return list;
  };

  // Cherry-pick or revert only some files, get a file from a revision (like the file context menu in JetBrains commit details)
  const openPickFiles = (c: Commit, initial: string[], revert: boolean, files?: FileChange[]) => {
    if (files) return setPickFiles({ commit: c, files, initial, revert });
    api.commitDetail(c.id).then(
      (d) => setPickFiles({ commit: c, files: d.files, initial, revert }),
      (e) => failedCb(msgOf(e)),
    );
  };
  const restoreFile = (c: Commit, f: FileChange) => {
    const del = f.status === "D";
    const local = status?.changes.some((x) => x.path === f.path) || status?.untracked.includes(f.path);
    ask({
      title: del ? t("删除工作区里的 {0}", f.path) : t("把 {0} 取回到这个版本", f.path),
      message: del
        ? t("这个提交删掉了这个文件，取回这个版本就是把工作区里的它删掉。可以在操作时间线里撤销。")
        : local
          ? t("工作区里这个文件的改动会被 {0} 的内容替换。可以在操作时间线里撤销。", shortId(c.id))
          : t("工作区里的文件换成 {0} 的内容，成为一处改动，检查后再提交。可以在操作时间线里撤销。", shortId(c.id)),
      confirm: del ? t("删除") : t("取回"),
      danger: del || !!local,
      onSubmit: () => runWrite(api.fileRestore(c.id, f.path), del ? t("已删除 {0}", f.path) : t("已把 {0} 取回到 {1}", f.path, shortId(c.id))),
    });
  };
  const commitFileMenu = (c: Commit, f: FileChange, files: FileChange[], x: number, y: number) => {
    const ok = repo?.state === "normal" && !repo?.bisecting;
    const why = t("合并或变基还没完成");
    setMenu({
      x,
      y,
      items: [
        { label: t("查看差异"), icon: COMMIT_ICONS.compare, run: () => openDiff({ kind: "commit", id: c.id, path: f.path }) },
        { label: t("查看这个文件的历史"), icon: COMMIT_ICONS.history, run: () => openFile(f.path, undefined, true) },
        "-",
        { label: t("把这个文件的改动拣选到工作区"), icon: COMMIT_ICONS.cherry, disabled: !ok, why, run: () => openPickFiles(c, [f.path], false, files) },
        { label: t("在工作区还原这个文件的改动"), icon: COMMIT_ICONS.revert, disabled: !ok, why, run: () => openPickFiles(c, [f.path], true, files) },
        { label: f.status === "D" ? t("取回这个版本（删除工作区里的文件）…") : t("取回这个版本的文件…"), icon: COMMIT_ICONS.checkout, disabled: !ok, why, run: () => restoreFile(c, f) },
      ],
    });
  };

  // Compare any two files, compare with clipboard (like JetBrains' Compare Files / Compare with Clipboard): reads worktree content
  const readSide = async (path: string): Promise<TextSide> => {
    const f = await api.fileText(path, null);
    if (f.missing) throw new Error(t("工作区里没有 {0}", path));
    if (f.truncated) throw new Error(t("{0} 太大，不能比较", path));
    return { label: path, text: f.binary ? null : f.text ?? "", file: path };
  };
  const compareFiles = async (a: string, b: string) => {
    try {
      const [l, r] = await Promise.all([readSide(a), readSide(b)]);
      if ((l.text === null) !== (r.text === null)) return failedCb(t("一个是文本文件、一个是二进制文件，不能比较"));
      if (l.text === null && !(isImage(a) && isImage(b))) return failedCb(t("两个都是二进制文件，只有图片能比较"));
      setCmpLeft(null);
      openDiff({ kind: "texts", path: b, left: l, right: r });
    } catch (e) {
      failedCb(e instanceof Error ? e.message : msgOf(e));
    }
  };
  const compareClipboard = async (path: string) => {
    let clip = "";
    try {
      // In the desktop app the web clipboard API needs another "Paste" click or is refused outright, so the shell reads it
      clip = await api.clipboardText();
    } catch {
      return failedCb(t("读不到剪贴板"));
    }
    if (!clip) return say(t("剪贴板里没有文字"));
    try {
      const l = await readSide(path);
      if (l.text === null) return failedCb(t("二进制文件不能和剪贴板比较"));
      openDiff({ kind: "texts", path, left: l, right: { label: t("剪贴板"), text: clip } });
    } catch (e) {
      failedCb(e instanceof Error ? e.message : msgOf(e));
    }
  };
  const compareItems = (path: string): MenuEntry[] => [
    ...(cmpLeft && cmpLeft !== path ? [{ label: t("和 {0} 比较", cmpLeft), icon: COMMIT_ICONS.compare, run: () => compareFiles(cmpLeft, path) }] : []),
    {
      label: cmpLeft === path ? t("已选为比较的左边") : t("选为比较的左边"),
      icon: COMMIT_ICONS.base,
      checked: cmpLeft === path,
      run: () => {
        setCmpLeft(path);
        say(t("已选 {0}。再在另一个文件上右键，选“和 {0} 比较”", path));
      },
    },
    { label: t("和剪贴板比较"), icon: COMMIT_ICONS.copy, run: () => compareClipboard(path) },
  ];
  const projectFileMenu = (path: string, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: t("打开"), icon: COMMIT_ICONS.tree, run: () => openFile(path) },
        { label: t("查看这个文件的历史"), icon: COMMIT_ICONS.history, run: () => openFile(path, undefined, true) },
        "-",
        ...compareItems(path),
      ],
    });

  // Context menu for files in the commit panel (spec §12.2)
  const fileMenu = (path: string, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: t("查看差异"), icon: COMMIT_ICONS.compare, run: () => openDiff({ kind: "worktree", path }) },
        { label: t("查看这个文件的历史"), icon: COMMIT_ICONS.history, run: () => {
          setUi((u) => ({ ...u, path }));
          setTab("log");
        } },
        { label: t("逐行追溯"), icon: COMMIT_ICONS.patch, run: () => setBlame({ path, rev: null }), disabled: status?.changes.find((c) => c.path === path)?.status === "D", why: t("文件已经删除") },
        "-",
        ...(status?.changes.find((c) => c.path === path)?.status === "D" ? [] : [...compareItems(path), "-" as const]),
        { label: t("丢弃改动…"), icon: COMMIT_ICONS.drop, run: () => discard([path]), danger: true, disabled: !normal, why: busyWhy },
      ],
    });

  return (
    <div className="window">
      <Toolbar
        repo={repo}
        onRepos={(x, y) => setRepoPop({ x, y })}
        onSettings={() => setSettingsOpen(true)}
        onReload={reload}
        onBranch={() => setPopup(true)}
        onAbortMerge={ops.abortMerge}
        onPalette={() => setPalette(true)}
        panel={{ open: panelOpen, count: (status?.changes.length ?? 0) + (status?.untracked.length ?? 0), onToggle: togglePanel }}
        undo={{
          can: oplog.list.can_undo && !undoBlocked && !oplog.busy,
          canRedo: oplog.list.can_redo && !undoBlocked && !oplog.busy,
          undoTip: undoBlocked ? t("合并进行中：在合并窗口里撤销标记，或中止合并") : oplog.nextUndo && !oplog.nextUndo.undoable ? t("不能撤销“{0}”：{1}", tr(oplog.nextUndo.label), tr(oplog.nextUndo.reason) || t("仓库在别处被修改过")) : oplog.nextUndo ? t("撤销：{0}（⌘Z）", tr(oplog.nextUndo.label)) : t("没有可以撤销的操作"),
          redoTip: undoBlocked ? t("合并进行中") : oplog.nextRedo ? t("重做：{0}（⇧⌘Z）", tr(oplog.nextRedo.label)) : t("没有可以重做的操作"),
          onUndo: () => oplog.undo(),
          onRedo: oplog.redo,
        }}
        onShowConflicts={session && conflictHidden ? () => setConflictHidden(false) : undefined}
        conflictLeft={session ? conflictLeft : null}
        busy={busy}
        remote={remote}
        ahead={cur?.ahead ?? 0}
        behind={cur?.needs_force ? 0 : cur?.behind ?? 0}
        needsForce={!!cur?.needs_force}
        hasUpstream={!!cur?.upstream}
        onPullMenu={(x, y) =>
          setMenu({
            x,
            y,
            items: [
              { label: (remote.pullMode === "merge" ? "✓ " : "　 ") + t("合并方式：生成一个合并提交"), run: () => remote.setPullMode("merge") },
              { label: (remote.pullMode === "rebase" ? "✓ " : "　 ") + t("变基方式：本地提交接到远程提交之后"), run: () => remote.setPullMode("rebase") },
            ],
          })
        }
      />
      {error && (
        <div className="banner err" role="alert">
          {tr(error)}
          <button type="button" onClick={() => setError(null)} aria-label={t("关闭")}>
            ×
          </button>
        </div>
      )}
      {session && !conflictHidden ? (
        <ConflictView
          session={session}
          repo={repo}
          onDone={(st, message, op) => {
            setSession(null);
            doneCb(st, message, op);
          }}
          onChanged={(st) => {
            setRepo(st);
            setLogKey(`${st.path}#${Date.now()}`);
            refreshStatus();
            refreshSession();
          }}
          onLater={() => setConflictHidden(true)}
          onAbort={ops.abortMerge}
          onError={(m) => setError(m)}
          onProgress={setConflictLeft}
          command={conflictCmd}
        />
      ) : (
      <div ref={panesRef} style={paneVars(settings())} className={"panes" + (wide ? " no-detail" : "") + (panelOpen ? "" : " no-panel")}>
        {/* Splitters (drag to resize): keep at least 420 px in the middle */}
        {panelOpen && (
          <Splitter
            name="paneLeft"
            host={panesRef}
            grow="right"
            min={260}
            max={() => (panesRef.current?.clientWidth ?? 1200) - (wide ? 0 : settings().paneRight) - 420}
            label={t("调整提交面板的宽度")}
          />
        )}
        {!wide && (
          <Splitter
            name="paneRight"
            host={panesRef}
            grow="left"
            min={260}
            max={() => (panesRef.current?.clientWidth ?? 1200) - (panelOpen ? settings().paneLeft : 0) - 420}
            label={t("调整提交详情的宽度")}
          />
        )}
        {panelOpen && (
        <aside className="commit-panel">
          <div className="ptabs" role="tablist">
            {(
              [
                ["commit", t("提交"), 0],
                ["shelf", t("暂存架"), ss.shelves.length],
                ["stash", t("贮藏"), ss.stashes.length],
                ["files", t("文件"), 0],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} type="button" role="tab" aria-selected={panel === k} onClick={() => setPanel(k)}>
                {label}
                {n > 0 && <span className="dim"> {n}</span>}
              </button>
            ))}
          </div>
          {panel === "files" && (
            <ProjectFiles
              status={status}
              active={tab === "file" ? fileOpen : null}
              reloadKey={`${logKey}|${status?.untracked.length ?? 0}|${status?.changes.length ?? 0}`}
              refs={refs}
              onOpen={openFile}
              onMenu={projectFileMenu}
            />
          )}
          {panel === "shelf" && (
            <ShelfPanel
              ops={ss}
              disabled={repo.state !== "normal"}
              activePath={tab === "diff" && target?.kind === "shelf" ? `${target.id}:${target.path}` : null}
              onOpenDiff={(e, path) => openDiff({ kind: "shelf", id: e.id, name: e.name, path })}
            />
          )}
          {panel === "stash" && (
            <StashPanel
              ops={ss}
              disabled={repo.state !== "normal"}
              activePath={tab === "diff" && target?.kind === "commit" ? `${target.id}:${target.path}` : null}
              onOpenDiff={(id, path) => openDiff({ kind: "commit", id, path })}
            />
          )}
          {panel === "commit" && (
          <CommitPanel
            configKey={configKey}
            onOpenGitSettings={() => (setSettingsSection("git"), setSettingsOpen(true))}
            repoPath={repo.path}
            onRefresh={() => refreshStatus()}
            onWritten={doneCb}
            onShelve={(paths, askName) => ss.shelve(paths, askName, status?.untracked ?? [])}
            onPickedChange={setPanelSel}
            lineSel={lineSel}
            onClearLines={(p) =>
              setLineSel((m) => {
                const n = { ...m };
                delete n[p];
                return n;
              })
            }
            onDiscard={discard}
            onUntracked={onUntracked}
            onBlame={(path) => setBlame({ path, rev: null })}
            onFileMenu={fileMenu}
            onApplyPatch={() => setApplying({ text: "" })}
            onPatch={(sel) => openPatch(t("{0} 个文件的补丁", sel.files.length), api.patchWorktree(sel), "changes.patch")}
            onStash={() => ss.stash(status?.untracked ?? [])}
            status={status}
            disabled={repo.state !== "normal"}
            activePath={tab === "diff" && target?.kind === "worktree" ? target.path : null}
            onOpenDiff={(path) => openDiff({ kind: "worktree", path })}
            onCommitted={committed}
          />
          )}
        </aside>
        )}
        <main className="main">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
              {t("Git 日志")} <span className="dim">{log.total}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>
              {t("控制台")}
            </button>
            {files.map((f, i) => {
              const name = f.path.slice(f.path.lastIndexOf("/") + 1);
              // Two open files with the same name: show the folder too
              const dup = files.some((g) => g !== f && g.path.slice(g.path.lastIndexOf("/") + 1) === name);
              const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
              const on = tab === "file" && fileOpen === f.path;
              return (
                <div
                  key={f.path}
                  role="tab"
                  tabIndex={0}
                  aria-selected={on}
                  className={"ftab" + (on ? " on" : "") + (f.pinned ? " pinned" : "")}
                  title={f.path}
                  onClick={() => showFile(f.path)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeFiles([f.path]);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") (e.preventDefault(), showFile(f.path));
                    if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), closeFiles([f.path]));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // Pinned tabs stay when closing others, left, right or all
                    const loose = (l: FileTab[]) => l.filter((g) => !g.pinned).map((g) => g.path);
                    const others = loose(files.filter((g) => g !== f));
                    const left = loose(files.slice(0, i));
                    const right = loose(files.slice(i + 1));
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: t("关闭"), hint: keys("⌘W"), run: () => closeFiles([f.path]) },
                        { label: t("关闭其他标签页"), disabled: !others.length, run: () => closeFiles(others) },
                        { label: t("关闭左侧的标签页"), disabled: !left.length, run: () => closeFiles(left) },
                        { label: t("关闭右侧的标签页"), disabled: !right.length, run: () => closeFiles(right) },
                        { label: t("关闭全部文件"), disabled: !loose(files).length, why: t("只剩固定的标签页"), run: () => closeFiles(loose(files)) },
                        { label: t("重新打开关掉的标签页"), hint: keys("⇧⌘T"), disabled: !closedRef.current.length, why: t("还没有关过标签页"), run: reopenFile },
                        "-",
                        f.pinned
                          ? { label: t("取消固定"), icon: PIN_ICON, run: () => pinFile(f.path, false) }
                          : { label: t("固定标签页"), icon: PIN_ICON, run: () => pinFile(f.path, true) },
                        { label: t("最近的文件…"), hint: keys("⌘E"), run: () => setRecentFiles(true) },
                        { label: t("复制路径"), icon: COMMIT_ICONS.copy, run: () => void navigator.clipboard.writeText(f.path) },
                        { label: t("查看这个文件的历史"), icon: COMMIT_ICONS.history, run: () => openFile(f.path, undefined, true) },
                      ],
                    });
                  }}
                >
                  <TypeIcon path={f.path} />
                  <span className="ftab-name">{name}</span>
                  {dup && dir && <span className="ftab-dir dim">{dir.slice(dir.lastIndexOf("/") + 1)}</span>}
                  {f.pinned ? (
                    <button
                      type="button"
                      className="ftab-x ftab-pin"
                      tabIndex={-1}
                      title={t("已固定，点一下取消固定")}
                      aria-label={t("取消固定 {0}", name)}
                      onClick={(e) => {
                        e.stopPropagation();
                        pinFile(f.path, false);
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={PIN_ICON} />
                      </svg>
                    </button>
                  ) : (
                  <button
                    type="button"
                    className="ftab-x"
                    tabIndex={-1}
                    title={t("关闭（鼠标中键）")}
                    aria-label={t("关闭 {0}", name)}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFiles([f.path]);
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                    </svg>
                  </button>
                  )}
                </div>
              );
            })}
            {target && (
              <button type="button" role="tab" aria-selected={tab === "diff"} onClick={() => setTab("diff")}>
                {t("差异 ·")} {target.path.split("/").pop()}
              </button>
            )}
          </div>
          <div className="tabpanel log-split" ref={logSplitRef} hidden={tab !== "log"}>
            {treeOpen && (
              <Splitter
                name="paneTree"
                host={panesRef}
                grow="right"
                min={160}
                max={() => Math.min(480, (logSplitRef.current?.clientWidth ?? 800) - 360)}
                label={t("调整分支树的宽度")}
              />
            )}
            {treeOpen && (
              <BranchTree
                refs={refs}
                ops={branchOps}
                favs={favs}
                toggleFav={toggleFav}
                merging={repo.state !== "normal"}
                picked={ui.branch}
                onPick={(name) => setUi((u) => ({ ...u, branch: u.branch === name ? null : name }))}
                onLocate={locate}
                onMenu={(x, y, items) => setMenu({ x, y, items })}
                onPushTag={remote.pushTag}
                onRemotes={() => setRemotesOpen(true)}
                subs={subs}
                remote={{
                  fetch: () => remote.fetch(),
                  pull: () => remote.pull(),
                  pullWhy: repo.state !== "normal" ? t("合并还没完成") : repo.head.kind !== "branch" ? t("现在不在任何分支上") : !cur?.upstream ? t("这个分支没有跟踪的远程分支") : null,
                }}
              />
            )}
            <div className="log-col">
            <LogFilterBar
              ui={ui}
              onChange={setUiCb}
              refs={refs}
              treeOpen={treeOpen}
              onToggleTree={toggleTree}
              onJump={jumpTo}
              onRebase={() => rebase.open()}
              onRefresh={() => {
                if (repo) setLogKey(`${repo.path}#${Date.now()}`);
                refreshRefs();
              }}
              pick={
                multi.length >= 2
                  ? { run: () => commitOps.cherryPick(multi), ok: !!multiPick?.ok, why: multiPick?.why ?? t("正在读取…"), count: multi.length }
                  : selected
                    ? { run: () => commitOps.cherryPick([selected.id]), ok: !!caps?.cherry_pick.ok, why: caps ? caps.cherry_pick.why : t("正在读取…"), count: 1 }
                    : { run: () => {}, ok: false, why: t("先选中一个提交"), count: 0 }
              }
              compareBase={compareBase}
              onExitCompare={() => setCompareBase(null)}
              // A bad author-rule regex gets a different message from the core layer; don't mark the search box red
              badRegex={log.error?.code === "INVALID_REGEX" && log.error.message === "正则表达式写得不对"}
              focus={focusSearch}
            />
            <BisectBar b={bisect} onLocate={(id) => locate(id)} />
            <LogView
              log={log}
              filtered={isFiltered(ui)}
              scrollKey={queryKey}
              onClearFilter={() => setUi((u) => ({ ...EMPTY_UI, regex: u.regex, caseSensitive: u.caseSensitive }))}
              highlight={ui.text && ui.searchIn === "message" ? { text: ui.text, regex: ui.regex, caseSensitive: ui.caseSensitive } : undefined}
              selected={selected?.id ?? null}
              multi={new Set(multi)}
              onSelect={pick}
              jump={jump}
              onJumpRow={goRow}
              headId={repo.head.commit ?? null}
              currentBranch={repo.head.kind === "branch" ? repo.head.branch ?? null : null}
              onExpand={() => setUi((u) => ({ ...u, collapse: false }))}
              onMenu={(c, x, y) => {
                if (multi.length >= 2 && multi.includes(c.id)) {
                  setMenu({
                    x,
                    y,
                    items: [
                      { label: t("拣选 {0} 个提交到当前分支", multi.length), icon: COMMIT_ICONS.cherry, run: () => commitOps.cherryPick(multi), disabled: !multiPick?.ok, why: multiPick?.why ?? t("正在读取…") },
                      "-",
                      { label: t("压缩成一个提交"), icon: COMMIT_ICONS.squash, run: () => rebase.squashMany(multi) },
                      { label: t("丢弃 {0} 个提交…", multi.length), icon: COMMIT_ICONS.drop, run: () => rebase.dropMany(multi), danger: true },
                      "-",
                      { label: t("取消多选"), icon: COMMIT_ICONS.cancel, run: () => setMulti([]) },
                    ],
                  });
                  return;
                }
                setMulti([]);
                setSelected(c);
                api.commitCaps(c.id).then(
                  (cp) => setMenu({ x, y, items: commitMenu(c, cp) }),
                  () => setMenu({ x, y, items: commitMenu(c, null) }),
                );
              }}
            />
            <Timeline oplog={oplog} disabled={undoBlocked} onReflog={() => setReflogOpen(true)} />
            </div>
          </div>
          {tab === "console" && <ConsoleView onToast={say} />}
          {files.map((f) => (
            <div key={f.path} className="tabpanel ftab-panel" hidden={!(tab === "file" && fileOpen === f.path)}>
              <FileView
                path={f.path}
                at={f.at}
                showHistory={f.chain}
                reloadKey={lfsVer}
                onLfsPull={repo?.lfs ? lfsPull : undefined}
                changed={!!status && (status.changes.some((c) => c.path === f.path) || status.untracked.includes(f.path))}
                onLocate={(id) => locate(id)}
              />
            </div>
          ))}
          {tab === "diff" && target && (
            <DiffView
              diff={diff.data}
              loading={diff.loading}
              error={diff.error}
              source={
                target.kind === "worktree"
                  ? t("工作区")
                  : target.kind === "compare"
                    ? t("比较 {0} → {1}", shortId(target.from), shortId(target.to))
                    : target.kind === "shelf"
                      ? t("暂存架“{0}”", target.name)
                      : target.kind === "texts"
                        ? t("{0} ↔ {1}", target.left.label, target.right.label)
                        : t("提交 {0}", shortId(target.id))
              }
              pick={
                target.kind === "worktree" && status?.changes.find((c) => c.path === target.path)?.status === "M"
                  ? {
                      excluded: new Set(lineSel[target.path]?.excluded ?? []),
                      onToggle: (keys, on, all) => toggleLines(target.path, keys, on, all),
                      keys: diff.pickKeys,
                    }
                  : undefined
              }
              onClose={() => {
                setTarget(null);
                setTab("log");
              }}
              find={ui.searchIn === "changes" && ui.text ? findRegExp(ui.text, ui.regex, ui.caseSensitive) : null}
              files={fileNav}
              readOnly={target.kind !== "worktree"}
              blameSides={
                target.kind === "commit"
                  ? { left: { path: target.path, rev: `${target.id}^` }, right: { path: target.path, rev: target.id } }
                  : target.kind === "compare"
                    ? { left: { path: target.path, rev: target.from }, right: { path: target.path, rev: target.to } }
                    : target.kind === "worktree"
                      ? { left: { path: target.path, rev: "HEAD" }, right: { path: target.path, rev: null } }
                      : null
              }
              imageSides={
                target.kind === "texts"
                  ? { left: target.left.file ? { path: target.left.file, rev: null } : null, right: target.right.file ? { path: target.right.file, rev: null } : null }
                  : null
              }
              onLocate={(id) => locate(id)}
              editable={
                target.kind === "worktree" && status?.changes.find((c) => c.path === target.path)?.status !== "D"
                  ? {
                      path: target.path,
                      onSaved: () => {
                        loadDiff(target, true);
                        refreshStatus();
                      },
                    }
                  : null
              }
            />
          )}
        </main>
        {/* The console uses the full width, without commit details */}
        {wide ? null : compareBase && selected && selected.id !== compareBase && multi.length < 2 ? (
          <CompareView
            from={compareBase}
            to={selected.id}
            activePath={target?.kind === "compare" && target.to === selected.id ? target.path : null}
            onPickCommit={jumpToCommit}
            onOpenDiff={(path) => openDiff({ kind: "compare", from: compareBase, to: selected.id, path })}
            onExit={() => setCompareBase(null)}
          />
        ) : (
        <Detail
          commit={selected}
          caps={caps}
          ops={commitOps}
          branch={ops.current}
          extra={extra}
          onJump={jumpToCommit}
          multi={multi}
          multiPick={multiPick}
          onClearMulti={() => setMulti([])}
          onSquashMany={() => rebase.squashMany(multi)}
          onDropMany={() => rebase.dropMany(multi)}
          activePath={target?.kind === "commit" && target.id === selected?.id ? target.path : null}
          onOpenDiff={(c, path) => openDiff({ kind: "commit", id: c.id, path })}
          onBlame={(path, rev) => setBlame({ path, rev })}
          onFileHistory={(p) => openFile(p, undefined, true)}
          repoName={repo.name}
          find={ui.searchIn === "changes" && ui.text ? { text: ui.text, regex: ui.regex, caseSensitive: ui.caseSensitive } : null}
          highlight={ui.searchIn === "message" && ui.text ? { text: ui.text, regex: ui.regex, caseSensitive: ui.caseSensitive } : null}
          onFilterPath={(path) => {
            setUi((u) => ({ ...u, path }));
            setTab("log");
          }}
          onFileMenu={commitFileMenu}
        />
        )}
      </div>
      )}
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
      {popup && (
        <BranchPopup
          refs={refs}
          ops={branchOps}
          favs={favs}
          toggleFav={toggleFav}
          merging={repo.state !== "normal"}
          common={(() => {
            const cur = refs?.branches.find((b) => b.is_current);
            const normal = repo.state === "normal";
            const busy = !!remote.running;
            return [
              { key: "pull", label: t("更新项目（拉取）"), icon: COMMIT_ICONS.pull, run: () => remote.pull(), disabled: !normal || !cur?.upstream || busy, why: busy ? t("另一个网络操作还在进行") : !normal ? t("合并或变基还没完成") : t("这个分支没有跟踪的远程分支") },
              {
                key: "commit",
                label: t("提交…"),
                icon: COMMIT_ICONS.commit,
                run: () => {
                  setPanel("commit");
                  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".cp-compose textarea")?.focus(), 50);
                },
                disabled: !status?.changes.length,
                why: t("没有改动"),
              },
              { key: "push", label: t("推送…"), icon: COMMIT_ICONS.push, run: () => remote.openPush(), disabled: repo.head.kind !== "branch" || busy, why: busy ? t("另一个网络操作还在进行") : t("现在不在任何分支上") },
              { key: "fetch", label: t("抓取"), icon: COMMIT_ICONS.fetch, run: () => remote.fetch(), disabled: busy, why: t("另一个网络操作还在进行") },
            ];
          })()}
          onShowOnly={(name) => setUi((u) => ({ ...u, branch: name }))}
          onClose={() => setPopup(false)}
        />
      )}
      {rebase.window}
      {remotesOpen && (
        <RemotesWindow
          onClose={() => setRemotesOpen(false)}
          done={doneCb}
          confirmRemove={(name, go) =>
            ask({
              title: t("删除远程 {0}", name),
              message: t("只删掉本地记下的这个远程和它的远程分支，远程仓库本身不受影响；跟踪它的本地分支不再有跟踪分支。之后可以重新添加。"),
              confirm: t("删除"),
              danger: true,
              onSubmit: () => go(),
            })
          }
        />
      )}
      {reflogOpen && (
        <ReflogWindow
          onClose={() => setReflogOpen(false)}
          onLocate={(id) => locate(id)}
          onBranch={(id) => ops.create({ rev: id, label: shortId(id) })}
          onCheckout={(id) => runWrite(api.checkoutDetached(id), t("已检出 {0}，现在不在任何分支上", shortId(id)))}
          say={say}
          busy={repo?.state !== "normal"}
        />
      )}
      {pickFiles && <PickFiles {...pickFiles} onClose={() => setPickFiles(null)} done={doneCb} failed={failedCb} say={say} />}
      {applying && <ApplyPatch initial={applying} onClose={() => setApplying(null)} done={doneCb} failed={failedCb} say={say} />}
      {patch && <PatchWindow title={patch.title} text={patch.text} name={patch.name} onClose={() => setPatch(null)} say={say} />}
      {repoPop && <RepoPopup x={repoPop.x} y={repoPop.y} current={repo.path} onOpen={open} onBrowse={choose} onClone={() => setCloneOpen(true)} onClose={() => setRepoPop(null)} />}
      {cloneDialog}
      {wtDialog && (
        <WorktreeDialog
          repoPath={repo.path}
          refs={refs}
          branch={wtDialog.branch}
          onClose={() => setWtDialog(null)}
          onDone={(path, branch, created, r) => {
            setWtDialog(null);
            const dir = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
            doneCb(r.state, created ? t("已在 {0} 新建分支 {1} 并检出", dir, branch) : t("已在 {0} 检出 {1}", dir, branch), r.op);
          }}
        />
      )}
      {recentFiles && repo && (
        <Palette
          label={t("最近的文件")}
          placeholder={t("搜索最近的文件")}
          query={recentQ}
          onQuery={setRecentQ}
          empty={t("没有最近的文件")}
          onClose={() => setRecentFiles(false)}
          rows={(() => {
            const q = recentQ.trim().toLowerCase();
            const used = fileUsed.current;
            const open = [...files].sort((a, b) => (used.get(b.path) ?? 0) - (used.get(a.path) ?? 0)).map((f) => f.path);
            const closed = [...closedRef.current].reverse().filter((p) => !open.includes(p));
            const row = (p: string, section: string) => ({
              key: section + p,
              section,
              label: p.slice(p.lastIndexOf("/") + 1),
              detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
              run: () => (setRecentFiles(false), openFile(p)),
            });
            return [...open.map((p) => row(p, t("打开的文件"))), ...closed.map((p) => row(p, t("最近关掉的")))].filter((r) => !q || (r.detail + "/" + r.label).toLowerCase().includes(q));
          })()}
        />
      )}
      {settingsOpen && <SettingsWindow git={git} repoOpen={!!repo} section={settingsSection} version={updates.version} onCheckUpdate={() => updates.check(true)} onClose={() => (setSettingsOpen(false), setSettingsSection(undefined), setConfigKey((k) => k + 1))} onRemotes={() => (setSettingsOpen(false), setRemotesOpen(true))} />}
      {palette && <CommandPalette commands={paletteCommands()} onPickCommit={(id) => locate(id)} onClose={() => setPalette(false)} />}
      {blame && <BlameWindow path={blame.path} rev={blame.rev} onClose={() => setBlame(null)} onJump={(id) => locate(id)} />}
      {treeOf && <TreeWindow id={treeOf.id} title={treeOf.title} onClose={() => setTreeOf(null)} />}
      {dialog}
      {remote.push && <PushDialog p={remote.push} onPush={remote.doPush} onClose={remote.closePush} onRemote={remote.pickPushRemote} />}
      {remote.pullPanel && <PullPanel p={remote.pullPanel} onMode={remote.previewMode} onStart={remote.startPull} onAbort={remote.abortPull} />}
      <UpdateCard u={updates} />
      {toast && (
        <div className="toast" role="status">
          {tr(toast.text)}
          {toast.op && (
            <button
              type="button"
              className="toast-undo"
              title={t("撤销：{0}", tr(toast.op.label))}
              aria-label={t("撤销")}
              onClick={() => {
                const id = toast.op!.id;
                setToast(null);
                oplog.undo(id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 2 1.5 5l3 3M1.5 5h7a4 4 0 0 1 0 8H6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
