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

/** 文字里匹配搜索的地方包在 <mark class="find"> 里（搜索结果高亮搜索词）；ws 为真时显示空白字符 */
export function Found({ t, find, ws }: { t: string; find?: RegExp | null; ws?: boolean }) {
  if (!find || !t) return <>{plain(t, ws)}</>;
  const g = new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of t.matchAll(g)) {
    if (!m[0]) break;
    const at = m.index ?? 0;
    if (at > last) out.push(plain(t.slice(last, at), ws, -at - 1));
    out.push(
      <mark key={at} className="find">
        {plain(m[0], ws)}
      </mark>,
    );
    last = at + m[0].length;
  }
  if (!out.length) return <>{plain(t, ws)}</>;
  out.push(plain(t.slice(last), ws, -1));
  return <>{out}</>;
}

/**
 * 显示 t，和 other 不同的部分包在 <mark> 里；other 为空，或两行没有共同部分时原样显示。
 * find 给出时，搜索词再单独标出来（在“不同的部分”里也标）。
 * 搜索词跨过“不同的部分”边界时按三段分别找，跨界的那一处标不出来（很少见）。
 */
export function Hi({ t, other, find, ws }: { t: string; other?: string; find?: RegExp | null; ws?: boolean }) {
  if (other === undefined) return <Found t={t} find={find} ws={ws} />;
  const [a, b, c] = splitDiff(t, other);
  // 共同的部分只有缩进、空白或一两个标点（如结尾的“);”）时，两行其实完全不同
  if ((a + c).replace(/\s+/g, "").length < 4) return <Found t={t} find={find} ws={ws} />;
  if (find && find.test(t) && ![a, b, c].some((x) => find.test(x))) {
    // 搜索词正好跨过边界：宁可不加深不同的部分，也要把搜索词标出来
    return <Found t={t} find={find} ws={ws} />;
  }
  return (
    <>
      <Found t={a} find={find} ws={ws} />
      {b && (
        <mark>
          <Found t={b} find={find} ws={ws} />
        </mark>
      )}
      <Found t={c} find={find} ws={ws} />
    </>
  );
}
