// 分支树（说明书 6.1）：搜索、HEAD、本地、远程、标签、工作目录。
//
// 单击分支：日志只显示这个分支的提交，再点一次取消（和过滤栏的分支是同一个状态）。单击标签：定位。
// 双击：切换。悬停：切换、合并到当前分支、和当前分支比较、收藏。右键：分支菜单（6.4）。
// 左边一列图标：新建、更新（拉取）、删除、比较、抓取、收藏、定位、全部展开或折叠。
// 工作目录（6.6）：分组标题上的＋新建；每行悬停出现打开、在文件管理器中显示、移除；双击打开。
// 在别的工作目录检出的分支后面有标记，这里切换不过去。

import { useEffect, useMemo, useRef, useState } from "react";
import type { Branch, RefsList, Worktree } from "../api/types";
import type { BranchOps } from "./branchOps";
import type { MenuEntry } from "./Menu";
import { COMMIT_ICONS as I } from "./commitOps";
import { t } from "../i18n";

/** 分支的操作项，右键菜单和分支弹窗的子菜单共用（说明书 6.2、6.4） */
export function branchActions(b: Branch, ops: BranchOps, fav: boolean, toggleFav: (n: string) => void, merging: boolean): MenuEntry[] {
  const busy = merging ? t("合并还没完成") : undefined;
  return [
    {
      label: t("切换到这个分支"),
      icon: I.switch,
      run: () => ops.switchTo(b.name),
      disabled: b.is_current || merging || !!b.worktree,
      why: b.is_current ? t("已经在这个分支上") : b.worktree ? t("已经在工作目录 {0} 里检出", b.worktree) : busy,
    },
    { label: t("合并到当前分支"), icon: I.merge, run: () => ops.merge(b.name), disabled: b.is_current || merging || !ops.current, why: b.is_current ? t("这就是当前分支") : busy ?? t("现在不在任何分支上") },
    "-",
    {
      label: t("把当前分支变基到它之上…"),
      icon: I.rebase,
      run: () => ops.rebaseOnto(b.name),
      // 已经在它之上、独有提交里有合并提交时，核心层先算好原因，这里直接置灰（说明书 6.3）
      disabled: b.is_current || merging || !ops.current || !!b.rebase_block,
      why: b.is_current ? t("这就是当前分支") : busy ?? b.rebase_block ?? t("现在不在任何分支上"),
    },
    { label: t("和当前分支比较"), icon: I.compare, run: () => ops.compareWith?.(b.name), disabled: b.is_current || !ops.compareWith, why: t("这就是当前分支") },
    { label: t("从这里新建分支…"), icon: I.branch, run: () => ops.create({ rev: b.name, label: b.name }) },
    b.worktree
      ? { label: t("打开它所在的工作目录"), icon: I.folder, run: () => ops.worktree?.open(b.worktree!), disabled: !ops.worktree }
      : { label: t("在新工作目录中检出…"), icon: I.folder, run: () => ops.worktree?.add(b.name), disabled: b.is_current || !ops.worktree, why: t("这就是当前分支") },
    { label: fav ? t("取消收藏") : t("收藏"), icon: I.star, run: () => toggleFav(b.name) },
    { label: t("重命名…"), icon: I.reword, run: () => ops.rename(b) },
    "-",
    { label: t("删除…"), icon: I.drop, run: () => ops.remove(b), disabled: b.is_current, why: t("不能删除当前分支"), danger: true },
  ];
}

interface Props {
  refs: RefsList | null;
  ops: BranchOps;
  favs: Set<string>;
  toggleFav: (name: string) => void;
  merging: boolean;
  /** 过滤栏里选中的分支 */
  picked: string | null;
  onPick: (name: string) => void;
  onLocate: (rev: string) => void;
  onMenu: (x: number, y: number, items: MenuEntry[]) => void;
  /** 推送一个标签（说明书 6.5） */
  onPushTag?: (name: string) => void;
  /** 图标列里的更新（拉取当前分支）和抓取；pullWhy 是不能拉取的原因 */
  remote?: { fetch: () => void; pull: () => void; pullWhy: string | null };
}

type Group = "local" | "remote" | "tags" | "worktrees";

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const FOLDER_ICON = "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z";
/** 行首的类型图标：本地分支是标签形（当前分支是黄色），远程分支是分叉，远程是文件夹，标签是吊牌，工作目录是文件夹 */
const LABEL_ICON = "M2 3.2C2 2.5 2.5 2 3.2 2h4.3l4.5 4.5-5.5 5.5L2 7.5z";
const DOT = "M5.2 4.4a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6z";
const KindIcon = ({ d, dot, className }: { d: string; dot?: boolean; className?: string }) => (
  <svg className={"tkind " + (className ?? "")} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
    {dot && <path d={DOT} fill="currentColor" stroke="none" />}
  </svg>
);
const OPEN_ICON = "M8 2h4v4M12 2 6.5 7.5M10.5 8.5V12H2V3.5h3.5";
const Icon = ({ d }: { d: string }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** 工作目录的操作项（右键菜单） */
function worktreeActions(w: Worktree, ops: BranchOps): MenuEntry[] {
  const wt = ops.worktree!;
  return [
    { label: t("在 Strand 中打开"), run: () => wt.open(w.path), disabled: w.is_current || w.prunable, why: w.is_current ? t("就是现在打开的这个") : t("文件夹已经不在了") },
    { label: t("在文件管理器中显示"), run: () => wt.reveal(w.path), disabled: w.prunable, why: t("文件夹已经不在了") },
    "-",
    {
      label: w.prunable ? t("清理记录") : t("移除…"),
      run: () => wt.remove(w),
      disabled: w.is_main || w.is_current,
      why: w.is_main ? t("主工作目录不能移除") : t("不能移除现在打开的工作目录"),
      danger: true,
    },
  ];
}

export function BranchTree({ refs, ops, favs, toggleFav, merging, picked, onPick, onLocate, onMenu, onPushTag, remote }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<Group, boolean>>({ local: true, remote: true, tags: false, worktrees: true });

  const f = q.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const local = useMemo(
    // 收藏的排在前面，其余保持核心层给的顺序（按名字）
    () => (refs?.branches ?? []).filter((b) => match(b.name)).sort((a, b) => Number(!favs.has(a.name)) - Number(!favs.has(b.name))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refs, f, favs],
  );
  const remotes = (refs?.remotes ?? []).filter((r) => match(r.name));
  const byRemote = new Map<string, typeof remotes>();
  for (const r of remotes) byRemote.set(r.remote, [...(byRemote.get(r.remote) ?? []), r]);
  const tags = (refs?.tags ?? []).filter((t) => match(t.name));
  const worktrees = (refs?.worktrees ?? []).filter((w) => match(w.path) || match(w.branch ?? ""));
  // 搜索时自动展开有结果的分组
  const isOpen = (g: Group) => (f ? true : open[g]);
  /** 折叠起来的远程（如 origin） */
  const [closedRemotes, setClosedRemotes] = useState<Set<string>>(() => new Set());
  const toggle = (g: Group) => setOpen((o) => ({ ...o, [g]: !o[g] }));
  const allOpen = open.local && open.remote && open.tags && open.worktrees;

  // 拖拽合并（说明书 6.1）：按住本地或远程分支拖到另一个本地分支上松开。
  // 用鼠标事件自己做，不用 HTML5 拖放（Tauri 窗口里文件拖放会拦截它）。移动超过 5 px 才算拖。
  const [drag, setDrag] = useState<{ src: string; x: number; y: number; over: string | null } | null>(null);
  const over = useRef<string | null>(null);
  const dragged = useRef(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const startDrag = (src: string) => (e: React.MouseEvent) => {
    if (e.button !== 0 || merging) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let on = false;
    const move = (ev: MouseEvent) => {
      if (!on && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      on = true;
      document.body.classList.add("dragging");
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drop]");
      const o = el?.dataset.drop && el.dataset.drop !== src ? el.dataset.drop : null;
      over.current = o;
      setDrag({ src, x: ev.clientX, y: ev.clientY, over: o });
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", esc);
      document.body.classList.remove("dragging");
      stopDrag.current = null;
      setDrag(null);
    };
    const up = () => {
      const target = on ? over.current : null;
      if (on) {
        // 松开后紧跟着的 click 不算单击
        dragged.current = true;
        window.setTimeout(() => (dragged.current = false), 0);
      }
      end();
      if (target) ops.mergeInto(src, target);
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && end();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", esc);
    stopDrag.current = end;
  };
  const click = (f: () => void) => () => !dragged.current && f();
  /**
   * 行可以用键盘操作（说明书 12.4）：Tab 到达，回车等同单击，Shift+F10 或菜单键打开右键菜单。
   * 只处理行本身上的按键，行里的图标按钮照常。
   */
  const rowKeys = (onEnter: () => void, menu: () => MenuEntry[]) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onMenu(r.left + 24, r.bottom, menu());
    }
  };

  const remoteMenu = (r: NonNullable<typeof refs>["remotes"][number]): MenuEntry[] => [
                      { label: t("检出为本地分支"), run: () => ops.checkoutRemote(r.name), disabled: merging, why: t("合并还没完成") },
                      { label: t("合并到当前分支"), icon: I.merge, run: () => ops.merge(r.name), disabled: merging || !ops.current, why: t("合并还没完成或不在分支上") },
                      {
                        label: t("把当前分支变基到它之上…"),
                        icon: I.rebase,
                        run: () => ops.rebaseOnto(r.name),
                        disabled: merging || !ops.current || !!r.rebase_block,
                        why: merging ? t("合并还没完成") : !ops.current ? t("现在不在任何分支上") : r.rebase_block,
                      },
                      { label: t("从这里新建分支…"), run: () => ops.create({ rev: r.name, label: r.name }) },
                    ];
  const tagMenu = (tg: NonNullable<typeof refs>["tags"][number]): MenuEntry[] => [
                  { label: t("检出这个标签"), icon: I.checkout, run: () => ops.checkoutRev(tg.name), disabled: merging, why: t("合并还没完成") },
                  { label: t("从这里新建分支…"), icon: I.branch, run: () => ops.create({ rev: tg.name, label: tg.name }) },
                  ...(onPushTag ? [{ label: t("推送标签"), icon: I.push, run: () => onPushTag(tg.name) }] : []),
                  "-",
                  { label: t("删除标签…"), icon: I.drop, run: () => ops.deleteTag(tg.name, !tg.unpushed), danger: true },
                ];

  const head = refs?.head;
  const pickedBranch = local.find((b) => b.name === picked) ?? null;

  return (
    <nav className="tree" aria-label={t("分支")}>
      <div className="tree-bar">
        {/* 左侧操作图标（说明书 6.1）：“选中的分支”指在树里单击高亮的那个 */}
        <button type="button" className="ib" title={t("新建分支")} aria-label={t("新建分支")} onClick={() => ops.create()}>
          <Icon d="M7 2v10M2 7h10" />
        </button>
        <button type="button" className="ib" title={remote?.pullWhy ?? t("更新当前分支（拉取）")} aria-label={t("更新当前分支（拉取）")} disabled={!remote || !!remote.pullWhy} onClick={() => remote?.pull()}>
          <Icon d={I.pull} />
        </button>
        <button
          type="button"
          className="ib"
          title={pickedBranch && !pickedBranch.is_current ? t("删除 {0}", pickedBranch.name) : t("删除（先单击选中一个非当前分支）")}
          aria-label={pickedBranch && !pickedBranch.is_current ? t("删除 {0}", pickedBranch.name) : t("删除（先单击选中一个非当前分支）")}
          disabled={!pickedBranch || pickedBranch.is_current}
          onClick={() => pickedBranch && ops.remove(pickedBranch)}
        >
          <Icon d="M2 7h10" />
        </button>
        <button
          type="button"
          className="ib"
          title={pickedBranch && !pickedBranch.is_current ? t("和当前分支比较：{0}", pickedBranch.name) : t("比较（先单击选中一个非当前分支）")}
          aria-label={pickedBranch && !pickedBranch.is_current ? t("和当前分支比较：{0}", pickedBranch.name) : t("比较（先单击选中一个非当前分支）")}
          disabled={!pickedBranch || pickedBranch.is_current || !ops.compareWith}
          onClick={() => pickedBranch && ops.compareWith?.(pickedBranch.name)}
        >
          <Icon d={I.compare} />
        </button>
        <button type="button" className="ib" title={t("抓取所有远程")} aria-label={t("抓取所有远程")} disabled={!remote} onClick={() => remote?.fetch()}>
          <Icon d={I.fetch} />
        </button>
        <button
          type="button"
          className="ib"
          title={t("收藏选中的分支（没有选中则为当前分支）")}
          aria-label={t("收藏选中的分支（没有选中则为当前分支）")}
          onClick={() => {
            const n = picked ?? ops.current;
            if (n) toggleFav(n);
          }}
        >
          <Icon d={I.star} />
        </button>
        <button type="button" className="ib" title={t("定位到当前位置（清空过滤条件）")} aria-label={t("定位到当前位置（清空过滤条件）")} onClick={() => onLocate("HEAD")}>
          <Icon d={I.jump} />
        </button>
        <button
          type="button"
          className="ib"
          title={allOpen ? t("全部折叠") : t("全部展开")}
          aria-label={allOpen ? t("全部折叠") : t("全部展开")}
          onClick={() => setOpen({ local: !allOpen, remote: !allOpen, tags: !allOpen, worktrees: !allOpen })}
        >
          <Icon d={allOpen ? "M4 6l3-3 3 3M4 11l3-3 3 3" : "M4 3l3 3 3-3M4 8l3 3 3-3"} />
        </button>
      </div>
      <input className="tree-q" placeholder={t("搜索分支和标签")} aria-label={t("搜索分支和标签")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      <div className="tree-body">
        <button
          type="button"
          className={"trow trow-head" + (picked && picked === (head?.kind === "detached" ? "HEAD" : head?.branch) ? " picked" : "")}
          title={t("只看当前分支的提交")}
          onClick={() => onPick(head?.kind === "detached" ? "HEAD" : head?.branch ?? "HEAD")}
        >
          <span className="tname">HEAD（{head?.kind === "detached" ? t("不在任何分支上") : head?.branch ?? t("空仓库")}）</span>
        </button>

        <GroupHead label={t("本地")} count={local.length} open={isOpen("local")} onToggle={() => toggle("local")} />
        {isOpen("local") &&
          local.map((b) => (
            <div
              key={b.name}
              className={"trow" + (b.is_current ? " current" : "") + (picked === b.name ? " picked" : "") + (drag?.over === b.name ? " drop" : "") + (drag?.src === b.name ? " drag-src" : "")}
              // 在别的工作目录检出的分支切换不过去，不能当拖放目标
              data-drop={!b.worktree || b.is_current ? b.name : undefined}
              onMouseDown={startDrag(b.name)}
              onClick={click(() => onPick(b.name))}
              tabIndex={0}
              onKeyDown={rowKeys(() => onPick(b.name), () => branchActions(b, ops, favs.has(b.name), toggleFav, merging))}
              onDoubleClick={() => !b.is_current && !b.worktree && !merging && ops.switchTo(b.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(e.clientX, e.clientY, branchActions(b, ops, favs.has(b.name), toggleFav, merging));
              }}
              title={b.upstream ? t("跟踪 {0}", b.upstream) : t("只在本地")}
            >
              <KindIcon d={LABEL_ICON} dot className={b.is_current ? "cur" : ""} />
              <span className="tname mono">
                {favs.has(b.name) && <span className="star">★ </span>}
                {b.name}
              </span>
              {b.is_current && <span className="cur-tag">{t("当前")}</span>}
              {b.worktree && (
                <span className="wt-mark" title={t("已经在工作目录 {0} 里检出", b.worktree)} aria-label={t("在别的工作目录里检出")}>
                  <Icon d={FOLDER_ICON} />
                </span>
              )}
              {b.needs_force ? (
                // 改写了已推送的提交：远程上那些是旧版本，落后数不显示（说明书 6.3）
                <span className="ab mono force" title={t("改写了已经推送的提交，要强制推送才能更新 {0}", b.upstream)} aria-label={t("需要强制推送")}>
                  {`↑${b.ahead}!`}
                </span>
              ) : (
                (b.ahead > 0 || b.behind > 0) && (
                  <span className="ab mono" title={t("比 {0} 领先 {1} 个、落后 {2} 个提交", b.upstream, b.ahead, b.behind)}>
                    {b.ahead > 0 && `↑${b.ahead}`}
                    {b.behind > 0 && `↓${b.behind}`}
                  </span>
                )
              )}
              <span className="tacts" onClick={(e) => e.stopPropagation()}>
                {!b.is_current && !b.worktree && (
                  <>
                    <button type="button" className="ib sm" title={t("切换到 {0}", b.name)} aria-label={t("切换到 {0}", b.name)} disabled={merging} onClick={() => ops.switchTo(b.name)}>
                      ⇄
                    </button>
                    <button type="button" className="ib sm" title={t("把 {0} 合并到当前分支", b.name)} aria-label={t("把 {0} 合并到当前分支", b.name)} disabled={merging || !ops.current} onClick={() => ops.merge(b.name)}>
                      ⤵
                    </button>
                  </>
                )}
                {!b.is_current && ops.compareWith && (
                  <button type="button" className="ib sm" title={t("和当前分支比较：{0}", b.name)} aria-label={t("和当前分支比较：{0}", b.name)} onClick={() => ops.compareWith?.(b.name)}>
                    <Icon d={I.compare} />
                  </button>
                )}
                <button type="button" className="ib sm" title={favs.has(b.name) ? t("取消收藏") : t("收藏")} aria-label={favs.has(b.name) ? t("取消收藏 {0}", b.name) : t("收藏 {0}", b.name)} onClick={() => toggleFav(b.name)}>
                  {favs.has(b.name) ? "★" : "☆"}
                </button>
              </span>
            </div>
          ))}

        <GroupHead label={t("远程")} count={remotes.length} open={isOpen("remote")} onToggle={() => toggle("remote")} />
        {isOpen("remote") &&
          [...byRemote].map(([remote, list]) => (
            <div key={remote}>
              <button
                type="button"
                className="trow tremote"
                aria-expanded={f ? true : !closedRemotes.has(remote)}
                onClick={() =>
                  setClosedRemotes((s) => {
                    const n = new Set(s);
                    if (n.has(remote)) n.delete(remote);
                    else n.add(remote);
                    return n;
                  })
                }
              >
                <span className="chev">{f || !closedRemotes.has(remote) ? "▾" : "▸"}</span>
                <KindIcon d={FOLDER_ICON} />
                <span className="tname">{remote}</span>
                <span className="dim">{list.length}</span>
              </button>
              {(f || !closedRemotes.has(remote)) && list.map((r) => (
                <div
                  key={r.name}
                  className={"trow indent" + (picked === r.name ? " picked" : "") + (drag?.src === r.name ? " drag-src" : "")}
                  onMouseDown={startDrag(r.name)}
                  onClick={click(() => onPick(r.name))}
                  tabIndex={0}
                  onKeyDown={rowKeys(() => onPick(r.name), () => remoteMenu(r))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onMenu(e.clientX, e.clientY, remoteMenu(r));
                  }}
                >
                  <KindIcon d={I.branch} />
                  <span className="tname mono">{r.name.slice(remote.length + 1)}</span>
                  <span className="tacts" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="ib sm" title={t("检出为本地分支")} aria-label={t("把 {0} 检出为本地分支", r.name)} disabled={merging} onClick={() => ops.checkoutRemote(r.name)}>
                      ↓
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}

        <GroupHead label={t("标签")} count={tags.length} open={isOpen("tags")} onToggle={() => toggle("tags")} />
        {isOpen("tags") &&
          tags.map((tg) => (
            <div
              key={tg.name}
              className="trow"
              onClick={() => onLocate(tg.name)}
              tabIndex={0}
              onKeyDown={rowKeys(() => onLocate(tg.name), () => tagMenu(tg))}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(e.clientX, e.clientY, tagMenu(tg));
              }}
            >
              <KindIcon d={I.tag} />
              <span className="tname mono">{tg.name}</span>
              {tg.unpushed && onPushTag && (
                // 未推送的标签显示推送图标（说明书 6.5），点一下推送
                <button
                  type="button"
                  className="ib sm tag-push"
                  title={t("还没推送，点击推送标签 {0}", tg.name)}
                  aria-label={t("推送标签 {0}", tg.name)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPushTag(tg.name);
                  }}
                >
                  <Icon d={I.push} />
                </button>
              )}
            </div>
          ))}

        {worktrees.length > 0 && ops.worktree && (
          <>
            <GroupHead label={t("工作目录")} count={worktrees.length} open={isOpen("worktrees")} onToggle={() => toggle("worktrees")} onAdd={() => ops.worktree?.add()} addTitle={t("新建工作目录…")} />
            {isOpen("worktrees") &&
              worktrees.map((w) => (
                <div
                  key={w.path}
                  className={"trow" + (w.is_current ? " current" : "") + (w.prunable ? " gone" : "")}
                  title={w.path}
                  onDoubleClick={() => !w.is_current && !w.prunable && ops.worktree?.open(w.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onMenu(e.clientX, e.clientY, worktreeActions(w, ops));
                  }}
                >
                  <KindIcon d={FOLDER_ICON} />
                  <span className="tname">
                    {baseName(w.path)}
                    <span className="mono dim wt-branch"> {w.branch ?? (w.head ? w.head.slice(0, 7) : "")}</span>
                  </span>
                  {w.is_current && <span className="cur-tag">{t("当前")}</span>}
                  {w.is_main && !w.is_current && <span className="dim small">{t("主目录")}</span>}
                  {w.prunable && <span className="dim small">{t("文件夹不在了")}</span>}
                  <span className="tacts" onClick={(e) => e.stopPropagation()}>
                    {!w.is_current && !w.prunable && (
                      <button type="button" className="ib sm" title={t("在 Strand 中打开")} aria-label={t("在 Strand 中打开 {0}", baseName(w.path))} onClick={() => ops.worktree?.open(w.path)}>
                        <Icon d={OPEN_ICON} />
                      </button>
                    )}
                    {!w.prunable && (
                      <button type="button" className="ib sm" title={t("在文件管理器中显示")} aria-label={t("在文件管理器中显示")} onClick={() => ops.worktree?.reveal(w.path)}>
                        <Icon d={FOLDER_ICON} />
                      </button>
                    )}
                    {!w.is_main && !w.is_current && (
                      <button type="button" className="ib sm" title={w.prunable ? t("清理记录") : t("移除…")} aria-label={t("移除工作目录 {0}", baseName(w.path))} onClick={() => ops.worktree?.remove(w)}>
                        ×
                      </button>
                    )}
                  </span>
                </div>
              ))}
          </>
        )}
        {drag && (
          <div className="drag-ghost mono" style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true">
            {drag.over ? t("把 {0} 合并到 {1}", drag.src, drag.over) : drag.src}
          </div>
        )}
        {f && local.length + remotes.length + tags.length + worktrees.length === 0 && <p className="pad dim">{t("没有匹配的分支或标签")}</p>}
      </div>
    </nav>
  );
}

function GroupHead({ label, count, open, onToggle, onAdd, addTitle }: { label: string; count: number; open: boolean; onToggle: () => void; onAdd?: () => void; addTitle?: string }) {
  const head = (
    <button type="button" className="tgroup" aria-expanded={open} onClick={onToggle}>
      <span className="chev">{open ? "▾" : "▸"}</span>
      {label}
      <span className="dim">{count}</span>
    </button>
  );
  if (!onAdd) return head;
  return (
    <div className="tgroup-row">
      {head}
      <button type="button" className="ib sm" title={addTitle} aria-label={addTitle} onClick={onAdd}>
        ＋
      </button>
    </div>
  );
}
