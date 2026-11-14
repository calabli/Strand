// Author options for the commit message (like Author and Co-authors in JetBrains commit options):
// commit as another author (only for the next commit, cleared after committing); co-authors are written as Co-authored-by lines at the end of the message, recognized by GitHub and GitLab.
// Pick from authors seen in the log, or type "Name <email>" directly.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/commands";
import type { LogAuthor } from "../api/types";
import { t } from "../i18n";

const CO = /^co-authored-by:\s*(.+)$/i;

export const identOk = (s: string) => /^[^<>]*[^<>\s][^<>]*\s*<[^<>\s]+>$/.test(s.trim());

/** Co-authors at the end of the message */
export function coAuthorsOf(msg: string): string[] {
  return msg
    .split("\n")
    .map((l) => CO.exec(l.trim())?.[1].trim())
    .filter((x): x is string => !!x);
}

/** Add a co-author line at the end of the message: after existing trailers if there are any, otherwise after a blank line */
export function addCoAuthor(msg: string, who: string): string {
  if (coAuthorsOf(msg).some((x) => x.toLowerCase() === who.toLowerCase())) return msg;
  const body = msg.replace(/\s+$/, "");
  const lines = body.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const trailer = /^[A-Za-z-]+:\s/.test(last) && lines.length > 1;
  const sep = !body ? "\n\n" : trailer ? "\n" : "\n\n";
  return `${body}${sep}Co-authored-by: ${who}`;
}

export function removeCoAuthor(msg: string, who: string): string {
  const out = msg.split("\n").filter((l) => CO.exec(l.trim())?.[1].trim() !== who);
  return out.join("\n").replace(/\n{3,}$/, "\n\n").replace(/\s+$/, "");
}

let authorsCache: Promise<LogAuthor[]> | null = null;
let authorsRepo = "";
function knownAuthors(repo: string) {
  if (!authorsCache || authorsRepo !== repo) {
    authorsRepo = repo;
    authorsCache = api.logAuthors().catch(() => []);
  }
  return authorsCache;
}

export function AuthorOptions({ repoPath, me, author, setAuthor, msg, setMsg }: { repoPath: string; me: string | null; author: string; setAuthor: (a: string) => void; msg: string; setMsg: (m: string) => void }) {
  const [authors, setAuthors] = useState<LogAuthor[]>([]);
  const [co, setCo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    knownAuthors(repoPath).then((a) => live && setAuthors(a));
    return () => {
      live = false;
    };
  }, [repoPath]);
  const idents = useMemo(() => authors.map((a) => `${a.name} <${a.email}>`), [authors]);
  const cos = coAuthorsOf(msg);
  const addCo = () => {
    const v = co.trim();
    if (!v) return;
    // Only a name was typed: look it up among the authors
    const hits = idents.filter((x) => x.toLowerCase().includes(v.toLowerCase()));
    const hit = identOk(v) ? v : hits.length === 1 ? hits[0] : hits.find((x) => x.toLowerCase().startsWith(v.toLowerCase()));
    if (!hit) return setErr(t("共同作者要写成“名字 <邮箱>”"));
    setErr(null);
    setMsg(addCoAuthor(msg, hit));
    setCo("");
  };
  const badAuthor = !!author.trim() && !identOk(author);
  return (
    <div className="cp-options cp-authors" role="group" aria-label={t("作者")}>
      <datalist id="cp-idents">
        {idents.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <div className="cpo-row">
        <span>{t("作者")}</span>
        {author && (
          <button type="button" className="linklike small" onClick={() => setAuthor("")}>
            {t("用我自己")}
          </button>
        )}
      </div>
      <input
        className="mono cpo-input"
        list="cp-idents"
        value={author}
        placeholder={me ? t("{0}（Git 配置里的身份）", me) : t("名字 <邮箱>")}
        aria-label={t("提交的作者")}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => setAuthor(e.target.value)}
      />
      {badAuthor && <p className="err small">{t("作者要写成“名字 <邮箱>”")}</p>}
      <div className="cpo-row">
        <span>{t("共同作者")}</span>
      </div>
      {cos.length > 0 && (
        <div className="cp-chips">
          {cos.map((c) => (
            <span key={c} className="cp-chip mono" title={c}>
              {c}
              <button type="button" className="ib xs" title={t("去掉这个共同作者")} aria-label={t("去掉 {0}", c)} onClick={() => setMsg(removeCoAuthor(msg, c))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="cpo-cmd">
        <input
          className="mono"
          list="cp-idents"
          value={co}
          placeholder={t("名字 <邮箱>，或者从作者里选")}
          aria-label={t("添加共同作者")}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setCo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addCo();
            }
          }}
        />
        <button type="button" className="btn sm" onClick={addCo} disabled={!co.trim()}>
          {t("添加")}
        </button>
      </div>
      {err && <p className="err small">{err}</p>}
      <p className="dim small cpo-hint">{t("换作者只对这一次提交有效。共同作者会写成说明末尾的 Co-authored-by 行。")}</p>
    </div>
  );
}
