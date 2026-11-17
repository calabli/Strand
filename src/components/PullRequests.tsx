// Pull requests (GitHub) and merge requests (GitLab) of the repository's origin: a middle tab listing the open ones,
// with each one's CI checks, a link to its page and checking out its branch; plus creating one from a pushed branch.
// The token comes from Git's own credential helper; when there's none, the tab asks for one and hands it to that helper.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errOf, openUrl } from "../api/commands";
import type { Checks, Hosting, PullRequest, RefsList } from "../api/types";
import type { DialogSpec } from "./Dialog";
import { useReturnFocus } from "./focus";
import { MenuIcon } from "./Menu";
import { COMMIT_ICONS as I } from "./commitOps";
import { relTime } from "./format";
import { t, tr } from "../i18n";

/** "#12" on GitHub, "!12" on GitLab */
export const prNo = (h: Hosting, n: number) => (h.kind === "gitlab" ? "!" : "#") + n;
/** The tab name: "Merge requests" on GitLab, "Pull requests" on GitHub */
export const prWord = (h: Hosting) => (h.kind === "gitlab" ? t("合并请求") : t("拉取请求"));
/** "New merge request…" / "New pull request…" */
export const prNewLabel = (h: Hosting) => (h.kind === "gitlab" ? t("新建合并请求…") : t("新建拉取请求…"));
export const prGoLabel = (h: Hosting) => (h.kind === "gitlab" ? t("转到合并请求") : t("转到拉取请求"));

function tokenUrl(h: Hosting) {
  return h.kind === "gitlab" ? `https://${h.host}/-/user_settings/personal_access_tokens` : `https://${h.host}/settings/tokens`;
}

/** Ask for an access token and hand it to Git's credential helper */
export function askToken(h: Hosting, ask: (s: DialogSpec) => void, done: () => void) {
  ask({
    title: t("{0} 的访问令牌", h.host),
    message:
      h.kind === "gitlab"
        ? t("Git 还没有这个网站的令牌。在 GitLab 的“访问令牌”页面新建一个（勾选 api），粘贴到这里；它会交给 Git 的凭据助手保存，Strand 自己不留。")
        : t("Git 还没有这个网站的令牌。在 GitHub 的“Personal access tokens”页面新建一个（需要 repo 权限），粘贴到这里；它会交给 Git 的凭据助手保存，Strand 自己不留。"),
    input: { initial: "", placeholder: h.kind === "gitlab" ? "glpat-…" : "ghp_… / github_pat_…", mono: true },
    confirm: t("保存"),
    alt: t("打开令牌页面"),
    onSubmit: async (token, alt) => {
      if (alt) {
        void openUrl(tokenUrl(h));
        return t("在浏览器里新建令牌后粘贴到上面");
      }
      try {
        await api.hostingSetToken(token);
        done();
      } catch (e) {
        return errOf(e).message;
      }
    },
  });
}

const needsToken = (e: unknown) => {
  const d = errOf(e).detail as { need_token?: boolean } | undefined;
  return !!d?.need_token;
};

function ChecksBadge({ c }: { c: Checks | null | "loading" | "error" }) {
  if (c === "loading") return <span className="dim small">{t("正在读取检查…")}</span>;
  if (c === "error") return <span className="dim small">{t("读不到检查结果")}</span>;
  if (!c || !c.total) return <span className="dim small">{t("没有检查")}</span>;
  const state = c.failed ? "bad" : c.pending ? "wait" : "ok";
  const text = c.failed
    ? t("{0} 项检查失败（共 {1} 项）", c.failed, c.total)
    : c.pending
      ? t("{0} 项检查还在运行（共 {1} 项）", c.pending, c.total)
      : t("{0} 项检查都通过了", c.total);
  return <span className={"pr-checks " + state}>{text}</span>;
}

interface Props {
  hosting: Hosting;
  refs: RefsList | null;
  ask: (s: DialogSpec) => void;
  onCheckout: (remoteBranch: string) => void;
  onCreate: () => void;
  /** Bumped after creating a request, to re-read the list */
  reloadKey: number;
}

export function PullRequestsView({ hosting, refs, ask, onCheckout, onCreate, reloadKey }: Props) {
  const [list, setList] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<{ text: string; token: boolean } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [checks, setChecks] = useState<Record<number, Checks | "loading" | "error">>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    api.prList().then(
      (l) => {
        setList(l);
        setChecks({});
        setBusy(false);
      },
      (e) => {
        setError({ text: tr(errOf(e).message), token: needsToken(e) });
        setBusy(false);
      },
    );
  }, []);
  useEffect(load, [load, reloadKey, hosting.web_url]);

  const pick = (p: PullRequest) => {
    setSel(p.number);
    if (checks[p.number] && checks[p.number] !== "error") return;
    setChecks((c) => ({ ...c, [p.number]: "loading" }));
    api.prChecks(p.number, p.head_sha).then(
      (r) => setChecks((c) => ({ ...c, [p.number]: r })),
      () => setChecks((c) => ({ ...c, [p.number]: "error" })),
    );
  };

  const remote = (p: PullRequest) => {
    // The request's branch on origin (only for requests from this repository, not from forks)
    const r = refs?.remotes.find((b) => b.name === `origin/${p.head}`) ?? refs?.remotes.find((b) => b.name.endsWith("/" + p.head));
    return r?.name ?? null;
  };
  const local = (p: PullRequest) => refs?.branches.find((b) => b.name === p.head);

  return (
    <div className="tabpanel prs">
      <div className="console-bar">
        <span className="dim small">
          {hosting.kind === "gitlab" ? t("GitLab 上 {0} 的开放合并请求", hosting.path) : t("GitHub 上 {0} 的开放拉取请求", hosting.path)}
        </span>
        <span className="grow" />
        <button type="button" className="btn sm" onClick={onCreate}>
          {prNewLabel(hosting)}
        </button>
        <button type="button" className="ib" title={t("在浏览器中打开仓库")} aria-label={t("在浏览器中打开仓库")} onClick={() => void openUrl(hosting.web_url)}>
          <MenuIcon d={I.web} />
        </button>
        <button type="button" className="ib" title={t("刷新")} aria-label={t("刷新")} disabled={busy} onClick={load}>
          <MenuIcon d={I.reload} />
        </button>
      </div>
      <div className="pr-list" role="list" aria-label={prWord(hosting)} aria-busy={busy}>
        {error && (
          <div className="pr-empty">
            <p>{error.text}</p>
            {error.token && (
              <button type="button" className="btn primary" onClick={() => askToken(hosting, ask, load)}>
                {t("输入访问令牌…")}
              </button>
            )}
          </div>
        )}
        {!error && list === null && <p className="dim pr-empty">{t("正在读取…")}</p>}
        {!error && list?.length === 0 && <p className="dim pr-empty">{hosting.kind === "gitlab" ? t("没有开放的合并请求") : t("没有开放的拉取请求")}</p>}
        {!error &&
          list?.map((p) => {
            const on = sel === p.number;
            const rb = remote(p);
            const lb = local(p);
            return (
              <div
                key={p.number}
                role="listitem"
                tabIndex={0}
                className={"pr-row" + (on ? " on" : "")}
                onClick={() => pick(p)}
                onDoubleClick={() => void openUrl(p.url)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void openUrl(p.url);
                  if (e.key === " ") (e.preventDefault(), pick(p));
                }}
              >
                <div className="pr-line">
                  <span className="mono dim pr-no">{prNo(hosting, p.number)}</span>
                  <span className="pr-title">{p.title}</span>
                  {p.draft && <span className="pr-draft">{t("草稿")}</span>}
                  <span className="grow" />
                  <span className="dim small">{relTime(p.updated)}</span>
                </div>
                <div className="pr-line small dim">
                  <span>{p.author}</span>
                  <span className="mono pr-branches">
                    {p.head} → {p.base}
                  </span>
                </div>
                {on && (
                  <div className="pr-line pr-acts">
                    <ChecksBadge c={checks[p.number] ?? null} />
                    <span className="grow" />
                    {lb?.is_current ? (
                      <span className="dim small">{t("当前分支")}</span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!rb && !lb}
                        title={!rb && !lb ? t("本地没有这个分支，先获取（来自派生仓库的请求不能直接检出）") : undefined}
                        onClick={(e) => (e.stopPropagation(), lb ? onCheckout(lb.name) : rb && onCheckout(rb))}
                      >
                        {lb ? t("切换到 {0}", lb.name) : t("检出分支")}
                      </button>
                    )}
                    <button type="button" className="btn sm" onClick={(e) => (e.stopPropagation(), void navigator.clipboard.writeText(p.url))}>
                      {t("复制链接")}
                    </button>
                    <button type="button" className="btn sm" onClick={(e) => (e.stopPropagation(), void openUrl(p.url))}>
                      {t("在浏览器中打开")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

interface CreateProps {
  hosting: Hosting;
  refs: RefsList | null;
  /** The current branch's last commit, for the default title and description */
  lastTitle: string;
  lastBody: string;
  ask: (s: DialogSpec) => void;
  onClose: () => void;
  onCreated: (p: PullRequest) => void;
}

/** Create a pull / merge request from the current branch (which must be pushed) */
export function CreatePr({ hosting, refs, lastTitle, lastBody, ask, onClose, onCreated }: CreateProps) {
  useReturnFocus();
  const title0 = hosting.kind === "gitlab" ? t("新建合并请求") : t("新建拉取请求");
  const head = refs?.head.kind === "branch" ? refs.head.branch ?? "" : "";
  const cur = refs?.branches.find((b) => b.name === head);
  // Candidate targets: origin's branches other than this one; the default is main / master / develop when there
  const bases = [...new Set((refs?.remotes ?? []).filter((r) => r.remote === "origin" && !r.name.endsWith("/HEAD")).map((r) => r.name.slice("origin/".length)))].filter(
    (b) => b !== head,
  );
  const def = ["main", "master", "develop", "trunk"].find((b) => bases.includes(b)) ?? bases[0] ?? "";
  const [base, setBase] = useState(def);
  const [title, setTitle] = useState(lastTitle);
  const [body, setBody] = useState(lastBody);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleEl = useRef<HTMLInputElement>(null);
  useEffect(() => titleEl.current?.select(), []);

  const pushed = !!cur?.upstream && refs?.remotes.some((r) => r.name === cur.upstream);
  const unpushed = cur && pushed ? cur.ahead : 0;
  const block = !head
    ? t("现在不在任何分支上")
    : !pushed
      ? t("{0} 还没有推送到 origin，先推送", head)
      : unpushed
        ? null
        : !base
          ? t("origin 上没有别的分支可以作为目标")
          : null;

  const submit = async () => {
    if (busy || block || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // The upstream may be named differently from the local branch
      const remoteHead = cur?.upstream?.replace(/^[^/]+\//, "") ?? head;
      const p = await api.prCreate(title.trim(), body, remoteHead, base, draft);
      onCreated(p);
      onClose();
    } catch (e) {
      if (needsToken(e)) askToken(hosting, ask, () => setError(t("令牌已保存，再点一次创建")));
      setError(tr(errOf(e).message));
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="modal pr-new"
        role="dialog"
        aria-modal="true"
        aria-label={title0}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), submit());
        }}
      >
        <h2>{title0}</h2>
        <div className="pr-route mono">
          <span>{head || "—"}</span>
          <span className="dim">→</span>
          <select aria-label={t("目标分支")} value={base} onChange={(e) => setBase(e.target.value)} disabled={!bases.length}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <span className="dim small">{hosting.path}</span>
        </div>
        {block && <p className="modal-msg err small">{block}</p>}
        {!block && unpushed > 0 && <p className="modal-msg small">{t("还有 {0} 个提交没有推送，请求里只会包含已推送的部分", unpushed)}</p>}
        <label className="modal-field">
          <span className="dim">{t("标题")}</span>
          <input ref={titleEl} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="modal-field">
          <span className="dim">{t("说明")}</span>
          <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("可以不填")} />
        </label>
        <label className="check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          {t("作为草稿")}
        </label>
        {error && <p className="modal-err err small">{error}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !!block || !title.trim()}>
            {busy ? t("请稍候…") : t("创建")}
          </button>
        </div>
      </div>
    </div>
  );
}
