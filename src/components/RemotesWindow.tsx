// 管理远程：列出这个仓库的远程（名字和地址），可以添加、改地址、重命名、删除。
// 抓取会抓全部远程；拉取跟着当前分支的跟踪分支；还没有跟踪分支的新分支推送时可以选推送到哪个远程。

import { useCallback, useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { OpInfo, RemoteInfo, RepoState, Written } from "../api/types";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

interface Props {
  onClose: () => void;
  done: (st: RepoState, message: string, op?: OpInfo) => void;
  /** 删除前确认 */
  confirmRemove: (name: string, go: () => void) => void;
}

export function RemotesWindow({ onClose, done, confirmRemove }: Props) {
  useReturnFocus();
  const [list, setList] = useState<RemoteInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑的一行：原名字 → 新名字和地址 */
  const [edit, setEdit] = useState<{ name: string; newName: string; url: string } | null>(null);
  const [add, setAdd] = useState({ name: "", url: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.remoteList().then(setList, (e) => setError(errOf(e).message));
  }, []);
  useEffect(load, [load]);

  const run = async (ps: (() => Promise<Written<null>>)[], message: string) => {
    setBusy(true);
    setError(null);
    try {
      let last: Written<null> | null = null;
      for (const p of ps) last = await p();
      if (last) done(last.state, message, last.op);
      load();
      return true;
    } catch (e) {
      setError(errOf(e).message);
      load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    const cur = list?.find((r) => r.name === edit.name);
    if (!cur) return;
    const steps: (() => Promise<Written<null>>)[] = [];
    if (edit.url.trim() !== cur.url) steps.push(() => api.remoteSetUrl(edit.name, edit.url.trim()));
    if (edit.newName.trim() !== edit.name) steps.push(() => api.remoteRename(edit.name, edit.newName.trim()));
    if (!steps.length) return setEdit(null);
    if (await run(steps, t("已修改远程 {0}", edit.newName.trim()))) setEdit(null);
  };

  const addOne = async () => {
    if (!add.name.trim() || !add.url.trim()) return;
    if (await run([() => api.remoteAdd(add.name.trim(), add.url.trim())], t("已添加远程 {0}，下次抓取时会取回它的分支", add.name.trim()))) setAdd({ name: "", url: "" });
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal remotes" role="dialog" aria-modal="true" aria-label={t("管理远程")} onKeyDown={(e) => e.key === "Escape" && !busy && (edit ? setEdit(null) : onClose())}>
        <h2>{t("管理远程")}</h2>
        <p className="modal-msg small">{t("抓取时会抓全部远程；拉取跟着当前分支的跟踪分支；还没推送过的分支推送时可以选推送到哪个远程。")}</p>
        {list && list.length === 0 && <p className="dim">{t("这个仓库还没有远程")}</p>}
        <ul className="rm-list">
          {list?.map((r) =>
            edit?.name === r.name ? (
              <li key={r.name} className="rm-row editing">
                <input
                  className="mono rm-name"
                  value={edit.newName}
                  aria-label={t("远程名字")}
                  spellCheck={false}
                  autoCapitalize="off"
                  onChange={(e) => setEdit({ ...edit, newName: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <input
                  className="mono rm-url"
                  value={edit.url}
                  aria-label={t("地址")}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoFocus
                  onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <button type="button" className="btn" onClick={() => setEdit(null)} disabled={busy}>
                  {t("取消")}
                </button>
                <button type="button" className="btn primary" onClick={saveEdit} disabled={busy || !edit.newName.trim() || !edit.url.trim()}>
                  {t("保存")}
                </button>
              </li>
            ) : (
              <li key={r.name} className="rm-row">
                <span className="mono rm-name">{r.name}</span>
                <span className="mono rm-url dim" title={r.push_url ? t("抓取：{0}\n推送：{1}", r.url, r.push_url) : r.url}>
                  {r.url}
                  {r.push_url && <span className="rm-push"> · {t("推送地址另设")}</span>}
                </span>
                <button type="button" className="btn" onClick={() => setEdit({ name: r.name, newName: r.name, url: r.url })} disabled={busy}>
                  {t("编辑")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => confirmRemove(r.name, () => run([() => api.remoteRemove(r.name)], t("已删除远程 {0}", r.name)))}
                >
                  {t("删除")}
                </button>
              </li>
            ),
          )}
        </ul>
        <div className="rm-add">
          <input
            className="mono rm-name"
            placeholder={t("名字，如 upstream")}
            value={add.name}
            aria-label={t("新远程的名字")}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setAdd({ ...add, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addOne()}
          />
          <input
            className="mono rm-url"
            placeholder={t("地址，如 git@github.com:owner/repo.git")}
            value={add.url}
            aria-label={t("新远程的地址")}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setAdd({ ...add, url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addOne()}
          />
          <button type="button" className="btn primary" onClick={addOne} disabled={busy || !add.name.trim() || !add.url.trim()}>
            {t("添加")}
          </button>
        </div>
        {error && (
          <p className="err" role="alert">
            {tr(error)}
          </p>
        )}
        <div className="modal-btns">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("完成")}
          </button>
        </div>
      </div>
    </div>
  );
}
