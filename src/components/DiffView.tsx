// 差异（说明书 10.1）：差异标签页、提交详情下面的差异框、文件视图共用。
//
// 显示整个文件（上下文给得很大时核心层返回整个文件在一块里），没改的长段默认折叠成“⋯ 展开 N 行”，
// 工具栏的开关可以全部展开；只拿到改动附近几行时（逐行勾选、暂存架），块和块之间显示块标题。
// 两种视图都由同一组“段”画出来：没改的段、改动段（删除行和新增行按顺序配对）。
// - 合并视图：一列，旧行号、新行号两列；改动段先删除行后新增行。
// - 左右对比：左边旧、右边新，改动段左右各自排，短的一边下面补斜纹；中间一条窄栏用色带把两边对应的改动连起来。
// 右边一条细栏标出全文里每处改动的位置（绿新增、红删除、蓝修改），点一下跳过去。
// 上一处、下一处按改动段跳，到头后绕回另一头；“第 i / n 处”。差异标签页另外可以在同一次提交（或比较、工作区）的文件之间切换。
// 工作区里已修改的文件可以逐行勾选：每个改动行和每个块标题前有勾选框，取消勾选的行变淡、不进这次提交（这时只拿改动附近 3 行）。
// 忽略空白只影响显示：同一组改动里，去掉空白后内容相同的删除行和新增行配对，显示为没改的行；勾选状态仍按原来的行记录。
// 一组改动里按顺序配对的删除行和新增行，不同的部分加深（和冲突窗口一样）；按内容搜索时搜索词标出来。
// 逐行追溯（工具栏的开关、右键菜单）：每行左边标出最后改它的日期和作者，越新底色越深；悬停看提交，点一下在日志里定位。
// 删除行和左边按旧版本追溯，其余按新版本追溯。右键菜单（和工具栏的“⋯”）里还有折叠、显示空白字符、显示行号、自动换行，按用户保存。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/commands";
import type { DiffLine, FileDiff } from "../api/types";
import { Menu, type MenuState } from "./Menu";
import { formatTime, shortId } from "./format";
import { t, tr } from "../i18n";
import { setSettings, useSettings } from "../settings";
import { Hi } from "./inlineDiff";

interface Props {
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** 显示在标题后面的来源说明，如“工作区”或短哈希 */
  source: string;
  onClose: () => void;
  /** 行级勾选：给出时显示勾选框。行的键是“块序号:行序号” */
  pick?: { excluded: Set<string>; onToggle: (keys: string[], on: boolean, all: string[]) => void };
  /** 窄的版本（提交详情里文件下面的差异框）：只显示文件名、行数、上下处和关闭，固定合并视图；onExpand 在标签页里打开 */
  compact?: boolean;
  onExpand?: () => void;
  /** 按改动内容搜索时：匹配的改动行标出来，打开时滚到第一处 */
  find?: RegExp | null;
  /** 在同一组文件之间切换（差异标签页）：第几个、一共几个、往前往后 */
  files?: { at: number; total: number; go: (d: number) => void } | null;
  /** 历史版本（不能改）：路径前显示锁 */
  readOnly?: boolean;
  /** 逐行追溯两边各按哪个版本：rev 为空是工作区；不给就不能逐行追溯（如暂存架） */
  blameSides?: { left?: { path: string; rev: string | null } | null; right?: { path: string; rev: string | null } | null } | null;
  /** 点逐行追溯里的提交：在日志里定位 */
  onLocate?: (id: string) => void;
}

/** 逐行追溯里一行的提交 */
type BInfo = { id: string; title: string; author: string; time: number; uncommitted: boolean; inLog: boolean };
/** 一边的追溯结果：行号 → 提交 */
type BSide = Map<number, BInfo>;

/** 追溯一边的整个文件 */
function blameSide(side: { path: string; rev: string | null } | null | undefined): Promise<BSide | null> {
  if (!side) return Promise.resolve(null);
  return api.blameFile(side.path, side.rev, 0, 1_000_000).then(
    (p) => new Map(p.lines.map((l) => { const c = p.commits[l.commit]; return [l.no, { id: c.id, title: c.title, author: c.author, time: c.time, uncommitted: c.uncommitted, inLog: c.in_log }] as const; })),
    // 新增的文件在旧版本里不存在：这一边没有追溯
    () => null,
  );
}

const key = (h: number, l: number) => `${h}:${l}`;
const squash = (s: string) => s.replace(/\s+/g, "");
/** 没改的段两头各留几行 */
const KEEP = 3;
/** 每行的高度（和样式里的 line-height 一致） */
const LH = 20;

/** 一行：h、j 是在核心层给的第几块、块里第几行（勾选按它记）；same 表示忽略空白后两边相同；pair 是配对的另一行（加深不同的部分） */
type Item = { kind: "context" | "add" | "del"; h: number; j: number; line: DiffLine; same?: boolean; pair?: string };
type Row = { left?: Item; right?: Item };
/** 段：没改的、改动的（id 是第几处改动）、块标题（只拿到改动附近几行时） */
type Seg = { kind: "ctx"; rows: Row[] } | { kind: "chg"; rows: Row[]; id: number } | { kind: "gap"; h: number; title: string };

/** 一块里的行左右配对：删除行和新增行按顺序配对，数量不等时另一边空着；忽略空白时配对相同的算没改 */
function pairRows(lines: DiffLine[], h: number, ignoreWs: boolean): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (l.kind === "context") {
      const it: Item = { kind: "context", h, j: k, line: l };
      rows.push({ left: it, right: it });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < lines.length && lines[k].kind === "del") dels.push(k++);
    while (k < lines.length && lines[k].kind === "add") adds.push(k++);
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      if (ignoreWs && d !== undefined && a !== undefined && squash(lines[d].text) === squash(lines[a].text)) {
        rows.push({ left: { kind: "context", h, j: d, line: lines[d], same: true }, right: { kind: "context", h, j: a, line: lines[a], same: true } });
      } else {
        rows.push({
          left: d !== undefined ? { kind: "del", h, j: d, line: lines[d], pair: a !== undefined ? lines[a].text : undefined } : undefined,
          right: a !== undefined ? { kind: "add", h, j: a, line: lines[a], pair: d !== undefined ? lines[d].text : undefined } : undefined,
        });
      }
    }
  }
  return rows;
}

/** 整个差异分成段 */
function segmentsOf(diff: FileDiff, ignoreWs: boolean, headers: boolean): Seg[] {
  const segs: Seg[] = [];
  let id = 0;
  diff.hunks.forEach((hk, h) => {
    if (headers) segs.push({ kind: "gap", h, title: hk.title });
    for (const r of pairRows(hk.lines, h, ignoreWs)) {
      const changed = r.left?.kind !== "context" || r.right?.kind !== "context";
      const last = segs[segs.length - 1];
      if (last && last.kind === (changed ? "chg" : "ctx")) last.rows.push(r);
      else segs.push(changed ? { kind: "chg", rows: [r], id: id++ } : { kind: "ctx", rows: [r] });
    }
  });
  return segs;
}

/** 改动段的种类：只有新增、只有删除、两者都有 */
const chgKind = (rows: Row[]) => {
  const l = rows.some((r) => r.left);
  const r = rows.some((x) => x.right);
  return l && r ? "mod" : l ? "del" : "add";
};

const ICON = {
  unified: "M2 3h10M2 6h10M2 9h10M2 12h10",
  split: "M2 2h4.5v10H2zM7.5 2H12v10H7.5z",
  ws: "M2.5 7.5v3.5h9V7.5",
  expand: "M8.5 2H12v3.5M12 2L7.5 6.5M5.5 12H2V8.5M2 12l4.5-4.5",
  fold: "M4 2l3 3 3-3M4 12l3-3 3 3",
  lock: "M3.5 6.5h7v5.5h-7zM5 6.5V4.5a2 2 0 0 1 4 0v2",
  blame: "M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function DiffView({ diff, loading, error, source, onClose, pick, compact, onExpand, find, files, readOnly, blameSides, onLocate }: Props) {
  const [cur, setCur] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const diffView = compact ? "unified" : settings.diffView;
  const ignoreWs = settings.ignoreWs;
  const fold = settings.diffFold;
  const showWs = settings.diffWs;
  const lineNo = settings.diffLineNo;
  const wrap = settings.diffWrap;
  const blameOn = settings.diffBlame && !!blameSides && !compact;
  const [menu, setMenu] = useState<MenuState | null>(null);

  // 逐行追溯：两边各追溯整个文件，按行号对上
  const [blame, setBlame] = useState<{ key: string; left: BSide | null; right: BSide | null } | null>(null);
  const blameKey = blameOn ? JSON.stringify(blameSides) : "";
  useEffect(() => {
    if (!blameKey) return;
    let live = true;
    Promise.all([blameSide(blameSides?.left), blameSide(blameSides?.right)]).then(([left, right]) => live && setBlame({ key: blameKey, left, right }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameKey]);
  const bl = blame?.key === blameKey ? blame : null;
  // 新旧着色：按这个文件里最早和最晚的提交时间分 5 档
  const [tMin, tMax] = useMemo(() => {
    const ts = [...(bl?.left?.values() ?? []), ...(bl?.right?.values() ?? [])].filter((b) => !b.uncommitted).map((b) => b.time);
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 0];
  }, [bl]);
  /** 一行的追溯标注；side 0 是旧版本（删除行、左边），1 是新版本 */
  const ann = (side: 0 | 1, no: number | undefined | null) => {
    if (!blameOn) return null;
    const b = no ? (side === 0 ? bl?.left : bl?.right)?.get(no) : undefined;
    if (!b) return <span className="ann" />;
    const heat = b.uncommitted ? "new" : String(tMax > tMin ? Math.round(((b.time - tMin) / (tMax - tMin)) * 4) : 4);
    const text = b.uncommitted ? t("还没提交") : `${formatTime(b.time).slice(0, 10)} ${b.author}`;
    return (
      <span
        className={"ann heat-" + heat + (b.inLog && onLocate ? " link" : "")}
        title={b.uncommitted ? t("还没提交的改动") : `${shortId(b.id)} ${b.title}\n${b.author} · ${formatTime(b.time)}` + (b.inLog ? t("\n点击在日志里定位") : "")}
        onClick={() => !b.uncommitted && b.inLog && onLocate?.(b.id)}
      >
        {text}
      </span>
    );
  };

  /** 右键菜单和工具栏“⋯”：逐行追溯、折叠、显示选项 */
  const viewMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: t("逐行追溯"), checked: blameOn, disabled: !blameSides || compact, why: compact ? t("在差异标签页里打开后可以逐行追溯") : t("这个差异不能逐行追溯"), run: () => setSettings({ diffBlame: !settings.diffBlame }) },
        { label: t("折叠没改的部分"), checked: fold, run: () => (setSettings({ diffFold: !fold }), setOpened(new Set())) },
        "-",
        { heading: true, label: t("显示") },
        { label: t("显示空白字符"), checked: showWs, run: () => setSettings({ diffWs: !showWs }) },
        { label: t("显示行号"), checked: lineNo, run: () => setSettings({ diffLineNo: !lineNo }) },
        { label: t("自动换行"), checked: wrap, run: () => setSettings({ diffWrap: !wrap }) },
      ],
    });
  /** 点开了的没改的段（按段的位置） */
  const [opened, setOpened] = useState<Set<number>>(() => new Set());

  // 整个文件在一块里（从第 1 行开始）时不显示块标题；逐行勾选时总是显示（块标题上有整块的勾选框）
  const whole = !!diff && diff.hunks.length === 1 && diff.hunks[0].old_start <= 1 && diff.hunks[0].new_start <= 1;
  const segs = useMemo(() => (diff ? segmentsOf(diff, ignoreWs, !!pick || !whole) : []), [diff, ignoreWs, pick, whole]);
  const n = segs.filter((s) => s.kind === "chg").length;

  useEffect(() => {
    setCur(0);
    setOpened(new Set());
  }, [diff?.path, source]);
  // 有搜索时滚到第一处匹配的改动行
  useEffect(() => {
    if (!find || !diff) return;
    const el = box.current?.querySelector(".found");
    if (el) el.scrollIntoView({ block: "center" });
  }, [diff, find]);
  const found = (it: Item | undefined) => (find && it && it.kind !== "context" && find.test(it.line.text) ? " found" : "");

  const scrollTo = (i: number, smooth = true) => box.current?.querySelector(`[data-block="${i}"]`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  const go = (d: number) => {
    if (n === 0) return;
    // 到头后循环到另一头（说明书 10.1）
    const next = (cur + d + n) % n;
    setCur(next);
    scrollTo(next);
  };

  const added = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "add").length, 0) ?? 0;
  const deleted = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "del").length, 0) ?? 0;
  // 所有改动行的键（勾选状态按它记录）
  const allKeys = diff ? diff.hunks.flatMap((h, i) => h.lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(i, j)]))) : [];
  const picked = pick ? allKeys.filter((k) => !pick.excluded.has(k)).length : 0;

  /** 一个改动行前的勾选框（没改的行留空位） */
  const check = (it: Item | undefined) =>
    !pick ? null : !it || it.kind === "context" ? (
      <span className="ck-pad" />
    ) : (
      <input
        type="checkbox"
        className="line-check"
        aria-label={t("提交第 {0} 行的改动", it.line.new_no ?? it.line.old_no)}
        checked={!pick.excluded.has(key(it.h, it.j))}
        onChange={(e) => pick.onToggle([key(it.h, it.j)], e.target.checked, allKeys)}
      />
    );
  const off = (it: Item | undefined) => (pick && it && it.kind !== "context" && pick.excluded.has(key(it.h, it.j)) ? " off" : "");

  /** 没改的段：太长时中间折起来。返回要显示的行（null 是折叠的那一行） */
  const visibleRows = (s: Seg & { kind: "ctx" }, i: number): (Row | { hidden: number })[] => {
    const L = s.rows.length;
    const first = i === 0 || segs[i - 1].kind === "gap";
    const last = i === segs.length - 1 || segs[i + 1].kind === "gap";
    const head = first ? 0 : KEEP;
    const tail = last ? 0 : KEEP;
    if (!fold || opened.has(i) || L <= head + tail + 2) return s.rows;
    return [...s.rows.slice(0, head), { hidden: L - head - tail }, ...s.rows.slice(L - tail)];
  };
  const foldRow = (i: number, hidden: number, k: number, split: boolean) => (
    <button key={`f${k}`} type="button" className={"dl-fold" + (split ? " split" : "")} onClick={() => setOpened((o) => new Set(o).add(i))} title={t("展开这 {0} 行没改的代码", hidden)}>
      ⋯ {t("展开 {0} 行", hidden)}
    </button>
  );

  /** 合并视图的一行 */
  const uLine = (it: Item, k: string | number) => (
    <div key={k} className={`dl dl-${it.kind}` + (pick ? " pickable" : "") + off(it) + (it.same ? " ws-same" : "") + found(it)} title={it.same ? t("只有空白不同") : undefined}>
      {check(it)}
      {it.kind === "del" ? ann(0, it.line.old_no) : ann(1, it.line.new_no)}
      <span className="ln">{it.kind === "add" ? "" : it.same ? "" : it.line.old_no ?? ""}</span>
      <span className="ln">{it.kind === "del" ? "" : it.line.new_no ?? ""}</span>
      <span className="sign">{it.kind === "add" ? "+" : it.kind === "del" ? "−" : ""}</span>
      <span className="code">
        <Hi t={it.line.text} other={it.pair} find={find} ws={showWs} />
      </span>
    </div>
  );

  /** 块标题（只拿到改动附近几行时）：逐行勾选时带整块的勾选框 */
  const gapRow = (s: Seg & { kind: "gap" }, i: number) => {
    const keys = pick && diff ? diff.hunks[s.h].lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(s.h, j)])) : [];
    const on = pick ? keys.filter((k) => !pick.excluded.has(k)).length : 0;
    return (
      <div key={`g${i}`} className="dl-gap mono">
        {pick && (
          <input
            type="checkbox"
            className="hunk-check"
            aria-label={t("勾选这个修改块的全部改动行")}
            checked={on === keys.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < keys.length;
            }}
            onChange={() => pick.onToggle(keys, on < keys.length, allKeys)}
          />
        )}
        {tr(s.title)}
      </div>
    );
  };

  const unified = () =>
    segs.map((s, i) => {
      if (s.kind === "gap") return gapRow(s, i);
      if (s.kind === "chg") {
        const items = [...s.rows.flatMap((r) => (r.left ? [r.left] : [])), ...s.rows.flatMap((r) => (r.right ? [r.right] : []))];
        return (
          <div key={i} className={"chg" + (s.id === cur ? " cur" : "")} data-block={s.id} data-kind={chgKind(s.rows)}>
            {items.map((it, k) => uLine(it, k))}
          </div>
        );
      }
      return (
        <div key={i} className="ctx">
          {visibleRows(s, i).map((r, k) =>
            "hidden" in r ? foldRow(i, r.hidden, k, false) : uLine({ ...r.right!, same: false, line: { ...r.right!.line, old_no: r.left!.line.old_no } }, k),
          )}
        </div>
      );
    });

  /** 左右对比里一边的一行 */
  const sLine = (it: Item, side: 0 | 1, k: string | number) => (
    <div key={k} className={`sl-line dl-${it.kind}` + (pick ? " pickable" : "") + off(it) + (it.same ? " ws-same" : "") + found(it)} title={it.same ? t("只有空白不同") : undefined}>
      {check(it.kind !== "context" ? it : undefined)}
      {ann(side, side === 0 ? it.line.old_no : it.line.new_no)}
      <span className="ln">{(side === 0 ? it.line.old_no : it.line.new_no) ?? ""}</span>
      <span className="sign">{it.kind === "add" ? "+" : it.kind === "del" ? "−" : ""}</span>
      <span className="code">
        <Hi t={it.line.text} other={it.pair} find={find} ws={showWs} />
      </span>
    </div>
  );

  const split = () =>
    segs.map((s, i) => {
      if (s.kind === "gap") return gapRow(s, i);
      if (s.kind === "chg") return <ChgSeg key={i} id={s.id} cur={s.id === cur} kind={chgKind(s.rows)} left={s.rows.flatMap((r, k) => (r.left ? [sLine(r.left, 0, k)] : []))} right={s.rows.flatMap((r, k) => (r.right ? [sLine(r.right, 1, k)] : []))} />;
      return (
        <div key={i} className="sseg ctx">
          {visibleRows(s, i).map((r, k) =>
            "hidden" in r ? (
              foldRow(i, r.hidden, k, true)
            ) : (
              <div key={k} className="srow">
                {sLine(r.left!, 0, "l")}
                <span className="sgut" />
                {sLine(r.right!, 1, "r")}
              </div>
            ),
          )}
        </div>
      );
    });

  return (
    <div
      className={"diff" + (compact ? " compact" : "")}
      onKeyDown={(e) => {
        // ⌥↑ ⌥↓ 上一处、下一处；⌥← ⌥→ 上一个、下一个文件
        if (!e.altKey) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          go(e.key === "ArrowDown" ? 1 : -1);
        } else if (files && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          files.go(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <div className="diff-bar">
        {files && files.total > 1 && (
          <span className="diff-files">
            <button type="button" className="ib" onClick={() => files.go(-1)} title={t("上一个文件（⌥←）")} aria-label={t("上一个文件")}>
              ←
            </button>
            <span className="dim">{t("{0} / {1} 个文件", files.at + 1, files.total)}</span>
            <button type="button" className="ib" onClick={() => files.go(1)} title={t("下一个文件（⌥→）")} aria-label={t("下一个文件")}>
              →
            </button>
          </span>
        )}
        {readOnly && !compact && (
          <span className="dim diff-lock" title={t("历史版本，只能看")}>
            <Ico d={ICON.lock} />
          </span>
        )}
        <span className="mono diff-path" title={diff?.path}>
          {compact ? diff?.path.split("/").pop() : diff?.path}
        </span>
        {!compact && <span className="dim">{source}</span>}
        {diff && !diff.binary && (
          <>
            <span className="mono plus">+{added}</span>
            <span className="mono minus">−{deleted}</span>
          </>
        )}
        {pick && allKeys.length > 0 && <span className="dim">{t("已选 {0} / {1} 行", picked, allKeys.length)}</span>}
        <span className="grow" />
        {!compact && (
          <span className="seg diff-seg" role="radiogroup" aria-label={t("差异视图")}>
            <button type="button" role="radio" aria-checked={diffView === "split"} className={diffView === "split" ? "on" : ""} title={t("左右对比")} aria-label={t("左右对比")} onClick={() => setSettings({ diffView: "split" })}>
              <Ico d={ICON.split} />
            </button>
            <button type="button" role="radio" aria-checked={diffView === "unified"} className={diffView === "unified" ? "on" : ""} title={t("合并视图")} aria-label={t("合并视图")} onClick={() => setSettings({ diffView: "unified" })}>
              <Ico d={ICON.unified} />
            </button>
          </span>
        )}
        {blameSides && !compact && (
          <button
            type="button"
            className={"ib" + (blameOn ? " pressed" : "")}
            aria-pressed={blameOn}
            title={blameOn ? (bl ? t("逐行追溯（已打开）") : t("正在逐行追溯…")) : t("逐行追溯：每行左边标出最后改它的日期和作者")}
            aria-label={t("逐行追溯")}
            onClick={() => setSettings({ diffBlame: !settings.diffBlame })}
          >
            <Ico d={ICON.blame} />
          </button>
        )}
        <button
          type="button"
          className={"ib" + (fold ? " pressed" : "")}
          aria-pressed={fold}
          title={fold ? t("折叠没改的部分（已打开，点一下显示整个文件）") : t("折叠没改的部分")}
          aria-label={t("折叠没改的部分")}
          onClick={() => {
            setSettings({ diffFold: !fold });
            setOpened(new Set());
          }}
        >
          <Ico d={ICON.fold} />
        </button>
        {!compact && (
          <button
            type="button"
            className={"ib" + (ignoreWs ? " pressed" : "")}
            aria-pressed={ignoreWs}
            title={ignoreWs ? t("忽略空白（已打开，只影响显示）") : t("忽略空白")}
            aria-label={t("忽略空白")}
            onClick={() => setSettings({ ignoreWs: !ignoreWs })}
          >
            <Ico d={ICON.ws} />
          </button>
        )}
        {n > 0 && (
          <>
            <span className="dim">{compact ? `${cur + 1}/${n}` : t("第 {0} / {1} 处", cur + 1, n)}</span>
            <button type="button" className="ib" onClick={() => go(-1)} disabled={n < 2} title={t("上一处（⌥↑）")} aria-label={t("上一处")}>
              ↑
            </button>
            <button type="button" className="ib" onClick={() => go(1)} disabled={n < 2} title={t("下一处（⌥↓）")} aria-label={t("下一处")}>
              ↓
            </button>
          </>
        )}
        <button
          type="button"
          className="ib"
          title={t("显示选项（也可以在差异里右键）")}
          aria-label={t("显示选项")}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            viewMenu(r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
        {onExpand && (
          <button type="button" className="ib" onClick={onExpand} title={t("在差异标签页里打开（可以左右对比）")} aria-label={t("在差异标签页里打开")}>
            <Ico d={ICON.expand} />
          </button>
        )}
        <button type="button" className="ib" onClick={onClose} title={t("关闭差异")} aria-label={t("关闭差异")}>
          ×
        </button>
      </div>
      <div className="diff-main">
        <div
          className={"diff-body" + (diffView === "split" ? " split" : "")}
          ref={box}
          tabIndex={-1}
          onContextMenu={(e) => {
            e.preventDefault();
            viewMenu(e.clientX, e.clientY);
          }}
        >
          {loading && <p className="pad dim">{t("正在读取差异…")}</p>}
          {error && <p className="pad err">{tr(error)}</p>}
          {diff && diff.binary && <p className="pad dim">{t("二进制文件，不显示差异")}</p>}
          {diff && !diff.binary && n === 0 && !loading && <p className="pad dim">{t("没有内容差异（可能只改了文件权限）")}</p>}
          {diff && !diff.binary && n > 0 && (
            <div className={"dfile" + (diffView === "split" ? " split" : "") + (wrap ? " wrap" : "") + (lineNo ? "" : " no-ln") + (showWs ? " show-ws" : "") + (blameOn ? " with-ann" : "")}>
              {diffView === "split" ? split() : unified()}
            </div>
          )}
          {diff?.truncated && <p className="pad dim">{t("文件太大，只显示了前 20000 行")}</p>}
        </div>
        {diff && !diff.binary && n > 0 && <Ruler body={box} deps={[segs, opened, fold, diffView, wrap, lineNo, blameOn]} onPick={(i) => (setCur(i), scrollTo(i, false))} />}
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * 左右对比里的一个改动段：两边各自往下排，短的一边下面补斜纹；中间用色带连起来。
 * 色带两头的高度按两边实际排出来的高度画（长行折行时也对得上）。
 */
function ChgSeg({ id, cur, kind, left, right }: { id: number; cur: boolean; kind: string; left: React.ReactNode[]; right: React.ReactNode[] }) {
  const lref = useRef<HTMLDivElement>(null);
  const rref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<{ l: number; r: number }>({ l: left.length * LH, r: right.length * LH });
  useLayoutEffect(() => {
    const measure = () => setH({ l: lref.current?.offsetHeight ?? 0, r: rref.current?.offsetHeight ?? 0 });
    measure();
    const ro = new ResizeObserver(measure);
    if (lref.current) ro.observe(lref.current);
    if (rref.current) ro.observe(rref.current);
    return () => ro.disconnect();
  }, [left.length, right.length]);
  const H = Math.max(h.l, h.r, 2);
  const W = 36;
  // 色带：左边 [0, l]，右边 [0, r]，两边用三次曲线连；只有一边有行时另一边收成一条线
  const lb = Math.max(h.l, 1);
  const rb = Math.max(h.r, 1);
  const d = `M0 0 C ${W / 2} 0, ${W / 2} 0, ${W} 0 L ${W} ${rb} C ${W / 2} ${rb}, ${W / 2} ${lb}, 0 ${lb} Z`;
  return (
    <div className={"sseg chg" + (cur ? " cur" : "")} data-block={id} data-kind={kind}>
      <div className="sside">
        <div ref={lref}>{left}</div>
        {h.l < H && <div className="sfill" />}
      </div>
      <svg className={"sgut ribbon " + kind} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={d} />
      </svg>
      <div className="sside">
        <div ref={rref}>{right}</div>
        {h.r < H && <div className="sfill" />}
      </div>
    </div>
  );
}

/** 右边的改动位置标记：每处改动按它在全文里的位置画一小段，点一下跳过去 */
function Ruler({ body, deps, onPick }: { body: React.RefObject<HTMLDivElement | null>; deps: unknown[]; onPick: (i: number) => void }) {
  const [marks, setMarks] = useState<{ id: number; top: number; h: number; kind: string }[]>([]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const total = el.scrollHeight || 1;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      setMarks(
        [...el.querySelectorAll<HTMLElement>("[data-block]")].map((b) => {
          const r = b.getBoundingClientRect();
          return { id: Number(b.dataset.block), top: (r.top - base) / total, h: r.height / total, kind: b.dataset.kind ?? "mod" };
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const content = el.querySelector(".dfile");
    if (content) ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <div className="diff-ruler" aria-hidden="true">
      {marks.map((m) => (
        <span key={m.id} className={"rmark " + m.kind} style={{ top: `${m.top * 100}%`, height: `max(3px, ${m.h * 100}%)` }} onClick={() => onPick(m.id)} />
      ))}
    </div>
  );
}
