// 新建工作目录（说明书 6.6）和克隆仓库。
// - WorktreeDialog：选文件夹，检出已有分支或者新建分支；默认放在仓库旁边，名字是“仓库名-分支名”。
// - CloneDialog：仓库地址、放在哪个文件夹、文件夹名（按地址自动填）；显示进度，可以取消；完成后打开它。

import { useReturnFocus } from "./focus";
import { useEffect, useRef, useState } from "react";
import { api, errOf, inTauri, onTaskProgress, pickFolder } from "../api/commands";
import type { RefsList } from "../api/types";
import { t, tr } from "../i18n";

const sep = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");
const parentOf = (p: string) => p.replace(/[\\/][^\\/]*[\\/]?$/, "") || p;
const baseOf = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const join = (dir: string, name: string) => (dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep(dir) + name);
/** 分支名里的斜杠在文件夹名里换成短横 */
const slug = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useReturnFocus();
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide-form" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function WorktreeDialog({
  repoPath,
  refs,
  branch,
  onDone,
  onClose,
}: {
  repoPath: string;
  refs: RefsList | null;
  /** 从分支上打开时预选的分支 */
  branch?: string;
  /** 完成：新建的路径和分支、是否新建了分支 */
  onDone: (path: string, branch: string, created: boolean, result: Awaited<ReturnType<typeof api.worktreeAdd>>) => void;
  onClose: () => void;
}) {
  // 能检出的分支：不是当前分支，也没有在别的工作目录检出
  const free = (refs?.branches ?? []).filter((b) => !b.is_current && !b.worktree);
  const [mode, setMode] = useState<"existing" | "new">(branch || free.length ? "existing" : "new");
  const [pick, setPick] = useState(branch ?? free[0]?.name ?? "");
  const [name, setName] = useState("feature/");
  const [base, setBase] = useState(refs?.head.kind === "branch" ? refs.head.branch ?? "HEAD" : "HEAD");
  const target = mode === "existing" ? pick : name.trim();
  const auto = (b: string) => join(parentOf(repoPath), `${baseOf(repoPath)}-${slug(b) || "worktree"}`);
  const [path, setPath] = useState(auto(target));
  // 用户没改过路径时跟着分支名变
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setPath(auto(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!target) return setError(mode === "existing" ? t("选择要检出的分支") : t("填写新分支的名字"));
    setBusy(true);
    setError(null);
    try {
      const r = await api.worktreeAdd(path.trim(), target, mode === "new", mode === "new" ? base : null);
      onDone(path.trim(), target, mode === "new", r);
    } catch (e) {
      setError(errOf(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("新建工作目录")} onClose={onClose}>
      <p className="dim small">{t("在另一个文件夹里同时检出一个分支，和这里互不影响，共用同一份提交历史。")}</p>
      <div className="seg" role="radiogroup" aria-label={t("分支")}>
        <button type="button" role="radio" aria-checked={mode === "existing"} className={mode === "existing" ? "on" : ""} onClick={() => setMode("existing")} disabled={!free.length && !branch}>
          {t("检出已有分支")}
        </button>
        <button type="button" role="radio" aria-checked={mode === "new"} className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
          {t("新建分支")}
        </button>
      </div>
      {mode === "existing" ? (
        <label className="form-row">
          <span>{t("分支")}</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="mono">
            {branch && !free.some((b) => b.name === branch) && <option value={branch}>{branch}</option>}
            {free.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="form-row">
            <span>{t("新分支")}</span>
            <input className="mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
          </label>
          <label className="form-row">
            <span>{t("从")}</span>
            <select value={base} onChange={(e) => setBase(e.target.value)} className="mono">
              <option value="HEAD">{t("当前位置")}</option>
              {(refs?.branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
              {(refs?.remotes ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="form-row">
        <span>{t("文件夹")}</span>
        <span className="form-path">
          <input
            className="mono"
            value={path}
            spellCheck={false}
            onChange={(e) => {
              touched.current = true;
              setPath(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn sm"
            title={t("选择放在哪个文件夹里")}
            onClick={async () => {
              const dir = await pickFolder(t("选择放在哪个文件夹里"));
              if (!dir) return;
              touched.current = true;
              setPath(join(dir, baseOf(path)));
            }}
          >
            {t("选择…")}
          </button>
        </span>
      </label>
      {error && (
        <p className="err small" role="alert">
          {tr(error)}
        </p>
      )}
      <div className="modal-btns">
        <button type="button" className="btn" onClick={onClose}>
          {t("取消")}
        </button>
        <button type="button" className="btn primary" onClick={submit} disabled={busy}>
          {busy ? t("正在新建…") : t("新建")}
        </button>
      </div>
    </Modal>
  );
}

/** 按仓库地址推测文件夹名：https://host/a/b.git、git@host:a/b.git → b */
export function cloneName(url: string) {
  const u = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "");
  return slug(u.split(/[\\/:]/).pop() ?? "");
}

const CLONE_DIR = "strand.cloneDir";

export function CloneDialog({ defaultDir, onDone, onClose }: { defaultDir: string | null; onDone: (path: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [dir, setDir] = useState(() => {
    try {
      return localStorage.getItem(CLONE_DIR) ?? defaultDir ?? "";
    } catch {
      return defaultDir ?? "";
    }
  });
  const [name, setName] = useState("");
  const nameTouched = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ text: string; percent?: number } | null>(null);

  useEffect(() => {
    if (!nameTouched.current) setName(cloneName(url));
  }, [url]);
  useEffect(() => (task ? onTaskProgress((p) => p.task_id === task && setProgress(p)) : undefined), [task]);

  const submit = async () => {
    if (task) return;
    if (!url.trim()) return setError(t("请填写仓库地址"));
    if (!dir.trim()) return setError(t("选择放在哪个文件夹里"));
    if (!name.trim()) return setError(t("填写文件夹名"));
    const id = `clone-${Date.now()}`;
    setTask(id);
    setProgress({ text: t("正在连接…") });
    setError(null);
    try {
      const dest = join(dir.trim(), name.trim());
      await api.repoClone(id, url.trim(), dest);
      try {
        localStorage.setItem(CLONE_DIR, dir.trim());
      } catch {
        /* 只在本次有效 */
      }
      onDone(dest);
    } catch (e) {
      const err = errOf(e);
      if (err.code !== "CANCELLED") setError(err.message);
    } finally {
      setTask(null);
      setProgress(null);
    }
  };

  return (
    <Modal title={t("克隆仓库")} onClose={() => (task ? api.taskCancel(task) : onClose())}>
      <label className="form-row">
        <span>{t("地址")}</span>
        <input
          className="mono"
          value={url}
          placeholder="https://github.com/owner/repo.git"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()}
          autoFocus
          spellCheck={false}
          disabled={!!task}
        />
      </label>
      <label className="form-row">
        <span>{t("放在")}</span>
        <span className="form-path">
          <input className="mono" value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} disabled={!!task} placeholder={inTauri ? t("选择一个文件夹") : "/Users/me/code"} />
          <button
            type="button"
            className="btn sm"
            disabled={!!task}
            onClick={async () => {
              const d = await pickFolder(t("选择放在哪个文件夹里"));
              if (d) setDir(d);
            }}
          >
            {t("选择…")}
          </button>
        </span>
      </label>
      <label className="form-row">
        <span>{t("文件夹名")}</span>
        <input
          className="mono"
          value={name}
          spellCheck={false}
          disabled={!!task}
          onChange={(e) => {
            nameTouched.current = true;
            setName(e.target.value);
          }}
        />
      </label>
      <p className="dim small">{t("用系统 Git 克隆，SSH 密钥和凭据助手里保存的账号照常可用。")}</p>
      {progress && (
        <div className="clone-progress" aria-live="polite">
          <div className="bar">
            <span style={{ width: `${progress.percent ?? 0}%` }} />
          </div>
          <span className="dim small mono">{progress.text}</span>
        </div>
      )}
      {error && (
        <p className="err small" role="alert">
          {tr(error)}
        </p>
      )}
      <div className="modal-btns">
        <button type="button" className="btn" onClick={() => (task ? api.taskCancel(task) : onClose())}>
          {task ? t("停止克隆") : t("取消")}
        </button>
        <button type="button" className="btn primary" onClick={submit} disabled={!!task}>
          {task ? t("正在克隆…") : t("克隆")}
        </button>
      </div>
    </Modal>
  );
}
