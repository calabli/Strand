// App settings and recently opened repositories. Stored in the UI's local storage on this machine, per user, not per repository.
// The language is stored separately in i18n (switching it reloads the window).

import { useEffect, useState } from "react";

export interface Settings {
  /** Theme: follow system, light, dark (spec §3.5) */
  theme: "auto" | "light" | "dark";
  /** Auto-fetch when the window gains focus (spec §7.1) */
  autoFetch: boolean;
  /** Minimum interval between auto-fetches (minutes) */
  fetchMinutes: number;
  /** Add a sign-off line (Signed-off-by) at the end of the message when committing */
  signOff: boolean;
  /** Show exact dates in the log; relative times when off (spec §5.2) */
  exactDates: boolean;
  /** Combine a local branch and its remote branch into one label when on the same commit (display options in spec §5.1) */
  mergeRefs: boolean;
  /** Show merge commit titles in grey (display options in spec §5.1) */
  dimMerges: boolean;
  /** Open the last repository on startup */
  reopenLast: boolean;
  /** Check for a new version on startup */
  autoUpdate: boolean;
  /** Diff view: unified (top and bottom) or side by side (spec §10.1) */
  diffView: "unified" | "split";
  /** Ignore whitespace in diffs: display only */
  ignoreWs: boolean;
  /** Fold long unchanged stretches in diffs (off shows the whole file) */
  diffFold: boolean;
  /** Show blame in diffs (the date and author that last changed each line) */
  diffBlame: boolean;
  /** Show spaces and tabs as dots and arrows in diffs */
  diffWs: boolean;
  /** Show line numbers in diffs */
  diffLineNo: boolean;
  /** Wrap long lines in diffs (when off, the unified view scrolls horizontally and side by side truncates) */
  diffWrap: boolean;
  /** Syntax highlighting in diffs and full file text */
  diffSyntax: boolean;
  /** Indent guides in diffs and full file text */
  diffIndent: boolean;
  /** Show file lists as a directory tree (spec §4.7): shared by the commit panel and commit details */
  groupByDir: boolean;
  /** Widths set by dragging splitters (px): commit panel on the left, commit details on the right, branch tree on the log's left */
  paneLeft: number;
  paneRight: number;
  paneTree: number;
  /** Heights set by vertical dragging in commit details (px): file list, commit info (with the diff box shown); null is automatic */
  detailFiles: number | null;
  detailInfo: number | null;
  /** Width of the change chain column in the file view */
  paneHistory: number;
  /** Save edited files automatically (a second after typing stops, and when leaving the editor) */
  autoSave: boolean;
}

export const DEFAULTS: Settings = { theme: "auto", autoFetch: true, fetchMinutes: 5, signOff: false, exactDates: true, mergeRefs: true, dimMerges: true, reopenLast: true, autoUpdate: true, diffView: "unified", ignoreWs: false, diffFold: true, diffBlame: false, diffWs: false, diffLineNo: true, diffWrap: true, diffSyntax: true, diffIndent: true, groupByDir: false, paneLeft: 280, paneRight: 340, paneTree: 220, detailFiles: null, detailInfo: null, paneHistory: 320, autoSave: true };

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
    /* Can't save: valid for this session only */
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

/** Write the theme on the root element: removed for auto, leaving it to the system */
export function applyTheme() {
  if (typeof document === "undefined") return;
  const r = document.documentElement;
  if (current.theme === "auto") delete r.dataset.theme;
  else r.dataset.theme = current.theme;
}
applyTheme();

// ---------- Recently opened repositories ----------

export interface RecentRepo {
  path: string;
  name: string;
  /** Last opened time (Unix seconds) */
  opened: number;
  /** Pinned to the top of the list */
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
  // Pinned first, the rest by most recently opened; at most 30 unpinned kept
  const pinned = next.filter((r) => r.pinned);
  const rest = next.filter((r) => !r.pinned).sort((a, b) => b.opened - a.opened).slice(0, MAX_REPOS);
  repos = [...pinned.sort((a, b) => a.name.localeCompare(b.name)), ...rest];
  try {
    localStorage.setItem(REPOS, JSON.stringify(repos));
  } catch {
    /* Only for this session */
  }
  repoListeners.forEach((f) => f());
}

export const recentRepos = (): RecentRepo[] => repos;

/** Record it after opening successfully */
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
