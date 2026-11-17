// Edit a worktree file: in a file tab (FileEditor, in place of the text) or from a diff (EditFile, a dialog around it).
// The current content is loaded into the code editor; on save the core layer checks the file on disk wasn't changed
// elsewhere before writing it back (keeping CRLF line endings). ⌘S saves; closing with unsaved edits asks first.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import { indentUnit } from "./inlineDiff";
import { setDirty } from "../editState";
import { hintOf, useKeymap } from "../keymap";
import { useSettings } from "../settings";
import { t, tr } from "../i18n";

const CodeEditor = lazy(() => import("./CodeEditor"));

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
}

export function FileEditor({ path, line, onClose, onSaved, closeOnSave }: Props) {
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [savedNote, setSavedNote] = useState<"saved" | "auto" | null>(null);
  /** Auto-save failed (the file changed on disk, or can't be written): wait for a manual save */
  const [autoOff, setAutoOff] = useState(false);
  const { autoSave } = useSettings();
  useKeymap();

  useEffect(() => {
    let live = true;
    api.fileText(path, null).then(
      (f) => {
        if (!live) return;
        if (f.binary || f.missing || f.truncated || f.text == null)
          setError(f.missing ? t("工作区里没有这个文件") : f.binary ? t("二进制文件不能编辑") : t("文件太大，不能在这里编辑"));
        else {
          setOrig(f.text);
          setText(f.text.replace(/\r\n/g, "\n"));
        }
      },
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const base = orig?.replace(/\r\n/g, "\n") ?? "";
  const dirty = orig != null && text !== base;
  useEffect(() => {
    setDirty(path, dirty);
  }, [path, dirty]);
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
    if (orig == null || busy || !dirty) return !dirty;
    const snapshot = text;
    setBusy(true);
    setError(null);
    try {
      await api.saveWorktreeFile(path, snapshot, orig);
      // What's on disk now: the saved text (the core keeps CRLF when the file used it)
      setOrig(orig.includes("\r\n") ? snapshot.replace(/\n/g, "\r\n") : snapshot);
      setBusy(false);
      setAutoOff(false);
      setSavedNote(auto ? "auto" : "saved");
      onSaved();
      if (closeOnSave && !auto) onClose();
      return true;
    } catch (e) {
      setError(errOf(e).message);
      setBusy(false);
      if (auto) setAutoOff(true);
      return false;
    }
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
    if (!dirty) return onClose();
    if (auto) void save(true).then((ok) => (ok ? onClose() : setAsking(true)));
    else setAsking(true);
  };

  return (
    <div className="editf-wrap">
      <div className="editf-bar">
        {dirty ? (
          <span className="editf-dirty">{auto ? t("等待自动保存") : t("未保存")}</span>
        ) : savedNote ? (
          <span className="dim small">{savedNote === "auto" ? t("已自动保存") : t("已保存")}</span>
        ) : (
          <span className="dim small">{auto ? t("自动保存") : t("工作区")}</span>
        )}
        <span className="grow" />
        <span className="dim small">{t("{0} 行", lines)}</span>
        <button type="button" className="btn sm primary" onClick={() => void save()} disabled={!dirty || busy} title={t("保存（{0}）", hintOf("save"))}>
          {busy ? t("正在保存…") : t("保存")}
        </button>
        <button type="button" className="btn sm" onClick={close} title={t("结束编辑（Esc）")}>
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
        <div className="editf-body">
          <Suspense fallback={<p className="dim pad">{t("正在打开编辑器…")}</p>}>
            <CodeEditor
              path={path}
              value={base}
              line={line}
              indent={indent}
              label={t("编辑 {0}", path)}
              onChange={setText}
              onSave={() => void save()}
              onBlur={() => auto && dirty && void saveRef.current(true)}
              onEscape={() => (close(), true)}
            />
          </Suspense>
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
