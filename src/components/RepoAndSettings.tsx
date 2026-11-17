// Repository list and settings.
// - Repository list: opened from the repository name in the toolbar; lists recently opened repositories (pinned first), with search, switch, pin, remove from list, open another folder.
// - Settings: opened from the toolbar's gear icon or ⌘,; changes apply immediately (language too switches in place without reloading the window).

import { useReturnFocus } from "./focus";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigScope,
  ConfigValue,
  GitInfo,
  SigningConfig,
} from "../api/types";
import { api, errOf } from "../api/commands";
import {
  lang,
  langSetting,
  lazy,
  setLang,
  t,
  tr,
  type LangSetting,
} from "../i18n";
import {
  forgetRepo,
  setSettings,
  togglePin,
  useRecentRepos,
  useSettings,
  type RecentRepo,
  type Settings,
} from "../settings";
import { formatTime } from "./format";
import { ACTIONS, type ActionId, comboFromEvent, comboOf, conflictOf, hintOf, labelOf, resetAll, setCombo, showCombo, usable, useKeymap } from "../keymap";

const isMacOs = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Recently opened repositories (shared by the toolbar popup and the "open a repository" page) */
export function RepoList({
  current,
  onOpen,
  onOpenNew,
  onClose,
  autoFocus = true,
}: {
  current: string | null;
  onOpen: (path: string) => void;
  /** Open in a new window; absent hides the button */
  onOpenNew?: (path: string) => void;
  onClose?: () => void;
  autoFocus?: boolean;
}) {
  const repos = useRecentRepos();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return repos.filter(
      (r) =>
        !f ||
        r.name.toLowerCase().includes(f) ||
        r.path.toLowerCase().includes(f),
    );
  }, [repos, q]);
  useEffect(() => setHi(0), [q]);

  const open = (r: RecentRepo | undefined) => {
    if (!r) return;
    onClose?.();
    if (r.path !== current) onOpen(r.path);
  };

  return (
    <div
      className="repo-list"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHi((h) => Math.min(shown.length - 1, h + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHi((h) => Math.max(0, h - 1));
        } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          open(shown[hi]);
        }
      }}
    >
      {repos.length > 0 && (
        <input
          className="pk-q"
          placeholder={t("搜索仓库")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus={autoFocus}
          spellCheck={false}
        />
      )}
      <div className="repo-rows">
        {shown.map((r, i) => (
          <div
            key={r.path}
            className={
              "repo-row" +
              (i === hi ? " hi" : "") +
              (r.path === current ? " cur" : "")
            }
            onMouseEnter={() => setHi(i)}
          >
            <button
              type="button"
              className="repo-main"
              onClick={() => open(r)}
              title={r.path}
            >
              <span className="repo-name">
                {r.pinned && <span className="star">★ </span>}
                {r.name}
                {r.path === current && (
                  <span className="cur-tag">{t("当前")}</span>
                )}
              </span>
              <span className="repo-path dim" title={r.path}>
                <bdi>{r.path}</bdi>
              </span>
            </button>
            <span className="repo-acts">
              <span className="dim small repo-time">
                {formatTime(r.opened).slice(0, 10)}
              </span>
              {onOpenNew && r.path !== current && (
                <button
                  type="button"
                  className="ib sm"
                  title={t("在新窗口中打开")}
                  aria-label={t("在新窗口中打开 {0}", r.name)}
                  onClick={() => (onClose?.(), onOpenNew(r.path))}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 2h4v4M12 2 6.5 7.5M10 8.5V12H2V4h3.5" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="ib sm"
                title={r.pinned ? t("取消固定") : t("固定在上面")}
                aria-label={r.pinned ? t("取消固定") : t("固定在上面")}
                onClick={() => togglePin(r.path)}
              >
                {r.pinned ? "★" : "☆"}
              </button>
              <button
                type="button"
                className="ib sm"
                title={t("从列表里移除（不删除文件）")}
                aria-label={t("从列表里移除")}
                onClick={() => forgetRepo(r.path)}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        {repos.length > 0 && shown.length === 0 && (
          <p className="dim pad">{t("没有匹配的仓库")}</p>
        )}
      </div>
    </div>
  );
}

/** The repository list popping up under the repository name in the toolbar */
export function RepoPopup({
  x,
  y,
  current,
  onOpen,
  onBrowse,
  onClone,
  onTerminal,
  onReveal,
  onOpenNew,
  onStats,
  onMaintenance,
  onClose,
}: {
  /** Repository maintenance (size, cleanup, rerere) */
  onMaintenance?: () => void;
  /** Contribution statistics of the current repository */
  onStats?: () => void;
  /** Open a repository in a new window */
  onOpenNew?: (path: string) => void;
  x: number;
  y: number;
  current: string | null;
  /** Open a terminal in the current repository's folder */
  onTerminal?: () => void;
  /** Reveal the current repository's folder in the file manager */
  onReveal?: () => void;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClone: () => void;
  onClose: () => void;
}) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r)
      setPos({
        left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
        top: y,
      });
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);
  return (
    <div
      className="picker repo-pop"
      ref={box}
      style={pos}
      role="dialog"
      aria-label={t("仓库")}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <RepoList current={current} onOpen={onOpen} onOpenNew={onOpenNew} onClose={onClose} />
      <button
        type="button"
        className="repo-browse"
        onClick={() => {
          onClose();
          onBrowse();
        }}
      >
        {t("打开其他文件夹…")}
      </button>
      <button
        type="button"
        className="repo-browse"
        onClick={() => {
          onClose();
          onClone();
        }}
      >
        {t("克隆仓库…")}
      </button>
      {(onTerminal || onReveal) && <div className="repo-sep" />}
      {onTerminal && (
        <button
          type="button"
          className="repo-browse"
          onClick={() => {
            onClose();
            onTerminal();
          }}
        >
          {t("在终端中打开")}
        </button>
      )}
      {onReveal && (
        <button
          type="button"
          className="repo-browse"
          onClick={() => {
            onClose();
            onReveal();
          }}
        >
          {t("在文件管理器中显示")}
        </button>
      )}
      {onStats && (
        <button
          type="button"
          className="repo-browse"
          onClick={() => {
            onClose();
            onStats();
          }}
        >
          {t("贡献统计…")}
        </button>
      )}
      {onMaintenance && (
        <button
          type="button"
          className="repo-browse"
          onClick={() => {
            onClose();
            onMaintenance();
          }}
        >
          {t("仓库维护…")}
        </button>
      )}
    </div>
  );
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <span className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? "on" : ""}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={"switch" + (on ? " on" : "")}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}

/** Settings window */
export function SettingsWindow({
  git,
  onClose,
  repoOpen,
  onRemotes,
  section,
  version,
  onCheckUpdate,
}: {
  git: GitInfo | null;
  onClose: () => void;
  repoOpen?: boolean;
  onRemotes?: () => void;
  section?: "git";
  version?: string | null;
  onCheckUpdate?: () => void;
}) {
  useReturnFocus();
  // Closing fades out first (the window unmounts after the animation)
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(onClose, reduce ? 0 : 140);
  };
  // Opened from the commit panel's "set identity": scroll to the Git settings and focus the user name
  const gitSec = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (section !== "git") return;
    const id = window.setTimeout(() => {
      gitSec.current?.scrollIntoView({ block: "start" });
      gitSec.current?.querySelector<HTMLInputElement>("input")?.focus();
    }, 300);
    return () => window.clearTimeout(id);
  }, [section]);
  const s = useSettings();
  // Commit signing for this repository (git config --local commit.gpgSign); hidden when no repository is open
  const [signing, setSigningState] = useState<SigningConfig | null>(repoOpen ? signCache : null);
  const setSigning = (v: SigningConfig | null) => {
    signCache = v;
    setSigningState(v);
  };
  const [signErr, setSignErr] = useState<string | null>(null);
  useEffect(() => {
    if (repoOpen) api.signingConfig().then(setSigning, () => setSigning(null));
  }, [repoOpen]);
  const set = (p: Partial<Settings>) => setSettings(p);
  const [langV, setLangV] = useState<LangSetting>(langSetting());
  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <div className="set-row">
      <div>
        <div>{label}</div>
        {hint && <div className="dim small">{hint}</div>}
      </div>
      {control}
    </div>
  );
  return (
    <div
      className={"modal-back" + (closing ? " closing" : "")}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label={t("设置")}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="set-head">
          <h2>{t("设置")}</h2>
          <button
            type="button"
            className="ib set-close"
            onClick={close}
            title={t("关闭设置（Esc）")}
            aria-label={t("关闭设置")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <div className="set-sec dim">{t("外观")}</div>
          {row(
            t("语言"),
            <Choice<LangSetting>
              value={langV}
              options={[
                ["auto", t("跟随系统")],
                ["zh", "中文"],
                ["en", "English"],
              ]}
              onChange={(v) => {
                setLangV(v);
                if (v !== langSetting()) setLang(v);
              }}
            />,
            t("当前是{0}", lang === "zh" ? "中文" : "English"),
          )}
          {row(
            t("主题"),
            <Choice
              value={s.theme}
              options={[
                ["auto", t("跟随系统")],
                ["light", t("浅色")],
                ["dark", t("深色")],
              ]}
              onChange={(v) => set({ theme: v })}
            />,
          )}
          {row(
            t("显示精确日期"),
            <Toggle
              on={s.exactDates}
              label={t("显示精确日期")}
              onChange={(v) => set({ exactDates: v })}
            />,
            t("关闭后日志里显示“3 小时前”这样的相对时间"),
          )}
          {row(
            t("编辑文件时自动保存"),
            <Toggle on={s.autoSave} label={t("编辑文件时自动保存")} onChange={(v) => set({ autoSave: v })} />,
            t("停止输入 1 秒后、结束编辑或离开编辑器时保存；关闭后用 {0} 手动保存", hintOf("save")),
          )}
          <div className="set-sec dim">{t("远程")}</div>
          {repoOpen &&
            onRemotes &&
            row(
              t("这个仓库的远程"),
              <button type="button" className="btn" onClick={onRemotes}>
                {t("管理远程…")}
              </button>,
              t("添加、改地址、重命名、删除远程"),
            )}
          {row(
            t("自动抓取"),
            <Toggle
              on={s.autoFetch}
              label={t("自动抓取")}
              onChange={(v) => set({ autoFetch: v })}
            />,
            t("打开仓库时和窗口重新获得焦点时抓取，更新领先落后数"),
          )}
          {s.autoFetch &&
            row(
              t("最短间隔"),
              <Choice
                value={s.fetchMinutes}
                options={[
                  [5, t("{0} 分钟", 5)],
                  [15, t("{0} 分钟", 15)],
                  [30, t("{0} 分钟", 30)],
                ]}
                onChange={(v) => set({ fetchMinutes: v })}
              />,
            )}
          <div className="set-sec dim">{t("提交")}</div>
          {row(
            t("加签名行"),
            <Toggle
              on={s.signOff}
              label={t("加签名行")}
              onChange={(v) => set({ signOff: v })}
            />,
            t("在提交说明末尾加 Signed-off-by"),
          )}
          {signing &&
            row(
              t("签名提交（这个仓库）"),
              <Toggle
                on={signing.commit}
                label={t("签名提交（这个仓库）")}
                onChange={(v) => {
                  setSignErr(null);
                  api
                    .signingSet(v)
                    .then(setSigning, (e) => setSignErr(errOf(e).message));
                }}
              />,
              signErr
                ? tr(signErr)
                : signing.key
                  ? t(
                      "提交、合并、变基时用 {0} 密钥 {1} 签名（Git 的 commit.gpgSign，只改这个仓库）",
                      signing.format === "ssh" ? "SSH" : "GPG",
                      signing.key,
                    )
                  : t(
                      "还没有配置签名密钥（user.signingKey），打开后由 Git 用默认的 GPG 密钥签名",
                    ),
            )}
          <div className="set-sec dim">{t("启动")}</div>
          {row(
            t("启动时打开上次的仓库"),
            <Toggle
              on={s.reopenLast}
              label={t("启动时打开上次的仓库")}
              onChange={(v) => set({ reopenLast: v })}
            />,
          )}
          <div className="set-sec dim">{t("更新")}</div>
          {row(
            t("自动检查更新"),
            <Toggle
              on={s.autoUpdate}
              label={t("自动检查更新")}
              onChange={(v) => set({ autoUpdate: v })}
            />,
            t(
              "启动时检查 GitHub 上有没有新版本，有的话提示你下载安装；不会自动安装",
            ),
          )}
          {onCheckUpdate &&
            row(
              t("当前版本 {0}", version ?? "…"),
              <button type="button" className="btn" onClick={onCheckUpdate}>
                {t("检查更新")}
              </button>,
              t("更新包带签名，安装前会核对，装好后自动重新启动"),
            )}
          <KeysSection />
        <div ref={gitSec}>
            <GitConfigSection repoOpen={!!repoOpen} />
          </div>
          <div className="set-sec dim">Git</div>
          {row(
            t("系统 Git"),
            <span className="mono dim">{git?.version ?? t("没有找到")}</span>,
            t(
              "Strand 使用系统里安装的 Git，最低版本 {0}",
              git?.min_version ?? "2.30",
            ),
          )}
        </div>
        <div className="modal-btns set-foot">
          <button
            type="button"
            className="btn primary"
            onClick={close}
            autoFocus
          >
            {t("完成")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Git settings (user.name, user.email, proxy, line endings, default branch) ----------

type FieldKind =
  | { kind: "text"; placeholder: string }
  | { kind: "choice"; options: [string, string][] };

/** The editable keys, in display order */
const GIT_FIELDS = lazy(
  (): {
    key: string;
    label: string;
    hint: string;
    field: FieldKind;
    globalOnly?: boolean;
  }[] => [
    {
      key: "user.name",
      label: t("用户名"),
      hint: t("写进每个提交的作者名"),
      field: { kind: "text", placeholder: t("如 Lin Xia") },
    },
    {
      key: "user.email",
      label: t("邮箱"),
      hint: t("写进每个提交的作者邮箱；托管平台按它认出是谁"),
      field: { kind: "text", placeholder: "name@example.com" },
    },
    {
      key: "http.proxy",
      label: t("代理"),
      hint: t(
        "抓取、拉取、推送和克隆 https 地址时走这个代理（http.proxy）；ssh 地址不走它",
      ),
      field: { kind: "text", placeholder: "http://127.0.0.1:7890" },
    },
    {
      key: "https.proxy",
      label: t("HTTPS 代理"),
      hint: t("只给 https 地址单独设代理时才填；不填时用上面的代理"),
      field: { kind: "text", placeholder: "socks5://127.0.0.1:1080" },
    },
    {
      key: "core.autocrlf",
      label: t("换行符"),
      hint: t(
        "core.autocrlf：Windows 上一般选“提交时转 LF，检出转 CRLF”，macOS 上选“提交时转 LF”",
      ),
      field: {
        kind: "choice",
        options: [
          ["", t("不设置")],
          ["true", t("提交时转 LF，检出转 CRLF")],
          ["input", t("提交时转 LF")],
          ["false", t("不转换")],
        ],
      },
    },
    {
      key: "init.defaultBranch",
      label: t("新仓库的默认分支"),
      hint: t("git init 时第一个分支的名字（init.defaultBranch）"),
      field: { kind: "text", placeholder: "main" },
      globalOnly: true,
    },
  ],
);

/** One text setting: saved on Enter or when focus leaves; Esc reverts */
function ConfigText({
  id,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  value: string;
  placeholder: string;
  onSave: (v: string) => Promise<string | null>;
}) {
  const [v, setV] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setV(value), [value]);
  const save = async () => {
    if (v.trim() === value) return setV(value);
    const e = await onSave(v);
    setErr(e);
    if (!e) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    }
  };
  return (
    <div className="gc-field">
      <div className="gc-input">
        <input
          id={id}
          className="mono"
          value={v}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-invalid={!!err}
          onChange={(e) => {
            setV(e.target.value);
            setErr(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape" && v !== value) {
              e.stopPropagation();
              setV(value);
              setErr(null);
            }
          }}
        />
        {value && (
          <button
            type="button"
            className="ib xs"
            title={t("清除")}
            aria-label={t("清除")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={async () => {
              setV("");
              setErr(await onSave(""));
            }}
          >
            ×
          </button>
        )}
      </div>
      {err ? (
        <span className="err small" role="alert">
          {tr(err)}
        </span>
      ) : saved ? (
        <span className="ok-ink small">{t("已保存")}</span>
      ) : null}
    </div>
  );
}

/** The last Git settings and commit signing read: the settings window shows them at once and refreshes in the background, so the page doesn't jump when they arrive */
let gitCache: ConfigValue[] | null = null;
let signCache: SigningConfig | null = null;
/** Read Git settings and signing ahead (when a repository opens), so the first time the settings window opens it's complete */
export function prefetchSettings(repoOpen: boolean) {
  api.gitConfigGet().then((v) => (gitCache = v), () => {});
  if (repoOpen) api.signingConfig().then((v) => (signCache = v), () => (signCache = null));
  else signCache = null;
}

/** Git settings in the settings window: global (~/.gitconfig) or this repository (.git/config, overriding global) */
export function GitConfigSection({ repoOpen }: { repoOpen: boolean }) {
  const [scope, setScope] = useState<ConfigScope>("global");
  const [values, setValuesState] = useState<ConfigValue[] | null>(gitCache);
  const setValues = (v: ConfigValue[]) => {
    gitCache = v;
    setValuesState(v);
  };
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    api.gitConfigGet().then(setValues, (e) => setLoadErr(errOf(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoOpen]);
  useEffect(() => {
    if (!repoOpen) setScope("global");
  }, [repoOpen]);
  const of = (key: string) => values?.find((v) => v.key === key);
  const inScope = (key: string) =>
    (scope === "global" ? of(key)?.global : of(key)?.local) ?? "";
  // Proxy: on when git's keys are set in this scope; the address is remembered in strand.* keys while off
  const proxyOn = !!(inScope("http.proxy") || inScope("https.proxy"));
  const proxyAddr = (real: string, saved: string) =>
    inScope(saved) || inScope(real);
  const hasProxyAddr = !!(
    proxyAddr("http.proxy", "strand.httpProxy") ||
    proxyAddr("https.proxy", "strand.httpsProxy")
  );
  const [proxyErr, setProxyErr] = useState<string | null>(null);
  const save = (key: string) => async (v: string) => {
    const first =
      (key === "http.proxy" || key === "https.proxy") && !hasProxyAddr;
    try {
      let next = await api.gitConfigSet(scope, key, v.trim() || null);
      // The first address entered turns the proxy on
      if (first && v.trim()) next = await api.gitProxyEnable(scope, true);
      setValues(next);
      return null;
    } catch (e) {
      return errOf(e).message;
    }
  };
  const toggleProxy = async (on: boolean) => {
    setProxyErr(null);
    try {
      setValues(await api.gitProxyEnable(scope, on));
    } catch (e) {
      setProxyErr(errOf(e).message);
    }
  };
  return (
    <>
      <div className="set-sec dim">{t("Git 配置")}</div>
      {repoOpen && (
        <div className="set-row">
          <div>
            <div>{t("改哪里的配置")}</div>
            <div className="dim small">
              {scope === "global"
                ? t("全局：对这台电脑上所有仓库生效（~/.gitconfig）")
                : t("这个仓库：只对当前仓库生效，覆盖全局的值（.git/config）")}
            </div>
          </div>
          <Choice<ConfigScope>
            value={scope}
            options={[
              ["global", t("全局")],
              ["local", t("这个仓库")],
            ]}
            onChange={setScope}
          />
        </div>
      )}
      {loadErr && <p className="err small">{tr(loadErr)}</p>}
      {!values && !loadErr && <p className="dim small">{t("正在读取…")}</p>}
      {values &&
        GIT_FIELDS.filter((f) => scope === "global" || !f.globalOnly).map(
          (f) => {
            const cv = of(f.key);
            const isProxy = f.key === "http.proxy" || f.key === "https.proxy";
            const mine = isProxy
              ? proxyAddr(
                  f.key,
                  f.key === "http.proxy"
                    ? "strand.httpProxy"
                    : "strand.httpsProxy",
                )
              : ((scope === "global" ? cv?.global : cv?.local) ?? "");
            // In the repository scope, show what it falls back to
            const inherited =
              scope === "local"
                ? (cv?.global ??
                  (cv?.effective && !cv.local ? cv.effective : null))
                : null;
            const id = `gc-${scope}-${f.key}`;
            return (
              <div className="set-row gc-row" key={id}>
                <div>
                  <label htmlFor={f.field.kind === "text" ? id : undefined}>
                    {f.label}
                  </label>
                  <div className="dim small">{f.hint}</div>
                  {scope === "global" && cv?.local && (
                    <div className="dim small">
                      {t("当前仓库里另设了：{0}", cv.local)}
                    </div>
                  )}
                  {f.key === "http.proxy" &&
                    (proxyErr ? (
                      <div className="err small">{tr(proxyErr)}</div>
                    ) : !proxyOn && hasProxyAddr ? (
                      <div className="dim small gc-off">
                        {scope === "local" && of("http.proxy")?.global
                          ? t("已关闭：这个仓库沿用全局的代理，填的地址留着")
                          : t("已关闭：Git 不走代理，填的地址留着，打开就恢复")}
                      </div>
                    ) : null)}
                </div>
                {f.key === "http.proxy" ? (
                  <div className="gc-proxy">
                    <Toggle
                      on={proxyOn}
                      label={t("使用代理")}
                      onChange={(v) => void toggleProxy(v)}
                    />
                    <ConfigText
                      id={id}
                      value={mine}
                      placeholder={
                        inherited
                          ? t("沿用全局：{0}", inherited)
                          : f.field.kind === "text"
                            ? f.field.placeholder
                            : ""
                      }
                      onSave={save(f.key)}
                    />
                  </div>
                ) : f.field.kind === "text" ? (
                  <ConfigText
                    id={id}
                    value={mine}
                    placeholder={
                      inherited
                        ? t("沿用全局：{0}", inherited)
                        : f.field.placeholder
                    }
                    onSave={save(f.key)}
                  />
                ) : (
                  <Choice<string>
                    value={mine}
                    options={f.field.options.map(
                      ([v, l]) =>
                        [
                          v,
                          v === "" && inherited
                            ? t("沿用全局（{0}）", inherited)
                            : l,
                        ] as [string, string],
                    )}
                    onChange={(v) => void save(f.key)(v)}
                  />
                )}
              </div>
            );
          },
        )}
    </>
  );
}

/** Settings → Keyboard shortcuts: click a shortcut, then press the new combo (Esc cancels) */
function KeysSection() {
  useKeymap();
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [msg, setMsg] = useState<{ id: ActionId; text: string } | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setCapturing(null);
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier alone: keep waiting
      if (!usable(combo)) return setMsg({ id: capturing, text: t("要带 {0} 或 {1}，或者用 F1–F12，免得打字时误触", isMacOs ? "⌘" : "Ctrl", isMacOs ? "⌥" : "Alt") });
      const other = conflictOf(capturing, combo);
      if (other) return setMsg({ id: capturing, text: t("{0} 已经给了“{1}”", showCombo(combo), labelOf(other)) });
      setCombo(capturing, combo);
      setMsg(null);
      setCapturing(null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [capturing]);
  const changed = ACTIONS.some((a) => comboOf(a.id) !== a.def);
  return (
    <>
      <div className="set-sec dim set-sec-row">
        <span>{t("快捷键")}</span>
        {changed && (
          <button type="button" className="linklike small" onClick={() => (resetAll(), setMsg(null))}>
            {t("全部恢复默认")}
          </button>
        )}
      </div>
      {ACTIONS.map((a) => (
        <div className="set-row keys-row" key={a.id}>
          <div>
            <div>{t(a.label)}</div>
            {msg?.id === a.id && <div className="small err">{msg.text}</div>}
          </div>
          <span className="keys-ctl">
            {comboOf(a.id) !== a.def && capturing !== a.id && (
              <button type="button" className="linklike small" title={t("恢复默认（{0}）", showCombo(a.def))} onClick={() => (setCombo(a.id, null), setMsg(null))}>
                {t("恢复默认")}
              </button>
            )}
            <button
              type="button"
              className={"btn sm keys-btn mono" + (capturing === a.id ? " pressed" : "")}
              aria-label={t("修改“{0}”的快捷键", t(a.label))}
              onClick={() => (setMsg(null), setCapturing(capturing === a.id ? null : a.id))}
            >
              {capturing === a.id ? t("按下新的快捷键…") : showCombo(comboOf(a.id))}
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
