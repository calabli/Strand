// 文件行：状态字母、路径、新增和删除行数（说明书 4.2）。提交面板和提交详情共用。

import type { ReactNode } from "react";
import type { FileChange } from "../api/types";
import { t } from "../i18n";

const STATUS_LABEL: Record<FileChange["status"], string> = {
  M: t("已修改"),
  A: t("新增"),
  D: t("已删除"),
  R: t("已重命名"),
  T: t("类型变化"),
};

export function StatusBadge({ s }: { s: FileChange["status"] | "?" }) {
  const letter = s === "T" ? "M" : s;
  return (
    <span className={`st st-${letter}`} title={s === "?" ? t("未跟踪") : STATUS_LABEL[s]}>
      {letter}
    </span>
  );
}

interface Props {
  f: FileChange;
  active?: boolean;
  onOpen: () => void;
  /** 行首的控件，如勾选框 */
  lead?: ReactNode;
  /** 行尾悬停时出现的图标 */
  trail?: ReactNode;
  /** 按目录分组时：只显示文件名，行往右缩进（悬停仍显示完整路径） */
  inDir?: boolean;
}

export function FileRow({ f, active, onOpen, lead, trail, inDir }: Props) {
  const name = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
  const label = inDir ? (f.old_path && dirOf(f.old_path) !== dirOf(f.path) ? `${f.old_path} → ${baseOf(f.path)}` : f.old_path ? `${baseOf(f.old_path)} → ${baseOf(f.path)}` : baseOf(f.path)) : name;
  return (
    <div className={"frow" + (active ? " active" : "") + (inDir ? " in-dir" : "")}>
      {lead}
      <button type="button" className="frow-main" onClick={onOpen} title={name}>
        <StatusBadge s={f.status} />
        <span className="fpath mono">{label}</span>
        {f.binary ? (
          <span className="dim">{t("二进制")}</span>
        ) : f.no_stats ? (
          <span className="dim mono" title={t("这个仓库是部分克隆，文件内容还没下载，暂时算不出行数")}>
            —
          </span>
        ) : (
          <>
            <span className="mono plus">+{f.added}</span>
            <span className="mono minus">−{f.deleted}</span>
          </>
        )}
      </button>
      {trail}
    </div>
  );
}

export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** 按所在目录分组（说明书 4.7）：目录按名字排，根目录的文件排在最前；组内保持原来的顺序 */
export function groupByDir<T>(items: T[], pathOf: (x: T) => string): { dir: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const x of items) {
    const d = dirOf(pathOf(x));
    map.set(d, [...(map.get(d) ?? []), x]);
  }
  return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))).map(([dir, items]) => ({ dir, items }));
}

/** 分组的标题行：目录名和文件数 */
export function DirHead({ dir, count }: { dir: string; count: number }) {
  return (
    <div className="fdir mono" title={dir || t("根目录")}>
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z" />
      </svg>
      <span className="fdir-name">{dir ? dir.replace(/\/$/, "") : t("根目录")}</span>
      <span className="dim">{count}</span>
    </div>
  );
}
