// 一对改动行里不同的部分加深（冲突窗口说明书 8.5、差异标签页 10.1 共用）。
// 只看共同的开头和结尾，中间那段加深；两行完全不同（共同的部分去掉空白后不到 4 个字符）时不加深，免得整行都是底色。

import type { ReactNode } from "react";

/** 拆成 [共同开头, 不同的部分, 共同结尾] */
export function splitDiff(x: string, y: string): [string, string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [x.slice(0, p), x.slice(p, x.length - q), x.slice(x.length - q)];
}

/** 显示空白字符时：空格画成灰色小点，制表符画成灰色箭头（占的宽度不变，复制出来仍是原来的空白） */
function Ws({ t }: { t: string }) {
  if (!/[ \t]/.test(t)) return <>{t}</>;
  const out: ReactNode[] = [];
  let buf = "";
  [...t].forEach((ch, i) => {
    if (ch === " " || ch === "\t") {
      if (buf) out.push(buf);
      buf = "";
      out.push(
        <span key={i} className={"wsd" + (ch === "\t" ? " tab" : "")} data-ch={ch === "\t" ? "→" : "·"}>
          {ch}
        </span>,
      );
    } else buf += ch;
  });
  if (buf) out.push(buf);
  return <>{out}</>;
}

/** 一段普通文字：显示空白字符时换成 Ws */
const plain = (s: string, ws: boolean | undefined, key?: number) => (ws ? <Ws key={key} t={s} /> : s);

/** 语法着色的一段：[开始, 结束, 种类] */
export type Tok = [number, number, string];

/**
 * 一行文字，几层标记叠在一起画：语法着色（toks）、和配对行不同的部分加深（diff 区间）、搜索词（find）、空白字符（ws）。
 * 先把所有区间的边界收集起来切成小段，每一小段按它落在哪些区间里套上对应的标签。
 */
export function Rich({ t, toks, diff, find, ws }: { t: string; toks?: Tok[] | null; diff?: [number, number] | null; find?: RegExp | null; ws?: boolean }) {
  if (!t) return null;
  const finds: [number, number][] = [];
  if (find) {
    const g = new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g");
    for (const m of t.matchAll(g)) {
      if (!m[0]) break;
      finds.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }
  if (!toks?.length && !diff && !finds.length) return <>{plain(t, ws)}</>;
  const cuts = new Set<number>([0, t.length]);
  for (const [a, b] of toks ?? []) cuts.add(Math.min(a, t.length)).add(Math.min(b, t.length));
  if (diff) cuts.add(diff[0]).add(diff[1]);
  for (const [a, b] of finds) cuts.add(a).add(b);
  const points = [...cuts].sort((x, y) => x - y);
  const out: ReactNode[] = [];
  let ti = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a === b) continue;
    while (toks && ti < toks.length && toks[ti][1] <= a) ti++;
    const kind = toks && ti < toks.length && toks[ti][0] <= a ? toks[ti][2] : null;
    let node: ReactNode = plain(t.slice(a, b), ws, a);
    if (kind) node = <span className={"tk-" + kind}>{node}</span>;
    if (finds.some(([x, y]) => x <= a && b <= y)) node = <mark className="find">{node}</mark>;
    if (diff && diff[0] <= a && b <= diff[1]) node = <mark>{node}</mark>;
    out.push(<span key={a}>{node}</span>);
  }
  return <>{out}</>;
}

/** 文字里匹配搜索的地方包在 <mark class="find"> 里（搜索结果高亮搜索词）；ws 为真时显示空白字符；toks 是语法着色 */
export function Found({ t, find, ws, toks }: { t: string; find?: RegExp | null; ws?: boolean; toks?: Tok[] | null }) {
  return <Rich t={t} find={find} ws={ws} toks={toks} />;
}

/**
 * 显示 t，和 other 不同的部分加深；other 为空，或两行没有共同部分时不加深。
 * find 给出时搜索词单独标出来，toks 是语法着色，ws 显示空白字符。
 */
export function Hi({ t, other, find, ws, toks }: { t: string; other?: string; find?: RegExp | null; ws?: boolean; toks?: Tok[] | null }) {
  let diff: [number, number] | null = null;
  if (other !== undefined) {
    const [a, b, c] = splitDiff(t, other);
    // 共同的部分只有缩进、空白或一两个标点（如结尾的“);”）时，两行其实完全不同
    if ((a + c).replace(/\s+/g, "").length >= 4 && b) diff = [a.length, a.length + b.length];
  }
  return <Rich t={t} diff={diff} find={find} ws={ws} toks={toks} />;
}

/** 一行开头的缩进占几列（制表符算 4 列） */
export function indentCols(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** 文件的缩进单位：大部分缩进是 4 的倍数就是 4，否则是 2 */
export function indentUnit(texts: string[]): number {
  let four = 0, two = 0;
  for (const x of texts) {
    const n = indentCols(x);
    if (!n || n >= x.length) continue;
    if (n % 4 === 0) four++;
    else if (n % 2 === 0) two++;
  }
  return two > four / 3 ? 2 : 4;
}

/** 缩进参考线：放在代码格子上的样式变量（缩进多宽、每级多宽），画线由样式表做 */
export const indentStyle = (text: string, unit: number): React.CSSProperties | undefined => {
  const n = indentCols(text);
  return n >= unit ? ({ "--ig": `${n}ch`, "--igu": `${unit}ch` } as React.CSSProperties) : undefined;
};
