// App updates: check GitHub Releases for a newer version (on startup when "check for updates automatically" is on,
// or from settings and the command palette), then download, install and restart. The updater verifies the package
// signature before installing. A card at the bottom right shows the new version, its notes and download progress.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errOf, onUpdateProgress } from "../api/commands";
import type { UpdateInfo } from "../api/types";
import { settings } from "../settings";
import { t, tr } from "../i18n";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "error"; info: UpdateInfo | null; message: string };

const SKIP_KEY = "strand.skipUpdate";
const skipped = () => {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
};

export function useUpdates({ say }: { say: (m: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  const busy = useRef(false);
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => {
    api.appVersion().then(setVersion, () => {});
  }, []);

  /** manual: from settings or the palette, so report "up to date" and ignore a skipped version */
  const check = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      if (manual) setPhase({ kind: "checking" });
      try {
        const info = await api.updateCheck();
        if (!info) {
          setPhase({ kind: "idle" });
          if (manual) sayRef.current(t("已经是最新版本"));
        } else if (!manual && skipped() === info.version) {
          setPhase({ kind: "idle" });
        } else {
          setPhase({ kind: "available", info });
        }
      } catch (e) {
        // Automatic checks fail quietly (e.g. offline)
        setPhase(manual ? { kind: "error", info: null, message: errOf(e).message } : { kind: "idle" });
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  // Check once a few seconds after startup, so it doesn't compete with opening the repository
  useEffect(() => {
    const id = window.setTimeout(() => settings().autoUpdate && check(false), 5000);
    return () => window.clearTimeout(id);
  }, [check]);

  const install = useCallback(async () => {
    if (phase.kind !== "available" && phase.kind !== "error") return;
    const info = phase.info;
    if (!info) return;
    setPhase({ kind: "downloading", info, downloaded: 0, total: null });
    const off = onUpdateProgress((p) =>
      setPhase((cur) => {
        if (cur.kind !== "downloading") return cur;
        if (p.total != null && p.downloaded >= p.total) return { kind: "installing", info };
        return { ...cur, downloaded: p.downloaded, total: p.total ?? null };
      }),
    );
    try {
      await api.updateInstall();
      // The desktop app restarts on its own; this only shows in the browser preview
      setPhase({ kind: "installing", info });
    } catch (e) {
      setPhase({ kind: "error", info, message: errOf(e).message });
    } finally {
      off();
    }
  }, [phase]);

  const dismiss = useCallback(() => setPhase({ kind: "idle" }), []);
  const skip = useCallback(() => {
    if (phase.kind === "available") {
      try {
        localStorage.setItem(SKIP_KEY, phase.info.version);
      } catch {
        /* only for this session */
      }
    }
    setPhase({ kind: "idle" });
  }, [phase]);

  return { phase, version, check, install, dismiss, skip };
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export function UpdateCard({ u }: { u: ReturnType<typeof useUpdates> }) {
  const p = u.phase;
  const [notes, setNotes] = useState(false);
  if (p.kind === "idle") return null;
  if (p.kind === "checking")
    return (
      <div className="update-card" role="status">
        <div className="uc-title">{t("正在检查更新…")}</div>
      </div>
    );
  const info = "info" in p ? p.info : null;
  return (
    <div className="update-card" role="status" aria-live="polite">
      <div className="uc-head">
        <div className="uc-title">{info ? t("有新版本 {0}", info.version) : t("检查更新失败")}</div>
        {(p.kind === "available" || p.kind === "error") && (
          <button type="button" className="ib sm" title={t("关闭")} aria-label={t("关闭")} onClick={u.dismiss}>
            ×
          </button>
        )}
      </div>
      {info && <div className="dim small">{t("现在是 {0}", info.current)}</div>}
      {info?.notes && p.kind === "available" && (
        <>
          <button type="button" className="linklike small" aria-expanded={notes} onClick={() => setNotes((v) => !v)}>
            {notes ? t("收起更新说明") : t("看看更新了什么")}
          </button>
          {notes && <pre className="uc-notes">{info.notes}</pre>}
        </>
      )}
      {p.kind === "downloading" && (
        <>
          <div className="uc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.total ? Math.round((p.downloaded / p.total) * 100) : undefined}>
            <span style={{ width: p.total ? `${Math.min(100, (p.downloaded / p.total) * 100)}%` : "30%" }} className={p.total ? "" : "indet"} />
          </div>
          <div className="dim small">{p.total ? t("正在下载 {0} / {1} MB", mb(p.downloaded), mb(p.total)) : t("正在下载 {0} MB", mb(p.downloaded))}</div>
        </>
      )}
      {p.kind === "installing" && <div className="dim small">{t("正在安装，装好后自动重新启动…")}</div>}
      {p.kind === "error" && <div className="err small">{tr(p.message)}</div>}
      {(p.kind === "available" || (p.kind === "error" && info)) && (
        <div className="uc-btns">
          {p.kind === "available" && (
            <button type="button" className="btn sm" onClick={u.skip} title={t("不再自动提醒这个版本")}>
              {t("跳过这个版本")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn sm" onClick={u.dismiss}>
            {t("以后再说")}
          </button>
          <button type="button" className="btn sm primary" onClick={u.install}>
            {p.kind === "error" ? t("重试") : t("下载并安装")}
          </button>
        </div>
      )}
    </div>
  );
}
