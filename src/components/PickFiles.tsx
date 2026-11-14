// Cherry-pick or revert only some files of a commit (like JetBrains' Apply / Revert Selected Changes):
// check files and apply their changes from this commit to the worktree (in reverse for revert), without creating a commit; review, then commit yourself.
// When they don't match the current code, apply three-way, entering conflict resolution on conflicts.

import { useState } from "react";
import { api, errOf } from "../api/commands";
import type { Commit, FileChange, OpInfo, RepoState } from "../api/types";
import { StatusBadge } from "./FileRow";
import { shortId } from "./format";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

interface Props {
  commit: Commit;
  files: FileChange[];
  /** Files checked initially; empty means all */
  initial: string[];
  revert: boolean;
  onClose: () => void;
  done: (st: RepoState, message: string, op?: OpInfo) => void;
  failed: (m: string) => void;
  say: (m: string) => void;
}

export function PickFiles({ commit, files, initial, revert: revert0, onClose, done, failed, say }: Props) {
  useReturnFocus();
  const [on, setOn] = useState<Set<string>>(new Set(initial.length ? initial : files.map((f) => f.path)));
  const [revert, setRevert] = useState(revert0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = files.filter((f) => on.has(f.path));

  const go = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    // Renamed files go together with their old paths
    const paths = picked.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path]));
    try {
      const w = await api.commitFilesApply(commit.id, paths, revert);
      done(w.state, revert ? t("已在工作区还原 {0} 个文件的改动，检查后提交", picked.length) : t("已把 {0} 个文件的改动拣选到工作区，检查后提交", picked.length), w.op);
      onClose();
    } catch (e) {
      const err = errOf(e);
      if (err.code === "CONFLICTS") {
        failed("");
        say(t("这些改动和现在的代码有冲突，请逐个处理"));
        onClose();
      } else {
        setError(err.message);
        setBusy(false);
      }
    }
  };

  const all = picked.length === files.length;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal pick-files" role="dialog" aria-modal="true" aria-label={revert ? t("还原部分文件") : t("拣选部分文件")} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h2>{revert ? t("还原部分文件") : t("拣选部分文件")}</h2>
        <p className="modal-msg small">
          <span className="mono dim">{shortId(commit.id)}</span> {commit.title}
        </p>
        <div className="seg pkf-mode" role="radiogroup" aria-label={t("做什么")}>
          <button type="button" role="radio" aria-checked={!revert} className={!revert ? "on" : ""} onClick={() => setRevert(false)}>
            {t("拣选（把改动拿过来）")}
          </button>
          <button type="button" role="radio" aria-checked={revert} className={revert ? "on" : ""} onClick={() => setRevert(true)}>
            {t("还原（撤掉这些改动）")}
          </button>
        </div>
        <label className="pkf-all check">
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = picked.length > 0 && !all;
            }}
            onChange={() => setOn(all ? new Set() : new Set(files.map((f) => f.path)))}
          />
          {t("已选 {0} / {1}", picked.length, files.length)}
        </label>
        <div className="pkf-list">
          {files.map((f) => (
            <label key={f.path} className="pkf-row check">
              <input
                type="checkbox"
                checked={on.has(f.path)}
                onChange={() =>
                  setOn((s) => {
                    const n = new Set(s);
                    if (n.has(f.path)) n.delete(f.path);
                    else n.add(f.path);
                    return n;
                  })
                }
              />
              <StatusBadge s={f.status} />
              <span className="mono pkf-path" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
                {f.path}
              </span>
              <span className="dim small mono">
                +{f.added} −{f.deleted}
              </span>
            </label>
          ))}
        </div>
        <p className="dim small">{t("改动放到工作区，不生成提交；检查后在提交面板里提交。可以在操作时间线里撤销。")}</p>
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
          <button type="button" className="btn primary" onClick={go} disabled={busy || picked.length === 0} autoFocus>
            {busy ? t("正在应用…") : revert ? t("还原 {0} 个文件", picked.length) : t("拣选 {0} 个文件", picked.length)}
          </button>
        </div>
      </div>
    </div>
  );
}
