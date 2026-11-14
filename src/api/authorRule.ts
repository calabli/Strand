// Author filter rules (spec §5.1): for the frontend preview and sample data, consistent with the core layer's AuthorMatch

/** Turn an author rule into a predicate (same as the core layer: name or email matching counts, case-insensitive) */
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
