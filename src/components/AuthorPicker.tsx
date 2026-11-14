// Author filter (spec §5.1): check multiple authors, or match by rule (contains, prefix, suffix, regex; name or email matching counts).
// - The input first searches the list below (by the selected match mode); checkboxes apply immediately;
// - Enter or "filter by rule" saves the text as a rule: authors appearing later that match it count too. The rule and checked authors are OR-ed.
// - A bad regex shows a red outline and can't be saved as a rule.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AuthorMatch, LogAuthor, MatchKind } from "../api/types";
import { authorRule } from "../api/authorRule";
import { useReturnFocus } from "./focus";
import { t, lazy } from "../i18n";

export const KIND_LABEL: Record<MatchKind, string> = lazy(() => ({ contains: t("包含"), prefix: t("前缀"), suffix: t("后缀"), regex: t("正则") }));

interface Props {
  x: number;
  y: number;
  /** Authors in the log (by commit count); null while still loading */
  authors: LogAuthor[] | null;
  picked: LogAuthor[];
  rule: AuthorMatch | null;
  onChange: (picked: LogAuthor[], rule: AuthorMatch | null) => void;
  onClose: () => void;
}

const LIMIT = 300;

export function AuthorPicker({ x, y, authors, picked, rule, onChange, onClose }: Props) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(rule?.text ?? "");
  const [kind, setKind] = useState<MatchKind>(rule?.kind ?? "contains");
  const [pos, setPos] = useState({ left: x, top: y });

  // Filter the list by input and match mode; test is null for a bad regex
  const test = useMemo(() => {
    try {
      return { fn: authorRule({ kind, text: q }), bad: false };
    } catch {
      return { fn: null, bad: true };
    }
  }, [kind, q]);
  const shown = useMemo(() => {
    const list = authors ?? [];
    const hit = test.fn;
    return (hit ? list.filter((a) => hit(a.name, a.email)) : test.bad ? [] : list).slice(0, LIMIT);
  }, [authors, test]);
  const ruleHit = useMemo(() => {
    try {
      return authorRule(rule);
    } catch {
      return null;
    }
  }, [rule]);
  const pickedSet = new Set(picked.map((a) => a.email));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    input.current?.focus();
    input.current?.select();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);

  const toggle = (a: LogAuthor) => onChange(pickedSet.has(a.email) ? picked.filter((p) => p.email !== a.email) : [...picked, a], rule);
  const canApply = !!q.trim() && !test.bad;
  const apply = () => canApply && onChange(picked, { kind, text: q.trim() });

  return (
    <div
      className="picker apk"
      ref={box}
      style={pos}
      role="dialog"
      aria-label={t("按作者过滤")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter" && e.target === input.current) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <div className="seg apk-kind" role="radiogroup" aria-label={t("匹配方式")}>
        {(Object.keys(KIND_LABEL) as MatchKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <input
        ref={input}
        className={"pk-q" + (test.bad ? " bad" : "")}
        placeholder={kind === "regex" ? t("正则，匹配名字或邮箱") : t("名字或邮箱的一部分")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        spellCheck={false}
        aria-invalid={test.bad}
      />
      {test.bad && <p className="apk-bad small">{t("正则表达式写得不对")}</p>}
      <button type="button" className="btn sm apk-apply" disabled={!canApply} onClick={apply}>
        {canApply ? t("按规则过滤：{0}“{1}”（匹配 {2} 位作者，回车）", KIND_LABEL[kind], q.trim(), shown.length) : t("输入文字后可以按规则过滤")}
      </button>
      {rule && (
        <div className="apk-rule">
          <span className="dim small">{t("当前规则")}</span>
          <span className="fchip on">
            <span className="fchip-main">
              <span className="fchip-val">
                {KIND_LABEL[rule.kind]} {rule.text}
              </span>
            </span>
            <button type="button" className="fchip-x" title={t("去掉规则")} aria-label={t("去掉规则")} onClick={() => onChange(picked, null)}>
              ×
            </button>
          </span>
        </div>
      )}
      <div className="pk-list" role="group" aria-label={t("作者")}>
        {shown.map((a) => {
          const byRule = !!ruleHit?.(a.name, a.email);
          return (
            <label key={a.email} className={"pk-row apk-row" + (pickedSet.has(a.email) ? " on" : "")} title={`${a.name} <${a.email}>`}>
              <input type="checkbox" checked={pickedSet.has(a.email)} onChange={() => toggle(a)} />
              <span className="pk-label">
                {a.name} <span className="dim">&lt;{a.email}&gt;</span>
              </span>
              {byRule && <span className="apk-tag small">{t("规则")}</span>}
              <span className="dim pk-sub">{a.count}</span>
            </label>
          );
        })}
        {!authors && <p className="pk-empty dim">{t("正在读取…")}</p>}
        {authors && shown.length === 0 && <p className="pk-empty dim">{t("没有匹配的作者")}</p>}
      </div>
      <div className="apk-foot">
        <span className="dim small">{t("已勾选 {0} 位", picked.length)}</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={!picked.length && !rule} onClick={() => onChange([], null)}>
          {t("清除")}
        </button>
        <button type="button" className="btn sm primary" onClick={onClose}>
          {t("完成")}
        </button>
      </div>
    </div>
  );
}
