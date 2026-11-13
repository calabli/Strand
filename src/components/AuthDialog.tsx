// 需要输入凭据时的输入框（说明书 7.5）：git 或 ssh 要用户名、密码、密钥口令时，核心层发出 auth_required，
// 这里弹出输入框，回答只交给发起请求的那一次 Git 操作，Strand 不保存。点取消或 Esc 等于不输入，操作按取消处理。
// 同时可能有多个请求（先问用户名再问密码），按顺序一个个问。

import { useReturnFocus } from "./focus";
import { useEffect, useRef, useState } from "react";
import { api, onAuthEvents, type AuthRequest } from "../api/commands";
import { t } from "../i18n";

/** 按提示原文判断要什么：用户名、密码、SSH 密钥口令，或其他（如确认主机指纹） */
function describe(prompt: string): { title: string; where: string } {
  const quoted = prompt.match(/'([^']+)'/)?.[1] ?? "";
  // https://linxia@github.com → github.com
  const host = quoted.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]*@/, "").replace(/\/.*$/, "");
  if (/^username/i.test(prompt)) return { title: t("需要用户名"), where: host };
  if (/^password/i.test(prompt)) return { title: t("需要密码"), where: host };
  if (/passphrase/i.test(prompt)) return { title: t("需要 SSH 密钥口令"), where: quoted.split(/[\\/]/).pop() ?? quoted };
  return { title: t("远程仓库需要你确认"), where: "" };
}

export function AuthDialog() {
  const [queue, setQueue] = useState<AuthRequest[]>([]);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      onAuthEvents(
        (r) => setQueue((q) => [...q, r]),
        // 用户点了停止：收回还没回答的那一个
        (id) => setQueue((q) => q.filter((x) => x.request_id !== id)),
      ),
    [],
  );
  const cur = queue[0];
  useEffect(() => {
    setValue("");
    input.current?.focus();
  }, [cur?.request_id]);
  useReturnFocus(!!cur);
  if (!cur) return null;

  const reply = (secret: string | null) => {
    api.authReply(cur.request_id, secret);
    setQueue((q) => q.slice(1));
  };
  const { title, where } = describe(cur.prompt);
  const other = title === t("远程仓库需要你确认");
  return (
    <div className="modal-back top">
      <div
        className="modal auth"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") reply(null);
          if (e.key === "Enter" && !e.nativeEvent.isComposing) reply(value);
        }}
      >
        <h2>{title}</h2>
        {where && <p className="modal-msg mono">{where}</p>}
        {other && <p className="modal-msg mono small">{cur.prompt}</p>}
        <label className="modal-field">
          <input
            ref={input}
            type={cur.secret ? "password" : "text"}
            value={value}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={title}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <p className="dim small">{t("只交给这一次 Git 操作，Strand 不会保存。想以后不再输入，可以配置 SSH 密钥或凭据助手。")}</p>
        <div className="modal-btns">
          <button type="button" className="btn" onClick={() => reply(null)}>
            {t("取消")}
          </button>
          <button type="button" className="btn primary" onClick={() => reply(value)}>
            {t("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
