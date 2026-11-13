// 一对改动行里不同的部分加深（冲突窗口说明书 8.5、差异标签页 10.1 共用）。
// 只看共同的开头和结尾，中间那段加深；两行完全不同（共同的部分去掉空白后不到 4 个字符）时不加深，免得整行都是底色。

/** 拆成 [共同开头, 不同的部分, 共同结尾] */
export function splitDiff(x: string, y: string): [string, string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [x.slice(0, p), x.slice(p, x.length - q), x.slice(x.length - q)];
}

/** 显示 t，和 other 不同的部分包在 <mark> 里；other 为空，或两行没有共同部分时原样显示 */
export function Hi({ t, other }: { t: string; other?: string }) {
  if (other === undefined) return <>{t}</>;
  const [a, b, c] = splitDiff(t, other);
  // 共同的部分只有缩进、空白或一两个标点（如结尾的“);”）时，两行其实完全不同
  if ((a + c).replace(/\s+/g, "").length < 4) return <>{t}</>;
  return (
    <>
      {a}
      {b && <mark>{b}</mark>}
      {c}
    </>
  );
}
