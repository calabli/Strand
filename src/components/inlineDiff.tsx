// Emphasize the differing parts of a pair of changed lines (shared by the conflict window, spec §8.5, and the diff tab, §10.1).
// Only the common start and end are compared and the middle is emphasized; when the lines are entirely different (fewer than 4 common characters after removing whitespace) nothing is emphasized, so the whole line isn't highlighted.

import type { ReactNode } from "react";

/** Split into [common start, differing part, common end] */
export function splitDiff(x: string, y: string): [string, string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [x.slice(0, p), x.slice(p, x.length - q), x.slice(x.length - q)];
}

/** When showing whitespace: spaces drawn as small grey dots, tabs as grey arrows (same width; copying still yields the original whitespace) */
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

/** A run of plain text: replaced with Ws when showing whitespace */
const plain = (s: string, ws: boolean | undefined, key?: number) => (ws ? <Ws key={key} t={s} /> : s);

/** A syntax-colored run: [start, end, kind] */
export type Tok = [number, number, string];

/**
 * Draws one line with several layers of marks: syntax colors (toks), emphasis on parts differing from the paired line (diff ranges), search terms (find), whitespace (ws).
 * All range boundaries are collected to cut the text into small pieces, and each piece gets the tags of the ranges it falls in.
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

/** Wrap matches of the search in <mark class="find"> (search results highlight the term); ws true shows whitespace; toks is syntax coloring */
export function Found({ t, find, ws, toks }: { t: string; find?: RegExp | null; ws?: boolean; toks?: Tok[] | null }) {
  return <Rich t={t} find={find} ws={ws} toks={toks} />;
}

/**
 * Show t, emphasizing parts that differ from other; no emphasis when other is empty or the lines have nothing in common.
 * With find, search terms are marked separately; toks is syntax coloring, ws shows whitespace.
 */
export function Hi({ t, other, find, ws, toks }: { t: string; other?: string; find?: RegExp | null; ws?: boolean; toks?: Tok[] | null }) {
  let diff: [number, number] | null = null;
  if (other !== undefined) {
    const [a, b, c] = splitDiff(t, other);
    // When the common parts are only indentation, whitespace or a punctuation mark or two (like a trailing ");"), the lines are really entirely different
    if ((a + c).replace(/\s+/g, "").length >= 4 && b) diff = [a.length, a.length + b.length];
  }
  return <Rich t={t} diff={diff} find={find} ws={ws} toks={toks} />;
}

/** Columns taken by a line's leading indentation (a tab counts as 4) */
export function indentCols(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** The file's indent unit: 4 when most indents are multiples of 4, otherwise 2 */
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

/** Indent guides: style variables on the code cell (indent width and width per level); the stylesheet draws the lines */
export const indentStyle = (text: string, unit: number): React.CSSProperties | undefined => {
  const n = indentCols(text);
  return n >= unit ? ({ "--ig": `${n}ch`, "--igu": `${unit}ch` } as React.CSSProperties) : undefined;
};
