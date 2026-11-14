// 提交面板（说明书第 4 节）：改动列表、勾选、提交说明、提交。
//
// 已实现：文件勾选（新出现的改动默认勾选）、全选、未跟踪文件列表、提交说明和标题字数、提交（⌘↵）。
// 搁置到暂存架（按勾选的文件，问名字或直接搁置）和贮藏（全部改动）在按钮行和“改动”节点上（说明书 4.7、4.9）。
// 行级勾选在差异标签页里做，这里的勾选框显示三态（全选、部分、不选），点部分态变为全选（说明书 4.3）。
// 文件行悬停出现丢弃图标；未跟踪的文件有加入版本控制、加入忽略规则、删除三个图标。
// 最上面一行工具图标（说明书 4.7）：刷新、回滚、查看差异、直接搁置、创建补丁、按目录分组、展开或折叠“改动”。
// 提交选项（说明书 4.6）：提交前格式化、提交前运行检查（命令存在仓库的 Git 配置里）、签名行。提交时先格式化再检查，
// 没通过时显示问题列表，用户选择仍然提交或取消；运行中点提交按钮取消。

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api/commands";
import type { CheckRun, ChecksInfo, CommitCreated, OpInfo, RangeCommit, RepoState, Selection, WorktreeStatus } from "../api/types";
import { FileRow, FileTree, StatusBadge, treeOrder } from "./FileRow";
import { setSettings, settings, useSettings } from "../settings";
import { t, tr } from "../i18n";
import { ChecksOptions, ChecksReport } from "./checks";

interface Props {
  /** 当前仓库路径（说明历史按仓库保存） */
  repoPath: string;
  /** 修订更早的提交（Fixup / Squash Into）之后：刷新并提示 */
  onWritten: (state: RepoState, message: string, op?: OpInfo) => void;
  status: WorktreeStatus | null;
  disabled: boolean;
  activePath: string | null;
  onOpenDiff: (path: string) => void;
  /** push 为真表示点的是“提交并推送” */
  onCommitted: (r: CommitCreated, files: number, push: boolean, amend?: boolean) => void;
  /** 搁置勾选的文件；askName 为假时直接搁置（自动命名） */
  onShelve: (paths: string[], askName: boolean) => void;
  /** 贮藏全部改动 */
  onStash: () => void;
  /** 为勾选的文件创建补丁 */
  onPatch: (sel: Selection) => void;
  /** 勾选变化时告诉外面（Fixup / Squash Into 用） */
  onPickedChange: (sel: Selection) => void;
  /** 行级勾选：路径 → 没勾的行和全部改动行（键是“块:行”） */
  lineSel: Record<string, { excluded: string[]; all: string[] }>;
  onClearLines: (path: string) => void;
  /** 丢弃这些文件的改动（会先确认） */
  onDiscard: (paths: string[]) => void;
  onUntracked: (kind: "add" | "ignore" | "delete", path: string) => void;
  /** 逐行追溯工作区里的文件 */
  onBlame: (path: string) => void;
  /** 文件的右键菜单（说明书 12.2） */
  onFileMenu: (path: string, x: number, y: number) => void;
  /** 工具行的刷新：重新读取工作区状态 */
  onRefresh: () => void;
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
const HISTORY_ICON = "M2.5 7a4.5 4.5 0 1 0 1.3-3.2M2.5 1.5v3h3M7 4.5V7l1.8 1.2";
const GENERATE_ICON = "M7 1.5l1.2 3.3L11.5 6 8.2 7.2 7 10.5 5.8 7.2 2.5 6l3.3-1.2zM11 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z";
const OPTIONS_ICON = "M2 3.5h6M11 3.5h1M2 7h1M6 7h6M2 10.5h5M10 10.5h2M9.5 2v3M4.5 5.5v3M8.5 9v3";
const REFRESH_ICON = "M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3";
const DIFF_ICON = "M3.5 1.5h7v11h-7zM5.5 5h3M7 3.5v3M5.5 9.5h3";
const GROUP_ICON = "M1.5 3h4l1 1.5h6V12h-11zM4 7.5h6M4 9.5h4";
const QUICK_SHELF_ICON = "M1.5 7h11M1.5 10.5h11M3 7v3.5M11 7v3.5M7 1v4M5 3l2 2 2-2";

export function CommitPanel({ repoPath, onWritten, status, disabled, activePath, onOpenDiff, onCommitted, onShelve, onStash, onPatch, onPickedChange, lineSel, onClearLines, onDiscard, onUntracked, onBlame, onFileMenu, onRefresh }: Props) {
  const groupDir = useSettings().groupByDir;
  // “改动”节点展开还是折叠（说明书 4.1）
  const [changesOpen, setChangesOpen] = useState(true);
  // 记录“取消勾选”的路径，这样新出现的改动自动是勾选状态
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  // 修订（说明书 4.5）：目标是当前分支上还没推送的提交，默认上一次提交
  const [amend, setAmend] = useState(false);
  const [targets, setTargets] = useState<RangeCommit[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const histKey = `strand.msgs:${repoPath}`;
  const readHistory = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(histKey) ?? "[]");
    } catch {
      return [];
    }
  };
  /** 说明历史：最近 10 条，去重，新的在前（说明书 4.6） */
  const remember = (m: string) => {
    const list = [m, ...readHistory().filter((x) => x !== m)].slice(0, 10);
    try {
      localStorage.setItem(histKey, JSON.stringify(list));
    } catch {
      /* 只在本次有效 */
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
  // 提交选项和提交前检查
  const [checks, setChecks] = useState<ChecksInfo | null>(null);
  const [showOpts, setShowOpts] = useState(false);
  /** 正在运行的步骤和它的任务号（用来取消） */
  const [phase, setPhase] = useState<{ kind: "format" | "check"; task: string } | null>(null);
  const [report, setReport] = useState<{ run: CheckRun; canCommit: boolean; resolve: (go: boolean) => void } | null>(null);
  /** 正在读取的提交选项：刚打开仓库就提交时要等它读完，不能跳过检查 */
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
  // 行级勾选把所有行都取消了的文件，按没勾选算
  const allOff = (p: string) => !!lineSel[p] && lineSel[p].excluded.length >= lineSel[p].all.length;
  const picked = useMemo(
    () => changes.filter((c) => !unchecked.has(c.path) && !allOff(c.path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, unchecked, lineSel],
  );
  /** 发给核心层的选择：部分勾选的文件带上要提交的行 */
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

  // 文件消失后，清掉它的取消勾选记录
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

  // 全部勾选时点击变为全不选，其余情况点击变为全选（说明书 4.3）
  const toggleAll = () => setUnchecked(picked.length === changes.length ? new Set(changes.map((c) => c.path)) : new Set());

  const title = msg.split("\n")[0];
  // 重命名的文件连旧路径一起搁置
  const pickedPaths = picked.flatMap((c) => (c.old_path ? [c.path, c.old_path] : [c.path]));
  const pickedKey = picked.map((c) => c.path).join("\n") + JSON.stringify(lineSel);
  useEffect(() => {
    onPickedChange(selectionOf(picked));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  /** 运行一步格式化或检查；没通过时弹出问题列表，返回是否继续提交 */
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

  /** 提交前步骤（说明书 4.4）：按提交选项先格式化（只格式化整文件勾选的文件），再检查 */
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
    if (!title.trim()) {
      setError(t("先写一句提交说明"));
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (!(await preCommit(picked))) return;
      const r = await api.commitCreate(msg, selectionOf(picked), settings().signOff);
      remember(msg.trim());
      setMsg("");
      onCommitted(r, picked.length, push);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      if (e instanceof ApiError && e.code === "EMPTY_MESSAGE") input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  /** 修订：上一次提交用 git commit --amend；更早的提交用 Fixup（有说明时是 Squash Into） */
  const doAmend = async () => {
    if (!target) return setError(targets && targets.length === 0 ? t("当前分支上没有还没推送的提交，不能修订") : t("正在读取可以修订的提交…"));
    const m = msg.trim() ? msg : null;
    if (picked.length === 0 && !m) return setError(t("勾选要并入的文件，或者写一段新的说明"));
    setBusy(true);
    try {
      if (picked.length && !(await preCommit(picked))) return;
      if (target === targets?.[0]?.id) {
        const r = await api.commitAmend(m, selectionOf(picked), settings().signOff);
        if (m) remember(m.trim());
        setMsg("");
        setAmend(false);
        onCommitted(r, picked.length, false, true);
      } else {
        if (picked.length === 0) {
          setError(t("修订更早的提交时要勾选要并入的文件"));
          return;
        }
        const w = await api.commitFixup(target, selectionOf(picked), m);
        if (m) remember(m.trim());
        setMsg("");
        setAmend(false);
        onWritten(w.state, t("已把改动并入“{0}”", targets?.find((x) => x.id === target)?.title ?? ""), w.op);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 生成说明（说明书 4.6）：按勾选的改动拼一句，用户再自己改 */
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

  // 提交完全部改动后说明框没了：刚才在用说明框（键盘提交）的话，焦点放到“没有改动”这句上，
  // 读屏会读出来，Tab 也从这里接着走，不会掉回页面开头（说明书 12.4）
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

  /** “改动”里的一个文件行；depth 是树形显示时的层级（只显示文件名） */
  const changeRow = (c: (typeof changes)[number], depth?: number) => (
              <div
                key={c.path}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onFileMenu(c.path, e.clientX, e.clientY);
                }}
                // 焦点在这一行（文件按钮或勾选框）时，Shift+F10 或菜单键打开右键菜单（说明书 12.4）
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
                      // 部分态点一下变为全选（说明书 4.3）
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
      {/* 工具图标行（说明书 4.1、4.7）：刷新、回滚、查看差异、直接搁置、创建补丁、按目录分组、展开或折叠 */}
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
            // 按列表上看到的顺序取第一个（树形显示时目录排过序）
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
          onClick={() => setChangesOpen((o) => !o)}
        >
          <BoxIcon d={changesOpen ? "M4 6l3-3 3 3M4 11l3-3 3 3" : "M4 3l3 3 3-3M4 8l3 3 3-3"} />
        </button>
      </div>
      <div className="cp-list">
        {changes.length === 0 ? (
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
              <span className="cp-node-name">{t("改动")}</span>
              <span className="dim">
                {t("已选 {0} / {1}", picked.length, changes.length)}
              </span>
            </label>
            {changesOpen &&
              (groupDir ? <FileTree items={changes} pathOf={(c) => c.path} leaf={(c, d) => changeRow(c, d)} /> : changes.map((c) => changeRow(c)))}
          </>
        )}
        {untracked.length > 0 && (
          <>
            <div className="cp-group dim">{t("未跟踪的文件")} {untracked.length}</div>
            {untracked.map((p) => (
              <div key={p} className={"frow untracked" + (activePath === p ? " active" : "")}>
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
          {history && (
            <div className="cp-history" role="listbox" aria-label={t("说明历史")}>
              {readHistory().length === 0 && <p className="dim small pad">{t("还没有说明历史")}</p>}
              {readHistory().map((m) => (
                <button
                  key={m}
                  type="button"
                  className="cp-hist-row"
                  title={m}
                  onClick={() => {
                    setMsg(m);
                    setHistory(false);
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
