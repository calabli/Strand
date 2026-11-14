// 应用设置和最近打开的仓库。都存在本机界面的本地存储里，按用户保存，不按仓库分开。
// 语言单独存在 i18n 里（切换时要重新加载窗口）。

import { useEffect, useState } from "react";

export interface Settings {
  /** 主题：跟随系统、浅色、深色（说明书 3.5） */
  theme: "auto" | "light" | "dark";
  /** 窗口获得焦点时自动抓取（说明书 7.1） */
  autoFetch: boolean;
  /** 自动抓取的最短间隔（分钟） */
  fetchMinutes: number;
  /** 提交时在说明末尾加签名行（Signed-off-by） */
  signOff: boolean;
  /** 日志里显示精确日期；关闭时显示相对时间（说明书 5.2） */
  exactDates: boolean;
  /** 本地分支和它的远程分支在同一个提交上时合成一个标签（说明书 5.1 显示选项） */
  mergeRefs: boolean;
  /** 合并提交的标题显示为灰色（说明书 5.1 显示选项） */
  dimMerges: boolean;
  /** 启动时打开上次的仓库 */
  reopenLast: boolean;
  /** 差异视图：合并（上下）或左右对比（说明书 10.1） */
  diffView: "unified" | "split";
  /** 差异里忽略空白：只影响显示 */
  ignoreWs: boolean;
  /** 文件列表按目录树显示（说明书 4.7）：提交面板和提交详情共用 */
  groupByDir: boolean;
  /** 拖动分隔线调整的宽度（像素）：左边提交面板、右边提交详情、日志左边的分支树 */
  paneLeft: number;
  paneRight: number;
  paneTree: number;
}

export const DEFAULTS: Settings = { theme: "auto", autoFetch: true, fetchMinutes: 5, signOff: false, exactDates: true, mergeRefs: true, dimMerges: true, reopenLast: true, diffView: "unified", ignoreWs: false, groupByDir: false, paneLeft: 280, paneRight: 340, paneTree: 220 };

const KEY = "strand.settings";
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();

export const settings = (): Settings => current;

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* 存不了就只在本次有效 */
  }
  applyTheme();
  listeners.forEach((f) => f());
}

export function useSettings(): Settings {
  const [s, set] = useState(current);
  useEffect(() => {
    const f = () => set(current);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return s;
}

/** 主题写到根元素上：auto 时去掉，交给系统 */
export function applyTheme() {
  if (typeof document === "undefined") return;
  const r = document.documentElement;
  if (current.theme === "auto") delete r.dataset.theme;
  else r.dataset.theme = current.theme;
}
applyTheme();

// ---------- 最近打开的仓库 ----------

export interface RecentRepo {
  path: string;
  name: string;
  /** 最近一次打开的时间（Unix 秒） */
  opened: number;
  /** 固定在列表上面 */
  pinned: boolean;
}

const REPOS = "strand.repos";
const MAX_REPOS = 30;
const repoListeners = new Set<() => void>();

function loadRepos(): RecentRepo[] {
  try {
    const v = JSON.parse(localStorage.getItem(REPOS) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let repos = loadRepos();

function saveRepos(next: RecentRepo[]) {
  // 固定的在前，其余按最近打开排序；没固定的最多保留 30 个
  const pinned = next.filter((r) => r.pinned);
  const rest = next.filter((r) => !r.pinned).sort((a, b) => b.opened - a.opened).slice(0, MAX_REPOS);
  repos = [...pinned.sort((a, b) => a.name.localeCompare(b.name)), ...rest];
  try {
    localStorage.setItem(REPOS, JSON.stringify(repos));
  } catch {
    /* 只在本次有效 */
  }
  repoListeners.forEach((f) => f());
}

export const recentRepos = (): RecentRepo[] => repos;

/** 打开成功后记下来 */
export function rememberRepo(path: string, name: string) {
  const old = repos.find((r) => r.path === path);
  saveRepos([...repos.filter((r) => r.path !== path), { path, name, opened: Math.floor(Date.now() / 1000), pinned: old?.pinned ?? false }]);
}

export function forgetRepo(path: string) {
  saveRepos(repos.filter((r) => r.path !== path));
}

export function togglePin(path: string) {
  saveRepos(repos.map((r) => (r.path === path ? { ...r, pinned: !r.pinned } : r)));
}

export function useRecentRepos(): RecentRepo[] {
  const [s, set] = useState(repos);
  useEffect(() => {
    const f = () => set(repos);
    repoListeners.add(f);
    return () => {
      repoListeners.delete(f);
    };
  }, []);
  return s;
}
