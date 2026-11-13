// 按需分页加载日志。列表滚动到哪里就请求哪一页，已加载的页缓存起来。
// 过滤条件或排序变化时清空缓存重新读（核心层缓存了过滤结果，翻页不会重算）。
// 过滤结果还没算完（partial，说明书 15 的“首批结果先返回，其余分批追加”）时，每 300 ms 把已经加载的页重新查一遍，
// 新结果到了再替换，替换前旧的行留着，列表不闪。
// 同一个仓库重新读取（提交、外部修改等）或换过滤条件时也一样：旧的页先留着显示，新的第一页回来后整体换掉。

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errOf } from "./commands";
import type { Commit, ErrorCode, GraphRow, LogFilter, LogSort } from "./types";

export const PAGE = 200;

export interface LogQuery {
  filter: LogFilter;
  sort: LogSort;
}

export interface LogData {
  total: number;
  /** 0 表示没有图谱（有过滤或按时间排序） */
  lanes: number;
  /** 第一页还没回来 */
  loading: boolean;
  /** 过滤结果还没算完，还会追加 */
  partial: boolean;
  /** 第 i 行的数据，没加载时为 undefined；没有图谱时 graph 为 undefined */
  row: (i: number) => { commit: Commit; graph?: GraphRow } | undefined;
  /** 确保 [start, end) 范围内的行已经加载或正在加载 */
  ensure: (start: number, end: number) => void;
  error: { code: ErrorCode; message: string } | null;
}

export function useLog(repoKey: string | null, query: LogQuery): LogData {
  const pages = useRef(new Map<number, { rows: Commit[]; graph: GraphRow[] }>());
  /** 重新读取前的页：新的第一页回来之前照样显示 */
  const stale = useRef(new Map<number, { rows: Commit[]; graph: GraphRow[] }>());
  const lastRepo = useRef<string | null>(null);
  const pending = useRef(new Set<number>());
  const [total, setTotal] = useState(0);
  const [lanes, setLanes] = useState(1);
  const [loading, setLoading] = useState(false);
  const [, setVersion] = useState(0);
  const [error, setError] = useState<LogData["error"]>(null);
  const [partial, setPartial] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const q = useRef(query);
  q.current = query;
  const qKey = JSON.stringify(query);

  // 结果还没算完：过一会儿把已经加载的页（至少第一页）重新查一遍
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) return;
    const gen = generation.current;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      if (gen !== generation.current) return;
      const loaded = new Set([0, ...pages.current.keys()]);
      for (const page of loaded) {
        api.logQuery(page * PAGE, PAGE, q.current.filter, q.current.sort).then(
          (p) => {
            if (gen !== generation.current) return;
            pages.current.set(page, { rows: p.rows, graph: p.graph });
            setTotal(p.total);
            setPartial(!!p.partial);
            setVersion((v) => v + 1);
            if (p.partial) scheduleRefresh();
          },
          () => {},
        );
      }
    }, 300);
  }, []);

  const load = useCallback((page: number) => {
    if (pages.current.has(page) || pending.current.has(page)) return;
    pending.current.add(page);
    const gen = generation.current;
    api
      .logQuery(page * PAGE, PAGE, q.current.filter, q.current.sort)
      .then((p) => {
        if (gen !== generation.current) return; // 仓库或过滤条件已经变了，丢弃旧结果
        pages.current.set(page, { rows: p.rows, graph: p.graph });
        if (page === 0) stale.current.clear();
        setTotal(p.total);
        setLanes(p.lanes);
        setPartial(!!p.partial);
        setError(null);
        setVersion((v) => v + 1);
        if (p.partial) scheduleRefresh();
      })
      .catch((e) => {
        if (gen !== generation.current) return;
        const err = errOf(e);
        setError({ code: err.code, message: err.message });
        if (page === 0) setTotal(0);
      })
      .finally(() => {
        if (gen !== generation.current) return;
        pending.current.delete(page);
        if (page === 0) setLoading(false);
      });
  }, [scheduleRefresh]);

  useEffect(() => {
    generation.current += 1;
    // 同一个仓库（repoKey 是“路径#时间”）：旧的页留着，等新的第一页；换了仓库就清掉
    const repoPath = repoKey?.split("#")[0] ?? null;
    stale.current = repoPath !== null && repoPath === lastRepo.current ? new Map([...stale.current, ...pages.current]) : new Map();
    lastRepo.current = repoPath;
    pages.current = new Map();
    pending.current.clear();
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = undefined;
    setPartial(false);
    setError(null);
    if (repoKey) {
      setLoading(true);
      load(0);
    } else setTotal(0);
  }, [repoKey, qKey, load]);

  const row = useCallback((i: number) => {
    const pg = Math.floor(i / PAGE);
    const p = pages.current.get(pg) ?? (pages.current.has(0) ? undefined : stale.current.get(pg));
    if (!p) return undefined;
    const j = i % PAGE;
    return p.rows[j] ? { commit: p.rows[j], graph: p.graph[j] } : undefined;
  }, []);

  const ensure = useCallback(
    (start: number, end: number) => {
      for (let pg = Math.floor(start / PAGE); pg <= Math.floor(Math.max(start, end - 1) / PAGE); pg++) load(pg);
    },
    [load],
  );

  return { total, lanes, loading, partial, row, ensure, error };
}
