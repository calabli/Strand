// The balloon stack in the bottom-right corner (newest at the bottom, next to the update card) and the notification
// history window.

import type { ReactNode } from "react";
import { clearHistory, hide, hold, useNotes, type Note } from "../notify";
import { useReturnFocus } from "./focus";
import { formatTime } from "./format";
import { t, tr } from "../i18n";

function Icon({ kind }: { kind: Note["kind"] }) {
  const d = {
    success: "M3.5 8.5l3 3 6-7",
    info: "M8 7v4.5M8 4.6v.1",
    warning: "M8 4.5v4M8 11v.1",
    error: "M5 5l6 6M11 5l-6 6",
  }[kind];
  return (
    <span className={"bal-icon " + kind} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

function Balloon({ n }: { n: Note }) {
  return (
    <div
      className={"balloon " + n.kind}
      role={n.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => hold(n.id, true)}
      onMouseLeave={() => hold(n.id, false)}
    >
      <Icon kind={n.kind} />
      <div className="bal-main">
        <div className="bal-title">{tr(n.title)}</div>
        {n.body && <div className="bal-body">{tr(n.body)}</div>}
        {!!n.actions?.length && (
          <div className="bal-acts">
            {n.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="bal-link"
                onClick={() => {
                  hide(n.id);
                  a.run();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="ib sm bal-x" title={t("关闭")} aria-label={t("关闭")} onClick={() => hide(n.id)}>
        ×
      </button>
    </div>
  );
}

/** Fixed in the bottom-right; `after` (the update card) sits below the balloons */
export function Balloons({ after }: { after?: ReactNode }) {
  const shown = useNotes().filter((n) => n.shown);
  return (
    <div className="balloons" aria-live="polite">
      {shown.map((n) => (
        <Balloon key={n.id} n={n} />
      ))}
      {after}
    </div>
  );
}

export function NoteHistory({ onClose }: { onClose: () => void }) {
  useReturnFocus();
  const all = [...useNotes()].reverse();
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal note-history" role="dialog" aria-modal="true" aria-label={t("通知记录")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{t("通知记录")}</h2>
        <div className="nh-list">
          {all.length === 0 && <p className="dim">{t("还没有通知")}</p>}
          {all.map((n) => (
            <div key={n.id} className={"nh-row " + n.kind}>
              <Icon kind={n.kind} />
              <div className="bal-main">
                <div className="bal-title">
                  {tr(n.title)} <span className="dim small">{formatTime(Math.floor(n.time / 1000)).slice(11)}</span>
                </div>
                {n.body && <div className="bal-body">{tr(n.body)}</div>}
                {!!n.actions?.length && (
                  <div className="bal-acts">
                    {n.actions.map((a) => (
                      <button key={a.label} type="button" className="bal-link" onClick={() => (onClose(), a.run())}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-btns">
          <button type="button" className="btn" onClick={clearHistory} disabled={!all.length}>
            {t("清空")}
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            {t("关闭")}
          </button>
        </div>
      </div>
    </div>
  );
}
