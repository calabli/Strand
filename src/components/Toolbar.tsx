// 顶部工具栏（说明书 3.2）：仓库、分支按钮、进行中状态、抓取、拉取（可选方式）、推送、刷新。

import type { RepoState } from "../api/types";
import type { RemoteKind, RemoteOps } from "./remoteOps";
import { keys, shortId } from "./format";
import { t } from "../i18n";

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  panel: "M1.5 2.5h11v9h-11zM5 2.5v9",
  fetch: "M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M7 4v5M5 7l2 2 2-2",
  pull: "M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10",
  push: "M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10",
  reload: "M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3",
  undo: "M4.5 2 1.5 5l3 3M1.5 5h7a4 4 0 0 1 0 8H6",
  gear: "M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1",
  lang: "M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M1.5 7h11M7 1.5c1.6 1.6 2.2 3.4 2.2 5.5S8.6 10.9 7 12.5M7 1.5C5.4 3.1 4.8 4.9 4.8 7s.6 3.9 2.2 5.5",
  redo: "M9.5 2l3 3-3 3M12.5 5h-7a4 4 0 0 0 0 8H8",
};

const MODE_LABEL: Record<RepoState["state"], string | null> = {
  normal: null,
  merging: t("合并进行中"),
  rebasing: t("变基进行中"),
  cherry_picking: t("拣选进行中"),
  reverting: t("还原进行中"),
  unstashing: t("取回进行中"),
};

interface Props {
  repo: RepoState;
  /** 打开仓库列表 */
  onRepos: (x: number, y: number) => void;
  onReload: () => void;
  /** 打开分支弹窗（说明书 6.2） */
  onBranch: () => void;
  onAbortMerge: () => void;
  /** 冲突界面被“稍后继续”隐藏时，点这里回去 */
  onShowConflicts?: () => void;
  /** 冲突还有几处待处理；不知道时为空（说明书 3.3） */
  conflictLeft?: number | null;
  busy: boolean;
  remote: RemoteOps;
  /** 当前分支相对跟踪分支的领先、落后数 */
  ahead: number;
  behind: number;
  /** 当前分支改写了已推送的提交，推送需要强制推送 */
  needsForce: boolean;
  hasUpstream: boolean;
  onPullMenu: (x: number, y: number) => void;
  /** 打开命令面板（说明书 12.1） */
  onPalette: () => void;
  /** 语言菜单 */
  onSettings: () => void;
  /** 提交面板开关（说明书 3.2）：显示或隐藏提交面板，角标是有改动的文件数 */
  panel: { open: boolean; count: number; onToggle: () => void };
  /** 撤销、重做（说明书 11.1） */
  undo: { can: boolean; canRedo: boolean; undoTip: string; redoTip: string; onUndo: () => void; onRedo: () => void };
}

export function Toolbar({ repo, onRepos, onReload, onBranch, onAbortMerge, onShowConflicts, conflictLeft, busy, remote, ahead, behind, needsForce, hasUpstream, onPullMenu, onSettings, onPalette, panel, undo }: Props) {
  const h = repo.head;
  const branch =
    h.kind === "detached" ? `HEAD@${shortId(h.commit ?? "")}` : h.kind === "unborn" ? t("{0}（还没有提交）", h.branch) : h.branch;
  const mode = MODE_LABEL[repo.state];
  const leftText = conflictLeft == null ? "" : " " + (conflictLeft > 0 ? t("· 还有 {0} 处待处理", conflictLeft) : t("· 都处理完了"));
  const run = remote.running;
  const normal = repo.state === "normal";
  const onBranchHead = h.kind === "branch";
  // 进行中的按钮再点一次是取消（说明书 7.5）
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
        {repo.name}
        <span className="chev">▾</span>
      </button>
      <button type="button" className="tb-branch mono" onClick={onBranch} title={t("分支（切换、新建、合并…）")}>
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
          <span className="kbd">{keys("⌘K")}</span>
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
        <button type="button" className="ib" title={t("设置（{0}）", keys("⌘,"))} aria-label={t("设置")} onClick={onSettings}>
          <Icon d={ICONS.gear} />
        </button>
        <button type="button" className={"ib" + (busy ? " spin" : "")} title={t("重新读取仓库")} aria-label={t("重新读取仓库")} onClick={onReload} disabled={busy}>
          <Icon d={ICONS.reload} />
        </button>
      </div>
    </header>
  );
}
