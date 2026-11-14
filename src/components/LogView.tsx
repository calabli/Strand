// Git 日志：虚拟滚动的提交列表 + 图谱。只渲染可见范围内的行，10 万条提交也只有几十个 DOM 节点。
//
// 图谱目前每行一个小 SVG，从本行节点画到下一行（超出本行的部分靠 overflow: visible 显示）。
// 跨过很多行的长连线由核心层折叠：cut_out 往下画一小段，末端是向下的箭头；cut_in 在本行顶部画一个向下的箭头再接着往下画。
// 说明书 2 节写的是 Canvas，等需要更高性能时再换成整块 Canvas。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogData } from "../api/useLog";
import type { Commit, GraphRow } from "../api/types";
import { formatTime, relTime } from "./format";
import { useSettings } from "../settings";
import { t, tr } from "../i18n";

const ROW = 28;
const LANE_W = 14;
const OVERSCAN = 10;
/** 图谱列最多显示的泳道数。长连线折叠后，8.6 万提交、几百个分支的仓库最宽也只有十几条；这里只是保险 */
const MAX_LANES = 24;
/** 一行最多显示几个引用标签，其余收成“+N” */
const MAX_REFS = 3;

const laneColor = (l: number) => `var(--l${l % 4})`;
const laneX = (l: number) => 10 + l * LANE_W;

/** isHead：当前分支的最新提交（HEAD 所在的提交），画空心圆（说明书 5.3）；其余实心 */
function GraphCell({ g, width, isHead, onJump }: { g: GraphRow; width: number; isHead: boolean; onJump?: (row: number) => void }) {
  const y = ROW / 2;
  return (
    <svg className="graph" width={width} height={ROW} aria-hidden="true">
      {g.edges.map((e, i) => {
        const x1 = laneX(e.from_lane);
        const x2 = laneX(e.to_lane);
        const color = laneColor(e.kind === "merge" ? e.to_lane : e.from_lane);
        if (e.kind === "cut_out") {
          // 往下一小段，末端向下的箭头：这条线在下面很远的地方接回来
          const end = y + ROW * 0.55;
          return (
            <g key={i}>
              <path d={`M${x1} ${y}V${end}M${x1 - 3.5} ${end - 4}L${x1} ${end}L${x1 + 3.5} ${end - 4}`} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {e.target != null && onJump && <JumpHit x={x1} y={end - 3} title={t("跳到父提交")} onClick={() => onJump(e.target!)} />}
            </g>
          );
        }
        if (e.kind === "cut_in") {
          // 本行顶部向下的箭头（从上面很远的地方接回来），再一直画到下一行
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

/** 箭头上可以点的一块：跳到折叠的线的另一头。比箭头大一圈，好点中；不冒泡到整行的点击 */
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
 * 提交上的标签。`merge` 打开时（说明书 5.1 显示选项），本地分支和同名的远程分支在同一个提交上，
 * 合成一个“origin & main”标签，样式跟本地分支。
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
  // 当前分支排在最前，用深色底（说明书 5.2）
  const shown = refs
    .filter((r) => !(r.kind === "remote" && folded.has(r.name)))
    .map((r) => ({ r, text: label.get(r.kind + r.name) ?? r.name, cur: r.kind === "branch" && r.name === current }))
    .sort((a, b) => Number(b.cur) - Number(a.cur));
  // 放不下时：前几个照常显示，其余收成“+N”，悬停看完整列表
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

/** 标题里和搜索文字匹配的部分加底色 */
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

/** 标题里有没有匹配 */
function hits(title: string, re: RegExp): boolean {
  re.lastIndex = 0;
  const m = re.test(title);
  re.lastIndex = 0;
  return m;
}

/** 搜索文字是不是这个提交的版本号前缀（4 位以上的十六进制，和核心层一样） */
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
  /** 有过滤条件（空结果时显示“清空过滤条件”） */
  filtered: boolean;
  /** 变化时滚回顶部（过滤条件变了） */
  scrollKey: string;
  onClearFilter: () => void;
  highlight?: { text: string; regex: boolean; caseSensitive: boolean };
  selected: string | null;
  /** 多选的提交（说明书 5.4） */
  multi: Set<string>;
  /** 单击；带 ⌘/Ctrl 是加选，带 Shift 是选一段 */
  onSelect: (c: Commit, row: number, mods: { toggle: boolean; range: boolean }) => void;
  /** 跳到某一行（滚动到可见区域中间）；n 每次不同，用来重复跳到同一行 */
  jump: { row: number; n: number } | null;
  /** HEAD 所在的提交，图谱里画空心圆 */
  headId?: string | null;
  /** 当前分支名，它的标签用深色底 */
  currentBranch?: string | null;
  /** 点折叠的长连线上的箭头：跳到线的另一头并选中那一行 */
  onJumpRow?: (row: number) => void;
  onMenu: (c: Commit, x: number, y: number) => void;
  /** 折叠线性分支时，点“已折叠”标记展开 */
  onExpand?: () => void;
}

export function LogView({ log, filtered, scrollKey, onClearFilter, highlight, selected, multi, onSelect, jump, onJumpRow, headId, currentBranch, onMenu, onExpand }: Props) {
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

  // 过滤条件刚变时总行数可能还是旧的，等新结果回来、行数够了再滚
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

  // 有过滤或按时间排序时没有图谱，只留一点左边距
  // 日志列很窄时（分支树和详情都开着、窗口不宽）：不显示作者列，日期只显示月/日
  const compact = width < 560;
  // 图谱列宽按看得见的这些行（含上下预读的行）里最宽的那一行算，不按整个日志：长连线折叠后大部分地方只用几条泳道。
  // 最多占日志宽度的 35%，窄窗口里也给标题留出位置；超出的泳道裁掉
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
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(c, e.clientX, e.clientY);
        }}
        // 键盘打开右键菜单（说明书 12.4）：Shift+F10 或菜单键
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
            {/* 折叠线性分支：这一行下面收起来的提交（图谱上这一段直接连到下面留下的提交） */}
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
            {/* 搜到了但标题里没有：匹配在正文里，或匹配的是版本号 */}
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
      {/* 结果还在追加（说明书 15）：右上角一个小提示，跟着滚动停在顶部 */}
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
