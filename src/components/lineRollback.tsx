import { useEffect, useMemo, useState } from "react";
import { api } from "../api/commands";
import type { LineRollback, LineRollbackPlan } from "../api/types";
import { t } from "../i18n";

export type RollbackLine = LineRollback & { index: number };
export const ROLLBACK_ICON = "M5 2.5 2 5.5 5 8.5M2 5.5h6a3 3 0 0 1 0 6H6";

export interface RollbackControls {
  busy: boolean;
  current: Map<number, RollbackLine>;
  previous: Map<number, RollbackLine>;
  deleted: Map<number, RollbackLine[]>;
  apply: (line: RollbackLine) => Promise<string | null>;
}

export function useRollbackPlan(path: string | null, revision: string) {
  const [loaded, setLoaded] = useState<{ path: string; revision: string; plan: LineRollbackPlan | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api.lineRollbacks(path).then(
      (plan) => live && setLoaded({ path, revision, plan }),
      () => live && setLoaded({ path, revision, plan: null }),
    );
    return () => { live = false; };
  }, [path, revision]);
  const plan = loaded && loaded.path === path && loaded.revision === revision ? loaded.plan : null;
  return useMemo(() => {
    if (!plan?.lines.length) return null;
    const current = new Map<number, RollbackLine>();
    const previous = new Map<number, RollbackLine>();
    const deleted = new Map<number, RollbackLine[]>();
    plan.lines.forEach((line, index) => {
      const row = { ...line, index };
      if (line.old_no != null) previous.set(line.old_no, row);
      if (line.new_no != null) current.set(line.new_no, row);
      else {
        const existing = deleted.get(row.before);
        if (existing) existing.push(row);
        else deleted.set(row.before, [row]);
      }
    });
    return { stamp: plan.stamp, current, previous, deleted };
  }, [plan]);
}

export function rollbackLabel(line: RollbackLine) {
  if (line.new_no == null) return t("恢复已删除的第 {0} 行", line.old_no);
  return line.old_no == null ? t("移除新增的第 {0} 行", line.new_no) : t("将第 {0} 行回退到最近一次提交", line.new_no);
}

export function LineRollbackGutter({ row, controls }: { row?: RollbackLine; controls: RollbackControls }) {
  return row ? (
    <button type="button" className="line-rollback-button" title={rollbackLabel(row)} aria-label={rollbackLabel(row)} disabled={controls.busy}
      onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void controls.apply(row); }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ROLLBACK_ICON} /></svg>
    </button>
  ) : <span className="line-rollback-space" aria-hidden="true" />;
}
