// 差异标签页（说明书 10.1）：合并视图（上下）或左右对比，按修改块显示，带新旧行号；上下箭头跳到前后修改块。
// 工作区里已修改的文件可以逐行勾选：每个改动行和每个修改块前有勾选框，取消勾选的行变淡、不进这次提交。
// 忽略空白只影响显示：同一组改动里，去掉空白后内容相同的删除行和新增行配对，显示为没改的行；
// 勾选状态仍按原来的行记录（被隐藏的行保持原来的勾选）。
// 一组改动里按顺序配对的删除行和新增行，不同的部分加深（和冲突窗口一样）。
// 上一块、下一块到头后循环到另一头。

import { useEffect, useRef, useState } from "react";
import type { DiffLine, FileDiff } from "../api/types";
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
  /** 窄的版本（提交详情里文件下面的差异框）：只显示文件名、行数、上下块和关闭，固定合并视图；onExpand 在标签页里打开 */
  compact?: boolean;
  onExpand?: () => void;
  /** 按改动内容搜索时：匹配的改动行标出来，打开时滚到第一处 */
  find?: RegExp | null;
}

const key = (h: number, l: number) => `${h}:${l}`;
const squash = (s: string) => s.replace(/\s+/g, "");

/** 一行显示内容：j 是在修改块里的原始行号；same 表示忽略空白后两边相同（显示为没改的行）；
 * pair 是配对的另一行的内容（不同的部分加深用） */
type Item = { kind: "context" | "add" | "del"; j: number; line: DiffLine; old?: DiffLine; same?: boolean; pair?: string };

/** 一组改动里第 i 个删除行和第 i 个新增行配对 */
const pairOf = (lines: DiffLine[], dels: number[], adds: number[], j: number, kind: "add" | "del") => {
  const i = (kind === "del" ? dels : adds).indexOf(j);
  const other = (kind === "del" ? adds : dels)[i];
  return other === undefined ? undefined : lines[other].text;
};

/** 合并视图的行：忽略空白时，配对相同的删除行和新增行合成一行“没改” */
function unifiedItems(lines: DiffLine[], ignoreWs: boolean): Item[] {
  const out: Item[] = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (l.kind === "context") {
      out.push({ kind: "context", j: k, line: l });
      k++;
      continue;
    }
    // 一组连续的改动：先删除行，后新增行
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < lines.length && lines[k].kind === "del") dels.push(k++);
    while (k < lines.length && lines[k].kind === "add") adds.push(k++);
    if (!ignoreWs) {
      dels.forEach((j) => out.push({ kind: "del", j, line: lines[j], pair: pairOf(lines, dels, adds, j, "del") }));
      adds.forEach((j) => out.push({ kind: "add", j, line: lines[j], pair: pairOf(lines, dels, adds, j, "add") }));
      continue;
    }
    let pendD: Item[] = [];
    let pendA: Item[] = [];
    const flush = () => {
      out.push(...pendD, ...pendA);
      pendD = [];
      pendA = [];
    };
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      if (d !== undefined && a !== undefined && squash(lines[d].text) === squash(lines[a].text)) {
        flush();
        out.push({ kind: "context", j: a, line: lines[a], old: lines[d], same: true });
      } else {
        if (d !== undefined) pendD.push({ kind: "del", j: d, line: lines[d], pair: a !== undefined ? lines[a].text : undefined });
        if (a !== undefined) pendA.push({ kind: "add", j: a, line: lines[a], pair: d !== undefined ? lines[d].text : undefined });
      }
    }
    flush();
  }
  return out;
}

/** 左右对比的行：左边旧内容，右边新内容；一组改动里删除行和新增行按顺序配对，数量不等时另一边留空 */
function splitRows(lines: DiffLine[], ignoreWs: boolean): { left?: Item; right?: Item }[] {
  const rows: { left?: Item; right?: Item }[] = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (l.kind === "context") {
      const it: Item = { kind: "context", j: k, line: l };
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
        rows.push({ left: { kind: "context", j: d, line: lines[d], same: true }, right: { kind: "context", j: a, line: lines[a], same: true } });
      } else {
        rows.push({
          left: d !== undefined ? { kind: "del", j: d, line: lines[d], pair: a !== undefined ? lines[a].text : undefined } : undefined,
          right: a !== undefined ? { kind: "add", j: a, line: lines[a], pair: d !== undefined ? lines[d].text : undefined } : undefined,
        });
      }
    }
  }
  return rows;
}

const ICON = {
  unified: "M2 3h10M2 6h10M2 9h10M2 12h10",
  split: "M2 2h4.5v10H2zM7.5 2H12v10H7.5z",
  ws: "M2.5 7.5v3.5h9V7.5",
  expand: "M8.5 2H12v3.5M12 2L7.5 6.5M5.5 12H2V8.5M2 12l4.5-4.5",
};

function Ico({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function DiffView({ diff, loading, error, source, onClose, pick, compact, onExpand, find }: Props) {
  const [cur, setCur] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const diffView = compact ? "unified" : settings.diffView;
  const ignoreWs = settings.ignoreWs;
  const n = diff?.hunks.length ?? 0;

  useEffect(() => setCur(0), [diff?.path, source]);
  // 有搜索时滚到第一处匹配的改动行
  useEffect(() => {
    if (!find || !diff) return;
    const el = box.current?.querySelector(".found");
    if (el) el.scrollIntoView({ block: "center" });
  }, [diff, find]);
  const found = (it: Item | undefined) => (find && it && it.kind !== "context" && find.test(it.line.text) ? " found" : "");

  const go = (d: number) => {
    if (n === 0) return;
    // 到头后循环到另一头（说明书 10.1）
    const next = (cur + d + n) % n;
    setCur(next);
    box.current?.querySelector(`#hunk-${next}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const added = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "add").length, 0) ?? 0;
  const deleted = diff?.hunks.reduce((a, h) => a + h.lines.filter((l) => l.kind === "del").length, 0) ?? 0;
  // 所有改动行的键（勾选状态按它记录）
  const allKeys = diff ? diff.hunks.flatMap((h, i) => h.lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(i, j)]))) : [];
  const picked = pick ? allKeys.filter((k) => !pick.excluded.has(k)).length : 0;

  /** 一个改动行前的勾选框（没改的行留空位） */
  const check = (h: number, it: Item | undefined) =>
    !pick ? null : !it || it.kind === "context" ? (
      <span />
    ) : (
      <input
        type="checkbox"
        className="line-check"
        aria-label={t("提交第 {0} 行的改动", it.line.new_no ?? it.line.old_no)}
        checked={!pick.excluded.has(key(h, it.j))}
        onChange={(e) => pick.onToggle([key(h, it.j)], e.target.checked, allKeys)}
      />
    );
  const off = (h: number, it: Item | undefined) => (pick && it && it.kind !== "context" && pick.excluded.has(key(h, it.j)) ? " off" : "");

  return (
    <div className={"diff" + (compact ? " compact" : "")}>
      <div className="diff-bar">
        <span className="mono diff-path" title={diff?.path}>{compact ? diff?.path.split("/").pop() : diff?.path}</span>
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
          <button type="button" role="radio" aria-checked={diffView === "unified"} className={diffView === "unified" ? "on" : ""} title={t("合并视图")} aria-label={t("合并视图")} onClick={() => setSettings({ diffView: "unified" })}>
            <Ico d={ICON.unified} />
          </button>
          <button type="button" role="radio" aria-checked={diffView === "split"} className={diffView === "split" ? "on" : ""} title={t("左右对比")} aria-label={t("左右对比")} onClick={() => setSettings({ diffView: "split" })}>
            <Ico d={ICON.split} />
          </button>
        </span>
        )}
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
            <span className="dim">{compact ? `${cur + 1}/${n}` : t("第 {0} / {1} 块", cur + 1, n)}</span>
            <button type="button" className="ib" onClick={() => go(-1)} disabled={n < 2} title={t("上一块")} aria-label={t("上一块")}>
              ↑
            </button>
            <button type="button" className="ib" onClick={() => go(1)} disabled={n < 2} title={t("下一块")} aria-label={t("下一块")}>
              ↓
            </button>
          </>
        )}
        {onExpand && (
          <button type="button" className="ib" onClick={onExpand} title={t("在差异标签页里打开（可以左右对比）")} aria-label={t("在差异标签页里打开")}>
            <Ico d={ICON.expand} />
          </button>
        )}
        <button type="button" className="ib" onClick={onClose} title={t("关闭差异")} aria-label={t("关闭差异")}>
          ×
        </button>
      </div>
      <div className="diff-body" ref={box}>
        {loading && <p className="pad dim">{t("正在读取差异…")}</p>}
        {error && <p className="pad err">{tr(error)}</p>}
        {diff && diff.binary && <p className="pad dim">{t("二进制文件，不显示差异")}</p>}
        {diff && !diff.binary && n === 0 && !loading && <p className="pad dim">{t("没有内容差异（可能只改了文件权限）")}</p>}
        {diff?.hunks.map((h, i) => (
          <section key={i} id={`hunk-${i}`} className={"hunk" + (i === cur ? " cur" : "") + (diffView === "split" ? " split" : "")}>
            <div className="hunk-title mono">
              {pick &&
                (() => {
                  const keys = h.lines.flatMap((l, j) => (l.kind === "context" ? [] : [key(i, j)]));
                  const on = keys.filter((k) => !pick.excluded.has(k)).length;
                  return (
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
                  );
                })()}
              {tr(h.title)}
            </div>
            {diffView === "unified"
              ? unifiedItems(h.lines, ignoreWs).map((it) => (
                  <div key={it.j + (it.old ? "s" : "")} className={`dl dl-${it.kind}` + (pick ? " pickable" : "") + off(i, it) + (it.same ? " ws-same" : "") + found(it)} title={it.same ? t("只有空白不同") : undefined}>
                    {check(i, it)}
                    <span className="ln">{(it.old ?? it.line).old_no ?? ""}</span>
                    <span className="ln">{it.line.new_no ?? ""}</span>
                    <span className="sign">{it.kind === "add" ? "+" : it.kind === "del" ? "−" : ""}</span>
                    <span className="code">
                      <Hi t={it.line.text} other={it.pair} find={find} />
                    </span>
                  </div>
                ))
              : splitRows(h.lines, ignoreWs).map((r, k) => (
                  <div key={k} className={"sl" + (pick ? " pickable" : "")}>
                    {[r.left, r.right].map((it, side) => (
                      <div
                        key={side}
                        className={"sl-side " + (it ? `dl-${it.kind}` : "sl-empty") + off(i, it) + (it?.same ? " ws-same" : "") + found(it)}
                        title={it?.same ? t("只有空白不同") : undefined}
                      >
                        {check(i, it && it.kind !== "context" ? it : undefined)}
                        <span className="ln">{it ? (side === 0 ? it.line.old_no : it.line.new_no) ?? "" : ""}</span>
                        <span className="sign">{it?.kind === "add" ? "+" : it?.kind === "del" ? "−" : ""}</span>
                        <span className="code">{it ? <Hi t={it.line.text} other={it.pair} find={find} /> : ""}</span>
                      </div>
                    ))}
                  </div>
                ))}
          </section>
        ))}
        {diff?.truncated && <p className="pad dim">{t("文件太大，只显示了前 20000 行")}</p>}
      </div>
    </div>
  );
}
