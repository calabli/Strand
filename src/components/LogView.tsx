// Git log: a virtually scrolled commit list + graph. Only visible rows are rendered, so even 100k commits use only a few dozen DOM nodes.
//
// The graph is currently one small SVG per row, drawn from this row's node to the next (overflow: visible shows what sticks out).
// Long edges spanning many rows are collapsed by the core layer: cut_out draws a short segment down ending in a down arrow; cut_in draws a down arrow at the top of the row, then continues down.
// Spec §2 says Canvas; switch to one big Canvas when more performance is needed.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogData } from "../api/useLog";
import type { Commit, GraphRow } from "../api/types";
import { formatTime, relTime } from "./format";
import { useSettings } from "../settings";
import { t, tr } from "../i18n";

const ROW = 28;
const LANE_W = 14;
const OVERSCAN = 10;
/** Maximum lanes shown in the graph column. After collapsing long edges, even a repository with 86k commits and hundreds of branches is only a dozen or so wide; this is just a safeguard */
const MAX_LANES = 24;
/** Maximum ref labels shown per row; the rest collapse into "+N" */
const MAX_REFS = 3;

const laneColor = (l: number) => `var(--l${l % 4})`;
const laneX = (l: number) => 10 + l * LANE_W;

/** isHead: the current branch's latest commit (the commit HEAD is on), drawn as a hollow circle (spec §5.3); others are filled */
function GraphCell({ g, width, isHead, onJump }: { g: GraphRow; width: number; isHead: boolean; onJump?: (row: number) => void }) {
  const y = ROW / 2;
  return (
    <svg className="graph" width={width} height={ROW} aria-hidden="true">
      {g.edges.map((e, i) => {
        const x1 = laneX(e.from_lane);
        const x2 = laneX(e.to_lane);
        const color = laneColor(e.kind === "merge" ? e.to_lane : e.from_lane);
        if (e.kind === "cut_out") {
          // A short segment down ending in a down arrow: this edge rejoins far below
          const end = y + ROW * 0.55;
          return (
            <g key={i}>
              <path d={`M${x1} ${y}V${end}M${x1 - 3.5} ${end - 4}L${x1} ${end}L${x1 + 3.5} ${end - 4}`} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {e.target != null && onJump && <JumpHit x={x1} y={end - 3} title={t("跳到父提交")} onClick={() => onJump(e.target!)} />}
            </g>
          );
        }
        if (e.kind === "cut_in") {
          // A down arrow at the top of the row (rejoining from far above), then drawn on to the next row
          const top = 3;
          return (
            <g key={i}>
              <path d={`M${x1 - 3.5} ${top}L${x1} ${top + 4}L${x1 + 3.5} ${top}M${x1} ${top + 4}V${y + ROW}`} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {e.target != null && onJump && <JumpHit x={x1} y={top + 2} title={t("跳到子提交")} onClick={() => onJump(e.target!)} />}
            </g>
          );
        }
        const d =
          x1 === x2
            ? `M${x1} ${y}V${y + ROW}`
            : `M${x1} ${y}C${x1} ${y + ROW * 0.6},${x2} ${y + ROW * 0.4},${x2} ${y + ROW}`;
        return <path key={i} d={d} stroke={color} strokeWidth={2} fill="none" />;
      })}
      <circle
        cx={laneX(g.lane)}
        cy={y}
        r={isHead ? 4 : 4.5}
        fill={isHead ? "var(--win)" : laneColor(g.lane)}
        stroke={laneColor(g.lane)}
        strokeWidth={2}
      />
    </svg>
  );
}

/** A clickable area on the arrow: jumps to the other end of the collapsed edge. Bigger than the arrow so it's easy to hit; doesn't bubble to the row click */
function JumpHit({ x, y, title, onClick }: { x: number; y: number; title: string; onClick: () => void }) {
  return (
    <circle
      className="graph-jump"
      cx={x}
      cy={y}
      r={6}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
    >
      <title>{title}</title>
    </circle>
  );
}

/**
 * Labels on a commit. With `merge` on (display options in spec §5.1), a local branch and its same-named remote branch on the same commit
 * are combined into one "origin & main" label styled like the local branch.
 */
function RefChips({ c, merge, current }: { c: Commit; merge: boolean; current: string | null }) {
  const refs = c.refs;
  const folded = new Set<string>();
  const label = new Map<string, string>();
  if (merge) {
    for (const r of refs) {
      if (r.kind !== "branch" && r.kind !== "head") continue;
      const remotes = refs.filter((x) => x.kind === "remote" && x.name.endsWith("/" + r.name) && x.name.length > r.name.length + 1);
      if (!remotes.length) continue;
      remotes.forEach((x) => folded.add(x.name));
      label.set(r.kind + r.name, `${remotes.map((x) => x.name.slice(0, -r.name.length - 1)).join(" & ")} & ${r.name}`);
    }
  }
  // The current branch first, with a dark background (spec §5.2)
  const shown = refs
    .filter((r) => !(r.kind === "remote" && folded.has(r.name)))
    .map((r) => ({ r, text: label.get(r.kind + r.name) ?? r.name, cur: r.kind === "branch" && r.name === current }))
    .sort((a, b) => Number(b.cur) - Number(a.cur));
  // When they don't fit: the first few show normally, the rest collapse into "+N"; hover for the full list
  const head = shown.slice(0, MAX_REFS);
  const rest = shown.slice(MAX_REFS);
  return (
    <>
      {head.map(({ r, text, cur }) => (
        <span
          key={r.kind + r.name}
          className={`ref ref-${r.kind}` + (cur ? " ref-current" : "")}
          title={label.has(r.kind + r.name) ? t("本地分支 {0} 和远程分支在同一个提交上", r.name) : cur ? t("当前分支 {0}", r.name) : text}
        >
          {text}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="ref ref-more" title={shown.map((x) => x.text).join("\n")}>
          {t("+{0}", rest.length)}
        </span>
      )}
    </>
  );
}

/** Highlight the parts of the title matching the search text */
function useMarker(h: Props["highlight"]) {
  return useMemo(() => {
    if (!h?.text) return null;
    try {
      const src = h.regex ? h.text : h.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(src, h.caseSensitive ? "g" : "gi");
    } catch {
      return null;
    }
  }, [h?.text, h?.regex, h?.caseSensitive]);
}

/** Whether the title has a match */
function hits(title: string, re: RegExp): boolean {
  re.lastIndex = 0;
  const m = re.test(title);
  re.lastIndex = 0;
  return m;
}

/** Whether the search text is a prefix of this commit's id (4+ hex characters, same as the core layer) */
const hashHit = (id: string, text: string) => {
  const t = text.trim().toLowerCase();
  return t.length >= 4 && /^[0-9a-f]+$/.test(t) && id.startsWith(t);
};

function marked(title: string, re: RegExp | null): ReactNode {
  if (!re) return title;
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(title); m; m = re.exec(title)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out.push(title.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (!out.length) return title;
  out.push(title.slice(last));
  return out;
}

interface Props {
  log: LogData;
  /** Filters are set (an empty result shows "clear filters") */
  filtered: boolean;
  /** Scroll back to the top when this changes (filters changed) */
  scrollKey: string;
  onClearFilter: () => void;
  highlight?: { text: string; regex: boolean; caseSensitive: boolean };
  selected: string | null;
  /** Multi-selected commits (spec §5.4) */
  multi: Set<string>;
  /** Click; with ⌘/Ctrl adds to the selection, with Shift selects a range */
  onSelect: (c: Commit, row: number, mods: { toggle: boolean; range: boolean }) => void;
  /** Double-click a commit: open its changes */
  onOpen?: (c: Commit) => void;
  /** Jump to a row (scrolled to the middle of the visible area); n differs every time so the same row can be jumped to again */
  jump: { row: number; n: number } | null;
  /** The commit HEAD is on, drawn as a hollow circle in the graph */
  headId?: string | null;
  /** The current branch name; its label has a dark background */
  currentBranch?: string | null;
  /** Clicking the arrow on a collapsed long edge: jump to the other end and select that row */
  onJumpRow?: (row: number) => void;
  onMenu: (c: Commit, x: number, y: number) => void;
  /** When collapsing linear branches, clicking the "folded" marker expands */
  onExpand?: () => void;
}

export function LogView({ log, filtered, scrollKey, onClearFilter, highlight, selected, multi, onSelect, onOpen, jump, onJumpRow, headId, currentBranch, onMenu, onExpand }: Props) {
  const marker = useMarker(highlight);
  const { exactDates: exact, mergeRefs, dimMerges } = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [width, setWidth] = useState(800);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = 0;
    setScroll(0);
  }, [scrollKey]);

  // Right after filters change the row count may still be the old one; scroll once new results arrive and there are enough rows
  const jumped = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!jump || !el || jumped.current === jump.n || jump.row >= log.total || log.loading) return;
    jumped.current = jump.n;
    const top = jump.row * ROW;
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
      setScroll(el.scrollTop);
    }
  }, [jump, log.total, log.loading]);

  const first = Math.max(0, Math.floor(scroll / ROW) - OVERSCAN);
  const last = Math.min(log.total, Math.ceil((scroll + height) / ROW) + OVERSCAN);

  useEffect(() => {
    if (log.total > 0) log.ensure(first, last);
  }, [first, last, log]);

  // No graph when filtering or sorting by time, just a little left margin
  // When the log column is narrow (branch tree and details both open, narrow window): hide the author column and show dates as month/day only
  const compact = width < 560;
  // The graph column width follows the widest of the visible rows (including rows prefetched above and below), not the whole log: after collapsing long edges most places only use a few lanes.
  // At most 35% of the log width so titles have room in narrow windows; extra lanes are clipped
  let shown = 0;
  if (log.lanes > 0)
    for (let i = first; i < last; i++) {
      const g = log.row(i)?.graph;
      if (g) shown = Math.max(shown, g.lane + 1, ...g.edges.map((e) => Math.max(e.from_lane, e.to_lane) + 1));
    }
  if (log.lanes > 0 && shown === 0) shown = log.lanes;
  const graphW = log.lanes > 0 ? Math.min(laneX(Math.min(shown, MAX_LANES) - 1) + 12, Math.max(48, Math.floor(width * 0.35))) : 10;
  const items = [];
  for (let i = first; i < last; i++) {
    const r = log.row(i);
    const style = { top: i * ROW, height: ROW };
    if (!r) {
      items.push(<div key={i} className="crow loading" style={style} />);
      continue;
    }
    const c = r.commit;
    items.push(
      <button
        key={c.id}
        type="button"
        className={"crow" + (c.id === selected || multi.has(c.id) ? " sel" : "")}
        style={{ ...style, gridTemplateColumns: compact ? `${graphW}px minmax(0,1fr) 0px 44px` : `${graphW}px minmax(0,1fr) 72px 118px` }}
        onClick={(e) => onSelect(c, i, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey })}
        onDoubleClick={(e) => !(e.metaKey || e.ctrlKey || e.shiftKey) && onOpen?.(c)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(c, e.clientX, e.clientY);
        }}
        // Open the context menu from the keyboard (spec §12.4): Shift+F10 or the menu key
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(c, r.left + 120, r.bottom);
          }
        }}
      >
        {r.graph ? <GraphCell g={r.graph} width={graphW} isHead={c.id === headId} onJump={onJumpRow} /> : <span />}
        <span className={"msg" + (c.is_merge && dimMerges ? " merge" : "")}>
          <RefChips c={c} merge={mergeRefs} current={currentBranch ?? null} />
          <span className="title">{marked(c.title, marker)}</span>
            {/* Collapsed linear branches: commits folded under this row (the graph connects this stretch directly to the next remaining commit) */}
            {!!r.folded && (
              <span
                className="folded-tag"
                title={t("下面有 {0} 个提交折叠起来了（旁支上没有分支或标签的连续提交）。点击展开线性分支", r.folded)}
                onClick={(e) => {
                  e.stopPropagation();
                  onExpand?.();
                }}
              >
                ⋯ {t("{0} 个已折叠", r.folded)}
              </span>
            )}
            {/* Matched but not in the title: the match is in the body, or it matched the commit id */}
            {marker && highlight && !hits(c.title, marker) && (
              <span className="in-body" title={hashHit(c.id, highlight.text) ? t("版本号以“{0}”开头", highlight.text.trim()) : t("搜索的文字在提交说明的正文里，选中后在右边的详情里标出")}>
                {hashHit(c.id, highlight.text) ? t("版本号") : t("正文")}
              </span>
            )}
          {c.unpushed && (
            <span className="unpushed" title={t("未推送")}>
              ↑
            </span>
          )}
        </span>
        <span className="who">{c.author.name}</span>
        <span className="when mono" title={exact ? relTime(c.time) : formatTime(c.time)}>
          {compact ? formatTime(c.time).slice(5, 10) : exact ? formatTime(c.time) : relTime(c.time)}
        </span>
      </button>,
    );
  }

  return (
    <div className="log" ref={box} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      {log.error && log.error.code !== "INVALID_REGEX" && <div className="log-error">{tr(log.error.message)}</div>}
      {(log.loading || log.partial) && log.total === 0 && <div className="log-note dim">{t("正在过滤…")}</div>}
      {/* Results still being appended (spec §15): a small hint at the top right that stays at the top while scrolling */}
      {log.partial && log.total > 0 && (
        <div className="log-partial-wrap">
          <span className="log-partial dim small" role="status">
            {t("仍在查找… 已找到 {0} 个", log.total)}
          </span>
        </div>
      )}
      {!log.loading && !log.partial && log.total === 0 && (filtered || log.error?.code === "INVALID_REGEX") && (
        <div className="log-note">
          <p className="dim">{log.error?.code === "INVALID_REGEX" ? tr(log.error.message) : t("没有符合条件的提交")}</p>
          <button type="button" className="btn sm" onClick={onClearFilter}>
            {t("清空过滤条件")}
          </button>
        </div>
      )}
      <div className="log-inner" style={{ height: log.total * ROW }}>
        {items}
      </div>
    </div>
  );
}
