// Branch and tag operations (spec §6.3). The branch tree, branch popup and context menu all call this, so the rules are written once.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errOf } from "../api/commands";
import type { Branch, MergeMode, OpInfo, RefsList, RepoState, Worktree, Written } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { shortId } from "./format";
import { t, withNote } from "../i18n";
import { dropMarks, marksOf } from "./ConflictView";

interface Deps {
  repo: RepoState | null;
  refs: RefsList | null;
  ask: (d: DialogSpec) => void;
  /** A write finished: update repository state, refresh the log and branches, show a notice */
  done: (state: RepoState, message: string, op?: OpInfo) => void;
  /** The operation failed but the repository may have changed (e.g. a merge stopped on conflicts): re-read */
  failed: (message: string) => void;
  /** Only show a notice */
  say: (message: string) => void;
}

const MERGE_TEXT = {
  up_to_date: (s: string) => t("当前分支已经包含 {0}，不需要合并", s),
  fast_forward: (s: string) => t("已快进到 {0}", s),
  merged: (s: string) => t("已合并 {0}", s),
  squashed: (s: string) => t("已把 {0} 的改动压缩成一个提交", s),
};

/** Merge mode options (spec §6.7); the chosen mode is remembered on this machine as the next default */
const MODE_KEY = "strand.mergeMode";
const lastMode = (): MergeMode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "no_ff" || m === "squash" ? m : "auto";
  } catch {
    return "auto";
  }
};
const rememberMode = (m: string) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* Only for this session */
  }
};
const modeChoices = () => [
  { value: "auto", label: t("能快进就快进"), hint: t("否则生成一个合并提交") },
  { value: "no_ff", label: t("总是生成合并提交"), hint: t("历史里保留这次合并（--no-ff）") },
  { value: "squash", label: t("压缩成一个提交"), hint: t("合成一个普通提交，不记成合并（--squash）") },
];

const REBASE_TEXT = {
  up_to_date: (o: string) => t("当前分支已经在 {0} 之上，不需要变基", o),
  fast_forward: (o: string) => t("当前分支没有独有的提交，已快进到 {0}", o),
  rebased: (o: string) => t("已变基到 {0} 之上", o),
};

export function useBranchOps({ repo, refs, ask, done, failed, say }: Deps) {
  const current = repo?.head.kind === "branch" ? repo.head.branch ?? null : null;

  /** Run a write; input errors like INVALID_NAME go back to the dialog for display, other errors go to failed */
  const run = useCallback(
    async <T,>(p: Promise<Written<T>>, message: (r: T) => string, inDialog = false): Promise<string | void> => {
      try {
        const w = await p;
        done(w.state, withNote(message(w.result), w.note), w.op);
      } catch (e) {
        const err = errOf(e);
        if (inDialog && err.code === "INVALID_NAME") return err.message;
        // Conflicts aren't an error: the repository stops mid merge or rebase, and after refreshing the main view switches to the conflict list (same as pull)
        if (err.code === "CONFLICTS") {
          failed("");
          say(t("{0}，请逐个处理", err.message));
          return;
        }
        failed(err.message);
      }
    },
    [done, failed, say],
  );

  const switchTo = useCallback(
    async (name: string) => {
      try {
        const w = await api.branchSwitch(name);
        done(w.state, t("已切换到 {0}", name), w.op);
      } catch (e) {
        const err = errOf(e);
        if (err.code !== "WORKTREE_CONFLICT") return failed(err.message);
        const files = ((err.detail as { files?: string[] })?.files ?? []).filter(Boolean);
        ask({
          title: t("切换到 {0}", name),
          message: t("工作区里这些文件的改动会被目标分支覆盖。可以先把改动贮藏起来再切换，之后在“贮藏”里取回。"),
          items: files,
          confirm: t("先贮藏再切换"),
          onSubmit: () => run(api.branchSwitch(name, true), () => t("已贮藏改动并切换到 {0}", name)),
        });
      }
    },
    [ask, done, failed, run],
  );

  const create = useCallback(
    (at?: { rev: string; label: string }) =>
      ask({
        title: t("新建分支"),
        message: at ? t("从 {0} 新建，并切换过去。", at.label) : t("从当前位置新建，并切换过去。"),
        input: { initial: "feature/", placeholder: t("分支名"), mono: true },
        confirm: t("新建并切换"),
        onSubmit: (name) => run(api.branchCreate(name, at?.rev ?? null, true), () => t("已新建并切换到 {0}", name), true),
      }),
    [ask, run],
  );

  const rename = useCallback(
    (b: Branch) =>
      ask({
        title: t("重命名 {0}", b.name),
        message: b.upstream ? t("只改本地名字，远程的 {0} 不会跟着变。", b.upstream) : undefined,
        input: { initial: b.name, mono: true },
        confirm: t("重命名"),
        onSubmit: (name) => run(api.branchRename(b.name, name), () => t("已重命名为 {0}", name), true),
      }),
    [ask, run],
  );

  const remove = useCallback(
    (b: Branch) =>
      ask({
        title: t("删除分支 {0}", b.name),
        message: b.merged
          ? t("这个分支的提交都已经在当前分支里，删除不会丢失提交。")
          : t("这个分支上有还没合并到当前分支的提交，删除后这些提交会从日志里消失。"),
        confirm: t("删除"),
        danger: true,
        onSubmit: () => run(api.branchDelete(b.name, !b.merged), () => t("已删除分支 {0}", b.name)),
      }),
    [ask, run],
  );

  /** Squash merge (spec §6.7): first edit the message in a dialog (prefilled with "Squash merge X" and the titles of the commits being merged), then merge on confirm */
  const squashWithMessage = useCallback(
    async (source: string, target: string | null) => {
      let initial = "";
      try {
        initial = await api.branchSquashMessage(source, target);
      } catch {
        /* Leave it empty if it can't be fetched; the core layer uses the default message */
      }
      // Wait for the merge mode dialog to close before opening
      window.setTimeout(() =>
        ask({
          title: t("压缩合并的说明"),
          message: t("{0} 的改动会合成一个普通提交，用下面的说明。", source),
          input: { initial, multiline: true, label: t("提交说明") },
          confirm: target && target !== current ? t("切换并合并") : t("合并"),
          onSubmit: (msg) => {
            if (!msg.trim()) return t("说明不能为空");
            return target && target !== current
              ? run(api.branchMergeInto(source, target, "squash", msg), (r) => t("已切换到 {0}。", target) + MERGE_TEXT[r](source))
              : run(api.branchMerge(source, "squash", msg), (r) => MERGE_TEXT[r](source));
          },
        }),
      );
    },
    [ask, current, run],
  );

  const merge = useCallback(
    (source: string) =>
      ask({
        title: t("把 {0} 合并到 {1}", source, current ?? t("当前位置")),
        message: t("有冲突时会停在合并状态，可以中止回到合并之前。"),
        choices: modeChoices(),
        initialChoice: lastMode(),
        confirm: t("合并"),
        onSubmit: (m) => {
          rememberMode(m);
          if (m === "squash") return void squashWithMessage(source, null);
          return run(api.branchMerge(source, m as MergeMode), (r) => MERGE_TEXT[r](source));
        },
      }),
    [ask, current, run, squashWithMessage],
  );

  /** Drag merge (spec §6.1): merge source into target; switch first when target isn't current, all as one step */
  const mergeInto = useCallback(
    (source: string, target: string) => {
      if (target === current) return merge(source);
      ask({
        title: t("把 {0} 合并到 {1}", source, target),
        message: t("会先切换到 {0}，再把 {1} 合并进去；有冲突时停在合并状态。整个可以撤销。", target, source),
        choices: modeChoices(),
        initialChoice: lastMode(),
        confirm: t("切换并合并"),
        onSubmit: (m) => {
          rememberMode(m);
          if (m === "squash") return void squashWithMessage(source, target);
          return run(api.branchMergeInto(source, target, m as MergeMode), (r) => t("已切换到 {0}。", target) + MERGE_TEXT[r](source));
        },
      });
    },
    [ask, current, merge, run, squashWithMessage],
  );

  /** Rebase the current branch onto onto (spec §6.3): check first, then confirm */
  const rebaseOnto = useCallback(
    async (onto: string) => {
      let plan;
      try {
        plan = await api.branchRebasePlan(onto);
      } catch (e) {
        return failed(errOf(e).message);
      }
      const { branch, own, pushed, incoming } = plan;
      if (plan.has_merge) {
        return ask({
          title: t("不能把 {0} 变基到 {1} 之上", branch, onto),
          message: t("{0} 独有的提交里有合并提交，变基会把合并拆散。可以改用“合并到当前分支”。", branch),
          confirm: t("知道了"),
          onSubmit: () => {},
        });
      }
      if (incoming === 0) return say(REBASE_TEXT.up_to_date(onto));
      const parts =
        own === 0
          ? [t("{0} 没有独有的提交，会直接快进到 {1}。", branch, onto)]
          : [
              t("{0} 独有的 {1} 个提交会被改写，接到 {2} 最新的提交之后（{2} 上有 {3} 个新提交）。", branch, own, onto, incoming),
              t("有冲突时按提交逐个解决，可以中止回到变基之前；整个变基可以撤销。"),
            ];
      if (pushed > 0) parts.push(t("其中 {0} 个提交已经推送，变基后要强制推送才能更新远程分支。", pushed));
      ask({
        title: t("把 {0} 变基到 {1} 之上", branch, onto),
        message: parts.join(""),
        confirm: own === 0 ? t("快进") : t("变基"),
        danger: pushed > 0,
        onSubmit: () => run(api.branchRebase(onto), (r) => REBASE_TEXT[r](onto)),
      });
    },
    [ask, failed, run, say],
  );

  const abortMerge = useCallback(
    () =>
      ask({
        title: t("中止{0}", repo?.state === "rebasing" ? t("变基") : repo?.state === "cherry_picking" ? t("拣选") : repo?.state === "reverting" ? t("还原") : repo?.state === "unstashing" ? t("取回") : t("合并")),
        message: t("放弃这次操作，仓库回到开始之前的状态。之后可以撤销这一步，回到现在的冲突和标记。"),
        confirm: t("中止"),
        danger: true,
        onSubmit: () => {
          // Hand the marks to the core layer to store with this step and clear the local ones, so restarting the same merge later doesn't carry old marks
          const path = repo?.path ?? "";
          return run(api.mergeAbort(marksOf(path)), () => {
            dropMarks(path);
            return t("已中止，回到开始之前");
          });
        },
      }),
    [ask, run, repo?.state, repo?.path],
  );

  const checkoutRemote = useCallback(
    (rb: string) => run(api.branchCheckoutRemote(rb), (local) => t("已检出 {0} 为本地分支 {1}", rb, local)),
    [run],
  );

  const checkoutRev = useCallback(
    (initial = "") =>
      ask({
        title: t("检出标签或指定版本"),
        message: t("输入标签名或版本号前缀。检出后不在任何分支上，切换到任意分支即可回来。"),
        input: { initial, placeholder: t("如 v0.4.0 或 a41f9c2"), mono: true },
        confirm: t("检出"),
        onSubmit: async (rev) => {
          try {
            const w = await api.checkoutDetached(rev);
            done(w.state, t("已检出 {0}，现在不在任何分支上", rev), w.op);
          } catch (e) {
            const err = errOf(e);
            if (err.code === "NOT_FOUND") return err.message;
            failed(err.message);
          }
        },
      }),
    [ask, done, failed],
  );

  // With a message it's an annotated tag (git tag -a); with a signing key configured it can be signed (git tag -s), defaulting to tag.gpgSign
  const createTag = useCallback(
    async (at: string) => {
      const cfg = await api.signingConfig().catch(() => null);
      ask({
        title: t("在 {0} 上新建标签", shortId(at)),
        input: { initial: "", placeholder: t("如 v0.5.0"), mono: true, label: t("标签名") },
        note: { label: t("说明（可选；写了就是带说明的标签）"), placeholder: t("如这个版本改了什么") },
        ...(cfg?.key
          ? {
              choices: [
                { value: "plain", label: t("不签名") },
                { value: "sign", label: t("签名这个标签"), hint: t("用 {0} 密钥 {1} 签名", cfg.format === "ssh" ? "SSH" : "GPG", cfg.key) },
              ],
              initialChoice: cfg.tag ? "sign" : "plain",
            }
          : {}),
        confirm: t("新建标签"),
        onSubmit: (name, _alt, { note, choice }) =>
          run(api.tagCreate(name, at, note || null, choice === "sign"), () => (choice === "sign" ? t("已新建签名标签 {0}", name) : t("已新建标签 {0}", name)), true),
      });
    },
    [ask, run],
  );

  /** pushed: already pushed (or unknown); the confirmation explains that the remote keeps it (spec §6.5) */
  const deleteTag = useCallback(
    (name: string, pushed = true) =>
      ask({
        title: t("删除标签 {0}", name),
        message: pushed ? t("只删除本地标签；如果已经推送过，远程的标签仍然保留。") : t("这个标签还没推送，删除后就没有了（可以撤销）。"),
        confirm: t("删除"),
        danger: true,
        onSubmit: () => run(api.tagDelete(name), () => t("已删除标签 {0}", name)),
      }),
    [ask, run],
  );

  const branchBy = (name: string) => refs?.branches.find((b) => b.name === name);

  return { current, switchTo, create, rename, remove, merge, mergeInto, rebaseOnto, abortMerge, checkoutRemote, checkoutRev, createTag, deleteTag, branchBy };
}

export type BranchOps = ReturnType<typeof useBranchOps> & {
  /** Compare with current branch (spec §10.3), provided by App */
  compareWith?: (name: string) => void;
  /** Worktrees (spec §6.6), provided by App */
  worktree?: {
    /** Create; branch is the preselected branch */
    add: (branch?: string) => void;
    /** Open in Strand (switch repository) */
    open: (path: string) => void;
    reveal: (path: string) => void;
    remove: (w: Worktree) => void;
  };
};

/** Favorite branches (spec §6.3: only affects display order, saved locally per repository) */
/**
 * Favorites (spec §6.1, §6.3): stored in the repository's .git/strand/favorites (core layer) and returned as favorite in refs_list.
 * Clicking updates the UI first, then refreshes the branch list once saved; reverts if saving fails.
 * Favorites previously kept in this machine's local storage (by worktree path) are moved into the repository on first open, then the local copies are deleted.
 */
export function useFavorites(repoPath: string | null, refs: RefsList | null, refresh: () => void) {
  // Changes not yet reflected in the branch list
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    setPending((m) => {
      if (!m.size) return m;
      const n = new Map(m);
      for (const b of refs?.branches ?? []) if (n.get(b.name) === !!b.favorite) n.delete(b.name);
      return n.size === m.size ? m : n;
    });
  }, [refs]);

  const favs = useMemo(() => {
    const s = new Set((refs?.branches ?? []).filter((b) => b.favorite).map((b) => b.name));
    pending.forEach((on, name) => (on ? s.add(name) : s.delete(name)));
    return s;
  }, [refs, pending]);

  // Migration: old favorites in this machine's local storage
  useEffect(() => {
    if (!repoPath) return;
    const key = `strand.fav:${repoPath}`;
    let old: string[] = [];
    try {
      old = JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      old = [];
    }
    if (!Array.isArray(old) || !old.length) return;
    Promise.all(old.map((n) => api.prefsSetFavorite(String(n), true).catch(() => null))).then(() => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* Migrating again next time is fine */
      }
      refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const toggle = useCallback(
    (name: string) => {
      const on = !favs.has(name);
      setPending((m) => new Map(m).set(name, on));
      api.prefsSetFavorite(name, on).then(refresh, () =>
        setPending((m) => {
          const n = new Map(m);
          n.delete(name);
          return n;
        }),
      );
    },
    [favs, refresh],
  );
  return { favs, toggle };
}
