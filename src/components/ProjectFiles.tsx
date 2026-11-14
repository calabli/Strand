// 项目文件（左侧面板的“文件”标签）：项目里的文件按目录树显示（已跟踪的和没被忽略的未跟踪文件），
// 目录一开始折叠；上面的搜索框按路径过滤，过滤时全部展开。有未提交改动的文件在右边标出状态。
// 单击文件在中间打开文件视图（内容和修改链）。

import { useEffect, useMemo, useState } from "react";
import { api, errOf } from "../api/commands";
import type { WorktreeStatus } from "../api/types";
import { FileTree, StatusBadge } from "./FileRow";
import { t, tr } from "../i18n";

/** 搜索时最多显示这么多个文件 */
const LIMIT = 3000;

interface Props {
  status: WorktreeStatus | null;
  /** 中间正在看的文件 */
  active: string | null;
  /** 变了就重新读取文件列表（仓库变化、切换分支后） */
  reloadKey: string;
  onOpen: (path: string) => void;
}

export function ProjectFiles({ status, active, reloadKey, onOpen }: Props) {
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
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true" className="dim">
            <path d="M3 1.5h5l3 3v8H3zM8 1.5v3h3" />
          </svg>
          <span className={"fpath mono" + (st ? " changed" : "")}>{name}</span>
          {st && <StatusBadge s={st === "R" ? "M" : st} />}
        </button>
      </div>
    );
  };

  return (
    <div className="pfiles">
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
  );
}
