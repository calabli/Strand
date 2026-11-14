// Edit a worktree file directly in the diff: load the current content into the editor; on save the core layer checks the file on disk wasn't changed elsewhere before writing it back.
// Opens at the change being viewed; ⌘S saves, Esc closes (asking first if there are unsaved edits). Tab inserts a tab or spaces following this file's indentation.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import { indentUnit } from "./inlineDiff";
import { t, tr } from "../i18n";

const LH = 20;

interface Props {
  path: string;
  /** Put the cursor on this line when opening (1-based) */
  line?: number;
  onClose: () => void;
  /** After a successful save (re-read the diff, refresh status) */
  onSaved: () => void;
}

export function EditFile({ path, line, onClose, onSaved }: Props) {
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

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

  // Once the content is loaded, put the cursor on the target line and scroll it to the upper third
  useEffect(() => {
    const el = area.current;
    if (orig == null || !el) return;
    const n = Math.max(1, line ?? 1);
    let at = 0;
    for (let i = 1; i < n && at >= 0; i++) at = text.indexOf("\n", at) + 1 || -1;
    if (at < 0) at = 0;
    el.focus();
    el.setSelectionRange(at, at);
    el.scrollTop = Math.max(0, (n - 1) * LH - el.clientHeight / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orig]);

  const dirty = orig != null && text !== orig.replace(/\r\n/g, "\n");
  const lines = useMemo(() => text.split("\n").length, [text]);
  const indent = useMemo(() => {
    if (orig == null) return "    ";
    const ls = orig.split("\n").slice(0, 2000);
    const tabs = ls.filter((l) => l.startsWith("\t")).length;
    const spaces = ls.filter((l) => l.startsWith(" ")).length;
    return tabs > spaces ? "\t" : " ".repeat(indentUnit(ls));
  }, [orig]);

  const save = async () => {
    if (orig == null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveWorktreeFile(path, text, orig);
      onSaved();
      onClose();
    } catch (e) {
      setError(errOf(e).message);
      setBusy(false);
    }
  };
  const close = () => (dirty ? setAsking(true) : onClose());
  const keepEditing = () => {
    setAsking(false);
    area.current?.focus();
  };

  // ⌘S save, Esc close: attached to the window (works even when focus isn't in the editor)
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (asking) keepEditing();
      else close();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", f, true);
    return () => window.removeEventListener("keydown", f, true);
  }, []);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal blame editf"
        role="dialog"
        aria-modal="true"
        aria-label={t("编辑 {0}", path)}
      >
        <div className="blame-head">
          <h2>{t("编辑")}</h2>
          <span className="mono">{path}</span>
          <span className="dim">{t("工作区")}</span>
          {dirty && <span className="editf-dirty">{t("未保存")}</span>}
          <span className="grow" />
          <span className="dim small">{t("{0} 行", lines)}</span>
          <button type="button" className="btn primary" onClick={save} disabled={!dirty || busy} title={t("保存（⌘S）")}>
            {busy ? t("正在保存…") : t("保存")}
          </button>
          <button type="button" className="ib" title={t("关闭（Esc）")} aria-label={t("关闭")} onClick={close}>
            ×
          </button>
        </div>
        {asking && (
          <div className="editf-ask">
            <span>{t("有没保存的修改，放弃吗？")}</span>
            <span className="grow" />
            <button type="button" className="btn" onClick={keepEditing} autoFocus>
              {t("继续编辑")}
            </button>
            <button type="button" className="btn danger" onClick={onClose}>
              {t("放弃修改")}
            </button>
          </div>
        )}
        {error && <p className="err pad">{tr(error)}</p>}
        {orig == null && !error && <p className="dim pad">{t("正在读取…")}</p>}
        {orig != null && (
          <div className="editf-body mono">
            <div className="editf-ln dim" ref={gutter} aria-hidden="true">
              {Array.from({ length: lines }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={area}
              value={text}
              wrap="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={t("文件内容")}
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
              onKeyDown={(e) => {
                // Tab inserts indentation (via insertText so undo still works)
                if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  document.execCommand("insertText", false, indent);
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
