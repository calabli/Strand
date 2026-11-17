// Contribution statistics of the current branch (command palette and the repository menu): totals, commits per month,
// when commits are made (weekday × hour), and a table of authors. Clicking an author filters the log to them.
// One series per chart, in the accent color; magnitude in the heat map is one hue from light to dark.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import type { AuthorStats, Contributions } from "../api/types";
import { Avatar } from "./Detail";
import { useReturnFocus } from "./focus";
import { formatTime } from "./format";
import { t, tr } from "../i18n";

type Range = "30" | "90" | "365" | "all";
const RANGES: { k: Range; label: () => string }[] = [
  { k: "30", label: () => t("30 天") },
  { k: "90", label: () => t("90 天") },
  { k: "365", label: () => t("1 年") },
  { k: "all", label: () => t("全部") },
];
const KEY = "strand.statsRange";
const WEEKDAYS = () => [t("周一"), t("周二"), t("周三"), t("周四"), t("周五"), t("周六"), t("周日")];

const num = (n: number) => n.toLocaleString();
const day = (s: number) => formatTime(s).slice(0, 10);

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

export function StatsWindow({ branch, onClose, onAuthor }: { branch: string; onClose: () => void; onAuthor: (a: AuthorStats) => void }) {
  useReturnFocus();
  const [range, setRange] = useState<Range>(() => {
    try {
      return (localStorage.getItem(KEY) as Range) || "365";
    } catch {
      return "365";
    }
  });
  const [data, setData] = useState<Contributions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, range);
    } catch {
      /* Only for this session */
    }
    let live = true;
    setLoading(true);
    setError(null);
    const since = range === "all" ? null : Math.floor(Date.now() / 1000) - Number(range) * 86400;
    api.contributions(since).then(
      (d) => live && (setData(d), setLoading(false)),
      (e) => live && (setError(errOf(e).message), setLoading(false)),
    );
    return () => {
      live = false;
    };
  }, [range]);

  /** Show a tooltip next to a mark (coordinates relative to the scrolling body) */
  const show = (e: React.MouseEvent | React.FocusEvent, lines: string[]) => {
    const b = box.current;
    if (!b) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const br = b.getBoundingClientRect();
    // At the pointer for the mouse (a column's hit area is taller than its bar), above the mark for the keyboard;
    // never above the visible part of the body
    const px = "clientX" in e ? e.clientX : r.left + r.width / 2;
    const py = "clientY" in e ? e.clientY - 4 : r.top;
    const x = Math.min(Math.max(px - br.left, 90), br.width - 90) + b.scrollLeft;
    setTip({ x, y: Math.max(py - br.top, 48) + b.scrollTop, lines });
  };
  const hide = () => setTip(null);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal stats-win" role="dialog" aria-modal="true" aria-label={t("贡献统计")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="stats-head">
          <h2>{t("贡献统计")}</h2>
          <span className="dim small mono">{branch}</span>
          <span className="grow" />
          <span className="seg" role="radiogroup" aria-label={t("时间范围")}>
            {RANGES.map((r) => (
              <button key={r.k} type="button" role="radio" aria-checked={range === r.k} className={range === r.k ? "on" : ""} onClick={() => setRange(r.k)}>
                {r.label()}
              </button>
            ))}
          </span>
          <button type="button" className="ib" title={t("关闭（Esc）")} aria-label={t("关闭")} onClick={onClose} autoFocus>
            ×
          </button>
        </div>
        <div className="stats-body" ref={box} onScroll={hide} aria-busy={loading}>
          {error && <p className="err">{tr(error)}</p>}
          {!data && !error && <p className="dim">{t("正在统计…")}</p>}
          {data && (
            <div className={loading ? "stats-stale" : ""}>
              <div className="stats-tiles">
                <Tile label={t("提交")} value={num(data.commits)} />
                <Tile label={t("作者")} value={num(data.authors.length)} />
                <Tile label={t("新增行")} value={data.no_lines ? "—" : data.added ? "+" + num(data.added) : "0"} />
                <Tile label={t("删除行")} value={data.no_lines ? "—" : data.deleted ? "−" + num(data.deleted) : "0"} />
              </div>
              {data.no_lines && <p className="dim small">{t("部分克隆的仓库里文件内容没有全部下载，不统计改动行数")}</p>}
              {!data.commits ? (
                <p className="dim stats-empty">{t("这段时间当前分支上没有提交")}</p>
              ) : (
                <>
                  <h3>{t("每月提交数")}</h3>
                  <Months data={data} show={show} hide={hide} />
                  <h3>{t("什么时候提交")}</h3>
                  <Heat heat={data.heat} show={show} hide={hide} />
                  <h3>{t("作者")}</h3>
                  <Authors data={data} onAuthor={onAuthor} />
                </>
              )}
              <p className="dim small stats-note">{t("只算当前分支的历史，不含合并提交；作者按 .mailmap 合并；时间按作者自己的时区。")}</p>
            </div>
          )}
          {tip && (
            <div className="stats-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
              {tip.lines.map((l, i) => (
                <div key={i} className={i ? "dim" : ""}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-tile">
      <div className="dim small">{label}</div>
      <div className="stats-num">{value}</div>
    </div>
  );
}

type Show = (e: React.MouseEvent | React.FocusEvent, lines: string[]) => void;

/** Commits per month: bars on a shared baseline, a few recessive grid lines, labels every few months */
function Months({ data, show, hide }: { data: Contributions; show: Show; hide: () => void }) {
  const ms = data.months;
  const max = Math.max(1, ...ms.map((m) => m.commits));
  // Round the axis top to a "nice" number
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const W = 760;
  const H = 150;
  const left = 34;
  const bottom = 20;
  const ph = H - bottom - 6;
  const slot = (W - left) / Math.max(1, ms.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const every = Math.ceil(ms.length / 12);
  return (
    <svg className="stats-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("每月提交数")}>
      {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => {
        const v = i * step;
        const y = 6 + ph - (v / top) * ph;
        return (
          <g key={i}>
            <line x1={left} x2={W} y1={y} y2={y} className={i ? "grid" : "axis"} />
            <text x={left - 6} y={y + 3} textAnchor="end" className="tick">
              {v}
            </text>
          </g>
        );
      })}
      {ms.map((m, i) => {
        const h = (m.commits / top) * ph;
        const x = left + i * slot + (slot - bw) / 2;
        const label = [t("{0}：{1} 个提交", m.month, m.commits), ...(data.no_lines ? [] : [t("+{0} −{1} 行", num(m.added), num(m.deleted))])];
        return (
          <g key={m.month}>
            {m.commits > 0 && <path d={barPath(x, 6 + ph, bw, h)} className="bar" />}
            {/* The hit area is the whole column, taller than the bar */}
            <rect
              x={left + i * slot}
              y={0}
              width={slot}
              height={H - bottom}
              className="hit"
              tabIndex={0}
              aria-label={label.join("，")}
              onMouseEnter={(e) => show(e, label)}
              onFocus={(e) => show(e, label)}
              onMouseLeave={hide}
              onBlur={hide}
            />
            {i % every === 0 && (
              <text x={left + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="tick">
                {m.month.slice(2).replace("-", "/")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A bar with 4 px rounded top corners, square at the baseline */
function barPath(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  const y = base - h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function niceStep(raw: number) {
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Weekday × hour: cells darker with more commits (5 steps of the accent, empty cells only outlined) */
function Heat({ heat, show, hide }: { heat: number[][]; show: Show; hide: () => void }) {
  const max = Math.max(1, ...heat.flat());
  const days = WEEKDAYS();
  return (
    <div className="stats-heat" role="grid" aria-label={t("什么时候提交")}>
      <div className="heat-row heat-hours" role="row">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="tick" role="columnheader">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
      </div>
      {heat.map((row, d) => (
        <div key={d} className="heat-row" role="row">
          <span className="tick" role="rowheader">
            {days[d]}
          </span>
          {row.map((n, h) => {
            const step = n ? Math.min(5, Math.ceil((n / max) * 5)) : 0;
            const label = t("{0} {1}:00–{2}:00：{3} 个提交", days[d], h, h + 1, n);
            return (
              <span
                key={h}
                role="gridcell"
                tabIndex={0}
                className={"heat-cell s" + step}
                aria-label={label}
                onMouseEnter={(e) => show(e, [label])}
                onFocus={(e) => show(e, [label])}
                onMouseLeave={hide}
                onBlur={hide}
              />
            );
          })}
        </div>
      ))}
      <div className="heat-legend dim small">
        {t("少")}
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <span key={s} className={"heat-cell s" + s} aria-hidden="true" />
        ))}
        {t("多")}
      </div>
    </div>
  );
}

function Authors({ data, onAuthor }: { data: Contributions; onAuthor: (a: AuthorStats) => void }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...data.authors.map((a) => a.commits));
  const list = useMemo(() => (all ? data.authors : data.authors.slice(0, 30)), [all, data.authors]);
  return (
    <table className="stats-authors">
      <thead>
        <tr>
          <th>{t("作者")}</th>
          <th className="num">{t("提交")}</th>
          {!data.no_lines && <th className="num">{t("新增 / 删除行")}</th>}
          <th>{t("期间")}</th>
        </tr>
      </thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.name + a.email}>
            <td>
              <button type="button" className="stats-who" title={t("在日志里只看 {0} 的提交", a.name)} onClick={() => onAuthor(a)}>
                <Avatar name={a.name} email={a.email} />
                <span className="stats-name">{a.name}</span>
                <span className="dim small stats-mail">{a.email}</span>
              </button>
            </td>
            <td className="num">
              <span className="stats-bar" style={{ width: `${(a.commits / max) * 100}%` }} aria-hidden="true" />
              <span className="mono">{num(a.commits)}</span>
              <span className="dim small"> {Math.round((a.commits / data.commits) * 100)}%</span>
            </td>
            {!data.no_lines && (
              <td className="num mono">
                <span className="plus">+{num(a.added)}</span> <span className="minus">−{num(a.deleted)}</span>
              </td>
            )}
            <td className="dim small">
              {day(a.first)} – {day(a.last)}
            </td>
          </tr>
        ))}
        {!all && data.authors.length > 30 && (
          <tr>
            <td colSpan={4}>
              <button type="button" className="btn sm" onClick={() => setAll(true)}>
                {t("显示全部 {0} 位作者", data.authors.length)}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
