// Clean up merged branches: list the local branches whose commits are all in a target branch (main by default),
// check the ones to delete, delete them in one step. Undo brings them all back.
// The current branch, the target itself and branches checked out in another worktree aren't listed.

import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { Branch, MergedBranch, OpInfo, RepoState } from "../api/types";
import { relTime } from "./format";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

interface Props {
  /** Local branches, to choose the target from */
  branches: Branch[];
  /** The branch to check against */
  into: string;
  onClose: () => void;
  done: (st: RepoState, message: string, op?: OpInfo) => void;
}

/** The default target: main or master when there is one, otherwise the current branch */
export function defaultCleanTarget(branches: Branch[]): string | null {
  return (branches.find((b) => b.name === "main") ?? branches.find((b) => b.name === "master") ?? branches.find((b) => b.is_current))?.name ?? null;
}

export function CleanBranches({ branches, into: into0, onClose, done }: Props) {
  useReturnFocus();
  const [into, setInto] = useState(into0);
  const [list, setList] = useState<MergedBranch[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    api.mergedBranches(into).then(
      (l) => {
        if (!live) return;
        setList(l);
        // Favorites start unchecked: kept on purpose more often than not
        setOn(new Set(l.filter((b) => !b.favorite).map((b) => b.name)));
      },
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [into]);

  const picked = (list ?? []).filter((b) => on.has(b.name));
  const go = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const w = await api.branchesDelete(picked.map((b) => b.name));
      done(w.state, picked.length === 1 ? t("已删除分支 {0}", picked[0].name) : t("已删除 {0} 个已合并的分支", picked.length), w.op);
      onClose();
    } catch (e) {
      setError(errOf(e).message);
      setBusy(false);
    }
  };
  const all = !!list?.length && picked.length === list.length;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal clean-branches" role="dialog" aria-modal="true" aria-label={t("清理已合并的分支")} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h2>{t("清理已合并的分支")}</h2>
        <label className="cb-into">
          <span>{t("已经并入")}</span>
          <select value={into} onChange={(e) => setInto(e.target.value)} disabled={busy}>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.is_current ? t("（当前）") : ""}
              </option>
            ))}
          </select>
          <span>{t("的本地分支")}</span>
        </label>
        {!list && !error && <p className="dim small">{t("正在查找…")}</p>}
        {list && !list.length && <p className="dim">{t("没有已经并入 {0} 的分支，不用清理。", into)}</p>}
        {list && list.length > 0 && (
          <>
            <label className="pkf-all check">
              <input
                type="checkbox"
                checked={all}
                ref={(el) => {
                  if (el) el.indeterminate = picked.length > 0 && !all;
                }}
                onChange={() => setOn(all ? new Set() : new Set(list.map((b) => b.name)))}
              />
              {t("已选 {0} / {1}", picked.length, list.length)}
            </label>
            <div className="pkf-list">
              {list.map((b) => (
                <label key={b.name} className="pkf-row check cb-row">
                  <input
                    type="checkbox"
                    checked={on.has(b.name)}
                    onChange={() =>
                      setOn((s) => {
                        const n = new Set(s);
                        if (n.has(b.name)) n.delete(b.name);
                        else n.add(b.name);
                        return n;
                      })
                    }
                  />
                  <span className="mono cb-name">
                    {b.favorite && <span title={t("收藏的分支")}>★ </span>}
                    {b.name}
                  </span>
                  <span className="dim small cb-title" title={b.title}>
                    {b.title}
                  </span>
                  <span className="dim small">{relTime(b.time)}</span>
                </label>
              ))}
            </div>
            <p className="dim small">{t("这些分支上的提交都已经在 {0} 里，删除后不会丢。远程分支不受影响。可以在操作时间线里撤销。", into)}</p>
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {tr(error)}
          </p>
        )}
        <div className="modal-btns">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button type="button" className="btn danger" onClick={go} disabled={busy || picked.length === 0}>
            {busy ? t("正在删除…") : t("删除 {0} 个分支", picked.length)}
          </button>
        </div>
      </div>
    </div>
  );
}
