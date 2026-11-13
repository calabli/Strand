// 命令面板（说明书 12.1）：⌘K 打开。输入为空时列出前 10 项常用命令；有输入时按子串匹配命令名和分类，
// 同时搜索提交说明和哈希。列表和按键由 Palette 组件处理（分支弹窗也用它）。

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/commands";
import type { Commit } from "../api/types";
import { t } from "../i18n";
import { formatTime, shortId } from "./format";
import { Palette, type PaletteRow } from "./Palette";

export interface PaletteCommand {
  id: string;
  /** 分类，如“视图”“操作” */
  section: string;
  label: string;
  /** 快捷键提示 */
  hint?: string;
  icon?: string;
  run: () => void;
  disabled?: boolean;
  why?: string;
}

const MAX_COMMITS = 20;

export function CommandPalette({ commands, onPickCommit, onClose }: { commands: PaletteCommand[]; onPickCommit: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [commits, setCommits] = useState<Commit[]>([]);

  // 搜索提交：输入停 150 ms 后查一次
  useEffect(() => {
    const text = q.trim();
    // 先清掉上一次的结果，免得回车选中和当前输入不匹配的提交
    setCommits([]);
    if (!text) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api.logQuery(0, MAX_COMMITS, { text }).then(
        (p) => live && setCommits(p.rows),
        () => live && setCommits([]),
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q]);

  const rows: PaletteRow[] = useMemo(() => {
    const f = q.trim().toLowerCase();
    const cmds = f ? commands.filter((c) => c.label.toLowerCase().includes(f) || c.section.toLowerCase().includes(f) || c.id.includes(f)) : commands.slice(0, 10);
    return [
      ...cmds.map((c) => ({ key: "c:" + c.id, section: c.section, label: c.label, icon: c.icon, hint: c.hint, disabled: c.disabled, why: c.why, run: c.run })),
      ...commits.map((c) => ({ key: "h:" + c.id, section: t("提交"), prefix: shortId(c.id), label: c.title, detail: formatTime(c.time), run: () => onPickCommit(c.id) })),
    ];
  }, [q, commands, commits, onPickCommit]);

  return (
    <Palette
      label={t("命令面板")}
      placeholder={t("输入命令、分支名、提交说明或哈希")}
      query={q}
      onQuery={setQ}
      rows={rows}
      onClose={onClose}
      empty={t("没有匹配的命令或提交")}
    />
  );
}

/** 快捷键说明（说明书 12.3），命令面板里的“查看快捷键”打开 */
export const SHORTCUTS: [string, string][] = [
  ["⌘K", "打开或关闭命令面板"],
  ["⌘F", "搜索日志"],
  ["↑ / ↓", "选中上一个 / 下一个提交"],
  ["→ / ←", "跳到父提交 / 子提交"],
  ["F2", "修改选中提交的说明"],
  ["⌘ 单击 / ⇧ 单击", "加选 / 范围选择提交"],
  ["⌘↵", "提交（在提交说明里）"],
  ["⌥⌘↵", "提交并推送"],
  ["⌘Z / ⇧⌘Z", "撤销 / 重做"],
  ["⌥↑ / ⌥↓", "合并窗口里的上一处 / 下一处"],
  ["Esc", "关闭对话框、菜单、命令面板"],
];
