// 文件行：状态字母、路径、新增和删除行数（说明书 4.2）。提交面板和提交详情共用。

import { useState, type ReactNode } from "react";
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
  /** 树形显示时的层级：只显示文件名，按层级往右缩进（悬停仍显示完整路径） */
  depth?: number;
  /** 双击（如在标签页里打开差异） */
  onDouble?: () => void;
}

export function FileRow({ f, active, onOpen, lead, trail, depth, onDouble }: Props) {
  const inDir = depth !== undefined;
  const name = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
  const label = inDir ? (f.old_path && dirOf(f.old_path) !== dirOf(f.path) ? `${f.old_path} → ${baseOf(f.path)}` : f.old_path ? `${baseOf(f.old_path)} → ${baseOf(f.path)}` : baseOf(f.path)) : name;
  return (
    <div className={"frow" + (active ? " active" : "") + (inDir ? " in-dir" : "")} style={inDir ? { paddingLeft: indentOf(depth) } : undefined}>
      {lead}
      <button type="button" className="frow-main" onClick={onOpen} onDoubleClick={onDouble} title={name}>
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

/** 树形显示时每一层缩进的像素 */
const indentOf = (depth: number) => 8 + depth * 14;

/** 目录树的一个目录：只有一个子目录、没有文件的目录和子目录合成一行（如 src/components） */
export interface TreeDir<T> {
  name: string;
  /** 完整路径，以 / 结尾；根目录是 "" */
  path: string;
  dirs: TreeDir<T>[];
  files: T[];
  /** 下面所有文件的个数 */
  count: number;
}

/** 按路径建目录树：目录在前、文件在后，都按名字排 */
export function buildTree<T>(items: T[], pathOf: (x: T) => string): TreeDir<T> {
  const root: TreeDir<T> = { name: "", path: "", dirs: [], files: [], count: 0 };
  for (const x of items) {
    const parts = pathOf(x).split("/");
    let d = root;
    d.count++;
    for (const part of parts.slice(0, -1)) {
      let sub = d.dirs.find((c) => c.name === part);
      if (!sub) {
        sub = { name: part, path: d.path + part + "/", dirs: [], files: [], count: 0 };
        d.dirs.push(sub);
      }
      sub.count++;
      d = sub;
    }
    d.files.push(x);
  }
  const tidy = (d: TreeDir<T>): TreeDir<T> => {
    d.dirs = d.dirs.map(tidy).map((c) => {
      while (c.files.length === 0 && c.dirs.length === 1) c = { ...c.dirs[0], name: `${c.name}/${c.dirs[0].name}` };
      return c;
    });
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => baseOf(pathOf(a)).localeCompare(baseOf(pathOf(b))));
    return d;
  };
  return tidy(root);
}

/** 按树形显示的顺序排好的文件（“查看差异”取第一个用） */
export function treeOrder<T>(items: T[], pathOf: (x: T) => string): T[] {
  const out: T[] = [];
  const walk = (d: TreeDir<T>) => {
    d.dirs.forEach(walk);
    out.push(...d.files);
  };
  walk(buildTree(items, pathOf));
  return out;
}

const FOLDER = "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z";

/**
 * 文件的目录树（说明书 4.7、5.5 的“按目录分组”改为树形）：目录行可以折叠，折叠状态在这个列表里记着，换内容时保留。
 * leaf 画一个文件行，depth 传给 FileRow。
 */
export function FileTree<T>({
  items,
  pathOf,
  leaf,
  startClosed,
  forceOpen,
}: {
  items: T[];
  pathOf: (x: T) => string;
  leaf: (x: T, depth: number) => ReactNode;
  /** 目录一开始都折叠（项目文件树：文件多） */
  startClosed?: boolean;
  /** 全部展开（搜索时） */
  forceOpen?: boolean;
}) {
  // 记的是和默认状态相反的目录：默认展开时记折叠的，默认折叠时记展开的
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const isOpen = (path: string) => forceOpen || flipped.has(path) === !!startClosed;
  const toggle = (path: string) =>
    setFlipped((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const dir = (d: TreeDir<T>, depth: number): ReactNode => {
    const open = isOpen(d.path);
    return (
      <div key={d.path} role="group" aria-label={d.path}>
        <button
          type="button"
          className="fdir mono"
          style={{ paddingLeft: indentOf(depth) }}
          title={d.path.replace(/\/$/, "")}
          aria-expanded={open}
          onClick={() => !forceOpen && toggle(d.path)}
        >
          <span className={"fdir-caret" + (open ? " open" : "")} aria-hidden="true">
            ▸
          </span>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
            <path d={FOLDER} />
          </svg>
          <span className="fdir-name">{d.name}</span>
          <span className="dim">{d.count}</span>
        </button>
        {open && body(d, depth + 1)}
      </div>
    );
  };
  const body = (d: TreeDir<T>, depth: number): ReactNode => (
    <>
      {d.dirs.map((c) => dir(c, depth))}
      {d.files.map((f) => leaf(f, depth))}
    </>
  );
  return <>{body(buildTree(items, pathOf), 0)}</>;
}
