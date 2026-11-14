// 作者过滤规则（说明书 5.1）：前端预览和示例数据用，和核心层的 AuthorMatch 一致

/** 作者规则换成判断函数（和核心层一样：名字或邮箱满足就算，不区分大小写） */
export function authorRule(m: { kind: string; text: string } | null | undefined): ((name: string, email: string) => boolean) | null {
  const t = m?.text.trim();
  if (!m || !t) return null;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const src = m.kind === "regex" ? t : m.kind === "prefix" ? `^${esc}` : m.kind === "suffix" ? `${esc}$` : esc;
  let re: RegExp;
  try {
    re = new RegExp(src, "i");
  } catch {
    throw { code: "INVALID_REGEX", message: "作者的正则表达式写得不对", detail: { field: "author" } };
  }
  return (name, email) => re.test(name) || re.test(email);
}
