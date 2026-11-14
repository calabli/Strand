// 项目文件（左侧面板的“文件”标签）：项目里的文件按目录树显示（已跟踪的和没被忽略的未跟踪文件），
// 目录一开始折叠；上面的搜索框按路径过滤，过滤时全部展开。有未提交改动的文件在右边标出状态。
// 单击文件在中间打开文件视图（内容和修改链）。
// 搜索框可以切到“内容”：在文件内容里全文搜（git grep），默认搜工作区，也可以选一个版本（分支、标签、版本号）；
// 结果按文件分组，列出行号和那一行，点一行打开文件并跳到那一行。

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import type { ProjectSearch, RefsList, WorktreeStatus } from "../api/types";
import { Picker, type PickItem } from "./Picker";
import { findRegExp } from "./format";
import { Found } from "./inlineDiff";
import { FileTree, StatusBadge, TypeIcon } from "./FileRow";
import { t, tr } from "../i18n";

/** 搜索时最多显示这么多个文件 */
const LIMIT = 3000;

interface Props {
  status: WorktreeStatus | null;
  /** 中间正在看的文件 */
  active: string | null;
  /** 变了就重新读取文件列表（仓库变化、切换分支后） */
  reloadKey: string;
  /** 内容搜索时选版本用 */
  refs: RefsList | null;
  /** 打开文件；从内容搜索结果打开时带上行号和版本（空是工作区） */
  onOpen: (path: string, at?: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null }) => void;
}

export function ProjectFiles({ status, active, reloadKey, refs, onOpen }: Props) {
  const [mode, setMode] = useState<"name" | "content">("name");
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api.projectFiles().then(
      (f) => live && setFiles(f),
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [reloadKey, nonce]);

  // 工作区里有改动的文件：路径 → 状态（未跟踪的是 ?）
  const marks = useMemo(() => {
    const m = new Map<string, "M" | "A" | "D" | "R" | "T" | "?">();
    for (const c of status?.changes ?? []) m.set(c.path, c.status);
    for (const p of status?.untracked ?? []) m.set(p, "?");
    return m;
  }, [status]);

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const all = files ?? [];
    return query ? all.filter((p) => p.toLowerCase().includes(query)).slice(0, LIMIT) : all;
  }, [files, query]);

  const leaf = (p: string, depth: number) => {
    const st = marks.get(p);
    const name = p.slice(p.lastIndexOf("/") + 1);
    return (
      <div key={p} className={"frow in-dir prow" + (active === p ? " active" : "")} style={{ paddingLeft: 8 + depth * 14 }}>
        <button type="button" className="frow-main" title={p} onClick={() => onOpen(p)}>
          <TypeIcon path={p} />
          <span className={"fpath mono" + (st ? " changed" : "")}>{name}</span>
          {st && <StatusBadge s={st === "R" ? "M" : st} />}
        </button>
      </div>
    );
  };

  return (
    <div className="pfiles">
      <div className="pf-mode">
        <span className="seg" role="radiogroup" aria-label={t("搜索什么")}>
          <button type="button" role="radio" aria-checked={mode === "name"} className={mode === "name" ? "on" : ""} onClick={() => setMode("name")}>
            {t("文件名")}
          </button>
          <button type="button" role="radio" aria-checked={mode === "content"} className={mode === "content" ? "on" : ""} onClick={() => setMode("content")}>
            {t("内容")}
          </button>
        </span>
      </div>
      {/* 两种搜索都留着，切换时不丢输入和结果 */}
      <div className="pf-pane" hidden={mode !== "content"}>
        <ContentSearch refs={refs} reloadKey={reloadKey} onOpen={onOpen} />
      </div>
      <div className="pf-pane" hidden={mode !== "name"}>
      <div className="pf-bar">
        <input className="pk-q" placeholder={t("搜索文件")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label={t("搜索文件")} />
        <button type="button" className="ib sm" title={t("重新读取文件列表")} aria-label={t("重新读取文件列表")} onClick={() => setNonce((n) => n + 1)}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2v2.5H9" />
          </svg>
        </button>
      </div>
      <div className="pf-sub dim small">
        {files ? (query ? t("{0} 个文件匹配", shown.length) + (shown.length >= LIMIT ? t("（只显示前 {0} 个）", LIMIT) : "") : t("{0} 个文件", files.length)) : error ? "" : t("正在读取…")}
      </div>
      <div className="pf-list">
        {error && <p className="err">{tr(error)}</p>}
        {files && <FileTree items={shown} pathOf={(p) => p} leaf={leaf} startClosed forceOpen={!!query} />}
        {files && shown.length === 0 && <p className="dim pad">{query ? t("没有匹配的文件") : t("这个仓库里还没有文件")}</p>}
      </div>
      </div>
    </div>
  );
}

/** 在文件内容里全文搜（git grep） */
function ContentSearch({ refs, reloadKey, onOpen }: { refs: RefsList | null; reloadKey: string; onOpen: Props["onOpen"] }) {
  const [q, setQ] = useState("");
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  /** 搜哪个版本；空是工作区 */
  const [rev, setRev] = useState<string | null>(null);
  const [res, setRes] = useState<{ data: ProjectSearch | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const re = findRegExp(q.trim(), regex, cs);

  // 输入后 400 ms（或回车）再搜；工作区的内容变了（reloadKey）也重搜
  const [go, setGo] = useState(0);
  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setRes({ data: null, loading: false, error: null });
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setRes((r) => ({ ...r, loading: true, error: null }));
      api.projectSearch(text, regex, cs, rev).then(
        (data) => live && setRes({ data, loading: false, error: null }),
        (e) => live && setRes({ data: null, loading: false, error: errOf(e).message }),
      );
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, regex, cs, rev, go, reloadKey]);



  const revItems: PickItem[] = [
    ...(refs?.branches ?? []).map((b) => ({ key: b.name, label: b.name, sub: b.is_current ? t("当前") : undefined })),
    ...(refs?.remotes ?? []).map((r) => ({ key: r.name, label: r.name })),
    ...(refs?.tags ?? []).map((g) => ({ key: g.name, label: g.name, sub: t("标签") })),
  ];

  const d = res.data;
  return (
    <>
      <div className="pf-bar">
        <label className={"fsearch pf-csearch" + (q.trim() && !re ? " bad" : "")}>
          <input
            ref={input}
            value={q}
            placeholder={t("搜索文件内容")}
            spellCheck={false}
            aria-label={t("搜索文件内容")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setGo((n) => n + 1)}
          />
          <button type="button" className={"ftog mono" + (regex ? " on" : "")} title={t("正则表达式")} aria-label={t("正则表达式")} aria-pressed={regex} onClick={() => setRegex((r) => !r)}>
            .*
          </button>
          <button type="button" className={"ftog mono" + (cs ? " on" : "")} title={t("区分大小写")} aria-label={t("区分大小写")} aria-pressed={cs} onClick={() => setCs((c) => !c)}>
            Cc
          </button>
        </label>
      </div>
      <div className="pf-sub dim small pf-rev">
        <span>{t("搜")}</span>
        <button
          type="button"
          className="linklike mono"
          title={t("选择搜哪个版本：工作区（现在的文件），或某个分支、标签、版本号")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPick({ x: r.left, y: r.bottom + 4 });
          }}
        >
          {rev ?? t("工作区")} ▾
        </button>
        <span className="grow" />
        {res.loading ? t("正在搜…") : d ? t("{0} 个文件 · {1} 处", d.files.length, d.total) + (d.truncated ? t("（只列出前 {0} 处）", d.total) : "") : ""}
      </div>
      <div className="pf-list">
        {res.error && <p className="err pad">{tr(res.error)}</p>}
        {!q.trim() && <p className="dim pad small">{t("在文件内容里搜一段文字，结果按文件列出。要找这段代码是哪次提交加进来或删掉的，在日志的搜索框里切到“改动”")}</p>}
        {d && d.total === 0 && !res.loading && <p className="dim pad">{t("没有找到")}</p>}
        {d?.files.map((f) => {
          const open = !closed.has(f.path);
          return (
            <div key={f.path} className={"pf-hitfile" + (res.loading ? " stale" : "")}>
              <button
                type="button"
                className="fdir mono pf-hithead"
                aria-expanded={open}
                title={f.path}
                onClick={() =>
                  setClosed((s) => {
                    const n = new Set(s);
                    if (n.has(f.path)) n.delete(f.path);
                    else n.add(f.path);
                    return n;
                  })
                }
              >
                <span className={"fdir-caret" + (open ? " open" : "")} aria-hidden="true">
                  ▸
                </span>
                <span className="fdir-name">
                  {f.path.slice(f.path.lastIndexOf("/") + 1)} <span className="dim">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                </span>
                <span className="dim">{f.hits.length + (f.more ? "+" : "")}</span>
              </button>
              {open &&
                f.hits.map((h) => (
                  <button key={h.line} type="button" className="pf-hit mono" title={t("打开 {0} 第 {1} 行", f.path, h.line)} onClick={() => onOpen(f.path, { line: h.line, rev, find: q.trim() ? { text: q.trim(), regex, caseSensitive: cs } : null })}>
                    <span className="ln">{h.line}</span>
                    <span className="pf-hit-text">
                      <Found t={h.text.trim()} find={re} />
                    </span>
                  </button>
                ))}
              {open && f.more && <p className="dim small pf-more">{t("这个文件里还有更多匹配")}</p>}
            </div>
          );
        })}
      </div>
      {pick && (
        <Picker
          x={pick.x}
          y={pick.y}
          items={revItems}
          free
          placeholder={t("分支、标签或版本号")}
          selected={rev}
          clearLabel={t("工作区（现在的文件）")}
          onPick={(k) => setRev(k)}
          onClose={() => setPick(null)}
        />
      )}
    </>
  );
}
