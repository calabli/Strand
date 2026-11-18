// Git hooks of the repository (repository menu and command palette): which hooks there are and what each is for,
// the script in the code editor (save, switch off / on), and trying a hook now to see its output without committing.

import { lazy, Suspense, useEffect, useState } from "react";
import { api, errOf } from "../api/commands";
import type { HookInfo, HookRun, Hooks } from "../api/types";
import { useReturnFocus } from "./focus";
import { t, tr } from "../i18n";

const CodeEditor = lazy(() => import("./CodeEditor"));

const STATE: Record<HookInfo["state"], () => string> = {
  active: () => t("运行中"),
  disabled: () => t("已停用"),
  sample: () => t("示例"),
  missing: () => t("没有"),
};
/** A file name for syntax colors from the script's interpreter */
const extOf = (h: HookInfo) => ({ node: "js", python: "py", python3: "py", ruby: "rb", perl: "pl", pwsh: "ps1" })[h.interpreter ?? ""] ?? "sh";
const TRY = ["pre-commit", "post-commit", "pre-merge-commit", "post-merge", "pre-auto-gc", "pre-applypatch", "post-applypatch"];
const NEW_SCRIPT = (name: string) => `#!/bin/sh\n# ${name}：${t("返回非 0 时 Git 会停下这次操作")}\n\nexit 0\n`;

export function HooksWindow({ onClose, onToast }: { onClose: () => void; onToast: (text: string) => void }) {
  useReturnFocus();
  const [hooks, setHooks] = useState<Hooks | null>(null);
  const [sel, setSel] = useState("pre-commit");
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<HookRun | null>(null);
  const [rev, setRev] = useState(0);

  const load = () => api.hooksList().then(setHooks, (e) => setError(errOf(e).message));
  useEffect(() => {
    void load();
  }, []);
  const hook = hooks?.hooks.find((h) => h.name === sel) ?? null;

  useEffect(() => {
    if (!hook) return;
    let live = true;
    setText(null);
    setRun(null);
    setError(null);
    api.hookRead(sel).then(
      (s) => {
        if (!live) return;
        const body = s || NEW_SCRIPT(sel);
        // A new hook's template isn't an edit yet
        setOrig(body);
        setText(body);
        setRev((r) => r + 1);
      },
      (e) => live && setError(errOf(e).message),
    );
    return () => {
      live = false;
    };
    // Re-read when switching hooks, not when the list refreshes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, !!hook]);

  const dirty = text !== null && text !== orig;
  const pick = (name: string) => {
    if (busy || name === sel) return;
    if (dirty) return setError(t("{0} 有没保存的修改，先保存再换别的钩子", sel));
    setSel(name);
  };
  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await load();
      onToast(done);
    } catch (e) {
      setError(errOf(e).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => text !== null && act(async () => (await api.hookWrite(sel, text), setOrig(text)), t("已保存 {0} 钩子", sel));
  // A missing hook is saved from its template even before any edit
  const canSave = dirty || hook?.state === "missing";
  const toggle = (on: boolean) => act(() => api.hookEnable(sel, on), on ? t("已启用 {0} 钩子", sel) : t("已停用 {0} 钩子（改名为 {0}.disabled）", sel));
  const tryIt = async () => {
    setBusy(true);
    setRun(null);
    setError(null);
    try {
      setRun(await api.hookTry(sel));
    } catch (e) {
      setError(errOf(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal hooks-win" role="dialog" aria-modal="true" aria-label={t("Git 钩子")} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <div className="hooks-head">
          <h2>{t("Git 钩子")}</h2>
          {hooks && <span className="dim small mono hooks-dir" title={hooks.dir}>{hooks.dir}</span>}
          <span className="grow" />
          <button type="button" className="ib" title={t("关闭（Esc）")} aria-label={t("关闭")} onClick={onClose}>
            ×
          </button>
        </div>
        {hooks?.manager && (
          <p className="hooks-note small">
            {t("这些钩子看起来由 {0} 管理{1}。在这里改的内容，可能在重新安装依赖时被它覆盖，长期的改动请改它的配置。", hooks.manager, hooks.hooks_path ? t("（core.hooksPath = {0}）", hooks.hooks_path) : "")}
          </p>
        )}
        <div className="hooks-body">
          <ul className="hooks-list" role="listbox" aria-label={t("钩子")}>
            {hooks?.hooks.map((h) => (
              <li
                key={h.name}
                role="option"
                aria-selected={h.name === sel}
                tabIndex={0}
                className={"hooks-row" + (h.name === sel ? " on" : "")}
                onClick={() => pick(h.name)}
                onKeyDown={(e) => e.key === "Enter" && pick(h.name)}
              >
                <span className="mono">{h.name}</span>
                <span className={"hook-state " + h.state}>{STATE[h.state]()}</span>
              </li>
            ))}
          </ul>
          <div className="hooks-main">
            {hook && (
              <>
                <p className="hooks-desc">{tr(hook.description)}</p>
                {hook.not_executable && <p className="err small">{t("这个文件没有可执行权限，Git 会跳过它。保存或启用一次就会加上。")}</p>}
                {hook.state === "sample" && <p className="dim small">{t("这是 Git 自带的示例，还没生效。点“启用”会复制一份生效。")}</p>}
                {hook.state === "missing" && <p className="dim small">{t("还没有这个钩子。写好脚本后点“保存”就会生效。")}</p>}
                <div className="hooks-editor">
                  {text !== null && (
                    <Suspense fallback={<p className="dim pad">{t("正在打开编辑器…")}</p>}>
                      <CodeEditor
                        key={sel + rev}
                        path={`${sel}.${extOf(hook)}`}
                        value={text}
                        indent="  "
                        label={t("编辑 {0}", sel)}
                        onChange={setText}
                        onSave={() => void save()}
                      />
                    </Suspense>
                  )}
                </div>
                {run && (
                  <div className={"hooks-run " + (run.ok ? "ok" : "bad")}>
                    <div className="small">{run.ok ? t("试运行通过（退出码 0）") : t("试运行失败：提交会被它拦下")}</div>
                    {run.output.trim() && <pre className="out-text mono">{run.output}</pre>}
                  </div>
                )}
                {error && <p className="err small">{tr(error)}</p>}
                <div className="hooks-btns">
                  {hook.state === "active" ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => void toggle(false)}>
                      {t("停用")}
                    </button>
                  ) : (
                    (hook.state === "disabled" || hook.state === "sample") && (
                      <button type="button" className="btn" disabled={busy} onClick={() => void toggle(true)}>
                        {t("启用")}
                      </button>
                    )
                  )}
                  {TRY.includes(hook.name) && hook.state === "active" && (
                    <button type="button" className="btn" disabled={busy || dirty} title={dirty ? t("先保存再试运行") : t("现在运行一次，看输出，不会提交")} onClick={() => void tryIt()}>
                      {busy && !run ? t("正在运行…") : t("试运行")}
                    </button>
                  )}
                  <span className="grow" />
                  <button type="button" className="btn primary" disabled={busy || !canSave} onClick={() => void save()}>
                    {t("保存")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
