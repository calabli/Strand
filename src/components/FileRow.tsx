// 文件行：状态字母、路径、新增和删除行数（说明书 4.2）。提交面板和提交详情共用。

import { useState, type ReactNode } from "react";
import type { FileChange } from "../api/types";
import { t, lazy } from "../i18n";

const STATUS_LABEL: Record<FileChange["status"], string> = lazy(() => ({
  M: t("已修改"),
  A: t("新增"),
  D: t("已删除"),
  R: t("已重命名"),
  T: t("类型变化"),
}));

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
        {/* 树形显示：文件类型图标，文件名按状态着色（修改蓝、新增绿、删除红）；列表显示：状态字母 */}
        {inDir ? <TypeIcon path={f.path} /> : <StatusBadge s={f.status} />}
        <span className={"fpath mono" + (inDir ? ` sn-${f.status}` : "")} title={inDir ? `${STATUS_LABEL[f.status]}：${name}` : undefined}>
          {label}
        </span>
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

/** 文件类型图标：按扩展名显示一两个字母的圆形徽标（颜色按语言），认不出的显示普通文件图标 */
const TYPES: Record<string, [string, string]> = {
  java: ["J", "#E76F00"], kt: ["K", "#7F52FF"], scala: ["S", "#DC322F"], groovy: ["G", "#4298B8"],
  ts: ["TS", "#3178C6"], tsx: ["TS", "#3178C6"], js: ["JS", "#C9A400"], jsx: ["JS", "#C9A400"], mjs: ["JS", "#C9A400"], vue: ["V", "#41B883"], svelte: ["S", "#FF3E00"],
  rs: ["R", "#B7410E"], go: ["Go", "#00ADD8"], py: ["Py", "#3776AB"], rb: ["Rb", "#CC342D"], php: ["P", "#777BB4"], swift: ["Sw", "#F05138"],
  c: ["C", "#555FB5"], h: ["H", "#555FB5"], cpp: ["C+", "#00599C"], cc: ["C+", "#00599C"], hpp: ["H+", "#00599C"], cs: ["C#", "#68217A"],
  sh: ["$", "#4EAA25"], zsh: ["$", "#4EAA25"], sql: ["DB", "#E38C00"],
  md: ["M", "#6E7781"], json: ["{}", "#8A8A8A"], yaml: ["Y", "#CB171E"], yml: ["Y", "#CB171E"], toml: ["T", "#9C4221"], xml: ["<>", "#E37933"],
  html: ["<>", "#E34F26"], css: ["#", "#264DE4"], scss: ["#", "#CF649A"], lock: ["L", "#8A8A8A"],
};
export function TypeIcon({ path }: { path: string }) {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  const hit = TYPES[ext] ?? (base === "dockerfile" ? ["D", "#2496ED"] : base === "makefile" ? ["M", "#6D8086"] : null);
  if (!hit) {
    return (
      <svg className="ftype" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 1.5h5l3 3v8H3zM8 1.5v3h3" />
      </svg>
    );
  }
  return (
    <span className={"ftype ftype-badge" + (hit[0].length > 1 ? " two" : "")} style={{ borderColor: hit[1], color: hit[1] }} aria-hidden="true">
      {hit[0]}
    </span>
  );
}

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
  root,
}: {
  items: T[];
  pathOf: (x: T) => string;
  leaf: (x: T, depth: number) => ReactNode;
  /** 目录一开始都折叠（项目文件树：文件多） */
  startClosed?: boolean;
  /** 全部展开（搜索时） */
  forceOpen?: boolean;
  /** 给出时最上面加一个根节点（如仓库名），显示文件总数 */
  root?: string;
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
    const isRoot = d.path.startsWith("\u0000");
    return (
      <div key={d.path} role="group" aria-label={isRoot ? d.name : d.path}>
        <button
          type="button"
          className={"fdir mono" + (isRoot ? " froot" : "")}
          style={{ paddingLeft: indentOf(depth) }}
          title={isRoot ? d.name : d.path.replace(/\/$/, "")}
          aria-expanded={open}
          onClick={() => !forceOpen && toggle(d.path)}
        >
          <span className={"fdir-caret" + (open ? " open" : "")} aria-hidden="true">
            ▸
          </span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
            <path d={FOLDER} />
            {/* 根节点（仓库）：文件夹右下角一个小方块，和普通目录区分 */}
            {isRoot && <rect x="8" y="8" width="5" height="5" rx="1.2" fill="var(--accent)" stroke="var(--win)" strokeWidth="1" />}
          </svg>
          <span className="fdir-name">{d.name}</span>
          <span className="dim fdir-count">{t("{0} 个文件", d.count)}</span>
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
  const tree = buildTree(items, pathOf);
  if (root === undefined) return <>{body(tree, 0)}</>;
  // 根节点：用 "" 以外的键记折叠状态
  return dir({ ...tree, name: root, path: "\u0000root/" }, 0);
}
