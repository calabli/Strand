// Generic dialog: confirm, enter a name, choose one of two. Per spec §3.4: Enter confirms, Esc cancels;
// when input validation fails (e.g. INVALID_NAME) the error shows below the input and the dialog stays open.

import { useReturnFocus } from "./focus";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, tr } from "../i18n";

export interface DialogSpec {
  title: string;
  message?: string;
  /** Extra information as a list, e.g. conflicted files */
  items?: string[];
  input?: { initial: string; placeholder?: string; label?: string; mono?: boolean; multiline?: boolean };
  /** A second input (multi-line, may be empty), e.g. an annotated tag's message; passed as note in onSubmit's third argument */
  note?: { label: string; placeholder?: string };
  /** Radio options (e.g. reset mode); the selected value is onSubmit's first argument */
  choices?: { value: string; label: string; hint?: string }[];
  initialChoice?: string;
  /** The confirm button turns red when certain options are selected */
  dangerWhen?: (value: string) => boolean;
  confirm: string;
  danger?: boolean;
  /** A second action button, e.g. "stash first, then switch" */
  alt?: string;
  /**
   * Runs on confirm (or the second button). Returning a string means an error: the dialog stays open and shows the text;
   * returning undefined means done and the dialog closes.
   */
  onSubmit: (value: string, alt: boolean, extra: { note: string; choice: string }) => Promise<string | void> | string | void;
}

export function useDialog() {
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const open = useCallback((s: DialogSpec) => setSpec(s), []);
  const el = spec ? <Dialog key={spec.title} spec={spec} onClose={() => setSpec(null)} /> : null;
  return [el, open] as const;
}

function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  useReturnFocus();
  const [value, setValue] = useState(spec.input?.initial ?? spec.initialChoice ?? spec.choices?.[0]?.value ?? "");
  // With both an input and radio options, the option is kept separately
  const [choice, setChoice] = useState(spec.initialChoice ?? spec.choices?.[0]?.value ?? "");
  const [note, setNote] = useState("");
  const both = !!spec.input && !!spec.choices;
  const picked = both ? choice : value;
  const pick = both ? setChoice : setValue;
  const choicesEl = spec.choices && (
          <div className="modal-choices" role="radiogroup">
            {spec.choices.map((c) => (
              <label key={c.value} className={"modal-choice" + (picked === c.value ? " on" : "")}>
                <input type="radio" name="dialog-choice" checked={picked === c.value} onChange={() => pick(c.value)} />
                <span>
                  {c.label}
                  {c.hint && <span className="dim small modal-hint">{c.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (input.current) {
      input.current.focus();
      // When prefilled with feature/, put the cursor at the end so typing continues
      const n = input.current.value.length;
      input.current.setSelectionRange(n, n);
    } else okBtn.current?.focus();
  }, []);

  const submit = async (alt: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await spec.onSubmit(spec.input?.multiline ? value.trimEnd() : value.trim(), alt, { note: note.trim(), choice: picked });
      if (typeof r === "string") setError(r);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          const multi = e.target instanceof HTMLTextAreaElement;
          if (e.key === "Enter" && !e.nativeEvent.isComposing && ((e.target instanceof HTMLInputElement && e.target.type !== "radio") || (multi && (e.metaKey || e.ctrlKey)))) {
            e.preventDefault();
            submit(false);
          }
        }}
      >
        <h2>{tr(spec.title)}</h2>
        {spec.message && <p className="modal-msg">{tr(spec.message)}</p>}
        {spec.items && spec.items.length > 0 && (
          <ul className="modal-items mono">
            {spec.items.slice(0, 12).map((i) => (
              <li key={i}>{i}</li>
            ))}
            {spec.items.length > 12 && <li className="dim">{t("还有 {0} 个", spec.items.length - 12)}</li>}
          </ul>
        )}
        {spec.choices && !both && choicesEl}
        {spec.input?.multiline && (
          <label className="modal-field">
            {spec.input.label && <span className="dim">{spec.input.label}</span>}
            <textarea
              ref={input}
              rows={5}
              value={value}
              placeholder={spec.input.placeholder}
              spellCheck={false}
              aria-invalid={!!error}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            <span className="dim small">{t("⌘↵ 确定")}</span>
          </label>
        )}
        {spec.input && !spec.input.multiline && (
          <label className="modal-field">
            {spec.input.label && <span className="dim">{spec.input.label}</span>}
            <input
              ref={input}
              className={spec.input.mono ? "mono" : ""}
              value={value}
              placeholder={spec.input.placeholder}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={!!error}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
          </label>
        )}
        {spec.note && (
          <label className="modal-field">
            <span className="dim">{spec.note.label}</span>
            <textarea rows={3} value={note} placeholder={spec.note.placeholder} spellCheck={false} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        {spec.choices && both && choicesEl}
        {error && (
          <p className="err modal-err" role="alert">
            {tr(error)}
          </p>
        )}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          {spec.alt && (
            <button type="button" className="btn" onClick={() => submit(true)} disabled={busy}>
              {spec.alt}
            </button>
          )}
          <button
            ref={okBtn}
            type="button"
            className={"btn " + (spec.danger || spec.dangerWhen?.(picked) ? "danger" : "primary")}
            onClick={() => submit(false)}
            disabled={busy || (!!spec.input && !value.trim())}
          >
            {busy ? t("请稍候…") : spec.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
