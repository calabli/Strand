// Worktree files with unsaved edits in an editor (file tabs or the diff's edit dialog), so closing a tab, switching
// repositories or closing the window can ask first.

import { useEffect, useState } from "react";

const dirty = new Set<string>();
const listeners = new Set<() => void>();

export function setDirty(path: string, on: boolean) {
  if (dirty.has(path) === on) return;
  if (on) dirty.add(path);
  else dirty.delete(path);
  listeners.forEach((f) => f());
}

export const dirtyPaths = () => [...dirty];
export const isDirty = (path: string) => dirty.has(path);

/** Re-render when the set changes; returns the paths with unsaved edits */
export function useDirty(): string[] {
  const [v, set] = useState(dirtyPaths);
  useEffect(() => {
    const f = () => set(dirtyPaths());
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return v;
}
