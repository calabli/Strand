// Loads the log page by page on demand. Pages are requested as the list scrolls to them, and loaded pages are cached.
// When filters or sorting change, the cache is cleared and reloaded (the core layer caches filter results, so paging doesn't recompute).
// While filter results are incomplete (partial, spec §15 "first results return first, the rest are appended in batches"), loaded pages are re-queried every 300 ms
// and replaced when new results arrive; old rows stay until then so the list doesn't flicker.
// The same happens when the same repository is re-read (commits, external changes, etc.) or filters change: old pages keep showing until the new first page arrives and replaces them all.

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
  /** 0 means no graph (filtered or sorted by time) */
  lanes: number;
  /** The first page hasn't arrived yet */
  loading: boolean;
  /** Filter results aren't complete; more will be appended */
  partial: boolean;
  /** Row i's data; undefined when not loaded; graph is undefined when there's no graph */
  row: (i: number) => { commit: Commit; graph?: GraphRow; folded?: number } | undefined;
  /** Make sure rows in [start, end) are loaded or loading */
  ensure: (start: number, end: number) => void;
  error: { code: ErrorCode; message: string } | null;
}

export function useLog(repoKey: string | null, query: LogQuery): LogData {
  const pages = useRef(new Map<number, { rows: Commit[]; graph: GraphRow[]; folded?: number[] }>());
  /** Pages from before the re-read: still shown until the new first page arrives */
  const stale = useRef(new Map<number, { rows: Commit[]; graph: GraphRow[]; folded?: number[] }>());
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

  // Results not complete yet: re-query the loaded pages (at least the first) a little later
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
            pages.current.set(page, { rows: p.rows, graph: p.graph, folded: p.folded });
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
        if (gen !== generation.current) return; // The repository or filters already changed; drop the old results
        pages.current.set(page, { rows: p.rows, graph: p.graph, folded: p.folded });
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
    // Same repository (repoKey is "path#time"): keep old pages until the new first page arrives; clear them for a different repository
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
    return p.rows[j] ? { commit: p.rows[j], graph: p.graph[j], folded: p.folded?.[j] ?? 0 } : undefined;
  }, []);

  const ensure = useCallback(
    (start: number, end: number) => {
      for (let pg = Math.floor(start / PAGE); pg <= Math.floor(Math.max(start, end - 1) / PAGE); pg++) load(pg);
    },
    [load],
  );

  return { total, lanes, loading, partial, row, ensure, error };
}
