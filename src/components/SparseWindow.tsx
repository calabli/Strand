// Sparse checkout (the "Files" tab and the command palette): tick the folders to have on disk in a huge repository.
// Every folder in HEAD is listed as a tree with its file count; a ticked folder brings everything under it (its
// subfolders show as included), and files directly in the root are always there. Applying runs
// `git sparse-checkout set --cone`; "check out everything" turns it off.

import { useEffect, useMemo, useState } from "react";
import { api, errOf } from "../api/commands";
import type { DirEntry, SparseState } from "../api/types";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

interface Node {
  path: string;
  name: string;
  files: number;
  kids: Node[];
}

function buildTree(dirs: DirEntry[]): Node[] {
  const byPath = new Map<string, Node>();
  const roots: Node[] = [];
  for (const d of dirs) {
    const node: Node = { path: d.path, name: d.path.slice(d.path.lastIndexOf("/") + 1), files: d.files, kids: [] };
    byPath.set(d.path, node);
    const parent = d.path.includes("/") ? byPath.get(d.path.slice(0, d.path.lastIndexOf("/"))) : undefined;
    (parent ? parent.kids : roots).push(node);
  }
  return roots;
}

const under = (path: string, parent: string) => path.startsWith(parent + "/");

export function SparseWindow({ onClose, onApplied }: { onClose: () => void; onApplied: (s: SparseState) => void }) {
  useReturnFocus();
  const [state, setState] = useState<SparseState | null>(null);
  const [dirs, setDirs] = useState<DirEntry[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; files?: string[] } | null>(null);

  useEffect(() => {
    Promise.all([api.sparseState(), api.sparseDirs()]).then(
      ([s, d]) => {
        setState(s);
        setDirs(d);
        if (s.enabled && s.cone) {
          setPicked(new Set(s.dirs));
          // Open the way down to every checked-out folder
          const o = new Set<string>();
          for (const p of s.dirs) {
            const parts = p.split("/");
            for (let i = 1; i < parts.length; i++) o.add(parts.slice(0, i).join("/"));
          }
          setOpen(o);
        }
      },
      (e) => setError({ text: errOf(e).message }),
    );
  }, []);

  const tree = useMemo(() => buildTree(dirs ?? []), [dirs]);
  const count = useMemo(() => new Map((dirs ?? []).map((d) => [d.path, d.files])), [dirs]);
  /** A ticked folder's own subfolders count as included (cone mode) */
  const coveredBy = (path: string) => [...picked].find((p) => p !== path && under(path, p));
  const files = useMemo(() => [...picked].filter((p) => !coveredBy(p)).reduce((n, p) => n + (count.get(p) ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, count]);
  const rootFiles = state && dirs ? Math.max(0, state.total_files - tree.reduce((n, d) => n + d.files, 0)) : 0;

  const toggle = (path: string) => {
    setError(null);
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        // Subfolders are included now; drop them so the list stays what was ticked
        for (const p of [...next]) if (under(p, path)) next.delete(p);
      }
      return next;
    });
  };

  const query = q.trim().toLowerCase();
  /** With a search: folders whose path matches, and the folders above them */
  const visible = useMemo(() => {
    if (!query || !dirs) return null;
    const v = new Set<string>();
    for (const d of dirs) {
      if (!d.path.toLowerCase().includes(query)) continue;
      const parts = d.path.split("/");
      for (let i = 1; i <= parts.length; i++) v.add(parts.slice(0, i).join("/"));
    }
    return v;
  }, [query, dirs]);

  const apply = async (list: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.sparseSet(list);
      onApplied(s);
      onClose();
    } catch (e) {
      const err = errOf(e);
      const d = err.detail as { files?: string[] } | undefined;
      setError({ text: err.message, files: d?.files });
    } finally {
      setBusy(false);
    }
  };

  const row = (n: Node, depth: number): React.ReactNode => {
    if (visible && !visible.has(n.path)) return null;
    const inherited = coveredBy(n.path);
    const on = picked.has(n.path) || !!inherited;
    const expanded = !!visible || open.has(n.path);
    return (
      <div key={n.path}>
        <div className="sp-row" style={{ paddingLeft: 8 + depth * 16 }}>
          <button
            type="button"
            className="sp-twisty"
            aria-label={expanded ? t("折叠") : t("展开")}
            disabled={!n.kids.length}
            onClick={() => setOpen((o) => {
              const next = new Set(o);
              if (next.has(n.path)) next.delete(n.path);
              else next.add(n.path);
              return next;
            })}
          >
            {n.kids.length ? (expanded ? "▾" : "▸") : ""}
          </button>
          <label className="sp-label" title={inherited ? t("已经包含在 {0} 里", inherited) : n.path}>
            <input type="checkbox" checked={on} disabled={!!inherited || busy} onChange={() => toggle(n.path)} />
            <span className="mono">{n.name}</span>
          </label>
          <span className="dim small sp-count">{t("{0} 个文件", n.files.toLocaleString())}</span>
        </div>
        {expanded && n.kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  const list = [...picked].filter((p) => !coveredBy(p)).sort();
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal sparse-win" role="dialog" aria-modal="true" aria-label={t("稀疏检出")} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h2>{t("只检出需要的目录")}</h2>
        <p className="modal-msg small">
          {t("超大仓库里只把勾选的目录放到磁盘上（git sparse-checkout）；根目录下的文件总会检出。历史、分支、提交都不受影响，随时可以改回检出全部。")}
        </p>
        {state && (
          <p className="small sp-now">
            {state.enabled
              ? t("现在：检出了 {0} / {1} 个文件", state.checked_out.toLocaleString(), state.total_files.toLocaleString())
              : t("现在：检出了全部 {0} 个文件", state.total_files.toLocaleString())}
            {state.enabled && !state.cone && <span className="dim"> · {t("用的是按规则（非目录）的旧模式，在这里修改会改成按目录")}</span>}
          </p>
        )}
        <input className="pk-q" placeholder={t("搜索目录")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label={t("搜索目录")} />
        <div className="sp-tree" role="tree" aria-label={t("目录")}>
          {!dirs && !error && <p className="dim pad">{t("正在读取目录…")}</p>}
          {dirs && dirs.length === 0 && <p className="dim pad">{t("这个仓库没有子目录")}</p>}
          {tree.map((n) => row(n, 0))}
        </div>
        <p className="small sp-sum">
          {list.length
            ? t("选了 {0} 个目录，约 {1} 个文件（另加根目录的 {2} 个）", list.length, files.toLocaleString(), rootFiles)
            : t("还没选目录")}
        </p>
        {error && (
          <div className="err small" role="alert">
            {tr(error.text)}
            {error.files && (
              <ul className="sp-files mono">
                {error.files.slice(0, 8).map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {error.files.length > 8 && <li>{t("还有 {0} 个", error.files.length - 8)}</li>}
              </ul>
            )}
          </div>
        )}
        <div className="modal-btns">
          {state?.enabled && (
            <button type="button" className="btn" disabled={busy} onClick={() => void apply([])}>
              {t("检出全部")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t("取消")}
          </button>
          <button type="button" className="btn primary" disabled={busy || !list.length} onClick={() => void apply(list)}>
            {busy ? t("正在检出…") : t("只检出选中的目录")}
          </button>
        </div>
      </div>
    </div>
  );
}
