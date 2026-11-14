// The input box for credentials (spec §7.5): when git or ssh needs a username, password or key passphrase, the core layer emits auth_required,
// and this shows an input box; the answer only goes to the Git operation that asked, and Strand doesn't store it. Cancel or Esc means no input, and the operation is cancelled.
// Several requests may come at once (username, then password); they're asked one at a time in order.

import { useReturnFocus } from "./focus";
import { useEffect, useRef, useState } from "react";
import { api, onAuthEvents, type AuthRequest } from "../api/commands";
import { t } from "../i18n";

/** Work out what's wanted from the prompt text: username, password, SSH key passphrase, or other (e.g. confirming a host fingerprint) */
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
        // The user pressed stop: withdraw the one not yet answered
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
