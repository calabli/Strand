// Branch tree (spec §6.1): search, HEAD, local, remote, tags, worktrees, submodules.
// Submodules show their state (not initialized, changes inside, another commit checked out); hover to update, open or reveal.
//
// Click a branch: the log shows only its commits; click again to cancel (same state as the filter bar's branch). Click a tag: locate it.
// Double-click: switch. Hover: switch, merge into current branch, compare with current branch, favorite. Right-click: branch menu (6.4).
// Icon column on the left: new, update (pull), delete, compare, fetch, favorite, locate, expand or collapse all.
// Worktrees (6.6): + on the group header to create; hovering a row shows open, reveal in file manager, remove; double-click opens.
// Branches checked out in another worktree are marked and can't be switched to here.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Branch, RefsList, Submodule, Worktree } from "../api/types";
import type { BranchOps } from "./branchOps";
import type { MenuEntry } from "./Menu";
import { COMMIT_ICONS as I } from "./commitOps";
import { t } from "../i18n";

/** Branch actions, shared by the context menu and the branch popup's submenu (spec §6.2, §6.4) */
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
      // When it's already on top or own commits include a merge commit, the core layer computes the reason up front and it's greyed out here (spec §6.3)
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
  /** The branch selected in the filter bar */
  picked: string | null;
  onPick: (name: string) => void;
  onLocate: (rev: string) => void;
  onMenu: (x: number, y: number, items: MenuEntry[]) => void;
  /** Push one tag (spec §6.5) */
  onPushTag?: (name: string) => void;
  /** Open remote management */
  onRemotes?: () => void;
  /** Update (pull the current branch) and fetch in the icon column; pullWhy is why pulling isn't possible */
  remote?: { fetch: () => void; pull: () => void; pullWhy: string | null };
  /** Submodules (null while loading or without any) */
  subs?: Submodule[] | null;
}

type Group = "local" | "remote" | "tags" | "worktrees" | "submodules";

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const FOLDER_ICON = "M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z";
/** Type icon at the start of a row: local branches are tag-shaped (the current one yellow), remote branches a fork, remotes a folder, tags a label, worktrees a folder */
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

/** Worktree actions (context menu) */
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

export function BranchTree({ refs, ops, favs, toggleFav, merging, picked, onPick, onLocate, onMenu, onPushTag, onRemotes, remote, subs }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<Group, boolean>>({ local: true, remote: true, tags: false, worktrees: true, submodules: true });

  const f = q.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const local = useMemo(
    // Favorites first, the rest in the order the core layer gave (by name)
    () => (refs?.branches ?? []).filter((b) => match(b.name)).sort((a, b) => Number(!favs.has(a.name)) - Number(!favs.has(b.name))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refs, f, favs],
  );
  const remotes = (refs?.remotes ?? []).filter((r) => match(r.name));
  const byRemote = new Map<string, typeof remotes>();
  for (const r of remotes) byRemote.set(r.remote, [...(byRemote.get(r.remote) ?? []), r]);
  const tags = (refs?.tags ?? []).filter((t) => match(t.name));
  const worktrees = (refs?.worktrees ?? []).filter((w) => match(w.path) || match(w.branch ?? ""));
  const submodules = (subs ?? []).filter((m) => match(m.path));
  // Expand groups with results automatically while searching
  const isOpen = (g: Group) => (f ? true : open[g]);
  /** Collapsed remotes (e.g. origin) */
  const [closedRemotes, setClosedRemotes] = useState<Set<string>>(() => new Set());
  const toggle = (g: Group) => setOpen((o) => ({ ...o, [g]: !o[g] }));
  const allOpen = open.local && open.remote && open.tags && open.worktrees;

  // Drag to merge or rebase (spec §6.1; rebase added later after JetBrains): press on a local or remote branch, drag onto another local branch and release,
  // and a menu offers merge or rebase. Rebase only changes the current branch: dragging the current branch rebases it onto the target; dropping onto the current branch rebases the current branch onto the dragged one.
  // Done with mouse events rather than HTML5 drag and drop (file drops in the Tauri window intercept it). Only counts as a drag after moving more than 5 px.
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
    const up = (ev: MouseEvent) => {
      const target = on ? over.current : null;
      if (on) {
        // The click right after releasing doesn't count as a click
        dragged.current = true;
        window.setTimeout(() => (dragged.current = false), 0);
      }
      end();
      if (target) onMenu(ev.clientX, ev.clientY, dropMenu(src, target));
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && end();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", esc);
    stopDrag.current = end;
  };
  const click = (f: () => void) => () => !dragged.current && f();
  /** The menu after releasing: merge, or rebase (only changes the current branch) */
  const dropMenu = (src: string, target: string): MenuEntry[] => {
    const cur = ops.current;
    // rebase_block is why "rebase the current branch onto it" isn't possible
    const block = (name: string) => refs?.branches.find((b) => b.name === name)?.rebase_block ?? refs?.remotes.find((r) => r.name === name)?.rebase_block ?? undefined;
    const rebase: MenuEntry =
      src === cur
        ? { label: t("把 {0} 变基到 {1} 之上…", src, target), icon: I.rebase, run: () => ops.rebaseOnto(target), disabled: !!block(target), why: block(target) }
        : target === cur
          ? { label: t("把 {0} 变基到 {1} 之上…", target, src), icon: I.rebase, run: () => ops.rebaseOnto(src), disabled: !!block(src), why: block(src) }
          : { label: t("变基…"), icon: I.rebase, disabled: true, why: t("变基只改当前分支：把当前分支拖到别的分支上，或者把别的分支拖到当前分支上") };
    return [{ label: t("{0} → {1}", src, target), heading: true }, { label: t("把 {0} 合并到 {1}…", src, target), icon: I.merge, run: () => ops.mergeInto(src, target) }, rebase];
  };
  /**
   * Rows are keyboard operable (spec §12.4): reachable with Tab, Enter acts as a click, Shift+F10 or the menu key opens the context menu.
   * Only keys on the row itself are handled; icon buttons in the row work as usual.
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
        {/* Icons on the left (spec §6.1): "the selected branch" is the one highlighted by clicking in the tree */}
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
          onClick={() => setOpen({ local: !allOpen, remote: !allOpen, tags: !allOpen, worktrees: !allOpen, submodules: !allOpen })}
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
              // Branches checked out in another worktree can't be switched to, so they can't be drop targets
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
                // Pushed commits were rewritten: those on the remote are old versions, so behind isn't shown (spec §6.3)
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
                onContextMenu={(e) => {
                  if (!onRemotes) return;
                  e.preventDefault();
                  onMenu(e.clientX, e.clientY, [{ label: t("管理远程…"), run: onRemotes }]);
                }}
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
              <span className="tname mono" title={tg.message ? `${tg.name}\n\n${tg.message}` : undefined}>
                {tg.name}
              </span>
              {tg.message && (
                <span className="tag-note dim" title={tg.message} aria-label={t("带说明的标签")}>
                  ¶
                </span>
              )}
              {tg.unpushed && onPushTag && (
                // Unpushed tags show a push icon (spec §6.5); click to push
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
        {submodules.length > 0 && ops.submodule && (
          <>
            <GroupHead
              label={t("子模块")}
              count={submodules.length}
              open={isOpen("submodules")}
              onToggle={() => toggle("submodules")}
              onAction={ops.submodule.busy ? undefined : () => ops.submodule?.update([])}
              actionTitle={t("更新全部子模块（检出记录的提交，没初始化的先初始化）")}
              actionIcon={I.pull}
            />
            {isOpen("submodules") &&
              submodules.map((m) => {
                const sm = ops.submodule!;
                const ready = m.state !== "uninitialized";
                const tag = SUB_TAG[m.state];
                const menu: MenuEntry[] = [
                  { label: ready ? t("更新到记录的提交") : t("初始化并检出"), icon: I.pull, disabled: sm.busy || (m.state === "clean"), why: sm.busy ? t("正在更新子模块") : t("已经是记录的提交"), run: () => sm.update([m.path]) },
                  { label: t("在 Strand 中打开"), icon: OPEN_ICON, disabled: !ready, why: t("还没初始化"), run: () => sm.open(m.path) },
                  { label: t("在文件管理器中显示"), icon: FOLDER_ICON, disabled: !ready, why: t("还没初始化"), run: () => sm.reveal(m.path) },
                  "-",
                  { label: t("复制地址"), icon: I.copy, disabled: !m.url, run: () => void navigator.clipboard.writeText(m.url ?? "") },
                ];
                return (
                  <div
                    key={m.path}
                    className={"trow sub-row" + (ready ? "" : " gone")}
                    title={[m.path, m.url, m.recorded && t("记录的提交 {0}", m.recorded.slice(0, 7)), m.current && m.current !== m.recorded && t("检出的提交 {0}", m.current.slice(0, 7))].filter(Boolean).join("\n")}
                    onDoubleClick={() => (ready ? sm.open(m.path) : sm.update([m.path]))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onMenu(e.clientX, e.clientY, menu);
                    }}
                  >
                    <KindIcon d={SUB_ICON} />
                    <span className="tname">
                      {baseName(m.path)}
                      <span className="mono dim wt-branch"> {(m.current ?? m.recorded ?? "").slice(0, 7)}</span>
                    </span>
                    {tag && <span className={"sub-tag " + m.state}>{t(tag)}</span>}
                    <span className="tacts" onClick={(e) => e.stopPropagation()}>
                      {m.state !== "clean" && (
                        <button type="button" className="ib sm" disabled={sm.busy} title={ready ? t("更新到记录的提交") : t("初始化并检出")} aria-label={t("更新子模块 {0}", m.path)} onClick={() => sm.update([m.path])}>
                          <Icon d={I.pull} />
                        </button>
                      )}
                      {ready && (
                        <button type="button" className="ib sm" title={t("在 Strand 中打开")} aria-label={t("在 Strand 中打开 {0}", m.path)} onClick={() => sm.open(m.path)}>
                          <Icon d={OPEN_ICON} />
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
          </>
        )}
        {drag && (
          <div className="drag-ghost mono" style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true">
            {drag.over ? t("{0} → {1}：松开后选合并或变基", drag.src, drag.over) : drag.src}
          </div>
        )}
        {f && local.length + remotes.length + tags.length + worktrees.length + submodules.length === 0 && <p className="pad dim">{t("没有匹配的分支或标签")}</p>}
      </div>
    </nav>
  );
}

/** State tags on submodule rows; none when clean */
const SUB_TAG: Record<Submodule["state"], string | null> = {
  uninitialized: "未初始化",
  clean: null,
  moved: "提交不同",
  dirty: "有改动",
  conflict: "有冲突",
};
/** A box inside a folder */
const SUB_ICON = "M1.5 3.5h4l1 1.2h6v6.8h-11zM6 7.5h3.5v2.5H6z";

function GroupHead({
  label,
  count,
  open,
  onToggle,
  onAdd,
  addTitle,
  onAction,
  actionTitle,
  actionIcon,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  /** An icon button other than ＋ */
  onAction?: () => void;
  actionTitle?: string;
  actionIcon?: string;
}) {
  const head = (
    <button type="button" className="tgroup" aria-expanded={open} onClick={onToggle}>
      <span className="chev">{open ? "▾" : "▸"}</span>
      {label}
      <span className="dim">{count}</span>
    </button>
  );
  if (actionIcon)
    return (
      <div className="tgroup-row">
        {head}
        <button type="button" className="ib sm" title={actionTitle} aria-label={actionTitle} onClick={onAction} disabled={!onAction}>
          <Icon d={actionIcon} />
        </button>
      </div>
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
