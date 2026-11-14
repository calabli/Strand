// 撤销、重做和操作时间线（说明书第 11 节）。
// 工具栏的撤销/重做、提示条上的撤销图标、日志底部的时间线、⌘Z / ⇧⌘Z 都调用这里。

import { useCallback, useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { OpInfo, OpKind, OpList, RepoState } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { t, tr } from "../i18n";

interface Deps {
  /** 每次仓库变化都换一个值，时间线随之刷新 */
  refreshKey: string | null;
  ask: (d: DialogSpec) => void;
  /** 撤销或重做完成：更新仓库状态、刷新日志、显示提示 */
  applied: (state: RepoState, message: string) => void;
  failed: (message: string) => void;
}

const EMPTY: OpList = { entries: [], can_undo: false, can_redo: false };

export function useOplog({ refreshKey, ask, applied, failed }: Deps) {
  const [list, setList] = useState<OpList>(EMPTY);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.oplogList(50).then(setList, () => setList(EMPTY));
  }, []);

  useEffect(() => {
    if (refreshKey) refresh();
    else setList(EMPTY);
  }, [refreshKey, refresh]);

  const undo = useCallback(
    async (toId: number | null = null, confirmPushed = false): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        const w = await api.oplogUndo(toId, confirmPushed);
        const r = w.result;
        applied(w.state, r.length === 1 ? t("已撤销：{0}", tr(r[0].label)) : t("已退回到“{0}”之前", tr(r[r.length - 1].label)));
      } catch (e) {
        const err = errOf(e);
        if (err.code === "ALREADY_PUSHED") {
          ask({
            title: t("撤销已经推送的操作"),
            message: t("这一步之后已经推送过。撤销后本地会和远程不一致，需要强制推送才能让远程也回去。"),
            confirm: t("仍然撤销"),
            danger: true,
            onSubmit: () => {
              undo(toId, true);
            },
          });
        } else if (err.code === "STATE_DIVERGED") {
          const files = ((err.detail as { files?: string[] })?.files ?? []).slice(0, 5);
          failed(t("{0}{1}。这一步和更早的步骤已标记为不能撤销。", err.message, files.length ? `（${files.join("、")}）` : ""));
        } else failed(err.message);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [busy, applied, failed, ask, refresh],
  );

  const redo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const w = await api.oplogRedo();
      const r = w.result;
      applied(w.state, r.length === 1 ? t("已重做：{0}", tr(r[0].label)) : t("已重做 {0} 步，到“{1}”为止", r.length, tr(r[r.length - 1].label)));
    } catch (e) {
      failed(errOf(e).message);
    } finally {
      setBusy(false);
      refresh();
    }
  }, [busy, applied, failed, refresh]);

  const live = list.entries.filter((o) => !o.undone);
  const nextUndo = live.find((o) => o.kind !== "push");
  // 下一次重做恢复的是最近一次撤销的那组，也就是被撤销的里面最早的那条
  const undoneIds = list.entries.filter((o) => o.undone);
  const nextRedo = undoneIds[undoneIds.length - 1];

  return { list, live, busy, refresh, undo, redo, nextUndo, nextRedo };
}

export type Oplog = ReturnType<typeof useOplog>;

const KIND_ICON: Record<OpKind, string> = {
  commit: "M7 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M1 7h3.5M9.5 7H13",
  branch: "M4 1.5v11M10 1.5v3c0 3-6 2.5-6 6",
  switch: "M2 4.5h9M8.5 2 11 4.5 8.5 7M12 9.5H3M5.5 7 3 9.5 5.5 12",
  merge: "M4 1.5v11M4 5c0 3 6 3 6 6v1.5",
  checkout: "M7 1.5v8M3.5 6 7 9.5 10.5 6M2 12.5h10",
  tag: "M1.5 1.5h5l6 6-5 5-6-6zM4.5 4.5h.01",
  pull: "M7 1.5v8M3.5 6.5 7 10l3.5-3.5M2 12.5h10",
  push: "M7 12.5v-8M3.5 7.5 7 4l3.5 3.5M2 1.5h10",
  stash: "M1.5 4.5h11v3h-11zM2.5 7.5v5h9v-5M5.5 10h3",
  shelf: "M1.5 3.5h11M1.5 7h11M1.5 10.5h11M3 3.5v7M11 3.5v7",
  other: "M3 7h8",
};

export function OpIcon({ kind }: { kind: OpKind }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={KIND_ICON[kind]} />
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

/** 日志底部的操作时间线：最近 5 步，最新的在左；点一步回到这一步之前 */
export function Timeline({ oplog, disabled, onReflog }: { oplog: Oplog; disabled: boolean; onReflog?: () => void }) {
  const steps = oplog.live.slice(0, 5);
  if (!steps.length) return null;
  const title = (o: OpInfo, i: number) => {
    if (o.kind === "push") return t("{0} · {1}（推送不能撤销）", tr(o.label), ago(o.time));
    if (!o.undoable) return t("{0} · {1}（不能撤销：{2}）", tr(o.label), ago(o.time), tr(o.reason) || t("仓库在别处被修改过"));
    if (disabled) return t("{0}（合并进行中，不能撤销）", tr(o.label));
    return t("{0} · {1}\n点击回到这一步之前{2}", tr(o.label), ago(o.time), i > 0 ? t("（会撤销包括它在内的 {0} 步）", steps.slice(0, i + 1).filter((x) => x.kind !== "push").length) : "");
  };
  return (
    <div className="timeline" role="list" aria-label={t("操作时间线")}>
      <span className="tl-head dim">{t("最近操作")}</span>
      {steps.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="listitem"
          className={"tl-step" + (o.kind === "push" ? " push" : "") + (!o.undoable && o.kind !== "push" ? " stuck" : "")}
          title={title(o, i)}
          disabled={disabled || oplog.busy || o.kind === "push" || !o.undoable}
          onClick={() => oplog.undo(o.id)}
        >
          <OpIcon kind={o.kind} />
          <span className="tl-label">{tr(o.label)}</span>
        </button>
      ))}
      {onReflog && (
        <button type="button" className="tl-more linklike small" title={t("Git 自己记下的操作记录（reflog）：更早的、命令行里做的也在里面，可以找回丢掉的提交")} onClick={onReflog}>
          {t("更多…")}
        </button>
      )}
    </div>
  );
}
