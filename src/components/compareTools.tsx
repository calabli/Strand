// Compare, patches, browsing a revision (spec §10.3–10.5). All read-only views.

import { useReturnFocus } from "./focus";
import { useEffect, useMemo, useState } from "react";
import { api, errOf, inTauri } from "../api/commands";
import type { Comparison } from "../api/types";
import { t, tr } from "../i18n";
import { FileRow } from "./FileRow";
import { formatTime, shortId } from "./format";

/** Comparison results shown in the details column. Clicking a commit selects it (the end point follows); clicking a file shows the diff between the two versions */
export function CompareView({
  from,
  to,
  activePath,
  onPickCommit,
  onOpenDiff,
  onExit,
}: {
  from: string;
  to: string;
  activePath: string | null;
  onPickCommit: (id: string) => void;
  onOpenDiff: (path: string) => void;
  onExit: () => void;
}) {
  const [c, setC] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setC(null);
    setError(null);
    api.compare(from, to).then(
      (r) => live && setC(r),
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [from, to]);

  const list = (title: string, commits: Comparison["only_to"]) => (
    <div className="cmp-sec">
      <div className="dsub dim">
        {title} {commits.length}
      </div>
      {commits.length === 0 && <p className="dim small cmp-none">{t("没有")}</p>}
      {commits.map((x) => (
        <button key={x.id} type="button" className="cmp-commit" onClick={() => onPickCommit(x.id)} title={x.body ? `${x.title}\n\n${x.body}` : x.title}>
          <span className="mono dim">{shortId(x.id)}</span>
          <span className="cmp-title">{x.title}</span>
          <span className="dim small">{formatTime(x.time)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <aside className="detail cmp">
      <div className="cmp-head">
        <b>{t("比较")}</b>
        <span className="mono">{shortId(from)}</span>
        <span className="dim">→</span>
        <span className="mono">{shortId(to)}</span>
        <span className="grow" />
        <button type="button" className="ib sm" title={t("退出比较")} aria-label={t("退出比较")} onClick={onExit}>
          ×
        </button>
      </div>
      {error && <p className="err pad">{tr(error)}</p>}
      {!c && !error && <p className="dim pad">{t("正在比较…")}</p>}
      {c && (
        <div className="cmp-body">
          {list(t("只在选中这边的提交"), c.only_to)}
          {list(t("只在起点这边的提交"), c.only_from)}
          {c.truncated && <p className="dim small cmp-none">{t("提交太多，每边只列出前 500 个")}</p>}
          <div className="cmp-sec">
            <div className="dsub dim">
              {t("有差异的文件")} {c.files.length}
            </div>
            {c.files.length === 0 && <p className="dim small cmp-none">{t("两个版本的文件内容相同")}</p>}
            {c.files.map((f) => (
              <FileRow key={f.path} f={f} active={activePath === f.path} onOpen={() => onOpenDiff(f.path)} />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

/** Save text as a file: the system save dialog in the desktop app, a direct download in the browser preview */
export async function saveText(name: string, text: string): Promise<boolean> {
  if (!inTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: name, title: t("保存补丁"), filters: [{ name: t("补丁"), extensions: ["patch", "diff"] }] });
  if (!path) return false;
  await api.fileSave(path, text);
  return true;
}

/** Patch window (spec §10.4): a read-only text box with copy to clipboard and save as file */
export function PatchWindow({ title, text, name, onClose, say }: { title: string; text: string | null; name: string; onClose: () => void; say: (m: string) => void }) {
  useReturnFocus();
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal patch" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{title}</h2>
        <textarea className="patch-text mono" readOnly value={text ?? t("正在生成补丁…")} spellCheck={false} />
        <div className="modal-btns">
          <span className="dim small grow">{text ? t("{0} 行", text.split("\n").length - 1) : ""}</span>
          <button type="button" className="btn" onClick={onClose}>
            {t("关闭")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!text}
            onClick={async () => {
              try {
                if (text && (await saveText(name, text))) say(t("已保存补丁"));
              } catch (e) {
                say(tr(errOf(e).message));
              }
            }}
          >
            {t("保存为文件…")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!text}
            autoFocus
            title={t("复制到剪贴板")}
            onClick={() =>
              text &&
              navigator.clipboard?.writeText(text).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                },
                () => say(t("复制失败")),
              )
            }
          >
            {copied ? t("已复制 ✓") : t("复制")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Browse the repository at a revision (spec §10.5): a read-only, searchable file list */
export function TreeWindow({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  useReturnFocus();
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    api.commitTree(id).then(setPaths, (e) => setError(errOf(e).message));
  }, [id]);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (paths ?? []).filter((p) => !f || p.toLowerCase().includes(f));
  }, [paths, q]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tree-win" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{title}</h2>
        <input className="pk-q" placeholder={t("搜索文件")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus spellCheck={false} />
        {error && <p className="err">{tr(error)}</p>}
        <ul className="tree-list mono">
          {!paths && !error && <li className="dim">{t("正在读取…")}</li>}
          {shown.slice(0, 2000).map((p) => (
            <li key={p}>{p}</li>
          ))}
          {shown.length > 2000 && <li className="dim">{t("还有 {0} 个", shown.length - 2000)}</li>}
        </ul>
        <div className="modal-btns">
          <span className="dim small grow">{paths ? t("{0} 个文件", paths.length) : ""}</span>
          <button type="button" className="btn" onClick={onClose}>
            {t("关闭")}
          </button>
        </div>
      </div>
    </div>
  );
}
