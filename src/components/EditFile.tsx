// Edit a worktree file: in a file tab (FileEditor, in place of the text) or from a diff (EditFile, a dialog around it).
// The current content is loaded into the code editor; on save the core layer checks the file on disk wasn't changed
// elsewhere before writing it back (keeping CRLF line endings). ⌘S saves; closing with unsaved edits asks first.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import { indentUnit } from "./inlineDiff";
import { setDirty } from "../editState";
import { hintOf, useKeymap } from "../keymap";
import { setSettings, useSettings, type MarkdownMode } from "../settings";
import { t, tr } from "../i18n";
import { previewProviders } from "./Preview";
import type { RollbackControls, RollbackLine } from "./lineRollback";

const CodeEditor = lazy(() => import("./CodeEditor"));

const MARKDOWN_MODES: readonly MarkdownMode[] = ["inline", "split", "source"];
const markdownModeLabel = (mode: MarkdownMode) => mode === "inline" ? t("行内排版") : mode === "split" ? t("并排预览") : t("原文");

/** Follow either live pane without feeding programmatic scroll events back into the other one. */
function useLinkedScroll(host: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const root = host.current;
    if (!root || !enabled) return;
    const expected = new WeakMap<HTMLElement, number>();
    let frame = 0;
    const scroll = (event: Event) => {
      const origin = event.target;
      if (!(origin instanceof HTMLElement)) return;
      const targetSelector = origin.matches(".cm-scroller") ? ".md-body" : origin.matches(".md-body") ? ".cm-scroller" : null;
      if (!targetSelector) return;
      const previous = expected.get(origin);
      expected.delete(origin);
      if (previous !== undefined && Math.abs(previous - origin.scrollTop) <= 1) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = root.querySelector<HTMLElement>(targetSelector);
        const length = origin.scrollHeight - origin.clientHeight;
        if (!target || length <= 0) return;
        const fraction = Math.max(0, Math.min(1, origin.scrollTop / length));
        const next = fraction * Math.max(0, target.scrollHeight - target.clientHeight);
        if (Math.abs(next - target.scrollTop) <= 1) return;
        target.scrollTop = next;
        expected.set(target, target.scrollTop);
      });
    };
    root.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener("scroll", scroll, true);
      cancelAnimationFrame(frame);
    };
  }, [host, enabled]);
}

interface Props {
  path: string;
  /** Put the cursor on this line when opening (1-based) */
  line?: number;
  /** Leave the editor (after asking when there are unsaved edits) */
  onClose: () => void;
  /** After a successful save (re-read the text or diff, refresh status) */
  onSaved: () => void;
  /** Saving closes the editor (the diff dialog); in a file tab editing goes on after saving */
  closeOnSave?: boolean;
  /** Move to a line when n changes (a jump into this file while editing) */
  goto?: { line: number; n: number } | null;
  rollback?: RollbackControls;
  worktreeRead?: number | null;
}

export function FileEditor({ path, line, onClose, onSaved, closeOnSave, goto, rollback, worktreeRead }: Props) {
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pastingImages, setPastingImages] = useState(0);
  const [diskEdit, setDiskEdit] = useState<{ from: string; to: string } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [asking, setAsking] = useState(false);
  const [savedNote, setSavedNote] = useState<"saved" | "auto" | null>(null);
  /** Auto-save failed (the file changed on disk, or can't be written): wait for a manual save */
  const [autoOff, setAutoOff] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const baseline = useRef<string | null>(null);
  const draft = useRef("");
  const saving = useRef<Promise<boolean> | null>(null);
  const rollbackPending = useRef(false);
  const editor = previewProviders.find((provider) => provider.editor && provider.matches({ path, file: null }))?.editor;
  const { autoSave, markdownMode, markdownSyncScroll } = useSettings();
  const md = editor?.markdown ? (MARKDOWN_MODES.includes(markdownMode) ? markdownMode : "split") : undefined;
  const split = !!editor && (md === "split" || md == null);
  useLinkedScroll(body, !!md && split && markdownSyncScroll && orig != null);
  useKeymap();

  useEffect(() => {
    let live = true;
    api.fileText(path, null).then(
      (f) => {
        if (!live) return;
        if (f.binary || f.missing || f.truncated || f.text == null)
          setError(f.missing ? t("工作区里没有这个文件") : f.binary ? t("二进制文件不能编辑") : t("文件太大，不能在这里编辑"));
        else {
          baseline.current = f.text;
          draft.current = f.text.replace(/\r\n/g, "\n");
          setOrig(f.text);
          setText(draft.current);
        }
      },
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const adoptDiskText = (text: string) => {
    baseline.current = text;
    draft.current = text.replace(/\r\n/g, "\n");
    setOrig(text);
    setText(draft.current);
    return draft.current;
  };

  // When the timeline undoes a rollback, refresh a clean editor without replacing any unsaved draft.
  useEffect(() => {
    const prior = baseline.current;
    const before = draft.current;
    if (worktreeRead == null || prior == null || before !== prior.replace(/\r\n/g, "\n") || saving.current || rollbackPending.current) return;
    let live = true;
    api.fileText(path, null).then((f) => {
      if (!live || saving.current || rollbackPending.current || draft.current !== before || baseline.current !== prior || f.text == null || f.truncated || f.lfs_missing) return;
      if (f.text !== prior) setDiskEdit({ from: before, to: adoptDiskText(f.text) });
    }, () => {});
    return () => { live = false; };
  }, [path, worktreeRead]);

  const base = orig?.replace(/\r\n/g, "\n") ?? "";
  const dirty = orig != null && text !== base;
  useEffect(() => {
    setDirty(path, dirty || pastingImages > 0);
  }, [path, dirty, pastingImages]);
  useEffect(() => () => setDirty(path, false), [path]);

  const lines = useMemo(() => text.split("\n").length, [text]);
  const indent = useMemo(() => {
    if (orig == null) return "    ";
    const ls = orig.split("\n").slice(0, 2000);
    const tabs = ls.filter((l) => l.startsWith("\t")).length;
    const spaces = ls.filter((l) => l.startsWith(" ")).length;
    return tabs > spaces ? "\t" : " ".repeat(indentUnit(ls));
  }, [orig]);

  /** Save what's in the editor now; auto when triggered by auto-save (stays in the editor, stops auto-saving on failure) */
  const save = async (auto = false): Promise<boolean> => {
    while (saving.current) if (!(await saving.current)) return false;
    const original = baseline.current;
    if (original == null) return false;
    const snapshot = draft.current;
    if (snapshot === original.replace(/\r\n/g, "\n")) return true;
    setBusy(true);
    setError(null);
    const task = Promise.resolve().then(async () => {
      try {
        await api.saveWorktreeFile(path, snapshot, original);
        baseline.current = original.includes("\r\n") ? snapshot.replace(/\n/g, "\r\n") : snapshot;
        setOrig(baseline.current);
        setAutoOff(false);
        setSavedNote(auto ? "auto" : "saved");
        onSaved();
        return true;
      } catch (e) {
        setError(errOf(e).message);
        if (auto) setAutoOff(true);
        return false;
      } finally {
        saving.current = null;
        setBusy(false);
      }
    });
    saving.current = task;
    const ok = await task;
    if (ok && closeOnSave && !auto && draft.current === snapshot) onClose();
    return ok;
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const auto = autoSave && !autoOff;
  // Auto-save a second after typing stops (again after a save if more was typed meanwhile)
  useEffect(() => {
    if (!auto || !dirty || busy) return;
    const id = window.setTimeout(() => void saveRef.current(true), 1000);
    return () => window.clearTimeout(id);
  }, [auto, dirty, busy, text]);
  useEffect(() => {
    if (!savedNote) return;
    const id = window.setTimeout(() => setSavedNote(null), 1500);
    return () => window.clearTimeout(id);
  }, [savedNote]);
  // Leaving: with auto-save, save first (ask only if that fails); without it, ask about unsaved edits
  const close = () => {
    if (pastingImages > 0 || rollbackPending.current) return;
    if (!dirty && !saving.current) return onClose();
    if (auto || !dirty) void save(true).then((ok) => {
      if (!ok) setAsking(true);
      else if (draft.current === baseline.current?.replace(/\r\n/g, "\n")) onClose();
    });
    else setAsking(true);
  };

  const rollbackFromEditor = async (row: RollbackLine) => {
    const prior = baseline.current;
    if (!rollback || rollbackPending.current || saving.current || prior == null || draft.current !== prior.replace(/\r\n/g, "\n")) return null;
    rollbackPending.current = true;
    setRollingBack(true);
    try {
      const updated = await rollback.apply(row);
      if (updated === null) return null;
      const text = adoptDiskText(updated);
      onSaved();
      return text;
    } finally {
      rollbackPending.current = false;
      setRollingBack(false);
    }
  };

  return (
    <div className="editf-wrap">
      <div className="editf-bar">
        {rollingBack ? (
          <span className="dim small" role="status">{t("正在回退这一行…")}</span>
        ) : pastingImages > 0 ? (
          <span className="editf-dirty" role="status">{t("正在保存粘贴的图片…")}</span>
        ) : dirty ? (
          <span className="editf-dirty">{auto ? t("等待自动保存") : t("未保存")}</span>
        ) : savedNote ? (
          <span className="dim small">{savedNote === "auto" ? t("已自动保存") : t("已保存")}</span>
        ) : (
          <span className="dim small">{auto ? t("自动保存") : t("工作区")}</span>
        )}
        {md && orig != null && <>
          <span className="seg md-modes" role="group" aria-label={t("Markdown 编辑模式")}>
            {MARKDOWN_MODES.map((mode) => <button key={mode} type="button" aria-pressed={md === mode} className={md === mode ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => setSettings({ markdownMode: mode })}>{markdownModeLabel(mode)}</button>)}
          </span>
          {split && <button type="button" className={"ib sm md-sync" + (markdownSyncScroll ? " pressed" : "")} title={t("同步滚动")} aria-label={t("同步滚动")} aria-pressed={markdownSyncScroll} onClick={() => setSettings({ markdownSyncScroll: !markdownSyncScroll })}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12V2L1.5 4.5M4 2l2.5 2.5M10 2v10l-2.5-2.5M10 12l2.5-2.5" /></svg>
          </button>}
        </>}
        <span className="grow" />
        <span className="dim small editf-lines">{t("{0} 行", lines)}</span>
        <button type="button" className="btn sm primary" onClick={() => void save()} disabled={!dirty || busy || pastingImages > 0} title={t("保存（{0}）", hintOf("save"))}>
          {busy ? t("正在保存…") : t("保存")}
        </button>
        <button type="button" className="btn sm" disabled={pastingImages > 0 || rollingBack} onClick={close} title={t("结束编辑（Esc）")}>
          {t("结束编辑")}
        </button>
      </div>
      {asking && (
        <div className="editf-ask" role="alert">
          <span>{t("有没保存的修改，放弃吗？")}</span>
          <span className="grow" />
          <button type="button" className="btn sm" onClick={() => setAsking(false)} autoFocus>
            {t("继续编辑")}
          </button>
          <button type="button" className="btn sm danger" onClick={() => (setDirty(path, false), onClose())}>
            {t("放弃修改")}
          </button>
        </div>
      )}
      {error && <p className="err pad">{tr(error)}</p>}
      {orig == null && !error && <p className="dim pad">{t("正在读取…")}</p>}
      {orig != null && (
        <div ref={body} className={"editf-body" + (split ? " editf-split" : "")}>
          <Suspense fallback={<p className="dim pad">{t("正在打开编辑器…")}</p>}>
            <CodeEditor
              path={path}
              value={base}
              line={line}
              goto={goto}
              indent={indent}
              label={t("编辑 {0}", path)}
              onChange={(value) => { draft.current = value; setText(value); }}
              onSave={() => { if (!pastingImages) void save(); }}
              onBlur={() => auto && dirty && void saveRef.current(true)}
              onEscape={() => (close(), true)}
              actions={editor?.actions}
              wrap={editor?.wrap}
              markdownMode={md}
              onImageImporting={(change) => setPastingImages((n) => n + change)}
              rollback={!dirty && !busy && pastingImages === 0 ? rollback : undefined}
              onRollback={rollbackFromEditor}
              diskEdit={diskEdit}
            />
          </Suspense>
          {editor && split && <section className="editf-preview" aria-label={t("实时预览")}><editor.View path={path} text={text} /></section>}
        </div>
      )}
    </div>
  );
}

/** Editing from a diff: the editor in a dialog; closes after saving */
export function EditFile(props: Omit<Props, "closeOnSave">) {
  return (
    <div className="modal-back">
      <div className="modal blame editf" role="dialog" aria-modal="true" aria-label={t("编辑 {0}", props.path)}>
        <div className="blame-head">
          <h2>{t("编辑")}</h2>
          <span className="mono">{props.path}</span>
        </div>
        <FileEditor {...props} closeOnSave />
      </div>
    </div>
  );
}
