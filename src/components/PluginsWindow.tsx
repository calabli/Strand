// Preview plugins (command palette, and the preview menu in a file tab): what's installed in the app's plugins folder,
// which files each shows, and why one can't be used. Opens the folder and writes a sample plugin to start from.

import { useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { PreviewPlugin } from "../api/types";
import { reloadPlugins } from "../preview";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

export function PluginsWindow({ onClose, onToast }: { onClose: () => void; onToast: (text: string) => void }) {
  useReturnFocus();
  const [list, setList] = useState<PreviewPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => reloadPlugins().then(setList);
  useEffect(() => {
    void load();
  }, []);

  const act = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await load();
      if (done) onToast(done);
    } catch (e) {
      setError(errOf(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plugins-win" role="dialog" aria-modal="true" aria-label={t("预览插件")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{t("预览插件")}</h2>
        <p className="modal-msg small">
          {t("插件让文件标签页能预览更多种文件。每个插件是插件文件夹里的一个子文件夹：manifest.json 写名字和要显示的扩展名，再加一个网页负责画出来。网页在沙箱里运行，只会收到文件内容，不能联网，也碰不到仓库和 Strand。")}
        </p>
        <div className="pl-list">
          {list === null && <p className="dim pad">{t("正在读取…")}</p>}
          {list?.length === 0 && <p className="dim pad">{t("还没有装插件。点“新建示例插件”生成一个十六进制查看器，照着它写。")}</p>}
          {list?.map((p) => (
            <div key={p.id} className={"pl-row" + (p.error ? " bad" : "")}>
              <div className="pl-head">
                <b>{p.name}</b>
                {p.version && <span className="dim small">{p.version}</span>}
                <span className="dim small mono">{p.id}/</span>
              </div>
              {p.description && <div className="small">{p.description}</div>}
              <div className="pl-exts">
                {p.extensions.map((e) => (
                  <span key={e} className="chip mono small">
                    {e === "*" ? t("任何文件") : "." + e}
                  </span>
                ))}
              </div>
              {p.error && <div className="err small">{tr(p.error)}</div>}
            </div>
          ))}
        </div>
        {error && <p className="err small">{tr(error)}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.previewPluginsOpen())}>
            {t("打开插件文件夹")}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.previewPluginSample(), t("已生成示例插件“十六进制查看器”"))}>
            {t("新建示例插件")}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void act(async () => {})}>
            {t("刷新")}
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            {t("关闭")}
          </button>
        </div>
      </div>
    </div>
  );
}
