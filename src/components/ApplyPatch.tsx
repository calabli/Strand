// Apply a patch: paste a patch, choose a .patch / .diff file, or drag a file into the window. First lists which files it changes, whether it carries commits, and whether it applies cleanly,
// then choose "create commits" (only for the mailbox format from git format-patch, keeping author and message) or "apply to worktree only".
// Conflicts when applying to the worktree go to the conflict list as usual, one by one.

import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { OpInfo, PatchPreview, RepoState } from "../api/types";
import { inTauri } from "../api/commands";
import { StatusBadge } from "./FileRow";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

interface Props {
  /** A patch dragged into the window or brought from elsewhere */
  initial?: { text: string; name?: string } | null;
  onClose: () => void;
  done: (st: RepoState, message: string, op?: OpInfo) => void;
  failed: (message: string) => void;
  say: (message: string) => void;
}

/** Pick a patch file and read its text; null when cancelled */
export async function pickPatchFile(): Promise<{ text: string; name: string } | null> {
  if (!inTauri) return { text: await api.fileReadText(""), name: "fix-graph.patch" };
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, title: t("选择补丁文件"), filters: [{ name: t("补丁"), extensions: ["patch", "diff", "txt"] }] });
  if (typeof path !== "string") return null;
  return { text: await api.fileReadText(path), name: path.slice(path.lastIndexOf("/") + 1) };
}

export function ApplyPatch({ initial, onClose, done, failed, say }: Props) {
  useReturnFocus();
  const [text, setText] = useState(initial?.text ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [pv, setPv] = useState<{ data: PatchPreview | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const [commit, setCommit] = useState(true);
  const [busy, setBusy] = useState(false);

  // Look again 300 ms after the content changes
  useEffect(() => {
    if (!text.trim()) {
      setPv({ data: null, loading: false, error: null });
      return;
    }
    let live = true;
    setPv((p) => ({ ...p, loading: true }));
    const timer = window.setTimeout(() => {
      api.patchPreview(text).then(
        (data) => {
          if (!live) return;
          setPv({ data, loading: false, error: null });
          // Default to creating commits when it carries commits and applies cleanly, otherwise to applying to the worktree
          setCommit(data.commits.length > 0 && data.fit === "clean");
        },
        (e) => live && setPv({ data: null, loading: false, error: errOf(e).message }),
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text]);

  const d = pv.data;
  const asCommits = !!d && d.commits.length > 0 && commit;
  const canApply = !!d && d.fit !== "fails" && !pv.loading && !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    try {
      const w = await api.patchApply(text, asCommits);
      done(w.state, asCommits ? t("已应用补丁，生成了 {0} 个提交", w.result) : t("已把补丁应用到工作区"), w.op);
      onClose();
    } catch (e) {
      const err = errOf(e);
      if (err.code === "CONFLICTS") {
        failed("");
        say(t("补丁和现在的代码有冲突，请逐个处理"));
        onClose();
      } else {
        setPv((p) => ({ ...p, error: err.message }));
        setBusy(false);
      }
    }
  };

  const fitLine = d && (
    <p className={"ap-fit " + d.fit}>
      {d.fit === "clean"
        ? t("可以直接应用")
        : d.fit === "three_way"
          ? t("对应的文件变过，会按三方合并应用，可能有冲突")
          : t("应用不了：{0}", d.reason ?? t("补丁和现在的代码对不上"))}
    </p>
  );

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal apply-patch" role="dialog" aria-modal="true" aria-label={t("应用补丁")} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h2>
          {t("应用补丁")}
          {name && <span className="dim mono small"> · {name}</span>}
        </h2>
        <div className="ap-src">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                const f = await pickPatchFile();
                if (f) {
                  setText(f.text);
                  setName(f.name);
                }
              } catch (e) {
                setPv({ data: null, loading: false, error: errOf(e).message });
              }
            }}
          >
            {t("选择文件…")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              navigator.clipboard?.readText().then(
                (s) => {
                  setText(s);
                  setName("");
                },
                () => say(t("读不到剪贴板")),
              )
            }
          >
            {t("从剪贴板粘贴")}
          </button>
          <span className="dim small">{t("也可以把 .patch 文件拖进窗口")}</span>
        </div>
        <textarea
          className="patch-text mono ap-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setName("");
          }}
          placeholder={t("把补丁粘贴到这里（git diff 或 git format-patch 的输出）")}
          spellCheck={false}
          autoFocus={!text}
          aria-label={t("补丁内容")}
        />
        {pv.error && <p className="err">{tr(pv.error)}</p>}
        {pv.loading && !d && <p className="dim small">{t("正在读取补丁…")}</p>}
        {d && (
          <div className={"ap-info" + (pv.loading ? " stale" : "")}>
            {fitLine}
            {d.commits.length > 0 && (
              <div className="ap-commits">
                <div className="dim small">{t("{0} 个提交", d.commits.length)}</div>
                {d.commits.map((c, i) => (
                  <div key={i} className="ap-commit">
                    <span className="ap-ctitle">{c.title}</span>
                    <span className="dim small">{c.author}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="dim small">{t("{0} 个文件", d.files.length)}</div>
            <ul className="ap-files mono">
              {d.files.map((f) => (
                <li key={f.path}>
                  <StatusBadge s={f.status} />
                  <span className="ap-path" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
                    {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                  </span>
                  {f.binary ? <span className="dim small">{t("二进制")}</span> : <span className="small"><span className="plus">+{f.added}</span> <span className="minus">−{f.deleted}</span></span>}
                </li>
              ))}
            </ul>
            {d.commits.length > 0 && d.fit !== "fails" && (
              <div className="ap-mode" role="radiogroup" aria-label={t("怎么应用")}>
                <label>
                  <input type="radio" checked={commit} onChange={() => setCommit(true)} />
                  {t("生成 {0} 个提交（保留作者和说明）", d.commits.length)}
                </label>
                <label>
                  <input type="radio" checked={!commit} onChange={() => setCommit(false)} />
                  {t("只应用到工作区（之后自己提交）")}
                </label>
                {commit && d.fit === "three_way" && <p className="dim small">{t("生成提交时如果有冲突，会整个退回，可以改成应用到工作区再解决")}</p>}
              </div>
            )}
          </div>
        )}
        <div className="modal-btns">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button type="button" className="btn primary" onClick={apply} disabled={!canApply}>
            {busy ? t("正在应用…") : asCommits ? t("生成提交") : t("应用到工作区")}
          </button>
        </div>
      </div>
    </div>
  );
}
