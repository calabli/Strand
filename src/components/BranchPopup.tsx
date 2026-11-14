// 分支弹窗（说明书 6.2）：工具栏分支按钮打开，用命令面板的组件（Palette），只是内容不同。
// - 常用操作：拉取、提交、推送、抓取（由外面给）、新建分支、新建工作目录、检出标签或指定版本。
// - 本地分支：收藏的在前，右边是跟踪的远程分支或“本地”；回车进入分支子菜单，第一项是“返回”。
// - 远程分支：回车检出为本地分支。
// - 有搜索词时另外列出跨分支的操作：把它合并到当前分支、和当前分支比较。

import { useMemo, useState } from "react";
import type { Branch, RefsList } from "../api/types";
import { branchActions } from "./BranchTree";
import type { BranchOps } from "./branchOps";
import { COMMIT_ICONS as I } from "./commitOps";
import type { MenuEntry, MenuItem } from "./Menu";
import { Palette, backRow, type PaletteRow } from "./Palette";
import { t, lang } from "../i18n";

interface Props {
  refs: RefsList | null;
  ops: BranchOps;
  favs: Set<string>;
  toggleFav: (name: string) => void;
  merging: boolean;
  /** 外面给的常用操作：拉取、提交、推送、抓取（key 分别是 pull、commit、push、fetch） */
  common: PaletteRow[];
  /** 日志只看这个分支的提交 */
  onShowOnly: (name: string) => void;
  onClose: () => void;
}

/** 菜单项换成面板的行（去掉分隔线） */
const fromMenu = (items: MenuEntry[], prefix: string): PaletteRow[] =>
  items
    .filter((x): x is MenuItem => x !== "-")
    .map((m, i) => ({ key: `${prefix}${i}:${m.label}`, label: m.label, icon: m.icon, hint: m.hint, disabled: m.disabled, why: m.why, danger: m.danger, run: () => m.run?.() }));

export function BranchPopup({ refs, ops, favs, toggleFav, merging, common, onShowOnly, onClose }: Props) {
  const [q, setQ] = useState("");
  const [sub, setSub] = useState<string | null>(null);
  const enter = (name: string | null) => {
    setSub(name);
    setQ("");
  };

  /** 分支子菜单（说明书 6.2 的表） */
  const subRows = (b: Branch): PaletteRow[] => {
    const rows: PaletteRow[] = [];
    if (b.is_current) rows.push(...common.filter((c) => c.key === "pull" || c.key === "push"));
    // 当前分支：切换、合并、比较、删除这些对它不适用的不列出来（说明书 6.2 的表）
    const acts = fromMenu(branchActions(b, ops, favs.has(b.name), toggleFav, merging), "b");
    rows.push(...(b.is_current ? acts.filter((r) => !r.disabled) : acts));
    // “只看它的提交”放在新建分支后面
    const at = rows.findIndex((r) => r.label === t("从这里新建分支…"));
    rows.splice(at < 0 ? rows.length : at + 1, 0, { key: "only", label: t("只看它的提交"), icon: I.base, run: () => onShowOnly(b.name) });
    return rows;
  };

  const rows: PaletteRow[] = useMemo(() => {
    const f = q.trim().toLowerCase();
    const match = (s: string) => !f || s.toLowerCase().includes(f);
    if (sub) {
      const b = refs?.branches.find((x) => x.name === sub);
      if (!b) return [backRow(() => enter(null))];
      return [backRow(() => enter(null)), ...subRows(b).filter((r) => match(r.label))];
    }
    const out: PaletteRow[] = [];
    const sec = t("常用操作");
    const actions: PaletteRow[] = [
      ...(merging ? [{ key: "abort", label: t("中止合并…"), icon: I.cancel, danger: true, run: () => ops.abortMerge() }] : []),
      ...common,
      { key: "new", label: t("新建分支…"), icon: I.branch, run: () => ops.create() },
      ...(ops.worktree ? [{ key: "wt", label: t("新建工作目录…"), icon: I.folder, run: () => ops.worktree!.add() }] : []),
      { key: "rev", label: t("检出标签或指定版本…"), icon: I.checkout, run: () => ops.checkoutRev(), disabled: merging, why: t("合并还没完成") },
    ];
    out.push(...actions.filter((a) => match(a.label)).map((a) => ({ ...a, section: sec })));

    const local = (refs?.branches ?? []).filter((b) => match(b.name)).sort((a, b) => Number(favs.has(b.name)) - Number(favs.has(a.name)));
    out.push(
      ...local.map((b) => ({
        key: "l:" + b.name,
        section: t("本地分支"),
        label: (favs.has(b.name) ? "★ " : "") + b.name + (b.is_current ? t("（当前）") : ""),
        icon: I.branch,
        detail: b.worktree
          ? t("在工作目录 {0}", b.worktree.split(/[\\/]/).pop())
          : b.needs_force
            ? t("{0} · 需要强制推送", b.upstream)
            : b.upstream ?? t("本地"),
        more: true,
        stay: true,
        run: () => enter(b.name),
      })),
    );
    out.push(
      ...(refs?.remotes ?? [])
        .filter((r) => match(r.name))
        .map((r) => ({
          key: "r:" + r.name,
          section: t("远程分支"),
          label: r.name,
          icon: I.checkout,
          detail: t("检出"),
          run: () => ops.checkoutRemote(r.name),
          disabled: merging,
          why: t("合并还没完成"),
        })),
    );
    // 有搜索词时列出跨分支的操作（说明书 6.2）
    if (f && ops.current) {
      const cross = (refs?.branches ?? []).filter((b) => !b.is_current && match(b.name)).slice(0, 5);
      for (const b of cross) {
        out.push({ key: "m:" + b.name, section: t("操作"), label: t("把 {0} 合并到当前分支", b.name), icon: I.merge, run: () => ops.merge(b.name), disabled: merging, why: t("合并还没完成") });
        out.push({ key: "rb:" + b.name, section: t("操作"), label: t("把当前分支变基到 {0} 之上…", b.name), icon: I.rebase, run: () => ops.rebaseOnto(b.name), disabled: merging || !!b.rebase_block, why: merging ? t("合并还没完成") : b.rebase_block });
        if (ops.compareWith) out.push({ key: "c:" + b.name, section: t("操作"), label: t("和 {0} 比较", b.name), icon: I.compare, run: () => ops.compareWith!(b.name) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sub, refs, favs, merging, ops, toggleFav, common, lang]);

  return (
    <Palette
      label={t("分支")}
      placeholder={sub ? t("{0} 的操作", sub) : t("搜索分支或操作")}
      query={q}
      onQuery={setQ}
      rows={rows}
      onClose={onClose}
      onBack={sub ? () => enter(null) : undefined}
      empty={t("没有匹配的项")}
    />
  );
}
