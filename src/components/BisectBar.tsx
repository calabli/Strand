// Bisect (git bisect): mark commits "bad" (has the problem) and "good" (doesn't) from the commit context menu,
// then Git checks out a commit in between each time; this bar above the log shows progress; after testing click "good", "bad" or "skip", and a few steps later the first bad commit is found.
// "End" returns to the branch from before it started. All state lives in Git, so a bisect started on the command line shows here too.

import { useCallback, useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { BisectMark, BisectStatus, OpInfo, RepoState } from "../api/types";
import { shortId } from "./format";
import { t } from "../i18n";

export function useBisect({ refreshKey, done, failed, say }: { refreshKey: string | null; done: (st: RepoState, message: string, op?: OpInfo) => void; failed: (m: string) => void; say: (m: string) => void }) {
  const [status, setStatus] = useState<BisectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    api.bisectStatus().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(() => {
    if (refreshKey) refresh();
  }, [refreshKey, refresh]);

  const mark = useCallback(
    async (m: BisectMark, rev: string | null = null) => {
      setBusy(true);
      try {
        const w = await api.bisectMark(m, rev);
        setStatus(w.result);
        const s = w.result;
        const msg = s.first_bad
          ? t("找到了：第一个坏提交是 {0}", shortId(s.first_bad))
          : s.bad && s.good.length
            ? t("已检出 {0}，测试后标好或坏（大约还要 {1} 步）", shortId(s.current ?? ""), s.steps ?? "?")
            : s.bad
              ? t("已标为坏的。再在一个没问题的旧提交上标“好的”")
              : t("已标为好的。再在一个有问题的提交上标“坏的”");
        done(w.state, msg, w.op);
      } catch (e) {
        failed(errOf(e).message);
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [done, failed, refresh],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      const w = await api.bisectReset();
      setStatus(null);
      done(w.state, t("已结束二分查找，回到 {0}", status?.start || t("原来的分支")), w.op);
    } catch (e) {
      failed(errOf(e).message);
    } finally {
      setBusy(false);
    }
  }, [done, failed, status]);

  void say;
  return { status, active: !!status?.active, busy, mark, reset, refresh };
}

export function BisectBar({ b, onLocate }: { b: ReturnType<typeof useBisect>; onLocate: (id: string) => void }) {
  const s = b.status;
  if (!s?.active) return null;
  const found = s.first_bad;
  const waiting = !s.bad || s.good.length === 0;
  return (
    <div className={"bisect-bar" + (found ? " found" : "")} role="status">
      <span className="bisect-tag">{t("二分查找")}</span>
      {found ? (
        <span className="bisect-text">
          {t("第一个坏提交：")}
          <button type="button" className="linklike mono" onClick={() => onLocate(found)} title={t("在日志里定位")}>
            {shortId(found)}
          </button>{" "}
          {s.first_bad_title}
        </span>
      ) : waiting ? (
        <span className="bisect-text">
          {s.bad ? t("已标坏的 {0}。在一个没问题的旧提交上右键，标为“好的”", shortId(s.bad)) : t("已标好的 {0} 个。在一个有问题的提交上右键，标为“坏的”", s.good.length)}
        </span>
      ) : (
        <span className="bisect-text">
          {t("正在测试")}{" "}
          {s.current && (
            <button type="button" className="linklike mono" onClick={() => onLocate(s.current!)} title={t("在日志里定位")}>
              {shortId(s.current)}
            </button>
          )}
          <span className="dim">
            {" "}
            · {t("好 {0} · 坏 1{1} · 大约还要 {2} 步", s.good.length, s.skipped.length ? t(" · 跳过 {0}", s.skipped.length) : "", s.steps ?? "?")}
          </span>
        </span>
      )}
      <span className="grow" />
      {!found && !waiting && (
        <>
          <button type="button" className="btn sm bisect-good" disabled={b.busy} onClick={() => b.mark("good")} title={t("这个版本没问题")}>
            {t("好的")}
          </button>
          <button type="button" className="btn sm bisect-bad" disabled={b.busy} onClick={() => b.mark("bad")} title={t("这个版本有问题")}>
            {t("坏的")}
          </button>
          <button type="button" className="btn sm" disabled={b.busy} onClick={() => b.mark("skip")} title={t("这个版本没法测试（比如编译不过），换一个")}>
            {t("跳过")}
          </button>
        </>
      )}
      <button type="button" className="btn sm" disabled={b.busy} onClick={b.reset} title={t("结束二分查找，回到 {0}", s.start || t("原来的分支"))}>
        {t("结束")}
      </button>
    </div>
  );
}
