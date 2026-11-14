import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errOf, inTauri, onRepoChanged, openUrl, pickFolder, revealPath } from "./api/commands";
import { CloneDialog, WorktreeDialog } from "./components/worktreeClone";
import type { Cap, Commit, CommitCaps, CommitCreated, Selection, FileDiff, GitInfo, MergeSession, OpInfo, RefsList, RepoState, Worktree, WorktreeStatus } from "./api/types";
import { COMMIT_ICONS, commitActions, useCommitOps } from "./components/commitOps";
import { useRebase } from "./components/RebaseWindow";
import { CompareView, PatchWindow, TreeWindow } from "./components/compareTools";
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
import { LogView } from "./components/LogView";
import { ConsoleView } from "./components/ConsoleView";
import { EMPTY_UI, LogFilterBar, isFiltered, toFilter, type LogUi } from "./components/LogFilterBar";
import { Toolbar } from "./components/Toolbar";
import { setLang, t, tr } from "./i18n";

/** 差异标签页显示的是什么：工作区里的文件，还是某个提交里的文件 */
type DiffTarget =
  | { kind: "worktree"; path: string }
  | { kind: "commit"; id: string; path: string }
  | { kind: "compare"; from: string; to: string; path: string }
  /** 暂存架条目里的文件（说明书 4.9） */
  | { kind: "shelf"; id: number; name: string; path: string };

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
    /* 存不了就算了，下次手动打开 */
  }
}

export default function App() {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Commit | null>(null);
  // 每次打开或刷新都换一个 key，日志缓存随之清空
  const [logKey, setLogKey] = useState<string | null>(null);
  // 日志过滤条件（说明书 5.1），只在前端保存；换仓库时清空
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
  // 提交面板开关（说明书 3.2），记在本机
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
        /* 只在本次有效 */
      }
      return !o;
    });
  const [focusSearch, setFocusSearch] = useState(0);
  // 清空条件后要跳到别的提交时，不再把旧的选中提交滚回可见区域
  const skipKeep = useRef(false);
  /** 三栏的容器和日志里分支树那一栏：分隔线往上面写宽度 */
  const panesRef = useRef<HTMLDivElement>(null);
  const logSplitRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [tab, setTab] = useState<"log" | "console" | "diff" | "file">("log");
  /** 中间“文件”标签里看的文件（项目文件和修改链） */
  const [fileOpen, setFileOpen] = useState<string | null>(null);
  /** 从内容搜索结果打开时：跳到哪一行、看哪个版本（空是工作区）；n 每次不同 */
  const [fileAt, setFileAt] = useState<{ line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null; n: number } | null>(null);
  const openFile = useCallback((p: string, at?: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null }) => {
    setFileOpen(p);
    setFileAt(at ? { ...at, n: Date.now() } : null);
    setTab("file");
  }, []);
  /** 控制台和文件视图用中间加右边的宽度，不显示提交详情 */
  const wide = tab === "console" || tab === "file";
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<{ data: FileDiff | null; loading: boolean; error: string | null }>({
    data: null,
    loading: false,
    error: null,
  });
  // 提示条；带 op 时显示撤销图标（说明书 3.5、11.1）
  const [toast, setToast] = useState<{ text: string; op?: OpInfo } | null>(null);
  const toastTimer = useRef<number>(0);
  // 日志刷新或跳转后，等那一行读出来再选中它（id 为空表示不核对编号）
  const [selectAfterLoad, setSelectAfterLoad] = useState<{ row: number; id?: string } | null>(null);
  const [jump, setJump] = useState<{ row: number; n: number } | null>(null);
  const [refs, setRefs] = useState<RefsList | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [popup, setPopup] = useState(false);
  const [dialog, ask] = useDialog();
  // 冲突会话：仓库在合并、变基等进行中时读取；“稍后继续”时先隐藏
  const [session, setSession] = useState<MergeSession | null>(null);
  const [conflictHidden, setConflictHidden] = useState(false);
  // 冲突还有几处待处理：冲突界面报上来，工具栏的“进行中”提示里显示（说明书 3.3）
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

  /** 清空过滤条件，在日志里跳到某个提交、分支或标签并选中它；找不到返回 false */
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

  // 过滤条件变了：选中的提交还在结果里就滚到它
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
        /* 只在本次有效 */
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
    setDiff((d) => ({ data: quiet ? d.data : null, loading: !quiet, error: null }));
    const p =
      t.kind === "worktree"
        ? api.diffWorktree(t.path)
        : t.kind === "compare"
          ? api.diffCompare(t.from, t.to, t.path)
          : t.kind === "shelf"
            ? api.shelfDiff(t.id, t.path)
            : api.diffCommit(t.id, t.path);
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

  const open = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const st = await api.repoOpen(path);
      rememberRepo(st.path, st.name);
      setRepo(st);
      setSelected(null);
      setTarget(null);
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
      // 启动参数指定的仓库优先，其次是上次打开的仓库
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

  // 文件监听说引用变了：Strand 自己的写操作刚读过时，核心层发现没变就不再读，日志也不用重新取
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

  // 分支和标签操作：成功后刷新日志、分支和工作区；失败时仓库也可能变了（如合并停在冲突），重新读取
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
      // 提交和引用都没变（如抓取了但没有新东西）时不重新读取日志，正在看的列表和过滤不被打断
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
  const undoBlocked = repo?.state !== "normal";
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

  // 行级勾选（说明书 4.3、10.1）：路径 → 没勾的行、全部改动行，以及记录时的改动行数；文件内容变了就重置为全选
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

  // 丢弃改动、未跟踪的文件（说明书 4.7、4.8）
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

  // 暂存架和贮藏（说明书 4.9）
  const [panel, setPanel] = useState<"commit" | "shelf" | "stash" | "files">("commit");
  const ss = useStashShelf({ refreshKey: logKey, ask, done: doneCb, failed: failedCb, say });
  const ssRefresh = useRef(ss.refresh);
  ssRefresh.current = ss.refresh;

  // 提交操作（说明书 5.6）：详情栏图标行、右键菜单、F2 共用
  const commitOps = useCommitOps({ ask, done: doneCb, failed: failedCb, say, head: repo?.head.commit });
  // 比较、补丁、查看某个版本的仓库（说明书 10.3–10.5）
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [patch, setPatch] = useState<{ title: string; text: string | null; name: string } | null>(null);
  const [treeOf, setTreeOf] = useState<{ id: string; title: string } | null>(null);
  // 逐行追溯（说明书 10.2）
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
  // 换仓库时退出比较
  useEffect(() => setCompareBase(null), [repo?.path]);
  // 分支上的“和当前分支比较”：起点是当前分支的最新提交，终点是那个分支的最新提交
  const branchOps = {
    ...ops,
    compareWith: (name: string) => {
      const head = repo?.head.commit;
      if (!head) return;
      setCompareBase(head);
      locate(name);
    },
    // 工作目录（说明书 6.6）
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
            // 有改动：关掉这个对话框后再问一次
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

  // 整理提交（说明书第 9 节）
  const rebase = useRebase({ ask, done: doneCb, failed: failedCb, say });
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
      // 分支子菜单：指向这个提交的本地分支，没有则为当前分支（说明书 5.6）
      branches: (() => {
        const all = refs?.branches ?? [];
        const here = all.filter((b) => b.head === c.id);
        const list = here.length ? here : all.filter((b) => b.is_current);
        return list.map((b) => ({ name: b.name, items: branchActions(b, branchOps, favs.has(b.name), toggleFav, repo?.state !== "normal") }));
      })(),
      jump: jumpToCommit,
      openWeb: (url: string) => openUrl(url).catch((e) => setError(errOf(e).message)),
    });

  // 选中提交的可用条件；多选时算“能不能全部拣选”
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
  // 日志刷新后清掉多选（提交可能已经变了）
  useEffect(() => setMulti([]), [logKey]);
  // 日志刷新后重新读取选中的提交：推送后“未推送”、引用标签等会变；提交已经不在了（被改写）就取消选中
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

  // 选中提交所在的行（↑ ↓ 用）
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

  /** 选中并滚动到某个提交：在当前过滤结果里就留在结果里，否则清空过滤条件 */
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

  // 文件监听推来的变化：引用变了刷新日志，工作区变了刷新提交面板和正在看的工作区差异
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!repo) return;
    return onRepoChanged((scopes) => {
      if (scopes.includes("refs")) refreshFromWatch();
      else if (scopes.includes("status")) {
        refreshStatus();
        // 在别处改了最近一步改过的文件：时间线上这一步要显示为不能撤销（说明书 16）
        oplogRefresh.current();
        const t = targetRef.current;
        if (t?.kind === "worktree") loadDiff(t, true);
      }
      // 贮藏、暂存架在别处变了（如在命令行里 git stash）：只刷新这两个列表（重新读取仓库时也会刷新）
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

  // ⌘F / Ctrl+F：聚焦日志搜索框
  const logVisible = !!repo && tab === "log" && !(session && !conflictHidden);
  /** 滚到第 row 行并选中它（还没加载时等加载完再选） */
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
  /** 选中上一个或下一个提交 */
  const step = (d: 1 | -1) => goRow((selRow.current ?? -1) + d);
  const keyCtx = useRef({ caps, selected, multi, commitOps, jumpToCommit, step });
  keyCtx.current = { caps, selected, multi, commitOps, jumpToCommit, step };
  useEffect(() => {
    if (!logVisible) return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFocusSearch(Date.now());
        return;
      }
      // →/← 跳到父提交、子提交，↑/↓ 上一个、下一个提交，F2 修改说明（说明书 5.4、12.3）
      const t = e.target as HTMLElement;
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

  // 命令面板（说明书 12.1）：⌘K 打开或关闭，全局有效；⌘, 打开设置
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // ⌘Z 撤销、⇧⌘Z 重做（输入框里留给输入框自己；冲突界面有自己的撤销）
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
      </div>
    );
  }

  // 命令面板里的命令（说明书 12.1），和图标按钮、右键菜单调用同一组操作
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
      { id: "pull", section: o, icon: COMMIT_ICONS.pull, label: t("拉取"), run: () => remote.pull(), disabled: !normal || !cur?.upstream, why: !normal ? busyWhy : t("这个分支没有跟踪的远程分支") },
      { id: "push", section: o, icon: COMMIT_ICONS.push, label: t("推送"), run: () => remote.openPush(), disabled: repo.head.kind !== "branch", why: t("现在不在任何分支上") },
      { id: "undo", section: o, icon: COMMIT_ICONS.undo, label: t("撤销上一步"), hint: keys("⌘Z"), run: () => oplog.undo(), disabled: !oplog.list.can_undo || undoBlocked, why: undoBlocked ? busyWhy : t("没有可以撤销的操作") },
      { id: "redo", section: o, icon: COMMIT_ICONS.redo, label: t("重做"), hint: keys("⇧⌘Z"), run: oplog.redo, disabled: !oplog.list.can_redo || undoBlocked, why: undoBlocked ? busyWhy : t("没有可以重做的操作") },
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
      { id: "stash-push", section: m, icon: COMMIT_ICONS.stash, label: t("贮藏全部改动"), run: ss.stash, disabled: !normal, why: busyWhy },
      { id: "reload", section: m, icon: COMMIT_ICONS.reload, label: t("重新读取仓库"), run: reload },
      { id: "repos", section: m, icon: COMMIT_ICONS.repo, label: t("切换仓库…"), run: () => setRepoPop({ x: 12, y: 48 }) },
      { id: "open", section: m, icon: COMMIT_ICONS.folder, label: t("打开仓库…"), run: choose },
      { id: "clone", section: m, icon: COMMIT_ICONS.clone, label: t("克隆仓库…"), run: () => setCloneOpen(true) },
      { id: "worktree-add", section: m, icon: COMMIT_ICONS.folder, label: t("新建工作目录…"), run: () => setWtDialog({}) },
      { id: "settings", section: m, icon: COMMIT_ICONS.gear, label: t("设置…"), hint: keys("⌘,"), run: () => setSettingsOpen(true) },
      { id: "lang-zh", section: m, icon: COMMIT_ICONS.web, label: "中文", run: () => setLang("zh") },
      { id: "lang-en", section: m, icon: COMMIT_ICONS.web, label: "English", run: () => setLang("en") },
      { id: "keys", section: m, icon: COMMIT_ICONS.keys, label: t("查看快捷键"), run: () =>
        ask({ title: t("快捷键"), items: SHORTCUTS.map(([k, d]) => `${keys(k)}　${t(d)}`), confirm: t("关闭"), onSubmit: () => {} }) },
    );
    return list;
  };

  // 提交面板里文件的右键菜单（说明书 12.2）
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
        {/* 分隔线（拖动调整宽度）：中间至少留 420 像素 */}
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
            repoPath={repo.path}
            onRefresh={() => refreshStatus()}
            onWritten={doneCb}
            onShelve={ss.shelve}
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
            onPatch={(sel) => openPatch(t("{0} 个文件的补丁", sel.files.length), api.patchWorktree(sel), "changes.patch")}
            onStash={ss.stash}
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
            {fileOpen && (
              <button type="button" role="tab" aria-selected={tab === "file"} onClick={() => setTab("file")} title={fileOpen}>
                {t("文件 ·")} {fileOpen.split("/").pop()}
              </button>
            )}
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
              // 作者规则的正则写错时核心层的提示不同，不标红搜索框
              badRegex={log.error?.code === "INVALID_REGEX" && log.error.message === "正则表达式写得不对"}
              focus={focusSearch}
            />
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
            <Timeline oplog={oplog} disabled={undoBlocked} />
            </div>
          </div>
          {tab === "console" && <ConsoleView onToast={say} />}
          {tab === "file" && fileOpen && (
            <FileView
              path={fileOpen}
              at={fileAt}
              changed={!!status && (status.changes.some((c) => c.path === fileOpen) || status.untracked.includes(fileOpen))}
              onClose={() => {
                setFileOpen(null);
                setTab("log");
              }}
              onLocate={(id) => locate(id)}
              onBlame={(path, rev) => setBlame({ path, rev })}
            />
          )}
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
                      : t("提交 {0}", shortId(target.id))
              }
              pick={
                target.kind === "worktree" && status?.changes.find((c) => c.path === target.path)?.status === "M"
                  ? {
                      excluded: new Set(lineSel[target.path]?.excluded ?? []),
                      onToggle: (keys, on, all) => toggleLines(target.path, keys, on, all),
                    }
                  : undefined
              }
              onClose={() => {
                setTarget(null);
                setTab("log");
              }}
              find={ui.searchIn === "changes" && ui.text ? findRegExp(ui.text, ui.regex, ui.caseSensitive) : null}
            />
          )}
        </main>
        {/* 控制台用整个宽度，不显示提交详情 */}
        {wide ? null : compareBase && selected && selected.id !== compareBase && multi.length < 2 ? (
          <CompareView
            from={compareBase}
            to={selected.id}
            activePath={tab === "diff" && target?.kind === "compare" && target.to === selected.id ? target.path : null}
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
          activePath={tab === "diff" && target?.kind === "commit" && target.id === selected?.id ? target.path : null}
          onOpenDiff={(c, path) => openDiff({ kind: "commit", id: c.id, path })}
          onBlame={(path, rev) => setBlame({ path, rev })}
          onFileHistory={(p) => openFile(p)}
          repoName={repo.name}
          find={ui.searchIn === "changes" && ui.text ? { text: ui.text, regex: ui.regex, caseSensitive: ui.caseSensitive } : null}
          highlight={ui.searchIn === "message" && ui.text ? { text: ui.text, regex: ui.regex, caseSensitive: ui.caseSensitive } : null}
          onFilterPath={(path) => {
            setUi((u) => ({ ...u, path }));
            setTab("log");
          }}
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
      {settingsOpen && <SettingsWindow git={git} onClose={() => setSettingsOpen(false)} />}
      {palette && <CommandPalette commands={paletteCommands()} onPickCommit={(id) => locate(id)} onClose={() => setPalette(false)} />}
      {blame && <BlameWindow path={blame.path} rev={blame.rev} onClose={() => setBlame(null)} onJump={(id) => locate(id)} />}
      {treeOf && <TreeWindow id={treeOf.id} title={treeOf.title} onClose={() => setTreeOf(null)} />}
      {dialog}
      {remote.push && <PushDialog p={remote.push} onPush={remote.doPush} onClose={remote.closePush} />}
      {remote.pullPanel && <PullPanel p={remote.pullPanel} onMode={remote.previewMode} onStart={remote.startPull} onAbort={remote.abortPull} />}
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
