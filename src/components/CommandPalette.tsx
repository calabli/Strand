// Command palette (spec §12.1): opened with ⌘K. With empty input, lists the top 10 common commands; with input, matches command names and categories by substring,
// and also searches commit messages and hashes. The list and keys are handled by the Palette component (the branch popup uses it too).

import { useEffect, useMemo, useState } from "react";
import { api } from "../api/commands";
import type { Commit } from "../api/types";
import { t, lang } from "../i18n";
import { formatTime, shortId } from "./format";
import { Palette, type PaletteRow } from "./Palette";

export interface PaletteCommand {
  id: string;
  /** Category, e.g. "View", "Actions" */
  section: string;
  label: string;
  /** Shortcut hint */
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

  // Search commits: query once after typing pauses for 150 ms
  useEffect(() => {
    const text = q.trim();
    // Clear the previous results first so Enter doesn't select a commit that doesn't match the current input
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
  }, [q, commands, commits, onPickCommit, lang]);

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

/** Keyboard shortcuts (spec §12.3), opened by "Show shortcuts" in the command palette */
export const SHORTCUTS: [string, string][] = [
  ["⌘K", "打开或关闭命令面板"],
  ["⌘F", "搜索日志"],
  ["⌘D", "在差异标签页里打开选中提交的文件"],
  ["⌥↑ / ⌥↓", "差异里的上一处 / 下一处改动"],
  ["⌥← / ⌥→", "差异标签页里的上一个 / 下一个文件"],
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
