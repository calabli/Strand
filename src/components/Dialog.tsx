// 通用对话框：确认、输入名字、二选一。按说明书 3.4：回车确认、Esc 取消；
// 输入校验失败（如 INVALID_NAME）时错误显示在输入框下方，对话框不关闭。

import { useReturnFocus } from "./focus";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, tr } from "../i18n";

export interface DialogSpec {
  title: string;
  message?: string;
  /** 列表形式的补充信息，如冲突的文件 */
  items?: string[];
  input?: { initial: string; placeholder?: string; label?: string; mono?: boolean; multiline?: boolean };
  /** 单选项（如重置方式）；选中的 value 作为 onSubmit 的第一个参数 */
  choices?: { value: string; label: string; hint?: string }[];
  initialChoice?: string;
  /** 选中某些项时确认按钮变红 */
  dangerWhen?: (value: string) => boolean;
  confirm: string;
  danger?: boolean;
  /** 第二个操作按钮，如“先贮藏再切换” */
  alt?: string;
  /**
   * 点确认（或第二个按钮）时执行。返回字符串表示出错，对话框不关闭并显示这段文字；
   * 返回 undefined 表示完成，对话框关闭。
   */
  onSubmit: (value: string, alt: boolean) => Promise<string | void> | string | void;
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (input.current) {
      input.current.focus();
      // 预填 feature/ 时光标放在末尾，方便接着输入
      const n = input.current.value.length;
      input.current.setSelectionRange(n, n);
    } else okBtn.current?.focus();
  }, []);

  const submit = async (alt: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await spec.onSubmit(spec.input?.multiline ? value.trimEnd() : value.trim(), alt);
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
        {spec.choices && (
          <div className="modal-choices" role="radiogroup">
            {spec.choices.map((c) => (
              <label key={c.value} className={"modal-choice" + (value === c.value ? " on" : "")}>
                <input type="radio" name="dialog-choice" checked={value === c.value} onChange={() => setValue(c.value)} />
                <span>
                  {c.label}
                  {c.hint && <span className="dim small modal-hint">{c.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
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
            className={"btn " + (spec.danger || spec.dangerWhen?.(value) ? "danger" : "primary")}
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
