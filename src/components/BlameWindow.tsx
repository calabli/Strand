// Blame (spec §10.2): the file's full content, each line with the commit that last changed it on the left.
// The first screen of 300 lines is read first, the rest in the background. Consecutive lines from the same commit show its info only on the first line; the color bar on the left distinguishes authors.
// Clicking the info on the left closes the window, clears the log filters, and selects and scrolls to that commit; no jump when the commit isn't in the log (rewritten).

import { useReturnFocus } from "./focus";
import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { BlamePage } from "../api/types";
import { t, tr } from "../i18n";
import { formatTime, shortId } from "./format";
import { Found } from "./inlineDiff";
import { highlight, langOf, type Tok } from "../highlight";
import { useSettings } from "../settings";

const FIRST = 300;
const REST = 5000;

type Commit = BlamePage["commits"][number];
type Line = { no: number; text: string; c: Commit };

/** author → color (same author, same color) */
function hue(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function BlameWindow({ path, rev, onClose, onJump }: { path: string; rev: string | null; onClose: () => void; onJump: (id: string) => void }) {
  useReturnFocus();
  const [lines, setLines] = useState<Line[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const start = performance.now();
    const add = (p: BlamePage) => {
      const ls = p.lines.map((l) => ({ no: l.no, text: l.text, c: p.commits[l.commit] }));
      setLines((x) => [...x, ...ls]);
    };
    (async () => {
      try {
        const first = await api.blameFile(path, rev, 0, FIRST);
        if (!live) return;
        setTotal(first.total);
        add(first);
        setMs(Math.round(performance.now() - start));
        // The rest is read in batches in the background
        for (let off = FIRST; off < first.total && live; off += REST) {
          const p = await api.blameFile(path, rev, off, REST);
          if (live) add(p);
        }
      } catch (e) {
        if (live) setError(errOf(e).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [path, rev]);

  // Syntax highlighting: color the whole thing once everything is read (on a background thread)
  const syntax = useSettings().diffSyntax;
  const [toks, setToks] = useState<Tok[][] | null>(null);
  const loaded = total !== null && lines.length >= total;
  useEffect(() => {
    if (!loaded || !syntax) return;
    let live = true;
    highlight(langOf(path), [lines.map((l) => l.text).join("\n")], true).then(([x]) => live && setToks(x));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, syntax, path]);

  const tip = (c: Commit) =>
    c.uncommitted ? t("还没提交的改动") : `${shortId(c.id)} · ${c.author} · ${formatTime(c.time)}\n\n${c.title}${c.body ? `\n\n${c.body}` : ""}${c.in_log ? "" : `\n\n${t("这个提交已经不在日志里，不能跳转")}`}`;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal blame" role="dialog" aria-modal="true" aria-label={t("逐行追溯")} onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1}>
        <div className="blame-head">
          <h2>{t("逐行追溯")}</h2>
          <span className="mono">{path}</span>
          <span className="dim">{rev ? t("版本 {0}", shortId(rev)) : t("工作区")}</span>
          <span className="grow" />
          <span className="dim small">
            {total == null ? t("正在读取…") : lines.length < total ? t("已读取 {0} / {1} 行", lines.length, total) : t("{0} 行", total)}
            {ms != null && ` · ${t("首屏 {0} ms", ms)}`}
          </span>
          <button type="button" className="ib" title={t("关闭")} aria-label={t("关闭")} onClick={onClose} autoFocus>
            ×
          </button>
        </div>
        {error && <p className="err pad">{tr(error)}</p>}
        <div className="blame-body mono">
          {lines.map((l, i) => {
            const first = i === 0 || lines[i - 1].c.id !== l.c.id;
            const color = l.c.uncommitted ? "var(--fg2)" : `hsl(${hue(l.c.email || l.c.author)} 55% 55%)`;
            return (
              <div key={l.no} className={"bl-row" + (first ? " first" : "")}>
                <span className="bl-bar" style={{ background: color }} />
                {first ? (
                  <button
                    type="button"
                    className={"bl-who" + (l.c.in_log ? "" : " gone")}
                    title={tip(l.c)}
                    onClick={() => {
                      if (!l.c.in_log) return;
                      onClose();
                      onJump(l.c.id);
                    }}
                  >
                    {l.c.uncommitted ? (
                      <span className="dim">{t("还没提交")}</span>
                    ) : (
                      <>
                        <span className="bl-hash">{shortId(l.c.id)}</span>
                        <span className="bl-author">{l.c.author}</span>
                        <span className="bl-date dim">{formatTime(l.c.time).slice(0, 10)}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <span className="bl-who" title={tip(l.c)} />
                )}
                <span className="bl-no dim">{l.no}</span>
                <span className="bl-code">
                  <Found t={l.text} toks={syntax ? toks?.[i] : null} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
