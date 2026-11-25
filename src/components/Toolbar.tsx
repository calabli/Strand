// Top toolbar (spec §3.2): repository, branch button, in-progress status, fetch, pull (with mode choice), push, refresh.

import type { RepoState } from "../api/types";
import type { RemoteKind, RemoteOps } from "./remoteOps";
import { shortId } from "./format";
import { hintOf, useKeymap } from "../keymap";
import { lang, setLang, t, lazy } from "../i18n";

const Icon = ({ d, className }: { d: string; className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  branch: "M4 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM4 5.5v6M4 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 4.5c0 2.5-1.5 3.5-6 4",
  panel: "M1.5 2.5h11v9h-11zM5 2.5v9",
  fetch: "M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M7 4v5M5 7l2 2 2-2",
  pull: "M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10",
  push: "M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10",
  reload: "M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3",
  undo: "M4.5 2 1.5 5l3 3M1.5 5h7a4 4 0 0 1 0 8H6",
  gear: "M5.90 2.43 L6.28 0.94 L7.72 0.94 L8.10 2.43 L9.46 2.99 L10.78 2.21 L11.79 3.22 L11.01 4.54 L11.57 5.90 L13.06 6.28 L13.06 7.72 L11.57 8.10 L11.01 9.46 L11.79 10.78 L10.78 11.79 L9.46 11.01 L8.10 11.57 L7.72 13.06 L6.28 13.06 L5.90 11.57 L4.54 11.01 L3.22 11.79 L2.21 10.78 L2.99 9.46 L2.43 8.10 L0.94 7.72 L0.94 6.28 L2.43 5.90 L2.99 4.54 L2.21 3.22 L3.22 2.21 L4.54 2.99ZM7 8.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z",
  lang: "M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M1.5 7h11M7 1.5c1.6 1.6 2.2 3.4 2.2 5.5S8.6 10.9 7 12.5M7 1.5C5.4 3.1 4.8 4.9 4.8 7s.6 3.9 2.2 5.5",
  redo: "M9.5 2l3 3-3 3M12.5 5h-7a4 4 0 0 0 0 8H8",
};

const MODE_LABEL: Record<RepoState["state"], string | null> = lazy(() => ({
  normal: null,
  merging: t("合并进行中"),
  rebasing: t("变基进行中"),
  cherry_picking: t("拣选进行中"),
  reverting: t("还原进行中"),
  unstashing: t("取回进行中"),
}));

interface Props {
  repo: RepoState;
  /** Open the repository list */
  onRepos: (x: number, y: number) => void;
  onReload: () => void;
  /** Open the branch popup (spec §6.2) */
  onBranch: () => void;
  onAbortMerge: () => void;
  /** When the conflict view was hidden by "continue later", click here to go back */
  onShowConflicts?: () => void;
  /** How many conflicts remain; empty when unknown (spec §3.3) */
  conflictLeft?: number | null;
  busy: boolean;
  remote: RemoteOps;
  /** Commits ahead of and behind the upstream for the current branch */
  ahead: number;
  behind: number;
  /** The current branch rewrote pushed commits; pushing needs a force push */
  needsForce: boolean;
  hasUpstream: boolean;
  onPullMenu: (x: number, y: number) => void;
  /** Open the command palette (spec §12.1) */
  onPalette: () => void;
  /** Language menu */
  onSettings: () => void;
  /** Commit panel toggle (spec §3.2): show or hide the commit panel; the badge is the number of changed files */
  panel: { open: boolean; count: number; onToggle: () => void };
  /** Undo, redo (spec §11.1) */
  undo: { can: boolean; canRedo: boolean; undoTip: string; redoTip: string; onUndo: () => void; onRedo: () => void };
}

export function Toolbar({ repo, onRepos, onReload, onBranch, onAbortMerge, onShowConflicts, conflictLeft, busy, remote, ahead, behind, needsForce, hasUpstream, onPullMenu, onSettings, onPalette, panel, undo }: Props) {
  useKeymap();
  const h = repo.head;
  const branch =
    h.kind === "detached" ? `HEAD@${shortId(h.commit ?? "")}` : h.kind === "unborn" ? t("{0}（还没有提交）", h.branch) : h.branch;
  const mode = MODE_LABEL[repo.state];
  const leftText = conflictLeft == null ? "" : " " + (conflictLeft > 0 ? t("· 还有 {0} 处待处理", conflictLeft) : t("· 都处理完了"));
  const run = remote.running;
  const normal = repo.state === "normal";
  const onBranchHead = h.kind === "branch";
  // Clicking a running button again cancels it (spec §7.5)
  const tip = (kind: RemoteKind, label: string) =>
    run?.kind === kind ? t("{0}中{1}（点击取消）", label, run.text ? `：${run.text}` : "…") : label;
  const btn = (kind: RemoteKind, label: string, icon: string, can: boolean, why: string, go: () => void, badge?: number, warn?: boolean) => (
    <button
      type="button"
      className={"ib remote" + (run?.kind === kind ? " spin" : "")}
      title={run?.kind === kind ? tip(kind, label) : can ? label : why}
      aria-label={label}
      disabled={run ? run.kind !== kind : !can}
      onClick={() => (run?.kind === kind ? remote.cancel() : go())}
    >
      <Icon d={icon} />
      {!!badge && <span className={"badge" + (warn ? " force" : "")}>{badge}</span>}
    </button>
  );
  return (
    <header className="toolbar">
      <button
        type="button"
        className="tb-repo"
        title={t("切换仓库（{0}）", repo.path)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onRepos(r.left, r.bottom + 4);
        }}
      >
        <span className="tb-repo-badge" aria-hidden="true">{(repo.name.trim()[0] ?? "S").toUpperCase()}</span>
        {repo.name}
        <span className="chev">▾</span>
      </button>
      <button type="button" className="tb-branch mono" onClick={onBranch} title={t("分支（切换、新建、合并…）")}>
        <Icon d={ICONS.branch} className="tb-branch-icon" />
        {branch}
        <span className="chev">▾</span>
      </button>
      {mode &&
        (onShowConflicts ? (
          <button type="button" className="tb-mode" onClick={onShowConflicts} title={t("回到冲突列表继续处理")}>
            {mode}
            {leftText}
            {" "}
            {t("· 回到冲突列表")}
          </button>
        ) : (
          <span className="tb-mode">
            {mode}
            {leftText}
          </span>
        ))}
      {repo.state !== "normal" && (
        <button type="button" className="btn sm" onClick={onAbortMerge}>
          {t("中止")}
        </button>
      )}
      <div className="tb-actions">
        <button type="button" className="tb-palette" onClick={onPalette} title={t("命令面板")} aria-label={t("命令面板")}>
          <Icon d="M9.5 9.5 12.5 12.5M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0" />
          <span className="kbd">{hintOf("palette")}</span>
        </button>
        <button type="button" className="ib" title={undo.undoTip} aria-label={t("撤销")} disabled={!undo.can} onClick={undo.onUndo}>
          <Icon d={ICONS.undo} />
        </button>
        <button type="button" className="ib" title={undo.redoTip} aria-label={t("重做")} disabled={!undo.canRedo} onClick={undo.onRedo}>
          <Icon d={ICONS.redo} />
        </button>
        <span className="tb-sep" />
        {run && (
          <span className="tb-progress dim" title={run.text}>
            {run.percent != null ? `${run.percent}%` : ""}
          </span>
        )}
        {btn("fetch", t("抓取"), ICONS.fetch, true, "", () => remote.fetch())}
        {btn(
          "pull",
          t("拉取（{0}方式）", remote.pullMode === "merge" ? t("合并") : t("变基")),
          ICONS.pull,
          normal && onBranchHead && hasUpstream,
          !normal ? t("合并还没完成") : !onBranchHead ? t("现在不在任何分支上") : t("这个分支没有跟踪的远程分支"),
          () => remote.pull(),
          behind,
        )}
        <button
          type="button"
          className="ib mode"
          title={t("选择拉取方式")}
          aria-label={t("选择拉取方式")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onPullMenu(r.left, r.bottom + 4);
          }}
        >
          ▾
        </button>
        {btn(
          "push",
          needsForce ? t("推送（改写了已经推送的提交，需要强制推送）") : t("推送"),
          ICONS.push,
          onBranchHead,
          t("现在不在任何分支上"),
          () => remote.openPush(),
          ahead,
          needsForce,
        )}
        <button
          type="button"
          className={"ib remote" + (panel.open ? " pressed" : "")}
          aria-pressed={panel.open}
          title={panel.open ? t("隐藏提交面板（{0} 个文件有改动）", panel.count) : t("显示提交面板（{0} 个文件有改动）", panel.count)}
          aria-label={t("提交面板")}
          onClick={panel.onToggle}
        >
          <Icon d={ICONS.panel} />
          {panel.count > 0 && <span className="badge">{panel.count}</span>}
        </button>
        {/* Chinese/English switch (spec §15 language): switches in place, re-drawing the whole UI without reloading the window */}
        <button
          type="button"
          className="ib tb-lang"
          title={lang === "zh" ? "Switch to English" : "切换到中文"}
          aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        >
          {lang === "zh" ? "EN" : "中"}
        </button>
        <button type="button" className="ib" title={t("设置（{0}）", hintOf("settings"))} aria-label={t("设置")} onClick={onSettings}>
          <Icon d={ICONS.gear} />
        </button>
        <button type="button" className={"ib" + (busy ? " spin" : "")} title={t("重新读取仓库")} aria-label={t("重新读取仓库")} onClick={onReload} disabled={busy}>
          <Icon d={ICONS.reload} />
        </button>
      </div>
    </header>
  );
}
