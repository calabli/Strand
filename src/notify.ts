// Notification balloons in the bottom-right corner, like an IDE's: a title, a line or two of detail and action links.
// Success and info balloons fade after a few seconds (not while hovered); warnings stay longer; errors stay until
// closed. Every notification is also kept in a history (the last 100) that can be opened from the command palette.

import { useEffect, useState } from "react";

export type NoteKind = "success" | "info" | "warning" | "error";

export interface NoteAction {
  label: string;
  run: () => void;
}

export interface NoteSpec {
  title: string;
  body?: string;
  kind?: NoteKind;
  actions?: NoteAction[];
  /** Stays until closed (default for errors) */
  sticky?: boolean;
}

export interface Note extends NoteSpec {
  id: number;
  kind: NoteKind;
  time: number;
  /** Still shown as a balloon (history keeps closed ones) */
  shown: boolean;
}

let seq = 0;
let notes: Note[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();
const emit = () => listeners.forEach((f) => f());

const LIFE: Record<NoteKind, number> = { success: 5000, info: 5000, warning: 10000, error: 0 };

function schedule(n: Note) {
  window.clearTimeout(timers.get(n.id));
  const life = n.sticky || n.kind === "error" ? 0 : LIFE[n.kind] + (n.actions?.length ? 3000 : 0);
  if (life) timers.set(n.id, window.setTimeout(() => hide(n.id), life));
}

/** Show a balloon; returns its id */
export function notify(spec: NoteSpec): number {
  const n: Note = { ...spec, kind: spec.kind ?? "success", id: ++seq, time: Date.now(), shown: true };
  // The same message again replaces the earlier balloon instead of stacking up
  notes = notes.map((x) => (x.shown && x.title === n.title && x.body === n.body ? { ...x, shown: false } : x));
  notes = [...notes, n].slice(-100);
  // At most 4 balloons at once: the oldest goes to the history
  const shown = notes.filter((x) => x.shown);
  if (shown.length > 4) notes = notes.map((x) => (x.id === shown[0].id ? { ...x, shown: false } : x));
  schedule(n);
  emit();
  return n.id;
}

export function hide(id: number) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  if (!notes.some((n) => n.id === id && n.shown)) return;
  notes = notes.map((n) => (n.id === id ? { ...n, shown: false } : n));
  emit();
}

/** Hovering keeps a balloon open; leaving restarts its timer */
export function hold(id: number, on: boolean) {
  const n = notes.find((x) => x.id === id && x.shown);
  if (!n) return;
  if (on) window.clearTimeout(timers.get(id));
  else schedule(n);
}

export function clearHistory() {
  notes = notes.filter((n) => n.shown);
  emit();
}

export function useNotes(): Note[] {
  const [v, set] = useState(notes);
  useEffect(() => {
    const f = () => set(notes);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return v;
}

// A window with a long text (a hook's full output), opened from a balloon's link
let output: { title: string; text: string } | null = null;
const outListeners = new Set<() => void>();
export function showOutput(title: string, text: string) {
  output = { title, text };
  outListeners.forEach((f) => f());
}
export function closeOutput() {
  output = null;
  outListeners.forEach((f) => f());
}
export function useOutput() {
  const [v, set] = useState(output);
  useEffect(() => {
    const f = () => set(output);
    outListeners.add(f);
    return () => {
      outListeners.delete(f);
    };
  }, []);
  return v;
}
