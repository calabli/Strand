// Fetch, pull, push (spec §7): running state, progress, cancel, result notices, pull mode, auto-fetch when the window gains focus.

import { useReturnFocus } from "./focus";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errOf, onTaskProgress } from "../api/commands";
import type { OpInfo, PullMode, PullPreview, PushPreview, RepoState, Written } from "../api/types";
import { shortId } from "./format";
import { settings } from "../settings";
import { t, tr, withNote } from "../i18n";

export type RemoteKind = "fetch" | "pull" | "push";


const PULL_TEXT: Record<string, (n: number) => string> = {
  up_to_date: () => t("远程没有新提交，不需要拉取"),
  fast_forward: (n) => t("已拉取 {0} 个提交", n),
  merged: (n) => t("已拉取 {0} 个提交并生成合并提交", n),
  rebased: (n) => t("已拉取 {0} 个提交，本地提交已接到它们之后", n),
};

interface Deps {
  repo: RepoState | null;
  /** keepLog: the repository's commits and refs are unchanged (e.g. a fetch with nothing new), no need to re-read the log */
  done: (state: RepoState, message: string, op?: OpInfo, keepLog?: boolean) => void;
  failed: (message: string) => void;
  /** Only show a notice, no refresh */
  say: (message: string) => void;
}

/** Notification titles for network operations that finish while the window is in the background */
const NOTIFY_TITLE: Record<RemoteKind, (ok: boolean) => string> = {
  fetch: (ok) => (ok ? t("抓取完成") : t("抓取失败")),
  pull: (ok) => (ok ? t("拉取完成") : t("拉取失败")),
  push: (ok) => (ok ? t("推送完成") : t("推送失败")),
};

/** A system notification when an operation that took a while (over 3 seconds) finishes while Strand isn't the front window */
export function notifyIfAway(started: number, title: string, body: string) {
  if (document.hasFocus() || Date.now() - started < 3000 || !body) return;
  void api.notify(title, body).catch(() => {});
}

export function useRemoteOps({ repo, done, failed, say }: Deps) {
  const [running, setRunning] = useState<{ kind: RemoteKind; task: string; text: string; percent?: number } | null>(null);
  const [push, setPush] = useState<PushPreview | null>(null);
  const [pullPanel, setPullPanel] = useState<PullPreview | null>(null);
  const lastFetch = useRef(0);
  const modeKey = repo ? `strand.pullMode:${repo.path}` : null;
  const [pullMode, setPullModeState] = useState<PullMode>("merge");

  useEffect(() => {
    if (!modeKey) return;
    try {
      setPullModeState(localStorage.getItem(modeKey) === "rebase" ? "rebase" : "merge");
    } catch {
      setPullModeState("merge");
    }
  }, [modeKey]);
  const setPullMode = (m: PullMode) => {
    setPullModeState(m);
    try {
      if (modeKey) localStorage.setItem(modeKey, m);
    } catch {
      /* Only for this session */
    }
  };

  useEffect(
    () =>
      onTaskProgress((p) =>
        setRunning((r) => (r && r.task === p.task_id ? { ...r, text: p.text, percent: p.percent } : r)),
      ),
    [],
  );

  /** Run a network task; CANCELLED isn't reported, other errors go to onError */
  const runTask = useCallback(
    async <T,>(
      kind: RemoteKind,
      f: (task: string) => Promise<Written<T>>,
      ok: (r: T) => string,
      onError?: (e: ReturnType<typeof errOf>) => boolean,
      keepLog?: (r: T) => boolean,
    ) => {
      const task = `${kind}-${Date.now()}`;
      const started = Date.now();
      setRunning({ kind, task, text: "" });
      try {
        const w = await f(task);
        const msg = withNote(ok(w.result), w.note);
        done(w.state, msg, w.op?.kind === "push" ? undefined : w.op, keepLog?.(w.result));
        notifyIfAway(started, NOTIFY_TITLE[kind](true), msg);
        return true;
      } catch (e) {
        const err = errOf(e);
        if (err.code === "CANCELLED") failed("");
        else if (!onError?.(err)) {
          failed(err.message);
          notifyIfAway(started, NOTIFY_TITLE[kind](false), tr(err.message));
        }
        return false;
      } finally {
        setRunning(null);
      }
    },
    [done, failed],
  );

  const fetch = useCallback(
    (quiet = false) => {
      lastFetch.current = Date.now();
      return runTask(
        "fetch",
        (t) => api.remoteFetch(t, quiet),
        (r) => (quiet ? "" : r.behind > 0 ? t("远程有 {0} 个新提交，可以拉取", r.behind) : t("远程没有新提交")),
        // Auto-fetch failures (e.g. offline) don't bother the user
        () => quiet,
        // Nothing new fetched: don't re-read the log, so the (filtered) list being viewed isn't interrupted
        (r) => !r.refs_changed,
      );
    },
    [runTask],
  );

  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  /** The real pull; with fetched true don't fetch again (just fetched and showed the summary panel) */
  const runPull = useCallback(
    (mode: PullMode, fetched: boolean) =>
      runTask(
        "pull",
        (t) => api.remotePull(t, mode, fetched),
        (r) => PULL_TEXT[r.outcome](r.incoming),
        // On conflicts the repository stops mid merge or rebase, and after refreshing the main view switches to the conflict list automatically
        (err) => {
          if (err.code !== "CONFLICTS") return false;
          failed("");
          say(t("{0}，请逐个处理", err.message));
          return true;
        },
      ),
    [runTask, failed, say],
  );

  /**
   * Pull (spec §7.2): fetch first, then dry-run in memory. When conflicts are expected, show the pull summary panel first
   * and let the user choose to abort or start resolving (the repository is unchanged at that point); without conflicts, pull directly. A failed dry run doesn't block the pull.
   */
  const pull = useCallback(
    async (mode: PullMode = pullMode) => {
      const task = `pull-${Date.now()}`;
      setRunning({ kind: "pull", task, text: "" });
      let fetched: Written<{ behind: number; refs_changed?: boolean }>;
      try {
        fetched = await api.remoteFetch(task);
      } catch (e) {
        setRunning(null);
        const err = errOf(e);
        failed(err.code === "CANCELLED" ? "" : err.message);
        return false;
      }
      if (fetched.result.behind === 0) {
        setRunning(null);
        done(fetched.state, PULL_TEXT.up_to_date(0), undefined, !fetched.result.refs_changed);
        return true;
      }
      const preview = await api.remotePullPreview(mode).catch(() => null);
      setRunning(null);
      if (preview && preview.conflicts.length > 0) {
        done(fetched.state, "", undefined, !fetched.result.refs_changed);
        setPullPanel(preview);
        return false;
      }
      return runPull(mode, true);
    },
    [pullMode, done, failed, runPull],
  );

  /** Changing the pull mode in the summary panel: dry-run again */
  const previewMode = useCallback(
    async (mode: PullMode) => {
      setPullMode(mode);
      try {
        setPullPanel(await api.remotePullPreview(mode));
      } catch (e) {
        setPullPanel(null);
        failed(errOf(e).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [failed, modeKey],
  );

  /** Summary panel: start resolving (pull for real, stopping in conflicts) */
  const startPull = useCallback(() => {
    const p = pullPanel;
    setPullPanel(null);
    if (p) runPull(p.mode, true);
  }, [pullPanel, runPull]);

  /** Summary panel: abort. The repository is unchanged, only fetched */
  const abortPull = useCallback(() => {
    setPullPanel(null);
    say(t("已中止拉取，仓库没有改动"));
  }, [say]);

  /** Open the push dialog (spec §7.3: always open the dialog first; only a notice when there's nothing to push) */
  /** Open the push dialog; with to set, it's "push up to here" (spec §5.6) */
  const openPush = useCallback(async (to: string | null = null) => {
    try {
      const p = await api.remotePushPreview(to);
      if (p.commits.length === 0 && !p.new_branch && p.behind === 0 && (p.to || p.unpushed_tags.length === 0)) return say(t("没有需要推送的提交"));
      setPush(p);
    } catch (e) {
      failed(errOf(e).message);
    }
  }, [failed, say]);

  const doPush = useCallback(
    (force: boolean, tags: boolean) => {
      const p = push;
      setPush(null);
      return runTask(
        "push",
        (t) => api.remotePush(t, force, tags, p?.to ?? null, p?.new_branch ? p.remote : null),
        () => (p?.to ? t("已推送到 {0}，到 {1} 为止", p.target, p.to.slice(0, 7)) : t("已推送到 {0}", p?.target ?? t("远程"))),
      );
    },
    [push, runTask],
  );

  /** New branch: change the remote to push to and preview again */
  const pickPushRemote = useCallback(
    (r: string) => {
      api.remotePushPreview(push?.to ?? null, r).then(setPush, (e) => failed(errOf(e).message));
    },
    [push, failed],
  );

  /** Push one tag (spec §6.5, §7.4) */
  const pushTag = useCallback(
    (name: string) => runTask("push", (task) => api.tagPush(task, name), () => t("已推送标签 {0}", name)),
    [runTask],
  );

  /** Commit and push (spec §7.4): push directly when the remote has no new commits and no force is needed, otherwise just explain why */
  const pushAfterCommit = useCallback(async () => {
    try {
      const p = await api.remotePushPreview();
      if (p.behind > 0) return failed(p.needs_force ? t("已提交。推送需要强制推送，请在推送对话框里确认") : t("已提交。远程有新提交，先拉取再推送"));
      await runTask("push", (t) => api.remotePush(t, false, false), () => t("已提交并推送到 {0}", p.target));
    } catch (e) {
      failed(t("已提交，但推送失败：{0}", errOf(e).message));
    }
  }, [failed, runTask]);

  const cancel = useCallback(() => {
    if (running) api.taskCancel(running.task);
  }, [running]);

  // Fetch once automatically after opening a repository so ahead/behind counts are current
  const path = repo?.path;
  useEffect(() => {
    if (!path) return;
    lastFetch.current = 0;
    if (!settings().autoFetch) return;
    const t = window.setTimeout(() => fetchRef.current(true), 800);
    return () => window.clearTimeout(t);
  }, [path]);

  // Auto-fetch when the window gains focus, at least 5 minutes apart
  const canAuto = !!repo && !running;
  useEffect(() => {
    if (!canAuto) return;
    const onFocus = () => {
      const s = settings();
      if (s.autoFetch && Date.now() - lastFetch.current >= s.fetchMinutes * 60 * 1000) fetch(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [canAuto, fetch]);

  /** Submodule update and LFS download run like a fetch: the fetch icon spins and clicking it again cancels */
  const submoduleUpdate = (paths: string[]) =>
    runTask(
      "fetch",
      (task) => api.submoduleUpdate(task, paths),
      () => (paths.length ? t("已更新子模块 {0}", paths.join(", ")) : t("已更新全部子模块")),
    );
  const deleteRemoteBranch = (name: string) => runTask("push", (task) => api.remoteBranchDelete(task, name), () => t("已删除远程分支 {0}", name));
  const deleteRemoteTag = (name: string) => runTask("push", (task) => api.remoteTagDelete(task, name), () => t("已删除远程标签 {0}", name));
  const lfsPull = () => runTask("fetch", (task) => api.lfsPull(task), () => t("已下载 LFS 文件"));
  return { running, submoduleUpdate, lfsPull, deleteRemoteBranch, deleteRemoteTag, fetch, pull, pullPanel, previewMode, startPull, abortPull, pullMode, setPullMode, openPush, doPush, pickPushRemote, pushTag, pushAfterCommit, cancel, push, closePush: () => setPush(null) };
}

export type RemoteOps = ReturnType<typeof useRemoteOps>;

/** Push dialog (spec §7.3) */
export function PushDialog({ p, onPush, onClose, onRemote }: { p: PushPreview; onPush: (force: boolean, tags: boolean) => void; onClose: () => void; onRemote?: (r: string) => void }) {
  useReturnFocus();
  const [force, setForce] = useState(false);
  const [tags, setTags] = useState(false);
  const warn = p.behind > 0
    ? p.needs_force
      ? t("这些提交改写了已经推送过的历史，需要勾选强制推送。")
      : t("远程有 {0} 个你本地没有的提交。不勾选强制推送会被拒绝，建议先拉取。", p.behind)
    : null;
  const blocked = p.behind > 0 && !force;
  // Only push tags not yet pushed; when never fetched we don't know which were pushed, so push all (spec §7.3)
  const canTags = p.tags_unknown || p.unpushed_tags.length > 0;
  const tagTip = p.tags_unknown
    ? t("还没抓取过，不知道远程有哪些标签")
    : p.unpushed_tags.length > 0
      ? p.unpushed_tags.join("、")
      : t("没有还没推送的标签");
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("推送")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2>{p.to ? t("推送到 {0}（到 {1} 为止）", p.target, p.to.slice(0, 7)) : t("推送到 {0}", p.target)}</h2>
        {p.to && p.left > 0 && <p className="modal-msg">{t("它之后的 {0} 个提交留在本地，仍为未推送。", p.left)}</p>}
        {p.new_branch && <p className="modal-msg">{t("远程还没有这个分支，推送时会新建，并设为 {0} 的跟踪分支。", p.branch)}</p>}
        {p.new_branch && p.remotes.length > 1 && onRemote && (
          <label className="modal-field push-remote">
            <span className="dim">{t("推送到哪个远程")}</span>
            <select value={p.remote} onChange={(e) => onRemote(e.target.value)}>
              {p.remotes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="modal-sub dim">{t("要推送的提交")} {p.commits.length}</div>
        <ul className="modal-items push-list">
          {p.commits.slice(0, 50).map((c) => (
            <li key={c.id}>
              <span className="mono dim">{shortId(c.id)}</span> {c.title}
            </li>
          ))}
          {p.commits.length > 50 && <li className="dim">{t("还有 {0} 个", p.commits.length - 50)}</li>}
          {p.commits.length === 0 && <li className="dim">{t("没有新提交，只推送分支")}</li>}
        </ul>
        {!p.to && (
        <>
        <label className="check" title={tagTip}>
          <input type="checkbox" checked={tags} disabled={!canTags} onChange={(e) => setTags(e.target.checked)} />
          {p.tags_unknown ? t("同时推送所有标签") : t("同时推送标签（{0} 个还没推送）", p.unpushed_tags.length)}
        </label>
        <label className="check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          {t("强制推送（会覆盖远程上的提交）")}
        </label>
        </>
        )}
        {warn && <p className="warnbox">{warn}</p>}
        {force && <p className="dim small">{t("强制推送使用 --force-with-lease：如果远程在你上次抓取之后又被别人更新，推送仍会被拒绝。")}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            type="button"
            className={"btn " + (force ? "danger" : "primary")}
            autoFocus
            disabled={blocked}
            title={blocked ? (p.needs_force ? t("需要勾选强制推送") : t("先拉取，或勾选强制推送")) : undefined}
            onClick={() => onPush(force, tags)}
          >
            {force ? t("强制推送") : t("推送")}
          </button>
        </div>
      </div>
    </div>
  );
}

const KIND_TEXT: Record<PullPreview["conflicts"][number]["kind"], string> = {
  text: "",
  modify_delete: "一边修改一边删除",
  binary: "二进制文件",
  lock: "锁文件",
};

/** Pull summary panel (spec §7.2): shown when the dry run predicts conflicts, while the repository is still unchanged (so the title doesn't say "the pull partly completed"). Esc equals abort. */
export function PullPanel({ p, onMode, onStart, onAbort }: { p: PullPreview; onMode: (m: PullMode) => void; onStart: () => void; onAbort: () => void }) {
  useReturnFocus();
  const kind = (c: PullPreview["conflicts"][number]) => (c.kind === "text" ? t("{0} 处内容冲突", c.blocks || 1) : t(KIND_TEXT[c.kind]));
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onAbort()}>
      <div
        className="modal pull-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("拉取摘要")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onAbort();
        }}
      >
        <h2>{t("拉取会遇到冲突，要你决定")}</h2>
        <p className="dim small pp-sub">{t("从 {0} 拉取到 {1}", p.upstream, p.branch)}</p>
        <div className="seg pp-mode" role="radiogroup" aria-label={t("拉取方式")}>
          {(["merge", "rebase"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={p.mode === m} className={p.mode === m ? "on" : ""} onClick={() => p.mode !== m && onMode(m)}>
              {m === "merge" ? t("合并") : t("变基")}
            </button>
          ))}
        </div>
        <p className="dim small">
          {p.mode === "merge"
            ? t("冲突一次全部出现；解决后生成一个合并提交。")
            : t("按本地提交逐个出现冲突，可以跳过某个提交；完成后历史是一条直线，本地 {0} 个提交换成新的哈希。", p.ahead)}
        </p>
        <div className="pp-nums">
          <div>
            <b>{p.incoming}</b>
            <span className="dim small">{t("新提交")}</span>
          </div>
          <div>
            <b>{p.auto_merged}</b>
            <span className="dim small">{t("自动合并的文件")}</span>
          </div>
          <div className="bad">
            <b>{p.conflicts.length}</b>
            <span className="dim small">{t("有冲突的文件")}</span>
          </div>
        </div>
        <ul className="modal-items pp-list">
          {p.conflicts.map((c) => (
            <li key={c.path}>
              <span className="mono pp-path">{c.path}</span>
              <span className="dim small">
                {kind(c)}
                {c.commit ? t(" · 在提交“{0}”", c.commit) : ""}
              </span>
            </li>
          ))}
        </ul>
        {p.dirty > 0 && <p className="dim small">{t("工作区里 {0} 个文件的改动会先搁置到暂存架，拉取结束后放回。", p.dirty)}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onAbort}>
            {t("中止，回到拉取之前")}
          </button>
          <button type="button" className="btn primary" autoFocus onClick={onStart}>
            {t("开始解决")}
          </button>
        </div>
      </div>
    </div>
  );
}
