// Repository maintenance (repository menu and command palette): how big the repository is, cleaning it up with
// git gc (can be stopped; reports how much it saved), and remembering conflict resolutions (rerere) for this repository.

import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { RepoSize } from "../api/types";
import { useReturnFocus } from "./focus";
import { Toggle } from "./RepoAndSettings";
import { fmtBytes } from "./format";
import { t, tr } from "../i18n";

export function MaintenanceWindow({ onClose, onToast }: { onClose: () => void; onToast: (text: string) => void }) {
  useReturnFocus();
  const [size, setSize] = useState<RepoSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aggressive, setAggressive] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rerere, setRerere] = useState<boolean | null>(null);

  const load = () =>
    api.repoSize().then(
      (s) => (setSize(s), s),
      (e) => (setError(errOf(e).message), null),
    );
  useEffect(() => {
    void load();
    api.rerereGet().then(setRerere, () => setRerere(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clean = async () => {
    const id = `gc-${Date.now()}`;
    const before = size?.git_dir ?? 0;
    setTask(id);
    setResult(null);
    setError(null);
    try {
      await api.repoGc(id, aggressive);
      const s = await load();
      const after = s?.git_dir ?? before;
      const msg = after < before ? t("清理完成，省了 {0}（{1} → {2}）", fmtBytes(before - after), fmtBytes(before), fmtBytes(after)) : t("清理完成，仓库已经很紧凑了");
      setResult(msg);
      onToast(msg);
    } catch (e) {
      const err = errOf(e);
      setError(err.code === "CANCELLED" ? t("已停止清理，仓库没有变化") : err.message);
      void load();
    } finally {
      setTask(null);
    }
  };
  const stop = () => task && void api.taskCancel(task);

  const switchRerere = (on: boolean) => {
    setRerere(on);
    api.rerereSet(on).then(
      () => onToast(on ? t("已打开：同样的冲突会自动按上次的方法解决") : t("已关闭冲突解决记忆")),
      (e) => (setRerere(!on), setError(errOf(e).message)),
    );
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !task && onClose()}>
      <div className="modal maint-win" role="dialog" aria-modal="true" aria-label={t("仓库维护")} onKeyDown={(e) => e.key === "Escape" && !task && onClose()}>
        <h2>{t("仓库维护")}</h2>

        <section className="maint-sec" aria-busy={!size}>
          <div className="maint-total">
            <span className="dim small">{t(".git 文件夹")}</span>
            <span className="maint-num">{size ? fmtBytes(size.git_dir) : "…"}</span>
            {size?.suggest_gc && <span className="maint-hint">{t("建议清理")}</span>}
          </div>
          {size && (
            <table className="maint-table">
              <tbody>
                <tr>
                  <th>{t("已打包的对象")}</th>
                  <td>{t("{0} 个，{1} 个包", size.packed_count.toLocaleString(), size.packs)}</td>
                  <td className="num">{fmtBytes(size.pack_bytes)}</td>
                </tr>
                <tr>
                  <th>{t("松散的对象")}</th>
                  <td>{t("{0} 个", size.loose_count.toLocaleString())}</td>
                  <td className="num">{fmtBytes(size.loose_bytes)}</td>
                </tr>
                <tr>
                  <th>{t("肯定能清掉的")}</th>
                  <td className="dim">{t("已经打包过的松散对象和残留文件")}</td>
                  <td className="num">{fmtBytes(size.cleanable_bytes)}</td>
                </tr>
                {size.lfs_bytes > 0 && (
                  <tr>
                    <th>{t("Git LFS 文件")}</th>
                    <td className="dim">{t("清理不会删掉它们")}</td>
                    <td className="num">{fmtBytes(size.lfs_bytes)}</td>
                  </tr>
                )}
                <tr>
                  <th>{t("Strand 的数据")}</th>
                  <td className="dim">{t("暂存架、撤销记录等")}</td>
                  <td className="num">{fmtBytes(size.strand_bytes)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>

        <section className="maint-sec">
          <h3>{t("清理仓库")}</h3>
          <p className="modal-msg small">
            {t("把松散的对象打包、合并零碎的包，删掉两周以前就已经找不回的对象（git gc）。分支、标签、操作记录和撤销能回到的提交都不会删。")}
          </p>
          <label className="check">
            <input type="checkbox" checked={aggressive} disabled={!!task} onChange={(e) => setAggressive(e.target.checked)} />
            {t("彻底压缩（--aggressive，大仓库可能要几十分钟）")}
          </label>
          <div className="maint-row">
            {task ? (
              <>
                <span className="spin" aria-hidden="true" />
                <span className="small">{t("正在清理…")}</span>
                <span className="grow" />
                <button type="button" className="btn sm" onClick={stop}>
                  {t("停止")}
                </button>
              </>
            ) : (
              <>
                {result && <span className="small ok-text">{result}</span>}
                <span className="grow" />
                <button type="button" className="btn primary" onClick={clean} disabled={!size}>
                  {t("清理")}
                </button>
              </>
            )}
          </div>
        </section>

        <section className="maint-sec">
          <div className="maint-row">
            <h3>{t("记住冲突的解决方法")}</h3>
            <span className="grow" />
            {rerere !== null && <Toggle on={rerere} onChange={switchRerere} label={t("记住冲突的解决方法")} />}
          </div>
          <p className="modal-msg small">
            {t("解决过的冲突再出现时（比如反复变基、重新合并），Git 自动按上次的方法改好，冲突列表里直接显示为已解决，检查后完成即可（git rerere）。只对这个仓库生效。")}
          </p>
        </section>

        {error && <p className="err small">{tr(error)}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onClose} disabled={!!task} autoFocus>
            {t("关闭")}
          </button>
        </div>
      </div>
    </div>
  );
}
