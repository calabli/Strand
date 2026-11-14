// 操作记录（reflog）：HEAD 或某个本地分支指向过哪些提交，从新到旧。
// 用来找回误删的分支、重置或变基之前的提交（包括命令行里做的、Strand 的撤销覆盖不到的）。
// 每一行：第几步、动作、说明、提交标题、短哈希、时间；悬停有在日志里定位、从这里新建分支、检出这个版本、复制版本号。

import { useEffect, useMemo, useState } from "react";
import { api, errOf } from "../api/commands";
import type { ReflogEntry } from "../api/types";
import { formatTime, relTime, shortId } from "./format";
import { useReturnFocus } from "./focus";
import { lazy, t, tr } from "../i18n";

/** 常见动作的说明（其余原样显示） */
const ACTION = lazy(() => ({
  commit: t("提交"),
  "commit (initial)": t("第一个提交"),
  "commit (amend)": t("修改提交"),
  "commit (merge)": t("合并提交"),
  checkout: t("切换"),
  reset: t("重置"),
  merge: t("合并"),
  pull: t("拉取"),
  "cherry-pick": t("拣选"),
  revert: t("还原"),
  am: t("应用补丁"),
  branch: t("新建分支"),
  clone: t("克隆"),
  "rebase (start)": t("变基开始"),
  "rebase (finish)": t("变基完成"),
  "rebase (pick)": t("变基"),
  "rebase (reword)": t("变基·改说明"),
  "rebase (squash)": t("变基·合并"),
  "rebase (fixup)": t("变基·并入"),
  "rebase (abort)": t("中止变基"),
  "rebase -i (start)": t("整理开始"),
  "rebase -i (finish)": t("整理完成"),
  "rebase -i (pick)": t("整理"),
}));

function actionText(a: string): string {
  const known = (ACTION as Record<string, string>)[a];
  if (known) return known;
  // merge origin/main、pull origin main 之类：认前面的词
  const head = a.split(" ")[0];
  const k2 = (ACTION as Record<string, string>)[head];
  return k2 ? `${k2} ${a.slice(head.length + 1)}`.trim() : a;
}

const ICON = {
  locate: "M7 1.5v2.5M7 10v2.5M1.5 7H4M10 7h2.5M7 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  branch: "M4 2v10M4 9c0-2.5 6-2 6-5M10 2v2M8.5 3.5h3",
  checkout: "M2 7h7M6 4l3 3-3 3M11.5 2v10",
  copy: "M4.5 4.5h7v7h-7zM2.5 9.5v-7h7",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

interface Props {
  onClose: () => void;
  onLocate: (id: string) => void;
  onBranch: (id: string) => void;
  onCheckout: (id: string) => void;
  say: (m: string) => void;
  /** 合并或变基进行中：不能检出、新建分支 */
  busy: boolean;
}

export function ReflogWindow({ onClose, onLocate, onBranch, onCheckout, say, busy }: Props) {
  useReturnFocus();
  const [refs, setRefs] = useState<string[]>(["HEAD"]);
  const [name, setName] = useState("HEAD");
  const [rows, setRows] = useState<ReflogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.reflogRefs().then(setRefs, () => setRefs(["HEAD"]));
  }, []);
  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    api.reflog(name).then(
      (r) => live && setRows(r),
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [name]);

  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!rows || !f) return rows ?? [];
    return rows.filter((r) => [r.action, r.message, r.title, r.id, actionText(r.action)].some((x) => x.toLowerCase().includes(f)));
  }, [rows, q]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal blame reflog" role="dialog" aria-modal="true" aria-label={t("操作记录")} onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1}>
        <div className="blame-head">
          <h2>{t("操作记录")}</h2>
          <select className="rl-ref mono" value={name} onChange={(e) => setName(e.target.value)} aria-label={t("看哪个的操作记录")}>
            {refs.map((r) => (
              <option key={r} value={r}>
                {r === "HEAD" ? t("HEAD（所有切换和提交）") : r}
              </option>
            ))}
          </select>
          <input className="pk-q rl-q" placeholder={t("搜索动作、说明或版本号")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label={t("搜索操作记录")} />
          <span className="grow" />
          <span className="dim small">{rows ? t("{0} 条", rows.length) : ""}</span>
          <button type="button" className="ib" title={t("关闭")} aria-label={t("关闭")} onClick={onClose} autoFocus>
            ×
          </button>
        </div>
        <p className="rl-tip dim small">{t("这里是 Git 自己记下的：{0} 指向过的每个提交。被重置、变基或删掉分支丢下的提交也能在这里找到，从那一行新建一个分支就找回来了。", name)}</p>
        {error && <p className="err pad">{tr(error)}</p>}
        <div className="rl-body">
          {!rows && !error && <p className="dim pad">{t("正在读取…")}</p>}
          {rows && shown.length === 0 && <p className="dim pad">{q ? t("没有匹配的记录") : t("还没有操作记录")}</p>}
          {shown.map((r) => (
            <div key={r.index} className={"rl-row" + (r.in_log ? "" : " lost") + (r.exists ? "" : " gone")}>
              <span className="rl-n mono dim" title={`${name}@{${r.index}}`}>
                @{"{"}
                {r.index}
                {"}"}
              </span>
              <span className="rl-act" title={r.action}>
                {actionText(r.action)}
              </span>
              <span className="rl-msg" title={[r.message, r.title].filter(Boolean).join("\n")}>
                <span className="rl-title">{r.exists ? r.title : t("（提交已经被清理掉了）")}</span>
                {r.message && r.message !== r.title && <span className="dim small"> · {r.message}</span>}
              </span>
              <span>
                {!r.in_log && r.exists && (
                  <span className="rl-badge" title={t("这个提交现在不在任何分支或标签上，日志里看不到；从这里新建分支可以找回它")}>
                    {t("不在日志里")}
                  </span>
                )}
              </span>
              <span className="rl-id mono dim">{shortId(r.id)}</span>
              <span className="rl-time dim small" title={formatTime(r.time)}>
                {relTime(r.time)}
              </span>
              <span className="rl-acts">
                {r.in_log && (
                  <button type="button" className="ib sm" title={t("在日志里定位")} aria-label={t("在日志里定位")} onClick={() => (onClose(), onLocate(r.id))}>
                    <Ico d={ICON.locate} />
                  </button>
                )}
                {r.exists && (
                  <>
                    <button type="button" className="ib sm" title={busy ? t("合并或变基还没完成") : t("从这里新建分支（找回这个提交）")} aria-label={t("从这里新建分支")} disabled={busy} onClick={() => (onClose(), onBranch(r.id))}>
                      <Ico d={ICON.branch} />
                    </button>
                    <button type="button" className="ib sm" title={busy ? t("合并或变基还没完成") : t("检出这个版本（不在任何分支上）")} aria-label={t("检出这个版本")} disabled={busy} onClick={() => (onClose(), onCheckout(r.id))}>
                      <Ico d={ICON.checkout} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="ib sm"
                  title={t("复制版本号")}
                  aria-label={t("复制版本号")}
                  onClick={() => navigator.clipboard?.writeText(r.id).then(() => say(t("已复制 {0}", shortId(r.id))), () => say(t("复制失败")))}
                >
                  <Ico d={ICON.copy} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
