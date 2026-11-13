// 逐行追溯（说明书 10.2）：文件的完整内容，每行左边是最后改它的提交。
// 先读首屏 300 行，其余在后台接着读。连续属于同一提交的行只在第一行显示提交信息；左边的颜色条按作者区分。
// 点左边的信息：关闭窗口，清空日志过滤条件，选中并滚动到那个提交；提交不在日志里（被整理掉）时不跳转。

import { useReturnFocus } from "./focus";
import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { BlamePage } from "../api/types";
import { t, tr } from "../i18n";
import { formatTime, shortId } from "./format";

const FIRST = 300;
const REST = 5000;

type Commit = BlamePage["commits"][number];
type Line = { no: number; text: string; c: Commit };

/** 作者 → 颜色（同一作者同一颜色） */
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
        // 其余分批在后台读
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
                <span className="bl-code">{l.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
