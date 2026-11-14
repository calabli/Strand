// Operations on commits (spec §5.6, §5.7). The detail icon row, context menu and F2 all call this, so the rules are written once.
// Availability is computed by the core layer (caps); this only shows dialogs, calls commands and reports results.

import { useCallback } from "react";
import { api, errOf } from "../api/commands";
import type { Commit, CommitCaps, OpInfo, RepoState, ResetMode, Written } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { shortId } from "./format";
import type { MenuEntry } from "./Menu";
import { t, lazy } from "../i18n";

interface Deps {
  ask: (d: DialogSpec) => void;
  done: (state: RepoState, message: string, op?: OpInfo) => void;
  /** The repository may have changed after a failure (e.g. stopped on conflicts): re-read */
  failed: (message: string) => void;
  say: (message: string) => void;
  /** The current HEAD commit: when changing something other than it, note that later commits will be recreated */
  head?: string | null;
}

/** Icons for commit operations (shared by the detail icon row and context menu, 14×14) */
export const COMMIT_ICONS = {
  copy: "M4.5 4.5h7v8h-7zM2.5 9.5v-8h7",
  console: "M1.5 2.5h11v9h-11zM4 5.5l2 1.5-2 1.5M7.5 9h2.5",
  cherry: "M4.5 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M10 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M4.5 8.5C5 5 7.5 2.5 11 1.5M10 7.5C10 5 9 3 7.5 2",
  checkout: "M7 1.5v8M3.5 6 7 9.5 10.5 6M2 12.5h10",
  reset: "M2.5 7a4.5 4.5 0 1 0 1.3-3.2M2.5 1.5v3h3",
  revert: "M12 7H2M5 4 2 7l3 3M12 3v8",
  undo: "M4.5 2 1.5 5l3 3M1.5 5h7a4 4 0 0 1 0 8H6",
  reword: "M9.5 2.5l2 2-7 7H2.5v-2zM8 4l2 2",
  drop: "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.5 8.5h6l.5-8.5",
  branch: "M4 1.5v11M10 1.5v3c0 3-6 2.5-6 6",
  tag: "M1.5 1.5h5l6 6-5 5-6-6zM4.5 4.5h.01",
  parent: "M7 2v10M3.5 8.5 7 12l3.5-3.5",
  child: "M7 12V2M3.5 5.5 7 2l3.5 3.5",
  rebase: "M3 2v10M3 4.5h5a2 2 0 0 1 0 4H5M7 6.5 5 8.5l2 2M11 2v3M11 9v3",
  patch: "M3.5 1.5h5l2.5 2.5v8.5h-7.5zM5.5 7h3M5.5 9.5h3",
  bisect: "M7 1.5v11M2 4l2.5 3L2 10M12 4 9.5 7 12 10",
  applyPatch: "M3.5 1.5h5l2.5 2.5v8.5h-7.5zM7 5.5v4.5M5 8l2 2 2-2",
  tree: "M2 2.5h4l1 1.5h5v8h-10zM4.5 7h5M4.5 9.5h3",
  compare: "M4 1.5v11M10 1.5v11M1.5 4h5M7.5 10h5",
  base: "M3 12.5v-11M3 2h7.5l-2 2.5 2 2.5H3",
  web: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M1.5 7h11M7 1.5c-2 2-2 9 0 11M7 1.5c2 2 2 9 0 11",
  squash: "M3 2.5h8M3 11.5h8M7 4v6M5 6l2-2 2 2M5 8l2 2 2-2",
  fixup: "M7 1.5v7M4 5.5l3 3 3-3M2.5 12h9",
  cancel: "M3 3l8 8M11 3l-8 8",
  switch: "M2 4.5h9M8.5 2l2.5 2.5L8.5 7M12 9.5H3M5.5 7 3 9.5 5.5 12",
  merge: "M4 1.5v11M4 4c0 3 6 2 6 5v3.5M8 10.5l2 2 2-2",
  star: "M7 1.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L7 10l-3.4 1.9.7-3.8L1.5 5.5l3.8-.5z",
  folder: "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z",
  pull: "M7 1.5v8M3.5 6 7 9.5 10.5 6M2 12.5h10",
  push: "M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10",
  fetch: "M7 2a5 5 0 1 0 5 5M7 4.5v4.5M5 7l2 2 2-2",
  commit: "M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M1.5 7h3M9.5 7h3",
  // The following are mainly for the command palette (spec §12.1)
  redo: "M9.5 2l3 3-3 3M12.5 5h-7a4 4 0 0 0 0 8H8",
  history: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M7 4v3l2 1.5",
  changes: "M2.5 1.5h9v11h-9zM5 5h4M5 7.5h4M5 10h2",
  search: "M9.5 9.5 12.5 12.5M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0",
  sidebar: "M1.5 2.5h11v9h-11zM5 2.5v9",
  shelf: "M1.5 4.5h11v8h-11zM1.5 4.5 3 1.5h8l1.5 3M5 7.5h4",
  stash: "M2 5.5h10M2 8.5h10M3 2.5h8M2.5 11.5h9",
  reload: "M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3",
  repo: "M3 1.5h8.5v11H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M4.5 10h7",
  clone: "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11zM7 6.5v3.5M5.5 8.5 7 10l1.5-1.5",
  gear: "M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1",
  keys: "M1.5 3.5h11v7h-11zM4 6h.01M7 6h.01M10 6h.01M4.5 8.5h5",
  conflict: "M7 1.5l5.5 10h-11zM7 5.5v3M7 10h.01",
  jump: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
};
const I = COMMIT_ICONS;

const RESET_CHOICES: { value: ResetMode; label: string; hint: string }[] = lazy(() => [
  { value: "soft" as const, label: t("软重置"), hint: t("被移除的提交里的改动放回工作区，可以直接重新提交") },
  { value: "mixed" as const, label: t("混合重置"), hint: t("被移除的提交里的改动放回工作区（默认）") },
  { value: "hard" as const, label: t("硬重置"), hint: t("丢弃被移除的提交里的改动，工作区里没提交的改动也会丢弃；可以撤销") },
]);

export function useCommitOps({ ask, done, failed, say, head }: Deps) {
  const run = useCallback(
    async (p: Promise<Written<null>>, message: string): Promise<string | void> => {
      try {
        const w = await p;
        done(w.state, message, w.op);
      } catch (e) {
        const err = errOf(e);
        if (err.code === "CONFLICTS") {
          // The repository stopped mid cherry-pick, revert or rebase; after re-reading the main view switches to the conflict list
          failed("");
          say(t("有冲突需要解决，请逐个处理"));
        } else if (err.code === "EMPTY_MESSAGE") return err.message;
        else failed(err.message);
      }
    },
    [done, failed, say],
  );

  const copy = useCallback(
    (c: Commit) => {
      navigator.clipboard?.writeText(c.id).then(
        () => say(t("已复制 {0}", shortId(c.id))),
        () => say(t("复制失败")),
      );
    },
    [say],
  );

  const cherryPick = useCallback(
    (ids: string[]) => run(api.commitCherryPick(ids), ids.length === 1 ? t("已拣选到当前分支") : t("已拣选 {0} 个提交到当前分支", ids.length)),
    [run],
  );

  const revert = useCallback(
    (c: Commit) =>
      ask({
        title: t("还原“{0}”", c.title),
        message: t("新建一个提交，撤掉这个提交的改动。原来的提交保留在历史里。"),
        confirm: t("还原"),
        onSubmit: () => run(api.commitRevert(c.id), t("已还原，生成了一个新提交")),
      }),
    [ask, run],
  );

  const reset = useCallback(
    (c: Commit, branch: string | null) =>
      ask({
        title: t("把 {0} 重置到 {1}", branch ?? t("当前分支"), shortId(c.id)),
        message: t("“{0}”之后的提交会从 {1} 上移除。", c.title, branch ?? t("当前分支")),
        choices: RESET_CHOICES,
        initialChoice: "mixed",
        dangerWhen: (v) => v === "hard",
        confirm: t("重置"),
        onSubmit: (mode) => run(api.commitReset(c.id, mode as ResetMode), t("已重置到 {0}", shortId(c.id))),
      }),
    [ask, run],
  );

  const undo = useCallback(() => run(api.commitUndo(), t("已撤销提交，改动放回了工作区")), [run]);

  const reword = useCallback(
    (c: Commit) =>
      ask({
        title: t("修改提交说明"),
        // Earlier commits are reworded via rebase (spec §5.6): later commits are recreated
        message: head && c.id !== head ? t("它之后的提交会重新生成（哈希会变），改动不变。可以撤销。") : undefined,
        input: { initial: c.body ? `${c.title}\n\n${c.body}` : c.title, multiline: true, placeholder: t("第一行是标题") },
        confirm: t("修改"),
        onSubmit: (msg) => run(api.commitReword(c.id, msg), t("已修改提交说明")),
      }),
    [ask, run, head],
  );

  const drop = useCallback(
    (c: Commit) =>
      ask({
        title: t("丢弃提交“{0}”", c.title),
        message: t("从历史里去掉这个提交和它的改动，之后的提交接到它的父提交上。可以撤销。"),
        confirm: t("丢弃"),
        danger: true,
        onSubmit: () => run(api.commitDrop(c.id), t("已丢弃提交")),
      }),
    [ask, run],
  );

  return { copy, cherryPick, revert, reset, undo, reword, drop };
}

export type CommitOps = ReturnType<typeof useCommitOps>;

/**
 * Commit operations in the context menu (the same set as the detail icon row). Grouped per spec §12.2 with dividers:
 * copy and patches / view / reset and revert / rebase / branches and tags / navigate / browser.
 */
export function commitActions(
  c: Commit,
  caps: CommitCaps | null,
  ops: CommitOps,
  branch: string | null,
  extra: {
    checkout: () => void;
    newBranch: () => void;
    newTag: () => void;
    rebaseFrom: () => void;
    fixup: () => void;
    squashInto: () => void;
    picked: number;
    patch: () => void;
    tree: () => void;
    compareLocal: () => void;
    setBase: () => void;
    /** Push up to here (spec §5.6) */
    pushTo: () => void;
    /** Branch menus for each local branch pointing at this commit (or the current branch if none) */
    branches: { name: string; items: MenuEntry[] }[];
    jump: (id: string) => void;
    openWeb: (url: string) => void;
    /** Bisect: mark good, bad, skip; active true means it has started */
    bisect?: { active: boolean; mark: (m: "good" | "bad" | "skip") => void };
    /** Cherry-pick or revert only some files (opens the file picker dialog); absent when the repository isn't in a normal state */
    pickFiles?: (revert: boolean) => void;
  },
): MenuEntry[] {
  const cap = (k: keyof Omit<CommitCaps, "parent" | "child" | "web_url">) => ({ disabled: !caps?.[k].ok, why: caps ? caps[k].why : t("正在读取…") });
  const fix = caps?.fixup.ok && extra.picked === 0 ? { disabled: true, why: t("先在提交面板里勾选要并入的改动") } : cap("fixup");
  const jump = (id: string | undefined, none: string) => ({ disabled: !id, why: caps ? none : t("正在读取…"), run: () => id && extra.jump(id) });
  const branchItems: MenuEntry[] = extra.branches.map((b) => ({ label: t("分支 {0}", b.name), icon: I.branch, sub: b.items }));
  return [
    // Copy and patches
    { label: t("复制版本号"), icon: I.copy, run: () => ops.copy(c) },
    { label: t("创建补丁…"), icon: I.patch, run: extra.patch },
    "-",
    // View
    { label: t("查看这个版本时的仓库…"), icon: I.tree, run: extra.tree },
    { label: t("和本地比较"), icon: I.compare, run: extra.compareLocal, ...cap("compare_local") },
    { label: t("设为比较起点"), icon: I.base, run: extra.setBase },
    { label: t("检出这个版本"), icon: I.checkout, run: extra.checkout, ...cap("checkout") },
    "-",
    // Reset and revert
    { label: t("拣选到当前分支"), icon: I.cherry, run: () => ops.cherryPick([c.id]), ...cap("cherry_pick") },
    { label: t("重置当前分支到这里…"), icon: I.reset, run: () => ops.reset(c, branch), ...cap("reset") },
    { label: t("还原提交…"), icon: I.revert, run: () => ops.revert(c), ...cap("revert") },
    {
      label: t("只拣选或还原部分文件"),
      icon: I.cherry,
      disabled: !extra.pickFiles,
      why: t("合并或变基还没完成"),
      sub: [
        { label: t("拣选部分文件到工作区…"), icon: I.cherry, run: () => extra.pickFiles?.(false) },
        { label: t("还原部分文件到工作区…"), icon: I.revert, run: () => extra.pickFiles?.(true) },
      ],
    },
    { label: t("撤销提交"), icon: I.undo, run: ops.undo, ...cap("undo") },
    "-",
    // Rebase
    { label: t("修改提交说明…"), icon: I.reword, run: () => ops.reword(c), hint: "F2", ...cap("reword") },
    { label: t("Fixup：并入勾选的 {0} 个文件", extra.picked), icon: I.fixup, run: extra.fixup, ...fix },
    { label: t("Squash Into：并入并修改说明…"), icon: I.squash, run: extra.squashInto, ...fix },
    { label: t("从这里开始整理…"), icon: I.rebase, run: extra.rebaseFrom, ...cap("rebase_from") },
    { label: t("丢弃提交…"), icon: I.drop, run: () => ops.drop(c), danger: true, ...cap("drop") },
    "-",
    // Branches and tags
    ...branchItems,
    { label: t("推送到这里为止…"), icon: I.push, run: extra.pushTo, ...cap("push_to") },
    { label: t("从这里新建分支…"), icon: I.branch, run: extra.newBranch },
    { label: t("在这里新建标签…"), icon: I.tag, run: extra.newTag },
    "-",
    // Bisect
    ...(extra.bisect
      ? ([
          {
            label: extra.bisect.active ? t("二分查找") : t("用二分查找找出问题提交"),
            icon: I.bisect,
            sub: [
              { label: t("标为坏的（有问题）"), run: () => extra.bisect!.mark("bad") },
              { label: t("标为好的（没问题）"), run: () => extra.bisect!.mark("good") },
              ...(extra.bisect.active ? [{ label: t("跳过这个"), run: () => extra.bisect!.mark("skip") }] : []),
            ],
          },
          "-",
        ] as MenuEntry[])
      : []),
    // Navigate
    { label: t("跳到父提交"), icon: I.parent, hint: "→", ...jump(caps?.parent, t("没有父提交")) },
    { label: t("跳到子提交"), icon: I.child, hint: "←", ...jump(caps?.child, t("没有子提交")) },
    // Browser
    ...(caps?.web_url ? (["-", { label: t("在浏览器中查看"), icon: I.web, run: () => extra.openWeb(caps.web_url!) }] as MenuEntry[]) : []),
  ];
}
