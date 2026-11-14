// Rebasing commits (spec §9): the rebase window and quick rebase actions (squash, drop several, Fixup, Squash Into).
// The window lists the oldest commit at the top; each row can move up or down and choose keep, squash into previous, or drop.

import { useReturnFocus } from "./focus";
import { useCallback, useState } from "react";
import { api, errOf } from "../api/commands";
import type { Commit, OpInfo, RangeCommit, RebaseStep, RepoState, Selection, StepAction, Written } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { shortId } from "./format";
import { t, lazy } from "../i18n";

interface Deps {
  ask: (d: DialogSpec) => void;
  done: (state: RepoState, message: string, op?: OpInfo) => void;
  failed: (message: string) => void;
  say: (message: string) => void;
}

/** message: a new message typed in the window (only used for kept commits) */
type Row = RangeCommit & { action: Exclude<StepAction, "fixup">; message?: string };

export function useRebase({ ask, done, failed, say }: Deps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hasPushed, setHasPushed] = useState(false);
  const [orig, setOrig] = useState<string[]>([]);

  const run = useCallback(
    async <T,>(p: Promise<Written<T>>, message: (r: T) => string): Promise<string | void> => {
      try {
        const w = await p;
        done(w.state, message(w.result), w.op);
      } catch (e) {
        const err = errOf(e);
        if (err.code === "CONFLICTS") {
          failed("");
          say(t("整理时有冲突，请逐个处理"));
        } else if (err.code === "EMPTY_MESSAGE") return err.message;
        else failed(err.message);
      }
    },
    [done, failed, say],
  );

  const resultText = (r: { before: number; after: number }) =>
    r.after === 0 ? t("{0} 个提交都丢弃了", r.before) : t("{0} 个提交整理成了 {1} 个", r.before, r.after);

  /** Open the rebase window; with from empty, all rebaseable commits */
  const open = useCallback(
    async (from: string | null = null) => {
      try {
        const r = await api.rebaseRange(from);
        if (r.commits.length < 2) return say(t("可以整理的提交不到 2 个"));
        setHasPushed(r.has_pushed);
        setOrig(r.commits.map((c) => c.id));
        setRows(r.commits.map((c) => ({ ...c, action: "pick" })));
      } catch (e) {
        failed(errOf(e).message);
      }
    },
    [failed, say],
  );

  const apply = useCallback(
    (steps: RebaseStep[]) => {
      setRows(null);
      return run(api.rebaseApply(steps), resultText);
    },
    [run],
  );

  /** Multi-selected commits: squash all but the oldest into the previous (spec §9.3) */
  const squashMany = useCallback(
    async (ids: string[]) => {
      try {
        const range = (await api.rebaseRange(null)).commits;
        const first = range.findIndex((c) => ids.includes(c.id));
        if (first < 0 || ids.some((id) => !range.some((c) => c.id === id))) return say(t("选中的提交不都在可以整理的范围里"));
        const steps = range.slice(first).map((c, k) => ({ id: c.id, action: (k > 0 && ids.includes(c.id) ? "squash" : "pick") as StepAction }));
        await run(api.rebaseApply(steps), resultText);
      } catch (e) {
        failed(errOf(e).message);
      }
    },
    [failed, run, say],
  );

  const dropMany = useCallback(
    (ids: string[]) =>
      ask({
        title: t("丢弃 {0} 个提交", ids.length),
        message: t("从历史里去掉这些提交和它们的改动，之后的提交接上来。可以撤销。"),
        confirm: t("丢弃"),
        danger: true,
        onSubmit: async () => {
          try {
            const range = (await api.rebaseRange(null)).commits;
            const first = range.findIndex((c) => ids.includes(c.id));
            if (first < 0 || ids.some((id) => !range.some((c) => c.id === id))) return t("选中的提交不都在可以整理的范围里");
            const steps = range.slice(first).map((c) => ({ id: c.id, action: (ids.includes(c.id) ? "drop" : "pick") as StepAction }));
            return run(api.rebaseApply(steps), resultText);
          } catch (e) {
            return errOf(e).message;
          }
        },
      }),
    [ask, run],
  );

  /** Fixup: fold the checked changes into this commit, message unchanged */
  const fixup = useCallback((c: Commit, sel: Selection) => run(api.commitFixup(c.id, sel), () => t("已把 {0} 个文件的改动并入“{1}”", sel.files.length, c.title)), [run]);

  /** Squash Into: fold in and edit the message */
  const squashInto = useCallback(
    (c: Commit, sel: Selection) =>
      ask({
        title: t("并入“{0}”并修改说明", c.title),
        message: t("把勾选的 {0} 个文件的改动并入这个提交，它之后的提交会被改写。", sel.files.length),
        input: { initial: c.body ? `${c.title}\n\n${c.body}` : c.title, multiline: true },
        confirm: t("并入"),
        onSubmit: (msg) => run(api.commitFixup(c.id, sel, msg), () => t("已并入“{0}”", msg.split("\n")[0])),
      }),
    [ask, run],
  );

  const window = rows ? <RebaseWindow rows={rows} orig={orig} hasPushed={hasPushed} onChange={setRows} onApply={apply} onClose={() => setRows(null)} /> : null;
  return { open, squashMany, dropMany, fixup, squashInto, window };
}

export type Rebase = ReturnType<typeof useRebase>;

const I = {
  up: "M7 11.5v-9M3.5 6 7 2.5 10.5 6",
  down: "M7 2.5v9M3.5 8 7 11.5 10.5 8",
  pick: "M2.5 7.5 5.5 10.5 11.5 3.5",
  squash: "M3 2.5v4.5a2 2 0 0 0 2 2h6.5M8.5 6 11.5 9 8.5 12",
  drop: "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.5 8.5h6l.5-8.5",
  edit: "M9.5 2.5l2 2-7 7H2.5v-2zM8 4l2 2",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ACTIONS: { a: Row["action"]; label: string; icon: string }[] = lazy(() => [
  { a: "pick" as const, label: t("保留"), icon: I.pick },
  { a: "squash" as const, label: t("并入上一个"), icon: I.squash },
  { a: "drop" as const, label: t("丢弃"), icon: I.drop },
]);

/** Commits left after rebasing: a squash that isn't preceded by a non-dropped commit counts as keep */
function countAfter(rows: Row[]) {
  let n = 0;
  for (const r of rows) {
    if (r.action === "pick" || (r.action === "squash" && n === 0)) n++;
  }
  return n;
}

function RebaseWindow({ rows, orig, hasPushed, onChange, onApply, onClose }: { rows: Row[]; orig: string[]; hasPushed: boolean; onChange: (f: (r: Row[] | null) => Row[] | null) => void; onApply: (s: RebaseStep[]) => void; onClose: () => void }) {
  useReturnFocus();
  // Editing a commit message in the window: the commit id and the text being typed
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const fullMessage = (r: Row) => r.message ?? (r.body ? `${r.title}\n\n${r.body}` : r.title);
  const saveEdit = () => {
    if (!editing) return;
    const text = editing.text.replace(/\s+$/, "");
    if (!text.split("\n")[0].trim()) return;
    onChange((rs) =>
      rs &&
      rs.map((r) => {
        if (r.id !== editing.id) return r;
        const original = r.body ? `${r.title}\n\n${r.body}` : r.title;
        return { ...r, message: text === original ? undefined : text };
      }),
    );
    setEditing(null);
  };
  const move = (i: number, d: -1 | 1) =>
    onChange((rs) => {
      if (!rs) return rs;
      const n = [...rs];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const set = (i: number, action: Row["action"]) => onChange((rs) => rs && rs.map((r, k) => (k === i ? { ...r, action } : r)));
  const after = countAfter(rows);
  const changed = rows.some((r, k) => r.action !== "pick" || r.id !== orig[k] || r.message !== undefined);
  // The nearest kept commit before each row (to tell whether a squash has a target)
  let keptAbove = false;
  const effective = rows.map((r) => {
    const eff = r.action === "squash" && !keptAbove ? "pick" : r.action;
    if (eff !== "drop") keptAbove = true;
    return eff;
  });
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal rb"
        role="dialog"
        aria-modal="true"
        aria-label={t("整理提交")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (editing) {
              e.stopPropagation();
              setEditing(null);
            } else onClose();
          }
        }}
      >
        <h2>{t("整理提交")}</h2>
        <p className="modal-msg">{t("最早的在最上面。可以调整顺序，选择保留、并入上一个或丢弃，点铅笔改保留的提交的说明。")}</p>
        <ol className="rb-list">
          {rows.map((r, i) => (
            <li key={r.id} className={"rb-row " + effective[i]}>
              <span className="rb-move">
                <button type="button" className="ib sm" title={t("上移")} aria-label={t("上移")} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Ico d={I.up} />
                </button>
                <button type="button" className="ib sm" title={t("下移")} aria-label={t("下移")} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  <Ico d={I.down} />
                </button>
              </span>
              <span className="rb-acts" role="radiogroup" aria-label={t("处理方式")}>
                {ACTIONS.map((x) => (
                  <button
                    key={x.a}
                    type="button"
                    role="radio"
                    aria-checked={r.action === x.a}
                    className={"ib sm rb-act" + (r.action === x.a ? " on " + x.a : "")}
                    title={x.a === "squash" && i === 0 ? t("并入上一个（第一行没有可并入的提交，按保留处理）") : x.label}
                    aria-label={x.label}
                    onClick={() => set(i, x.a)}
                  >
                    <Ico d={x.icon} />
                  </button>
                ))}
              </span>
              <span className="rb-text" title={fullMessage(r)}>
                <span className="mono dim">{shortId(r.id)}</span> <span className="rb-title">{r.message !== undefined ? r.message.split("\n")[0] : r.title}</span>
              </span>
              {r.message !== undefined && effective[i] === "pick" && <span className="rb-edited">{t("已改说明")}</span>}
              {r.pushed && <span className="rb-pushed">{t("已推送")}</span>}
              <button
                type="button"
                className="ib sm rb-edit"
                title={effective[i] === "pick" ? t("改说明") : t("只有保留的提交能改说明")}
                aria-label={t("改 {0} 的说明", shortId(r.id))}
                disabled={effective[i] !== "pick"}
                onClick={() => setEditing({ id: r.id, text: fullMessage(r) })}
              >
                <Ico d={I.edit} />
              </button>
              {editing?.id === r.id && (
                <div className="rb-editor">
                  <textarea
                    autoFocus
                    rows={4}
                    value={editing.text}
                    aria-label={t("新的提交说明")}
                    onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveEdit();
                      }
                    }}
                  />
                  <div className="rb-editor-btns">
                    {r.message !== undefined && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          onChange((rs) => rs && rs.map((x) => (x.id === r.id ? { ...x, message: undefined } : x)));
                          setEditing(null);
                        }}
                      >
                        {t("恢复原说明")}
                      </button>
                    )}
                    <span className="grow" />
                    <button type="button" className="btn sm" onClick={() => setEditing(null)}>
                      {t("取消")}
                    </button>
                    <button type="button" className="btn sm primary" disabled={!editing.text.split("\n")[0].trim()} onClick={saveEdit} title={t("确定（⌘↵）")}>
                      {t("确定")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="rb-sum">
          {t("{0} 个提交整理后变成 {1} 个", rows.length, after)}
          {after === 0 && t("，分支会退回到这些提交之前")}
        </p>
        {hasPushed && <p className="warnbox">{t("其中有已经推送的提交，整理后需要强制推送。")}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            type="button"
            className={"btn " + (after === 0 ? "danger" : "primary")}
            disabled={!changed}
            title={changed ? undefined : t("还没有做任何调整")}
            onClick={() => onApply(rows.map((r, i) => ({ id: r.id, action: r.action, ...(r.message !== undefined && effective[i] === "pick" ? { message: r.message } : {}) })))}
          >
            {t("整理")}
          </button>
        </div>
      </div>
    </div>
  );
}
