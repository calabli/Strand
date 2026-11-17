// Shelf and stash (spec §4.9): the commit panel's second and third tabs, plus the "shelve" and "stash" buttons in the commit panel.
// When restoring conflicts with the worktree, the repository enters "restore in progress" and the main view switches to the conflict list (§8).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import type { FileChange, OpInfo, RepoState, ShelfEntry, StashEntry, Written } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { FileRow } from "./FileRow";
import { t } from "../i18n";

interface Deps {
  /** Changes on every repository change, refreshing the lists */
  refreshKey: string | null;
  ask: (d: DialogSpec) => void;
  done: (state: RepoState, message: string, op?: OpInfo) => void;
  failed: (message: string) => void;
  say: (message: string) => void;
}

/** A branch forking off */
const BRANCH_ICON = "M4 2v10M4 9c0-3 6-2 6-5M10 2.5v2";

export function useStashShelf({ refreshKey, ask, done, failed, say }: Deps) {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [shelves, setShelves] = useState<ShelfEntry[]>([]);

  const refresh = useCallback(() => {
    api.stashList().then(setStashes, () => setStashes([]));
    api.shelfList().then(setShelves, () => setShelves([]));
  }, []);
  useEffect(() => {
    if (refreshKey) refresh();
  }, [refreshKey, refresh]);

  const run = useCallback(
    async <T,>(p: Promise<Written<T>>, message: string): Promise<string | void> => {
      try {
        const w = await p;
        done(w.state, message, w.op);
      } catch (e) {
        const err = errOf(e);
        if (err.code === "CONFLICTS") {
          failed("");
          say(t("取回的改动和工作区有冲突，请逐个处理"));
        } else if (err.code === "INVALID_NAME") return err.message;
        else failed(err.message);
      }
    },
    [done, failed, say],
  );

  /** Stash all changes; with untracked files in the worktree, ask whether to include them (git stash -u) */
  const stash = useCallback(
    (untracked: string[] = []) => {
      if (!untracked.length) return run(api.stashPush(), t("已贮藏全部改动"));
      const some = untracked.slice(0, 3).join("、") + (untracked.length > 3 ? t(" 等") : "");
      ask({
        title: t("贮藏全部改动"),
        message: t("工作区里还有 {0} 个未跟踪的文件（{1}）。", untracked.length, some),
        choices: [
          { value: "tracked", label: t("只贮藏已跟踪文件的改动"), hint: t("未跟踪的文件留在工作区") },
          { value: "all", label: t("连同未跟踪的文件一起贮藏"), hint: t("它们会从工作区移走，取回贮藏时放回来") },
        ],
        initialChoice: "tracked",
        confirm: t("贮藏"),
        onSubmit: (v) => run(api.stashPush(null, v === "all"), v === "all" ? t("已贮藏全部改动和 {0} 个未跟踪的文件", untracked.length) : t("已贮藏全部改动")),
      });
    },
    [ask, run],
  );

  /** Shelve the selected files; with ask true ask for a name first, otherwise name it "Changes · n" */
  const shelve = useCallback(
    (paths: string[], askName: boolean, untracked: string[] = []) => {
      if (!askName) return run(api.shelfSave("", paths), t("已搁置到暂存架"));
      ask({
        title: t("搁置到暂存架"),
        message: t("把 {0} 个文件的改动收到暂存架，工作区里这些文件回到最近一次提交的样子。", paths.length),
        input: { initial: t("改动 · {0}", shelves.length + 1), placeholder: t("名字") },
        // Untracked files can come along; they leave the worktree and come back on restore
        choices: untracked.length
          ? [
              { value: "checked", label: t("只搁置勾选的文件") },
              { value: "all", label: t("再加上 {0} 个未跟踪的文件", untracked.length), hint: untracked.slice(0, 3).join("、") + (untracked.length > 3 ? t(" 等") : "") },
            ]
          : undefined,
        initialChoice: "checked",
        confirm: t("搁置"),
        onSubmit: (name, _alt, { choice }) => run(api.shelfSave(name, choice === "all" ? [...paths, ...untracked] : paths), t("已搁置到“{0}”", name)),
      });
    },
    [ask, run, shelves.length],
  );

  const restore = useCallback((e: ShelfEntry) => run(api.shelfRestore(e.id), t("已取回“{0}”", e.name)), [run]);
  /** Restore only the checked files, the rest stay on the shelf (spec §4.9) */
  const restoreFiles = useCallback(
    (e: ShelfEntry, paths: string[]) => run(api.shelfRestore(e.id, paths), t("已从“{0}”取回 {1} 个文件", e.name, paths.length)),
    [run],
  );
  const removeShelf = useCallback((e: ShelfEntry) => run(api.shelfDelete(e.id), t("已删除“{0}”", e.name)), [run]);
  const rename = useCallback(
    (e: ShelfEntry) =>
      ask({
        title: t("重命名"),
        input: { initial: e.name },
        confirm: t("重命名"),
        onSubmit: async (name) => {
          try {
            await api.shelfRename(e.id, name);
            refresh();
          } catch (err) {
            return errOf(err).message;
          }
        },
      }),
    [ask, refresh],
  );

  const pop = useCallback((e: StashEntry) => run(api.stashApply(e.index, true), t("已取回贮藏")), [run]);
  const apply = useCallback((e: StashEntry) => run(api.stashApply(e.index, false), t("已取回贮藏，条目保留")), [run]);
  const drop = useCallback(
    (e: StashEntry) =>
      ask({
        title: t("丢弃贮藏"),
        message: t("丢弃“{0}”。可以在操作时间线里撤销。", e.message),
        confirm: t("丢弃"),
        danger: true,
        onSubmit: () => run(api.stashDrop(e.index), t("已丢弃贮藏")),
      }),
    [ask, run],
  );

  /** Bring a stash back on a new branch made where it was stashed (git stash branch): for a stash that no longer applies cleanly */
  const branch = useCallback(
    (e: StashEntry) =>
      ask({
        title: t("从贮藏新建分支"),
        message: t("在贮藏时所在的提交上新建分支并切换过去，再把这条贮藏取回到那里，取回后删除这条贮藏。贮藏和现在的代码冲突时用这个。可以在操作时间线里撤销。"),
        input: { initial: "", placeholder: t("新分支名") },
        confirm: t("新建分支并取回"),
        onSubmit: (name) => run(api.stashBranch(e.index, name.trim()), t("已在新分支 {0} 上取回贮藏", name.trim())),
      }),
    [ask, run],
  );
  return { stashes, shelves, refresh, stash, shelve, restore, restoreFiles, removeShelf, rename, pop, apply, drop, branch };
}

export type StashShelf = ReturnType<typeof useStashShelf>;

const I = {
  restore: "M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10",
  apply: "M2 7.5 5.5 11 12 3",
  drop: "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.5 8.5h6l.5-8.5",
  rename: "M9.5 2.5l2 2-7 7H2.5v-2zM8 4l2 2",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function ago(at: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return t("刚刚");
  if (s < 3600) return t("{0} 分钟前", Math.floor(s / 60));
  if (s < 86400) return t("{0} 小时前", Math.floor(s / 3600));
  return t("{0} 天前", Math.floor(s / 86400));
}

/** Shelf tab */
/** Shelf tab; expand and click a file to see its diff (read from the saved patch, worktree untouched) */
export function ShelfPanel({
  ops,
  disabled,
  onOpenDiff,
  activePath,
}: {
  ops: StashShelf;
  disabled: boolean;
  onOpenDiff: (e: ShelfEntry, path: string) => void;
  activePath: string | null;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  // Check the files to restore in an expanded entry, all checked by default
  const [off, setOff] = useState<Set<string>>(new Set());
  const live = open != null && ops.shelves.some((e) => e.id === open);
  // After a partial restore the remaining files get a new id (same name and time): keep it expanded
  const last = useRef<ShelfEntry | null>(null);
  useEffect(() => {
    const cur = ops.shelves.find((e) => e.id === open);
    if (cur) last.current = cur;
    else if (open != null && last.current) {
      const prev = last.current;
      const next = ops.shelves.find((e) => e.name === prev.name && e.time === prev.time);
      if (next) setOpen(next.id);
    }
  }, [open, ops.shelves]);
  useEffect(() => {
    setFiles(null);
    setOff(new Set());
    if (open == null || !live) return;
    let on = true;
    api.shelfFiles(open).then((f) => on && setFiles(f), () => on && setFiles([]));
    return () => {
      on = false;
    };
  }, [open, live]);
  if (!ops.shelves.length)
    return <p className="cp-clean dim">{t("暂存架是空的。在“提交”里勾选文件后点搁置图标，改动会收到这里。")}</p>;
  const why = disabled ? t("合并或取回还没完成") : undefined;
  return (
    <div className="ss-list">
      {ops.shelves.map((e) => {
        // When expanded with only some files checked, the restore icon restores only the checked files
        const picked = open === e.id && files ? files.filter((f) => !off.has(f.path)).map((f) => f.path) : null;
        const partial = !!picked && !!files && picked.length < files.length;
        const none = !!picked && picked.length === 0;
        return (
        <div key={e.id} className="ss-item">
          <div className="ss-row">
            <button type="button" className="ss-main" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <span className="chev">{open === e.id ? "▾" : "▸"}</span>
              <span className="ss-name">{e.name}</span>
              <span className="dim ss-meta">
                {t("{0} 个文件 · {1}", e.files.length, ago(e.time))}
              </span>
            </button>
            <span className="ss-acts">
              <button
                type="button"
                className="ib sm"
                title={why ?? (none ? t("先勾选要取回的文件") : partial ? t("取回勾选的 {0} 个文件（其余留在暂存架）", picked!.length) : t("取回到工作区（条目删除）"))}
                aria-label={t("取回")}
                disabled={disabled || none}
                onClick={() => (partial ? ops.restoreFiles(e, picked!) : ops.restore(e))}
              >
                <Ico d={I.restore} />
              </button>
              <button type="button" className="ib sm" title={t("重命名")} aria-label={t("重命名")} onClick={() => ops.rename(e)}>
                <Ico d={I.rename} />
              </button>
              <button type="button" className="ib sm x" title={t("删除（可以撤销）")} aria-label={t("删除")} onClick={() => ops.removeShelf(e)}>
                <Ico d={I.drop} />
              </button>
            </span>
          </div>
          {open === e.id && (
            <div className="ss-files">
              {!files && <p className="dim small pad">{t("正在读取…")}</p>}
              {files?.map((f) => (
                <FileRow
                  key={f.path}
                  f={f}
                  active={activePath === `${e.id}:${f.path}`}
                  onOpen={() => onOpenDiff(e, f.path)}
                  lead={
                    <input
                      type="checkbox"
                      aria-label={t("取回 {0}", f.path)}
                      title={t("取回时包含这个文件")}
                      checked={!off.has(f.path)}
                      onChange={() => setOff((o) => (o.has(f.path) ? new Set([...o].filter((x) => x !== f.path)) : new Set([...o, f.path])))}
                    />
                  }
                />
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

/** Stash tab; expand and click a file to see its diff */
export function StashPanel({ ops, disabled, onOpenDiff, activePath }: { ops: StashShelf; disabled: boolean; onOpenDiff: (id: string, path: string) => void; activePath: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const openEntry = open ? ops.stashes.find((s) => s.id === open) : undefined;
  const openIndex = openEntry?.index;
  useEffect(() => {
    setFiles(null);
    if (openIndex == null) return;
    let live = true;
    api.stashFiles(openIndex).then((f) => live && setFiles(f), () => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [open, openIndex]);
  if (!ops.stashes.length)
    return <p className="cp-clean dim">{t("没有贮藏。在“提交”里点贮藏图标，可以一次收起全部改动；命令行里的 git stash 也会出现在这里。")}</p>;
  const why = disabled ? t("合并或取回还没完成") : undefined;
  return (
    <div className="ss-list">
      {ops.stashes.map((e) => (
        <div key={e.id} className="ss-item">
          <div className="ss-row">
            <button type="button" className="ss-main" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} title={e.message}>
              <span className="chev">{open === e.id ? "▾" : "▸"}</span>
              <span className="ss-name">{e.message.replace(/^(WIP on|On) [^:]+: /, "")}</span>
              <span className="dim ss-meta">
                {e.message.match(/^(?:WIP on|On) ([^:]+):/)?.[1] ?? ""} · {ago(e.time)}
              </span>
            </button>
            <span className="ss-acts">
              <button type="button" className="ib sm" title={why ?? t("取回并删除")} aria-label={t("取回并删除")} disabled={disabled} onClick={() => ops.pop(e)}>
                <Ico d={I.restore} />
              </button>
              <button type="button" className="ib sm" title={why ?? t("取回但保留")} aria-label={t("取回但保留")} disabled={disabled} onClick={() => ops.apply(e)}>
                <Ico d={I.apply} />
              </button>
              <button type="button" className="ib sm" title={why ?? t("新建分支并取回（贮藏和现在的代码冲突时用）")} aria-label={t("从贮藏新建分支")} disabled={disabled} onClick={() => ops.branch(e)}>
                <Ico d={BRANCH_ICON} />
              </button>
              <button type="button" className="ib sm x" title={t("丢弃")} aria-label={t("丢弃")} onClick={() => ops.drop(e)}>
                <Ico d={I.drop} />
              </button>
            </span>
          </div>
          {open === e.id && (
            <div className="ss-files">
              {!files && <p className="dim small pad">{t("正在读取…")}</p>}
              {files?.map((f) => (
                <FileRow key={f.path} f={f} active={activePath === `${e.id}:${f.path}`} onOpen={() => onOpenDiff(e.id, f.path)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
