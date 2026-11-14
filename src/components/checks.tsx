// Format and check before committing (spec §4.4, §4.6).
// - ChecksOptions: the panel opened by the "commit options" icon in the message tool row: two toggles, two commands, the sign-off toggle.
//   Commands and toggles are stored in the repository's Git config (strand.formatCommand etc.); sign-off is a global setting.
// - ChecksReport: the issue list when formatting or checks fail; the user chooses to commit anyway or cancel.

import { useReturnFocus } from "./focus";
import { useEffect, useState } from "react";
import type { CheckRun, ChecksConfig, ChecksInfo } from "../api/types";
import { setSettings, useSettings } from "../settings";
import { t } from "../i18n";

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function ChecksOptions({ info, onSave, onRunNow, running }: { info: ChecksInfo | null; onSave: (c: ChecksConfig) => Promise<void>; onRunNow: () => void; running: boolean }) {
  const s = useSettings();
  const [fmt, setFmt] = useState(info?.format_command ?? "");
  const [chk, setChk] = useState(info?.check_command ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setFmt(info?.format_command ?? "");
    setChk(info?.check_command ?? "");
  }, [info?.format_command, info?.check_command]);
  if (!info) return <div className="cp-options dim small pad">{t("正在读取…")}</div>;

  const save = (patch: Partial<ChecksConfig>) => {
    const next: ChecksConfig = {
      format_command: fmt,
      check_command: chk,
      format_on_commit: info.format_on_commit,
      check_on_commit: info.check_on_commit,
      ...patch,
    };
    setErr(null);
    onSave(next).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const cmdRow = (value: string, set: (v: string) => void, key: "format_command" | "check_command", suggest: string[], label: string) => (
    <div className="cpo-cmd">
      <input
        className="mono"
        value={value}
        aria-label={label}
        placeholder={suggest[0] ?? (key === "format_command" ? "prettier -w {files}" : "eslint {files}")}
        spellCheck={false}
        onChange={(e) => set(e.target.value)}
        onBlur={() => value !== info[key] && save({ [key]: value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suggest
        .filter((x) => x !== value)
        .slice(0, 3)
        .map((x) => (
          <button
            key={x}
            type="button"
            className="cpo-sug mono"
            title={t("用这条命令")}
            onClick={() => {
              set(x);
              save({ [key]: x });
            }}
          >
            {x}
          </button>
        ))}
    </div>
  );

  return (
    <div className="cp-options" role="group" aria-label={t("提交选项")}>
      <div className="cpo-row">
        <span>{t("提交前格式化")}</span>
        <Switch on={info.format_on_commit} label={t("提交前格式化")} onChange={(v) => save({ format_on_commit: v })} />
      </div>
      {cmdRow(fmt, setFmt, "format_command", info.suggest_format, t("格式化命令"))}
      <div className="cpo-row">
        <span>{t("提交前运行检查")}</span>
        <Switch on={info.check_on_commit} label={t("提交前运行检查")} onChange={(v) => save({ check_on_commit: v })} />
      </div>
      {cmdRow(chk, setChk, "check_command", info.suggest_check, t("检查命令"))}
      <div className="cpo-row">
        <span>{t("加签名行")}</span>
        <Switch on={s.signOff} label={t("加签名行")} onChange={(v) => setSettings({ signOff: v })} />
      </div>
      <p className="dim small cpo-hint">{t("{files} 换成要提交的文件。命令存在这个仓库的 Git 配置里（strand.checkCommand 等）；签名行对所有仓库生效。")}</p>
      {err && <p className="err small">{err}</p>}
      <div className="cpo-foot">
        <button type="button" className="btn sm" onClick={onRunNow} disabled={running || !info.check_command.trim()} title={info.check_command.trim() ? t("对勾选的文件运行检查命令") : t("先填写检查命令")}>
          {running ? t("正在检查…") : t("现在检查")}
        </button>
      </div>
    </div>
  );
}

/** Title of one run */
export function runTitle(r: CheckRun) {
  if (r.timed_out) return r.kind === "format" ? t("格式化超时（5 分钟）") : t("检查超时（5 分钟）");
  if (r.ok) return r.kind === "format" ? t("格式化完成") : t("检查通过");
  return r.kind === "format" ? t("格式化没有成功") : t("检查没有通过");
}

export function ChecksReport({
  run,
  canCommit,
  onCommit,
  onCancel,
  onOpen,
}: {
  run: CheckRun;
  /** Run before committing: shows "commit anyway" */
  canCommit: boolean;
  onCommit: () => void;
  onCancel: () => void;
  /** Open the file's diff */
  onOpen: (path: string) => void;
}) {
  useReturnFocus();
  const errors = run.issues.filter((i) => i.level === "error").length;
  const warnings = run.issues.filter((i) => i.level === "warning").length;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal checks-report" role="dialog" aria-modal="true" aria-label={runTitle(run)} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h2>{runTitle(run)}</h2>
        <p className="dim small">
          <span className="mono">{run.command}</span>
          {" · "}
          {run.code != null ? t("退出码 {0}", run.code) : ""}
          {run.code != null ? " · " : ""}
          {t("{0} 秒", (run.ms / 1000).toFixed(1))}
          {run.issues.length > 0 && ` · ${t("{0} 个错误，{1} 个警告", errors, warnings)}`}
        </p>
        {run.issues.length > 0 && (
          <div className="ck-issues">
            {run.issues.map((i, k) => (
              <button key={k} type="button" className={"ck-issue " + (i.level || "note")} title={t("打开 {0} 的差异", i.path)} onClick={() => onOpen(i.path)}>
                <span className="ck-lv">{i.level === "error" ? "✕" : i.level === "warning" ? "!" : "·"}</span>
                <span className="mono ck-at">
                  {i.path}
                  {i.line ? `:${i.line}` : ""}
                  {i.col ? `:${i.col}` : ""}
                </span>
                <span className="ck-msg">{i.message}</span>
              </button>
            ))}
          </div>
        )}
        {run.changed.length > 0 && <p className="small">{t("格式化改动了 {0} 个文件：{1}", run.changed.length, run.changed.join("、"))}</p>}
        {run.output.trim() && (
          <details className="ck-out" open={run.issues.length === 0}>
            <summary className="dim small">{run.truncated ? t("完整输出（只保留前 64 KB）") : t("完整输出")}</summary>
            <pre className="mono">{run.output}</pre>
          </details>
        )}
        {!run.output.trim() && run.issues.length === 0 && <p className="dim small">{t("命令没有输出")}</p>}
        <div className="modal-btns">
          <button type="button" className="btn" onClick={onCancel} autoFocus>
            {canCommit ? t("取消提交") : t("关闭")}
          </button>
          {canCommit && (
            <button type="button" className="btn primary" onClick={onCommit}>
              {t("仍然提交")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
